import { z } from "zod";
import { xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import {
  AddLiquidityRequest,
  RemoveLiquidityRequest,
  LiquidityResult,
  AddLiquidityQuote,
} from "@/types/liquidity";
import { LPPosition } from "@/types/pool";
import { GasEstimate } from "@/types/gas";
import { PRECISION } from "@/config";
import { TransactionError, ValidationError } from "@/errors";
import { isValidAddress } from "@/utils/addresses";
import { validateWithSchema } from "@/schemas";
import { estimateGas } from "@/utils/gas";

// ---------------------------------------------------------------------------
// Input schemas
//
// Declarative equivalents of the hand-written guards that used to live in this
// module (`validateAddress`, `validatePositiveAmount`,
// `validateNonNegativeAmount`, `validateDistinctTokens`). Every rule and every
// error message text is carried over verbatim; the shared
// {@link validateWithSchema} helper turns schema failures into the SDK's own
// {@link ValidationError}. See `src/schemas/index.ts` for the convention.
// ---------------------------------------------------------------------------

/**
 * A Stellar account (G...) or contract (C...) address.
 *
 * Mirrors `validateAddress()`: an empty/whitespace-only value reports
 * "must not be empty", anything else that is not decodable as an address
 * reports "is not a valid Stellar address: <value>".
 */
function addressSchema(name: string) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not be empty`,
      });
      return;
    }

    if (!isValidAddress(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} is not a valid Stellar address: ${value}`,
      });
    }
  });
}

/**
 * A strictly positive bigint amount (mirrors `validatePositiveAmount()`).
 */
function positiveAmountSchema(name: string) {
  return z.bigint().superRefine((value, ctx) => {
    if (value <= 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be greater than 0, got ${value}`,
      });
    }
  });
}

/**
 * A non-negative bigint amount (mirrors `validateNonNegativeAmount()`).
 */
function nonNegativeAmountSchema(name: string) {
  return z.bigint().superRefine((value, ctx) => {
    if (value < 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be non-negative, got ${value}`,
      });
    }
  });
}

/**
 * Cross-field rule mirroring `validateDistinctTokens()`: the two tokens of a
 * pool must differ.
 */
const distinctTokensIssue = (value: { tokenA: string; tokenB: string }) =>
  value.tokenA === value.tokenB
    ? {
        code: z.ZodIssueCode.custom,
        path: ["tokenB"],
        message: "tokenIn and tokenOut must be different addresses",
      }
    : null;

/** Parameters of `LiquidityModule.getAddLiquidityQuote()`. */
const AddLiquidityQuoteParamsSchema = z
  .object({
    tokenA: addressSchema("tokenA"),
    tokenB: addressSchema("tokenB"),
    amountADesired: positiveAmountSchema("amountADesired"),
  })
  .superRefine((value, ctx) => {
    const issue = distinctTokensIssue(value);
    if (issue) ctx.addIssue(issue);
  });

/** Parameters of `LiquidityModule.addLiquidity()` / `buildAddLiquidityOperation()`. */
const AddLiquidityRequestSchema = z
  .object({
    tokenA: addressSchema("tokenA"),
    tokenB: addressSchema("tokenB"),
    to: addressSchema("to"),
    amountADesired: positiveAmountSchema("amountADesired"),
    amountBDesired: positiveAmountSchema("amountBDesired"),
    amountAMin: nonNegativeAmountSchema("amountAMin"),
    amountBMin: nonNegativeAmountSchema("amountBMin"),
    deadline: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    // Slippage protection: the minimum acceptable amount can never exceed the
    // desired amount, but equality (100% tolerance) is allowed.
    if (value.amountAMin > value.amountADesired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountAMin"],
        message: "amountAMin must not exceed amountADesired",
      });
    }

    if (value.amountBMin > value.amountBDesired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountBMin"],
        message: "amountBMin must not exceed amountBDesired",
      });
    }
  })
  .superRefine((value, ctx) => {
    const issue = distinctTokensIssue(value);
    if (issue) ctx.addIssue(issue);
  });

/** Parameters of `LiquidityModule.removeLiquidity()` / `buildRemoveLiquidityOperation()`. */
const RemoveLiquidityRequestSchema = z
  .object({
    tokenA: addressSchema("tokenA"),
    tokenB: addressSchema("tokenB"),
    to: addressSchema("to"),
    liquidity: positiveAmountSchema("liquidity"),
    amountAMin: nonNegativeAmountSchema("amountAMin"),
    amountBMin: nonNegativeAmountSchema("amountBMin"),
    deadline: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    const issue = distinctTokensIssue(value);
    if (issue) ctx.addIssue(issue);
  });


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
    validateWithSchema(
      AddLiquidityQuoteParamsSchema,
      { tokenA, tokenB, amountADesired },
      "getAddLiquidityQuote parameters",
    );

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
   * Execute an add-liquidity transaction via the Router, or estimate its fee.
   *
   * Pass `{ estimateOnly: true }` to dry-run the simulation and return a
   * {@link GasEstimate} without submitting.
   *
   * @param request - Parameters for adding liquidity
   * @param options.estimateOnly - When true, returns a fee estimate instead of submitting
   * @returns The execution result, or a GasEstimate when estimateOnly is true
   * @throws {ValidationError} If minimum amounts exceed desired amounts or inputs are invalid
   * @throws {TransactionError} If the transaction execution fails
   * @example
   * const result = await client.liquidity.addLiquidity({ tokenA: 'C...', ... });
   * const gas = await client.liquidity.addLiquidity({ tokenA: 'C...', ... }, { estimateOnly: true });
   */
  buildAddLiquidityOperation(request: AddLiquidityRequest): xdr.Operation {
    const {
      to,
      tokenA,
      tokenB,
      amountADesired,
      amountBDesired,
      amountAMin,
      amountBMin,
      deadline,
    } = validateWithSchema(
      AddLiquidityRequestSchema,
      request,
      "add liquidity request",
    );

    return this.client.router.buildAddLiquidity(
      to,
      tokenA,
      tokenB,
      amountADesired,
      amountBDesired,
      amountAMin,
      amountBMin,
      deadline ?? this.client.getDeadline(),
    );
  }

  async addLiquidity(request: AddLiquidityRequest, options: { estimateOnly: true }): Promise<GasEstimate>;
  async addLiquidity(request: AddLiquidityRequest, options?: { estimateOnly?: false }): Promise<LiquidityResult>;
  async addLiquidity(request: AddLiquidityRequest, options?: { estimateOnly?: boolean }): Promise<LiquidityResult | GasEstimate> {
    const op = this.buildAddLiquidityOperation(request);

    if (options?.estimateOnly) {
      return estimateGas((ops) => this.client.simulateTransaction(ops, {}), [op]);
    }

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
   * Execute a remove-liquidity transaction via the Router, or estimate its fee.
   *
   * Pass `{ estimateOnly: true }` to dry-run the simulation and return a
   * {@link GasEstimate} without submitting.
   *
   * @param request - Parameters for removing liquidity
   * @param options.estimateOnly - When true, returns a fee estimate instead of submitting
   * @returns The execution result, or a GasEstimate when estimateOnly is true
   * @throws {TransactionError} If the transaction execution fails
   * @example
   * const result = await client.liquidity.removeLiquidity({ tokenA: 'C...', ... });
   * const gas = await client.liquidity.removeLiquidity({ tokenA: 'C...', ... }, { estimateOnly: true });
   */
  buildRemoveLiquidityOperation(request: RemoveLiquidityRequest): xdr.Operation {
    const {
      to,
      tokenA,
      tokenB,
      liquidity,
      amountAMin,
      amountBMin,
      deadline,
    } = validateWithSchema(
      RemoveLiquidityRequestSchema,
      request,
      "remove liquidity request",
    );

    return this.client.router.buildRemoveLiquidity(
      to,
      tokenA,
      tokenB,
      liquidity,
      amountAMin,
      amountBMin,
      deadline ?? this.client.getDeadline(),
    );
  }

  async removeLiquidity(request: RemoveLiquidityRequest, options: { estimateOnly: true }): Promise<GasEstimate>;
  async removeLiquidity(request: RemoveLiquidityRequest, options?: { estimateOnly?: false }): Promise<LiquidityResult>;
  async removeLiquidity(
    request: RemoveLiquidityRequest,
    options?: { estimateOnly?: boolean },
  ): Promise<LiquidityResult | GasEstimate> {
    const op = this.buildRemoveLiquidityOperation(request);

    if (options?.estimateOnly) {
      return estimateGas((ops) => this.client.simulateTransaction(ops, {}), [op]);
    }

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
