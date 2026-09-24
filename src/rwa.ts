import { PoolState, FeeState } from '@/types/pool';
import { CoralSwapClient } from '@/client';
import { TransactionError } from '@/errors';
import { validateAddress } from '@/utils/validation';
import { getTransactionStatus, shouldRetrySubmission } from '@/utils/idempotent-resubmission';

/**
 * Configuration for an RWA (Real-World Asset) liquidity pool.
 *
 * RWA pools pair a yield-bearing token (e.g. deJTRSY, a tokenised U.S. T-bill)
 * with a stablecoin (e.g. USDC).  Unlike a vanilla volatile pool, the RWA token
 * accrues value over time as the underlying instrument matures, so the pool
 * carries two independent yield sources:
 *   1. Swap fees collected from traders.
 *   2. The native yield of the RWA token itself (T-bill rate, bond coupon, etc.).
 *
 * The `navPerToken` field must be sourced from an on-chain NAV price feed
 * (e.g. a RedStone oracle) and kept current so that NAV-adjusted quotes
 * remain accurate.
 */
export interface RWAPoolConfig {
  /** Address of the RWA / yield-bearing token (e.g. deJTRSY) */
  rwaTokenAddress: string;
  /** Address of the paired stablecoin (e.g. USDC) */
  stablecoinAddress: string;
  /**
   * On-chain NAV price feed contract address (e.g. RedStone oracle).
   * The factory records this at pair-creation time so the pool can
   * enforce NAV-parity checks during rebalancing windows.
   */
  navPriceFeedAddress: string;
  /**
   * Current NAV per RWA token returned by the price feed, expressed in
   * the stablecoin's smallest unit (7 decimal places on Stellar).
   *
   * Example: if 1 deJTRSY = $1.052 USDC, pass 10_520_000n (7 dp).
   */
  navPerToken: bigint;
  /**
   * Annualised underlying yield of the RWA expressed in basis points.
   * For a U.S. T-bill yielding 5.20 % this would be 520.
   * Source this value from the same RedStone price feed or Centrifuge API.
   */
  underlyingYieldBps: number;
}

/**
 * Combined APY breakdown for an RWA pool.
 */
export interface RWAPoolAPY {
  /** Swap-fee component of total APY in basis points */
  swapFeeApyBps: number;
  /** Underlying RWA yield component of total APY in basis points */
  underlyingYieldApyBps: number;
  /** Sum of both components (swap fees + T-bill / bond yield) in basis points */
  combinedApyBps: number;
  /** `combinedApyBps / 100` — convenient human-readable percentage */
  combinedApyPercent: number;
}

/** Stellar token precision: 7 decimal places */
const STELLAR_PRECISION = 10_000_000n;

const BPS_DENOMINATOR = 10_000;
const DAYS_PER_YEAR = 365;

/**
 * Conservative estimate of daily volume relative to pool TVL for a
 * stablecoin / RWA pool.  RWA pools attract institutional arb flow but
 * experience lower retail volume than volatile pairs; 0.50 % per day is
 * a reasonable lower-bound assumption.
 */
const DAILY_VOLUME_RATIO_BPS = 50; // 0.50 %

/**
 * Estimate the annualised swap-fee APY earned by LPs.
 *
 * Formula (all values in basis points):
 *   annual_swap_fee_apy_bps =
 *     (feeCurrent_bps × daily_volume_ratio_bps × days_per_year) / BPS_DENOMINATOR
 *
 * Because fee income scales linearly with volume, a pair with zero reserves
 * (no liquidity yet) returns 0 — there is nothing to earn fees on.
 */
function estimateSwapFeeApyBps(
  reserve0: bigint,
  reserve1: bigint,
  feeCurrent: number,
): number {
  if (reserve0 === 0n || reserve1 === 0n) return 0;
  return Math.floor(
    (feeCurrent * DAILY_VOLUME_RATIO_BPS * DAYS_PER_YEAR) / BPS_DENOMINATOR,
  );
}

/**
 * Compute the combined APY for an RWA liquidity pool.
 *
 * The total yield has two independent components:
 *
 *   **Swap-fee APY** — fees paid by traders routed through this pool.
 *   Estimated from the current dynamic fee rate and a conservative
 *   daily volume assumption (0.50 % of TVL), then annualised.
 *
 *   **Underlying yield APY** — the native yield of the RWA token itself
 *   (e.g. the current U.S. Treasury bill rate for deJTRSY).  This is
 *   passed in via `config.underlyingYieldBps` and sourced from the
 *   RedStone NAV price feed off-chain.
 *
 * Both components are additive because they accrue to different parties:
 * swap fees go to the LP position, while the RWA yield is embedded in the
 * token's rising NAV.  An LP holding deJTRSY in the pool captures both.
 *
 * @param poolState - Live on-chain pool state including reserves and fee config
 * @param config    - RWA-specific parameters: NAV per token and underlying yield
 * @returns         Combined APY breakdown with per-component and total figures
 *
 * @example
 * const apy = getRWAPoolAPY(
 *   { reserve0: 500_000_0000000n, reserve1: 525_000_0000000n, feeState: { feeCurrent: 30 } },
 *   { underlyingYieldBps: 520, navPerToken: 10_500_000n, ... },
 * );
 * console.log(`Combined APY: ${apy.combinedApyPercent.toFixed(2)} %`);
 */
export function getRWAPoolAPY(
  poolState: Pick<PoolState, 'reserve0' | 'reserve1'> & {
    feeState: Pick<FeeState, 'feeCurrent'>;
  },
  config: RWAPoolConfig,
): RWAPoolAPY {
  const swapFeeApyBps = estimateSwapFeeApyBps(
    poolState.reserve0,
    poolState.reserve1,
    poolState.feeState.feeCurrent,
  );

  const underlyingYieldApyBps = config.underlyingYieldBps;
  const combinedApyBps = swapFeeApyBps + underlyingYieldApyBps;

  return {
    swapFeeApyBps,
    underlyingYieldApyBps,
    combinedApyBps,
    combinedApyPercent: combinedApyBps / 100,
  };
}

/**
 * Compute the NAV-adjusted fair-value output for a stablecoin → RWA swap.
 *
 * A yield-bearing token like deJTRSY continuously appreciates against USDC as
 * the underlying T-bills accrue interest.  The AMM pool price may temporarily
 * diverge from the current NAV due to lagging arbitrage; this function gives
 * the oracle-derived reference output independent of pool reserves.
 *
 * Uses the NAV feed directly:
 *   output_rwa = stablecoin_in × STELLAR_PRECISION / navPerToken
 *
 * @param stablecoinIn - Amount of stablecoin to convert (7 dp units)
 * @param navPerToken  - Current NAV per RWA token from the price feed (7 dp units)
 * @returns Expected RWA token amount at fair value (7 dp units), or 0n if NAV is zero
 *
 * @example
 * // Swap 1 000 USDC for deJTRSY at NAV = $1.052
 * const out = navAdjustedSwapOutput(10_000_0000000n, 10_520_000n);
 * // out ≈ 950_570_342n  (≈ 950.57 deJTRSY)
 */
export function navAdjustedSwapOutput(
  stablecoinIn: bigint,
  navPerToken: bigint,
): bigint {
  if (navPerToken === 0n) return 0n;
  return (stablecoinIn * STELLAR_PRECISION) / navPerToken;
}

/**
 * Express the pool's spot price (reserveStable / reserveRWA) relative to NAV.
 *
 * Returns the ratio as a fraction scaled to `STELLAR_PRECISION`:
 *   - 10_000_000n (1.0)  → pool is at NAV parity
 *   - > 10_000_000n      → pool over-prices the RWA token (arb: sell RWA into pool)
 *   - < 10_000_000n      → pool under-prices the RWA token (arb: buy RWA from pool)
 *
 * @param spotPrice    - Pool spot price: reserveStable / reserveRWA (7 dp)
 * @param navPerToken  - Current NAV per RWA token from the price feed (7 dp)
 * @returns Spot-to-NAV ratio scaled to 7 dp, or 0n if NAV is zero
 */
export function navPremiumRatio(spotPrice: bigint, navPerToken: bigint): bigint {
  if (navPerToken === 0n) return 0n;
  return (spotPrice * STELLAR_PRECISION) / navPerToken;
}

/** Parameters for registering a new RWA trading pair on-chain. */
export interface CreateRWAPairRequest {
  /** Address of the first token (e.g. a stablecoin such as USDC). */
  tokenA: string;
  /** Address of the second token (e.g. a yield-bearing RWA token such as deJTRSY). */
  tokenB: string;
  /** RedStone (or equivalent) NAV price feed contract address for `tokenB`. */
  navPriceFeedAddress: string;
}

/** Result of a (possibly recovered) RWA pair creation. */
export interface CreateRWAPairResult {
  txHash: string;
  ledger: number;
  /** Resolved pair address, or null if it could not be looked up yet. */
  pairAddress: string | null;
}

/**
 * Write-path operations for RWA (Real-World Asset) pools.
 *
 * RWA pool interactions move real funds against NAV-priced positions, so a
 * timeout during submission must never result in a blind resubmission --
 * that would risk registering (or attempting to register) the same pair
 * twice against real capital. On a retryable failure this module always
 * checks the transaction's real on-chain status via the shared
 * {@link getTransactionStatus} / {@link shouldRetrySubmission} utility
 * before ever resubmitting.
 */
export class RWAModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Register a new RWA trading pair, recording its NAV price feed on-chain.
   *
   * @throws {ValidationError} If any address is invalid.
   * @throws {TransactionError} If the submission genuinely fails (not just times out).
   */
  async createRWAPair(request: CreateRWAPairRequest): Promise<CreateRWAPairResult> {
    validateAddress(request.tokenA, 'tokenA');
    validateAddress(request.tokenB, 'tokenB');
    validateAddress(request.navPriceFeedAddress, 'navPriceFeedAddress');

    const op = this.client.factory.buildCreateRWAPair(
      this.client.publicKey,
      request.tokenA,
      request.tokenB,
      request.navPriceFeedAddress,
    );

    const { txHash, ledger } = await this.submitIdempotent(op, 'RWA pair creation');

    const pairAddress = await this.client.getPairAddress(request.tokenA, request.tokenB);

    return { txHash, ledger, pairAddress };
  }

  /**
   * Submit an operation, and on a retryable submission failure, check the
   * transaction's real on-chain status before ever resubmitting.
   *
   * - Real status `SUCCESS` -- the write already landed despite the
   *   client-side failure; return it rather than resubmitting.
   * - Real status `FAILED` -- the write genuinely failed on-chain; throw
   *   without resubmitting.
   * - Real status `NOT_FOUND` / `ERROR` -- the write never landed (or its
   *   status can't be confirmed); it is safe to resubmit exactly once.
   */
  private async submitIdempotent(
    op: import('@stellar/stellar-sdk').xdr.Operation,
    label: string,
  ): Promise<{ txHash: string; ledger: number }> {
    const result = await this.client.submitTransaction([op]);

    if (result.success) {
      return { txHash: result.txHash!, ledger: result.data!.ledger };
    }

    if (!result.txHash) {
      throw new TransactionError(
        `${label} failed: ${result.error?.message ?? 'Unknown error'}`,
      );
    }

    const status = await getTransactionStatus(this.client.server, result.txHash);
    const decision = shouldRetrySubmission(status);

    if (!decision.shouldRetry) {
      if (status.status === 'SUCCESS') {
        // Timed out client-side, but the write genuinely landed -- report
        // it rather than resubmitting a duplicate against real capital.
        return { txHash: result.txHash, ledger: status.ledger };
      }
      throw new TransactionError(
        `${label} failed on-chain: ${result.error?.message ?? 'Transaction failed'}`,
        result.txHash,
      );
    }

    // Genuinely never landed -- safe to resubmit exactly once. submitTransaction
    // rebuilds the transaction (fresh account sequence number) internally.
    const retryResult = await this.client.submitTransaction([op]);
    if (!retryResult.success) {
      throw new TransactionError(
        `${label} failed after retry: ${retryResult.error?.message ?? 'Unknown error'}`,
        retryResult.txHash,
      );
    }

    return { txHash: retryResult.txHash!, ledger: retryResult.data!.ledger };
  }
}
