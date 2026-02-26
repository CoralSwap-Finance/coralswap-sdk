import { CoralSwapClient } from "@/client";
import {
  AddLiquidityRequest,
  RemoveLiquidityRequest,
  LiquidityResult,
  AddLiquidityQuote,
} from "@/types/liquidity";
import { LPPosition } from "@/types/pool";
import { PRECISION } from "@/config";
import { TransactionError, ValidationError } from "@/errors";
import {
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateDistinctTokens,
} from "@/utils/validation";

/**
 * Liquidity module -- manages LP positions in CoralSwap pools.
 *
 * Provides quoting, adding, and removing liquidity with slippage
 * protection and deadline enforcement through the Router contract.
 */
export class LiquidityModule {
  private client: CoralSwapClient;
  private lpTokenCache: Map<string, string> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get a quote for adding liquidity at current pool ratios.
   *
   * @param tokenA - Address of the first token
   * @param tokenB - Address of the second token
   * @param amountADesired - Desired amount of token A to add
   * @returns A quote with optimal token amounts and estimated LP share
   * @example
   * const quote = await client.liquidity.getAddLiquidityQuote('C...', 'C...', 100n);
   */
  async getAddLiquidityQuote(
    tokenA: string,
    tokenB: string,
    amountADesired: bigint,
  ): Promise<AddLiquidityQuote> {
    validateAddress(tokenA, "tokenA");
    validateAddress(tokenB, "tokenB");
    validateDistinctTokens(tokenA, tokenB);
    validatePositiveAmount(amountADesired, "amountADesired");

    const pairAddress = await this.client.getPairAddress(tokenA, tokenB);

    if (!pairAddress) {
      // First liquidity provider -- any ratio is accepted
      return {
        amountA: amountADesired,
        amountB: amountADesired,
        estimatedLPTokens:
          this.sqrt(amountADesired * amountADesired) - PRECISION.MIN_LIQUIDITY,
        shareOfPool: 1.0,
        priceAPerB: PRECISION.PRICE_SCALE,
        priceBPerA: PRECISION.PRICE_SCALE,
      };
    }

    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    const isAToken0 = tokens.token0 === tokenA;
    const reserveA = isAToken0 ? reserve0 : reserve1;
    const reserveB = isAToken0 ? reserve1 : reserve0;

    const amountBOptimal = (amountADesired * reserveB) / reserveA;

    const totalSupply = await this.getLPTotalSupply(pairAddress);
    const estimatedLP =
      totalSupply > 0n
        ? (amountADesired * totalSupply) / reserveA
        : this.sqrt(amountADesired * amountBOptimal) - PRECISION.MIN_LIQUIDITY;

    const shareOfPool =
      totalSupply > 0n
        ? Number((estimatedLP * 10000n) / (totalSupply + estimatedLP)) / 10000
        : 1.0;

    return {
      amountA: amountADesired,
      amountB: amountBOptimal,
      estimatedLPTokens: estimatedLP,
      shareOfPool,
      priceAPerB:
        reserveA > 0n ? (reserveB * PRECISION.PRICE_SCALE) / reserveA : 0n,
      priceBPerA:
        reserveB > 0n ? (reserveA * PRECISION.PRICE_SCALE) / reserveB : 0n,
    };
  }

  /**
   * Execute an add-liquidity transaction via the Router.
   *
   * @param request - Parameters for adding liquidity
   * @returns The execution result containing the transaction hash and added amounts
   * @throws {ValidationError} If minimum amounts exceed desired amounts or inputs are invalid
   * @throws {TransactionError} If the transaction execution fails
   * @example
   * const result = await client.liquidity.addLiquidity({
   *   tokenA: 'C...', tokenB: 'C...', amountADesired: 100n, amountBDesired: 100n, amountAMin: 99n, amountBMin: 99n, to: 'C...'
   * });
   */
  async addLiquidity(request: AddLiquidityRequest): Promise<LiquidityResult> {
    validateAddress(request.tokenA, "tokenA");
    validateAddress(request.tokenB, "tokenB");
    validateDistinctTokens(request.tokenA, request.tokenB);
    validateAddress(request.to, "to");
    validatePositiveAmount(request.amountADesired, "amountADesired");
    validatePositiveAmount(request.amountBDesired, "amountBDesired");
    validateNonNegativeAmount(request.amountAMin, "amountAMin");
    validateNonNegativeAmount(request.amountBMin, "amountBMin");
    if (request.amountAMin > request.amountADesired) {
      throw new ValidationError("amountAMin must not exceed amountADesired", {
        amountAMin: request.amountAMin.toString(),
        amountADesired: request.amountADesired.toString(),
      });
    }
    if (request.amountBMin > request.amountBDesired) {
      throw new ValidationError("amountBMin must not exceed amountBDesired", {
        amountBMin: request.amountBMin.toString(),
        amountBDesired: request.amountBDesired.toString(),
      });
    }

    const deadline = request.deadline ?? this.client.getDeadline();

    const op = this.client.router.buildAddLiquidity(
      request.to,
      request.tokenA,
      request.tokenB,
      request.amountADesired,
      request.amountBDesired,
      request.amountAMin,
      request.amountBMin,
      deadline,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Add liquidity failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return {
      txHash: result.txHash!,
      amountA: request.amountADesired,
      amountB: request.amountBDesired,
      liquidity: 0n,
      ledger: result.data!.ledger,
    };
  }

  /**
   * Execute a remove-liquidity transaction via the Router.
   *
   * @param request - Parameters for removing liquidity
   * @returns The execution result containing the withdrawn token amounts
   * @throws {TransactionError} If the transaction execution fails
   * @example
   * const result = await client.liquidity.removeLiquidity({
   *   tokenA: 'C...', tokenB: 'C...', liquidity: 50n, amountAMin: 49n, amountBMin: 49n, to: 'C...'
   * });
   */
  async removeLiquidity(
    request: RemoveLiquidityRequest,
  ): Promise<LiquidityResult> {
    validateAddress(request.tokenA, "tokenA");
    validateAddress(request.tokenB, "tokenB");
    validateDistinctTokens(request.tokenA, request.tokenB);
    validateAddress(request.to, "to");
    validatePositiveAmount(request.liquidity, "liquidity");
    validateNonNegativeAmount(request.amountAMin, "amountAMin");
    validateNonNegativeAmount(request.amountBMin, "amountBMin");

    const deadline = request.deadline ?? this.client.getDeadline();

    const op = this.client.router.buildRemoveLiquidity(
      request.to,
      request.tokenA,
      request.tokenB,
      request.liquidity,
      request.amountAMin,
      request.amountBMin,
      deadline,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Remove liquidity failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return {
      txHash: result.txHash!,
      amountA: request.amountAMin,
      amountB: request.amountBMin,
      liquidity: request.liquidity,
      ledger: result.data!.ledger,
    };
  }

  /**
   * Get the current LP position for an address in a specific pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param owner - The address of the LP token holder
   * @returns Details concerning the user's LP position
   * @example
   * const pos = await client.liquidity.getPosition('C...', 'C...');
   */
  async getPosition(pairAddress: string, owner: string): Promise<LPPosition> {
    const pair = this.client.pair(pairAddress);
    const reserves = await pair.getReserves();

    // Retrieve LP token address from cache or fetch from pair contract
    let lpTokenAddress = this.lpTokenCache.get(pairAddress);
    if (!lpTokenAddress) {
      lpTokenAddress = await pair.getLPTokenAddress();
      this.lpTokenCache.set(pairAddress, lpTokenAddress);
    }

    const lpClient = this.client.lpToken(lpTokenAddress);

    const [balance, totalSupply] = await Promise.all([
      lpClient.balance(owner),
      lpClient.totalSupply(),
    ]);

    const share =
      totalSupply > 0n ? Number((balance * 10000n) / totalSupply) / 10000 : 0;

    const token0Amount =
      totalSupply > 0n ? (reserves.reserve0 * balance) / totalSupply : 0n;
    const token1Amount =
      totalSupply > 0n ? (reserves.reserve1 * balance) / totalSupply : 0n;

    return {
      pairAddress,
      lpTokenAddress,
      balance,
      totalSupply,
      share,
      token0Amount,
      token1Amount,
    };
  }

  /**
   * Get all LP positions for an address across all known pairs.
   *
   * @param owner - The address of the account to query
   * @returns Array of the user's LP positions
   * @example
   * const positions = await client.liquidity.getAllPositions('C...');
   */
  async getAllPositions(owner: string): Promise<LPPosition[]> {
    const pairs = await this.client.factory.getAllPairs();
    const positions = await Promise.all(
      pairs.map((addr) => this.getPosition(addr, owner)),
    );
    return positions.filter((p) => p.balance > 0n);
  }

  /**
   * Get the total supply of LP tokens for a pair.
   */
  private async getLPTotalSupply(pairAddress: string): Promise<bigint> {
    const lpClient = this.client.lpToken(pairAddress);
    return lpClient.totalSupply();
  }

  /**
   * Integer square root (Babylonian method) for LP token calculations.
   */
  private sqrt(value: bigint): bigint {
    if (value < 0n) throw new ValidationError("Square root of negative number");
    if (value === 0n) return 0n;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
      x = y;
      y = (x + value / x) / 2n;
    }
    return x;
  }
}
