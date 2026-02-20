import { CoralSwapClient } from '../client';
import {
  AddLiquidityRequest,
  RemoveLiquidityRequest,
  LiquidityResult,
  AddLiquidityQuote,
} from '../types/liquidity';
import { LPPosition } from '../types/pool';
import { PRECISION } from '../config';
import { TransactionError, ValidationError } from '../errors';

/**
 * Liquidity module -- manages LP positions in CoralSwap pools.
 *
 * Provides quoting, adding, and removing liquidity with slippage
 * protection and deadline enforcement through the Router contract.
 */
export class LiquidityModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get a quote for adding liquidity at current pool ratios.
   */
  async getAddLiquidityQuote(
    tokenA: string,
    tokenB: string,
    amountADesired: bigint,
  ): Promise<AddLiquidityQuote> {
    const pairAddress = await this.client.getPairAddress(tokenA, tokenB);

    if (!pairAddress) {
      // First liquidity provider -- any ratio is accepted
      return {
        amountA: amountADesired,
        amountB: amountADesired,
        estimatedLPTokens: this.sqrt(amountADesired * amountADesired) - PRECISION.MIN_LIQUIDITY,
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
    const estimatedLP = totalSupply > 0n
      ? (amountADesired * totalSupply) / reserveA
      : this.sqrt(amountADesired * amountBOptimal) - PRECISION.MIN_LIQUIDITY;

    const shareOfPool = totalSupply > 0n
      ? Number((estimatedLP * 10000n) / (totalSupply + estimatedLP)) / 10000
      : 1.0;

    return {
      amountA: amountADesired,
      amountB: amountBOptimal,
      estimatedLPTokens: estimatedLP,
      shareOfPool,
      priceAPerB: reserveA > 0n ? (reserveB * PRECISION.PRICE_SCALE) / reserveA : 0n,
      priceBPerA: reserveB > 0n ? (reserveA * PRECISION.PRICE_SCALE) / reserveB : 0n,
    };
  }

  /**
   * Execute an add-liquidity transaction via the Router.
   */
  async addLiquidity(request: AddLiquidityRequest): Promise<LiquidityResult> {
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
        `Add liquidity failed: ${result.error?.message ?? 'Unknown error'}`,
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
   */
  async removeLiquidity(request: RemoveLiquidityRequest): Promise<LiquidityResult> {
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
        `Remove liquidity failed: ${result.error?.message ?? 'Unknown error'}`,
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
   */
  async getPosition(
    pairAddress: string,
    owner: string,
  ): Promise<LPPosition> {
    const pair = this.client.pair(pairAddress);
    const reserves = await pair.getReserves();

    // Determine LP token address from pair state
    const lpTokenAddress = pairAddress; // LP token is co-located in V1
    const lpClient = this.client.lpToken(lpTokenAddress);

    const [balance, totalSupply] = await Promise.all([
      lpClient.balance(owner),
      lpClient.totalSupply(),
    ]);

    const share = totalSupply > 0n
      ? Number((balance * 10000n) / totalSupply) / 10000
      : 0;

    const token0Amount = totalSupply > 0n
      ? (reserves.reserve0 * balance) / totalSupply
      : 0n;
    const token1Amount = totalSupply > 0n
      ? (reserves.reserve1 * balance) / totalSupply
      : 0n;

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
    if (value < 0n) throw new ValidationError('Square root of negative number');
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
