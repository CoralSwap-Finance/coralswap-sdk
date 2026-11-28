import { z } from "zod";
import { xdr, rpc } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import {
  AddLiquidityRequest,
  RemoveLiquidityRequest,
  LiquidityResult,
  AddLiquidityQuote,
  RemoveLiquidityQuote,
} from "@/types/liquidity";
import { LPPosition } from "@/types/pool";
import { GasEstimate } from "@/types/gas";
import { Result } from "@/types/common";
import { DEFAULTS, PRECISION } from "@/config";
import {
  InsufficientLiquidityError,
  PairNotFoundError,
  TransactionError,
  ValidationError,
} from "@/errors";
import { isValidAddress } from "@/utils/addresses";
import { validateWithSchema } from "@/schemas";
import { EventParser } from "@/utils/events";
import { estimateGas } from "@/utils/gas";
import { submitIdempotent } from "@/utils/submit-idempotent";

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

/** Maximum accepted slippage tolerance for liquidity operations (50%). */
const MAX_SLIPPAGE_BPS = 5000;

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

/** Slippage tolerance in basis points. */
const slippageBpsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SLIPPAGE_BPS)
  .optional();

/** Explicit opt-in for an unbounded (zero) minimum. */
const allowZeroMinSchema = z.boolean().optional();

/**
 * Slippage policy: an explicit zero minimum is unbounded slippage and is
 * rejected unless the caller opts in with `allowZeroMin`.
 */
function zeroMinimumIssue(
  value: bigint | undefined,
  name: string,
  allowZeroMin: boolean | undefined,
) {
  if (value === 0n && !allowZeroMin) {
    return {
      code: z.ZodIssueCode.custom,
      path: [name],
      message: `${name} must be greater than 0 unless allowZeroMin is true`,
    };
  }
  return null;
}

/** Parameters of `LiquidityModule.getAddLiquidityQuote()`. */
const AddLiquidityQuoteParamsSchema = z
  .object({
    tokenA: addressSchema("tokenA"),
    tokenB: addressSchema("tokenB"),
    amountADesired: positiveAmountSchema("amountADesired"),
    amountBDesired: positiveAmountSchema("amountBDesired").optional(),
  })
  .superRefine((value, ctx) => {
    const issue = distinctTokensIssue(value);
    if (issue) ctx.addIssue(issue);
  });

/** Parameters of `LiquidityModule.getRemoveLiquidityQuote()`. */
const RemoveLiquidityQuoteParamsSchema = z
  .object({
    tokenA: addressSchema("tokenA"),
    tokenB: addressSchema("tokenB"),
    liquidity: positiveAmountSchema("liquidity"),
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
    amountAMin: nonNegativeAmountSchema("amountAMin").optional(),
    amountBMin: nonNegativeAmountSchema("amountBMin").optional(),
    slippageBps: slippageBpsSchema,
    allowZeroMin: allowZeroMinSchema,
    deadline: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    // Slippage protection: the minimum acceptable amount can never exceed the
    // desired amount, but equality (100% tolerance) is allowed.
    if (
      value.amountAMin !== undefined &&
      value.amountAMin > value.amountADesired
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountAMin"],
        message: "amountAMin must not exceed amountADesired",
      });
    }

    if (
      value.amountBMin !== undefined &&
      value.amountBMin > value.amountBDesired
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountBMin"],
        message: "amountBMin must not exceed amountBDesired",
      });
    }

    const amountAIssue = zeroMinimumIssue(
      value.amountAMin,
      "amountAMin",
      value.allowZeroMin,
    );
    if (amountAIssue) ctx.addIssue(amountAIssue);

    const amountBIssue = zeroMinimumIssue(
      value.amountBMin,
      "amountBMin",
      value.allowZeroMin,
    );
    if (amountBIssue) ctx.addIssue(amountBIssue);
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
    amountAMin: nonNegativeAmountSchema("amountAMin").optional(),
    amountBMin: nonNegativeAmountSchema("amountBMin").optional(),
    slippageBps: slippageBpsSchema,
    allowZeroMin: allowZeroMinSchema,
    deadline: z.number().optional(),
  })
  .superRefine((value, ctx) => {
    const amountAIssue = zeroMinimumIssue(
      value.amountAMin,
      "amountAMin",
      value.allowZeroMin,
    );
    if (amountAIssue) ctx.addIssue(amountAIssue);

    const amountBIssue = zeroMinimumIssue(
      value.amountBMin,
      "amountBMin",
      value.allowZeroMin,
    );
    if (amountBIssue) ctx.addIssue(amountBIssue);
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
   * For the first deposit into a pair that does not exist yet there are no
   * reserves to derive the second amount from, so `amountBDesired` is required
   * and used as-is. For an existing pair, `amountB` is the optimal amount at
   * the current reserve ratio; pass `amountBDesired` as well when quoting a
   * first deposit into an initialized-but-empty pool. If `amountBDesired` is
   * below `amountB` for an existing pair it caps the deposit and `amountA` is
   * reduced proportionally, so the quote matches what the router will pull.
   *
   * @param tokenA - Address of the first token
   * @param tokenB - Address of the second token
   * @param amountADesired - Desired amount of token A to add
   * @param amountBDesired - Desired amount of token B (required for a first deposit)
   * @returns A quote with optimal token amounts and estimated LP share
   * @throws {ValidationError} If a first deposit has no `amountBDesired` or is too small to mint LP tokens
   * @throws {InsufficientLiquidityError} If the pair exists but has empty reserves
   * @example
   * const quote = await client.liquidity.getAddLiquidityQuote('C...', 'C...', 100n, 200n);
   */
  async getAddLiquidityQuote(
    tokenA: string,
    tokenB: string,
    amountADesired: bigint,
    amountBDesired?: bigint,
  ): Promise<AddLiquidityQuote> {
    const params = validateWithSchema(
      AddLiquidityQuoteParamsSchema,
      { tokenA, tokenB, amountADesired, amountBDesired },
      "getAddLiquidityQuote parameters",
    );

    const pairAddress = await this.client.getPairAddress(tokenA, tokenB);

    if (!pairAddress) {
      return this.firstDepositQuote(
        amountADesired,
        this.requireAmountBDesired(params.amountBDesired),
      );
    }

    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    const isAToken0 = tokens.token0 === tokenA;
    const reserveA = isAToken0 ? reserve0 : reserve1;
    const reserveB = isAToken0 ? reserve1 : reserve0;

    if (reserveA <= 0n || reserveB <= 0n) {
      throw new InsufficientLiquidityError(pairAddress, {
        message: `Cannot quote add liquidity for pair ${pairAddress}: pool reserves are empty`,
        tokenA,
        tokenB,
      });
    }

    const totalSupply = await this.getLPTotalSupply(pairAddress);
    if (totalSupply === 0n) {
      return this.firstDepositQuote(
        amountADesired,
        this.requireAmountBDesired(params.amountBDesired),
      );
    }

    const amountBOptimal = (amountADesired * reserveB) / reserveA;

    // The router uses whichever side is binding: when `amountBDesired` is
    // below the ratio-optimal amount, B is deposited in full and A is reduced.
    // Mirror that here so derived minimums never exceed what will be pulled.
    let amountA = amountADesired;
    let amountB = amountBOptimal;
    if (
      params.amountBDesired !== undefined &&
      params.amountBDesired < amountBOptimal
    ) {
      amountA = (params.amountBDesired * reserveA) / reserveB;
      amountB = params.amountBDesired;
    }

    // The pair mints min(liqA, liqB); mirror that instead of using the A side only.
    const liquidityA = (amountA * totalSupply) / reserveA;
    const liquidityB = (amountB * totalSupply) / reserveB;
    const estimatedLP =
      liquidityA < liquidityB ? liquidityA : liquidityB;

    const shareOfPool =
      Number((estimatedLP * 10000n) / (totalSupply + estimatedLP)) / 10000;

    return {
      amountA,
      amountB,
      estimatedLPTokens: estimatedLP,
      shareOfPool,
      priceAPerB: (reserveB * PRECISION.PRICE_SCALE) / reserveA,
      priceBPerA: (reserveA * PRECISION.PRICE_SCALE) / reserveB,
    };
  }

  /**
   * Get a quote for removing liquidity from a pair.
   *
   * Returns the amounts the pair would pay for burning `liquidity` LP tokens at
   * the current reserves and LP supply, so callers can set minimums from a
   * `slippageBps` tolerance.
   *
   * @param tokenA - Address of the first token
   * @param tokenB - Address of the second token
   * @param liquidity - Amount of LP tokens to burn
   * @returns Expected `amountA`, `amountB` and the burned `liquidity`
   * @throws {PairNotFoundError} If no pair exists for the token pair
   * @throws {InsufficientLiquidityError} If the pair has no reserves or LP supply
   * @example
   * const quote = await client.liquidity.getRemoveLiquidityQuote('C...', 'C...', 500n);
   */
  async getRemoveLiquidityQuote(
    tokenA: string,
    tokenB: string,
    liquidity: bigint,
  ): Promise<RemoveLiquidityQuote> {
    validateWithSchema(
      RemoveLiquidityQuoteParamsSchema,
      { tokenA, tokenB, liquidity },
      "getRemoveLiquidityQuote parameters",
    );

    const pairAddress = await this.client.getPairAddress(tokenA, tokenB);
    if (!pairAddress) {
      throw new PairNotFoundError(tokenA, tokenB);
    }

    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    const isAToken0 = tokens.token0 === tokenA;
    const reserveA = isAToken0 ? reserve0 : reserve1;
    const reserveB = isAToken0 ? reserve1 : reserve0;

    if (reserveA <= 0n || reserveB <= 0n) {
      throw new InsufficientLiquidityError(pairAddress, {
        message: `Cannot quote remove liquidity for pair ${pairAddress}: pool reserves are empty`,
        tokenA,
        tokenB,
      });
    }

    const totalSupply = await this.getLPTotalSupply(pairAddress);
    if (totalSupply <= 0n) {
      throw new InsufficientLiquidityError(pairAddress, {
        message: `Cannot quote remove liquidity for pair ${pairAddress}: LP total supply is zero`,
        tokenA,
        tokenB,
      });
    }

    return {
      amountA: (liquidity * reserveA) / totalSupply,
      amountB: (liquidity * reserveB) / totalSupply,
      liquidity,
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

    if (amountAMin === undefined || amountBMin === undefined) {
      throw new ValidationError(
        "amountAMin and amountBMin are required when building an add-liquidity operation directly; call addLiquidity() with slippageBps to derive them from a quote",
      );
    }

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
    const resolved = await this.resolveAddLiquidityRequest(request);
    const op = this.buildAddLiquidityOperation(resolved);

    if (options?.estimateOnly) {
      return estimateGas((ops) => this.client.simulateTransaction(ops, {}), [op]);
    }

    // Idempotent: a timed-out submission is checked on-chain before the
    // caller retries, so a deposit or withdrawal that landed is not repeated.
    const result = await submitIdempotent(
      () => this.client.submitTransaction([op]),
      this.client.server.getTransaction.bind(this.client.server),
    );

    if (!result.success) {
      throw new TransactionError(
        `Add liquidity failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    // Report what the transaction actually did, decoded from its on-chain
    // return value (or events) — never the pre-submit simulation or the request.
    const amounts = await this.resolveExecutedAmounts(result, 3, "add");

    return {
      txHash: result.txHash!,
      amountA: amounts.amountA,
      amountB: amounts.amountB,
      liquidity: amounts.liquidity ?? 0n,
      ledger: result.data?.ledger ?? 0,
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

    if (amountAMin === undefined || amountBMin === undefined) {
      throw new ValidationError(
        "amountAMin and amountBMin are required when building a remove-liquidity operation directly; call removeLiquidity() with slippageBps to derive them from a quote",
      );
    }

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
    const resolved = await this.resolveRemoveLiquidityRequest(request);
    const op = this.buildRemoveLiquidityOperation(resolved);

    if (options?.estimateOnly) {
      return estimateGas((ops) => this.client.simulateTransaction(ops, {}), [op]);
    }

    // Idempotent: a timed-out submission is checked on-chain before the
    // caller retries, so a deposit or withdrawal that landed is not repeated.
    const result = await submitIdempotent(
      () => this.client.submitTransaction([op]),
      this.client.server.getTransaction.bind(this.client.server),
    );

    if (!result.success) {
      throw new TransactionError(
        `Remove liquidity failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    // Report what the transaction actually did, decoded from its on-chain
    // return value (or events) — never the pre-submit simulation or the request.
    const amounts = await this.resolveExecutedAmounts(result, 2, "remove");

    return {
      txHash: result.txHash!,
      amountA: amounts.amountA,
      amountB: amounts.amountB,
      liquidity: amounts.liquidity ?? resolved.liquidity,
      ledger: result.data?.ledger ?? 0,
    };
  }

  /**
   * Build the quote for a first deposit, where there are no reserves to
   * derive a ratio from. The pair mints `sqrt(amountA * amountB) - MIN_LIQUIDITY`,
   * so a deposit that cannot mint a positive amount is rejected.
   */
  private firstDepositQuote(
    amountA: bigint,
    amountB: bigint,
  ): AddLiquidityQuote {
    const estimatedLPTokens =
      this.sqrt(amountA * amountB) - PRECISION.MIN_LIQUIDITY;

    if (estimatedLPTokens <= 0n) {
      throw new ValidationError(
        `First deposit is too small: sqrt(amountA * amountB) must exceed MIN_LIQUIDITY (${PRECISION.MIN_LIQUIDITY}), got ${estimatedLPTokens}`,
        {
          amountA,
          amountB,
          estimatedLPTokens,
          minLiquidity: PRECISION.MIN_LIQUIDITY,
        },
      );
    }

    return {
      amountA,
      amountB,
      estimatedLPTokens,
      shareOfPool: 1.0,
      priceAPerB: (amountB * PRECISION.PRICE_SCALE) / amountA,
      priceBPerA: (amountA * PRECISION.PRICE_SCALE) / amountB,
    };
  }

  /** Require the caller-supplied B amount needed by a first deposit. */
  private requireAmountBDesired(amountBDesired?: bigint): bigint {
    if (amountBDesired === undefined) {
      throw new ValidationError(
        "amountBDesired is required for the first liquidity deposit; there are no pool reserves to derive it from",
      );
    }
    return amountBDesired;
  }

  /**
   * Resolve the slippage tolerance for a liquidity request.
   *
   * Uses the explicit request value, then the client default, then the SDK
   * default. Rejects out-of-range values so no operation is built with an
   * implicit, unbounded tolerance.
   */
  private resolveSlippageBps(request: { slippageBps?: number }): number {
    const configured = (
      this.client as unknown as {
        config?: { defaultSlippageBps?: number };
      }
    ).config?.defaultSlippageBps;
    const slippageBps = request.slippageBps ?? configured ?? DEFAULTS.slippageBps;

    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > MAX_SLIPPAGE_BPS
    ) {
      throw new ValidationError(
        `Invalid slippageBps: ${slippageBps}. Expected an integer between 0 and ${MAX_SLIPPAGE_BPS}.`,
        { slippageBps },
      );
    }

    return slippageBps;
  }

  /** Subtract a basis-point tolerance from an expected amount. */
  private applySlippage(amount: bigint, slippageBps: number): bigint {
    return (
      (amount * (PRECISION.BPS_DENOMINATOR - BigInt(slippageBps))) /
      PRECISION.BPS_DENOMINATOR
    );
  }

  /**
   * Guard a minimum derived from a quote. A derived `0n` is just as unbounded
   * as an explicit zero minimum, so it needs the same `allowZeroMin` opt-in.
   */
  private requireDerivedMinimum(
    amount: bigint,
    name: string,
    allowZeroMin: boolean | undefined,
  ): bigint {
    if (amount === 0n && !allowZeroMin) {
      throw new ValidationError(
        `${name} derived from the current quote and slippageBps is 0; increase the amount or set allowZeroMin to true to opt into unbounded slippage`,
        { [name]: amount },
      );
    }
    return amount;
  }

  /**
   * Fill in missing minimums for an add-liquidity request from a fresh quote
   * and the request's slippage tolerance.
   */
  private async resolveAddLiquidityRequest(
    request: AddLiquidityRequest,
  ): Promise<AddLiquidityRequest> {
    const parsed = validateWithSchema(
      AddLiquidityRequestSchema,
      request,
      "add liquidity request",
    );

    if (parsed.amountAMin !== undefined && parsed.amountBMin !== undefined) {
      return parsed;
    }

    const slippageBps = this.resolveSlippageBps(parsed);
    const quote = await this.getAddLiquidityQuote(
      parsed.tokenA,
      parsed.tokenB,
      parsed.amountADesired,
      parsed.amountBDesired,
    );

    return {
      ...parsed,
      amountAMin:
        parsed.amountAMin ??
        this.requireDerivedMinimum(
          this.applySlippage(quote.amountA, slippageBps),
          "amountAMin",
          parsed.allowZeroMin,
        ),
      amountBMin:
        parsed.amountBMin ??
        this.requireDerivedMinimum(
          this.applySlippage(quote.amountB, slippageBps),
          "amountBMin",
          parsed.allowZeroMin,
        ),
    };
  }

  /**
   * Fill in missing minimums for a remove-liquidity request from a fresh
   * removal quote and the request's slippage tolerance.
   *
   * Public so composed flows (for example staking's unstake-and-withdraw)
   * derive the same bounds instead of sending zero minimums to the router.
   */
  async resolveRemoveLiquidityRequest(
    request: RemoveLiquidityRequest,
  ): Promise<RemoveLiquidityRequest & { amountAMin: bigint; amountBMin: bigint }> {
    const parsed = validateWithSchema(
      RemoveLiquidityRequestSchema,
      request,
      "remove liquidity request",
    );

    if (parsed.amountAMin !== undefined && parsed.amountBMin !== undefined) {
      return {
        ...parsed,
        amountAMin: parsed.amountAMin,
        amountBMin: parsed.amountBMin,
      };
    }

    const slippageBps = this.resolveSlippageBps(parsed);
    const quote = await this.getRemoveLiquidityQuote(
      parsed.tokenA,
      parsed.tokenB,
      parsed.liquidity,
    );

    const amountAMin =
      parsed.amountAMin ??
      this.requireDerivedMinimum(
        this.applySlippage(quote.amountA, slippageBps),
        "amountAMin",
        parsed.allowZeroMin,
      );
    const amountBMin =
      parsed.amountBMin ??
      this.requireDerivedMinimum(
        this.applySlippage(quote.amountB, slippageBps),
        "amountBMin",
        parsed.allowZeroMin,
      );

    return { ...parsed, amountAMin, amountBMin };
  }

  /**
   * Decode the amounts an executed transaction actually produced.
   *
   * The submitted transaction's return value is authoritative. When it has
   * already been confirmed without a return value, the transaction is fetched
   * from RPC and decoded from its return value or emitted liquidity events.
   * There is no fallback to request/simulation values.
   */
  private async resolveExecutedAmounts(
    result: Result<{ txHash: string; ledger: number }>,
    expectedLength: 2 | 3,
    operation: "add" | "remove",
  ): Promise<{ amountA: bigint; amountB: bigint; liquidity?: bigint }> {
    const txHash = result.txHash ?? result.data?.txHash;
    if (!txHash) {
      throw new TransactionError(
        `Cannot decode ${operation} liquidity amounts: transaction hash is missing`,
        undefined,
      );
    }

    const inline =
      this.tryDecodeAmounts(result.data, expectedLength) ??
      this.tryDecodeAmounts(result, expectedLength);
    if (inline) return inline;

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await this.client.server.getTransaction(txHash);
    } catch (err) {
      throw new TransactionError(
        `Cannot read ${operation} liquidity transaction ${txHash}: ${err instanceof Error ? err.message : String(err)}`,
        txHash,
      );
    }

    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionError(
        `Cannot decode ${operation} liquidity amounts: transaction ${txHash} is ${response.status}`,
        txHash,
      );
    }

    const decoded =
      this.tryDecodeAmounts(response, expectedLength) ??
      this.tryDecodeLiquidityEventAmounts(response, operation);

    if (!decoded) {
      throw new TransactionError(
        `Transaction ${txHash} did not return ${operation === "add" ? "minted" : "withdrawn"} liquidity amounts`,
        txHash,
      );
    }

    return decoded;
  }

  /** Try to decode a `(amountA, amountB, liquidity?)` payload without throwing. */
  private tryDecodeAmounts(
    value: unknown,
    expectedLength: number,
  ): { amountA: bigint; amountB: bigint; liquidity?: bigint } | null {
    if (!value || typeof value !== "object") return null;

    const obj = value as Record<string, unknown>;
    if (typeof obj.amountA === "bigint" && typeof obj.amountB === "bigint") {
      return {
        amountA: obj.amountA,
        amountB: obj.amountB,
        liquidity:
          typeof obj.liquidity === "bigint" ? obj.liquidity : undefined,
      };
    }

    const returnValue =
      obj.returnValue ??
      (obj.result as { retval?: unknown } | undefined)?.retval;
    if (returnValue === undefined || returnValue === null) return null;

    try {
      return this.decodeLiquidityResult(returnValue, expectedLength);
    } catch {
      return null;
    }
  }

  /** Try to decode amounts from liquidity events in a successful tx response. */
  private tryDecodeLiquidityEventAmounts(
    response: unknown,
    operation: "add" | "remove",
  ): { amountA: bigint; amountB: bigint; liquidity?: bigint } | null {
    try {
      const events = new EventParser().fromTransaction(
        response as rpc.Api.GetSuccessfulTransactionResponse,
      );
      const type = operation === "add" ? "add_liquidity" : "remove_liquidity";
      const event = events.find((candidate) => candidate.type === type);
      if (!event || !("amountA" in event)) return null;
      return {
        amountA: event.amountA as bigint,
        amountB: event.amountB as bigint,
        liquidity: event.liquidity as bigint,
      };
    } catch {
      return null;
    }
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

  private decodeLiquidityResult(
    value: unknown,
    expectedLength: number,
  ): { amountA: bigint; amountB: bigint; liquidity?: bigint } {
    const vec =
      (value as { vec?: unknown[] })?.vec ??
      (value as { value?: unknown[] })?.value ??
      [];
    if (!Array.isArray(vec) || vec.length < expectedLength) {
      throw new TransactionError(
        "Liquidity transaction returned an unexpected result shape",
        undefined,
      );
    }

    const amountA = this.decodeI128Entry(vec[0]);
    const amountB = this.decodeI128Entry(vec[1]);
    const liquidity =
      expectedLength === 3 ? this.decodeI128Entry(vec[2]) : undefined;

    return { amountA, amountB, liquidity };
  }

  /** Decode one entry of a liquidity result vector into a bigint. */
  private decodeI128Entry(entry: unknown): bigint {
    if (typeof entry === "bigint") return entry;
    if (typeof entry === "number") return BigInt(entry);
    if (typeof entry === "string") return BigInt(entry);

    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (obj.type !== undefined && obj.type !== "scvI128") {
        throw new TransactionError(
          `Liquidity transaction returned a non-i128 value (${String(obj.type)})`,
          undefined,
        );
      }

      const raw = typeof obj.i128 === "function" ? obj.i128() : obj.i128;
      if (raw !== undefined) return this.int128ToBigInt(raw);

      const asString = String(entry);
      if (/^-?\d+$/.test(asString)) return BigInt(asString);
    }

    throw new TransactionError(
      "Liquidity transaction returned a non-i128 value",
      undefined,
    );
  }

  /** Decode a Soroban Int128 value (hi/lo parts or decimal string) to bigint. */
  private int128ToBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);

    if (value && typeof value === "object") {
      const parts = value as Record<string, unknown>;
      const hi = typeof parts.hi === "function" ? parts.hi() : parts.hi;
      const lo = typeof parts.lo === "function" ? parts.lo() : parts.lo;
      if (hi !== undefined && lo !== undefined) {
        return (this.int128PartToBigInt(hi) << 64n) + this.int128PartToBigInt(lo);
      }

      const asString = String(value);
      if (/^-?\d+$/.test(asString)) return BigInt(asString);
    }

    throw new TransactionError(
      "Liquidity transaction returned an undecodable i128 value",
      undefined,
    );
  }

  /** Decode the signed hi / unsigned lo half of an Int128. */
  private int128PartToBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
    if (value && typeof value === "object") {
      const asString = String(value);
      if (/^-?\d+$/.test(asString)) return BigInt(asString);
    }
    throw new TransactionError(
      "Liquidity transaction returned an undecodable i128 part",
      undefined,
    );
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
