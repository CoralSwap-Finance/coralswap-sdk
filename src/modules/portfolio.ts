/**
 * API reference for portfolio analytics, LP valuation, and PnL reporting.
 *
 * The portfolio module reports current position value from on-chain LP balances
 * and caller-supplied prices. Historical PnL requires caller-supplied cost
 * basis because CoralSwap pool contracts do not store each wallet's deposit
 * timestamps, entry prices, or external fee-claim history.
 *
 * Core metrics:
 *
 * - Cost basis: USD value of the originally deposited token amounts at entry prices.
 * - Unrealized PnL: current LP value minus cost basis, excluding fees.
 * - Total PnL: unrealized PnL plus caller-supplied fee income.
 * - Hold value: current USD value of the original deposited tokens outside the pool.
 * - Impermanent loss: current LP value minus hold value.
 *
 * @module Portfolio
 */
import { CoralSwapClient } from "@/client";
import { ValidationError } from "@/errors";
import { EnrichedLPPosition } from "@/types/positions";
import {
  GetPortfolioOptions,
  ImpermanentLossInput,
  ImpermanentLossResult,
  PortfolioCostBasis,
  PortfolioPnL,
  PortfolioPosition,
  PortfolioSummary,
  PortfolioValuationOptions,
} from "@/types/portfolio";
import { validateAddress } from "@/utils/validation";
import { PositionsModule } from "./positions";

const DEFAULT_TOKEN_DECIMALS = 7;

/**
 * Portfolio module for LP valuation and profit-and-loss reporting.
 *
 * This module combines on-chain LP balances from {@link PositionsModule} with
 * caller-supplied market prices and cost-basis data. CoralSwap does not infer
 * historical entry prices on chain, so PnL calculations require the caller to
 * provide the original deposited amounts and entry prices.
 *
 * Financial metrics use these formulas:
 *
 * - `currentValueUsd = currentToken0Amount * token0PriceUsd + currentToken1Amount * token1PriceUsd`
 * - `costBasisUsd = entryToken0Amount * entryToken0PriceUsd + entryToken1Amount * entryToken1PriceUsd`
 * - `holdValueUsd = entryToken0Amount * currentToken0PriceUsd + entryToken1Amount * currentToken1PriceUsd`
 * - `unrealizedPnlUsd = currentValueUsd - costBasisUsd`
 * - `totalPnlUsd = unrealizedPnlUsd + feesEarnedUsd`
 * - `impermanentLossUsd = currentValueUsd - holdValueUsd`
 * - `impermanentLossBps = impermanentLossUsd / holdValueUsd * 10000`
 *
 * Basis-point returns use `10000` as 100%. A positive PnL means the LP value is
 * above cost basis; a negative impermanent-loss value means the LP underperformed
 * simply holding the originally deposited tokens.
 *
 * @example
 * ```ts
 * import { CoralSwapClient, Network, PortfolioModule } from "@coralswap/sdk";
 *
 * const client = new CoralSwapClient({ network: Network.TESTNET, publicKey: "G..." });
 * const portfolio = new PortfolioModule(client);
 *
 * const position = await portfolio.getPosition("C...pair", "G...owner", {
 *   token0PriceUsd: 0.12,
 *   token1PriceUsd: 1.00,
 * });
 *
 * console.log(position.currentValueUsd);
 * ```
 */
export class PortfolioModule {
  private readonly positions: PositionsModule;

  /**
   * Create a portfolio module bound to a CoralSwap client.
   *
   * @param client - SDK client used to read pair, LP token, and factory state.
   * @returns A new PortfolioModule instance.
   * @throws Never throws during construction.
   * @example
   * ```ts
   * const portfolio = new PortfolioModule(client);
   * ```
   */
  constructor(client: CoralSwapClient) {
    this.positions = new PositionsModule(client);
  }

  /**
   * Read and value one LP position at current market prices.
   *
   * Formula:
   *
   * `currentValueUsd = token0AmountDecimal * token0PriceUsd + token1AmountDecimal * token1PriceUsd`
   *
   * Raw token amounts are converted with the provided decimals before valuation.
   * If decimals are omitted, Stellar-style 7 decimal places are used.
   *
   * @param pairAddress - Pair contract address to query.
   * @param owner - Wallet address that holds the LP tokens.
   * @param valuation - Current USD prices and optional token decimal metadata.
   * @returns The enriched LP position with current USD valuation fields.
   * @throws {ValidationError} If addresses, prices, or decimal values are invalid.
   * @throws If the underlying pair or LP token RPC calls fail.
   * @example
   * ```ts
   * const position = await portfolio.getPosition("C...pair", "G...owner", {
   *   token0PriceUsd: 0.12,
   *   token1PriceUsd: 1,
   *   token0Decimals: 7,
   *   token1Decimals: 7,
   * });
   *
   * console.log(position.currentValueUsd);
   * ```
   */
  async getPosition(
    pairAddress: string,
    owner: string,
    valuation: PortfolioValuationOptions,
  ): Promise<PortfolioPosition> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");
    this.validateValuation(valuation);

    const position = await this.positions.getPosition(pairAddress, owner);
    return this.valuePosition(position, valuation);
  }

  /**
   * Read and value LP positions across many pairs.
   *
   * The position filter behavior matches {@link PositionsModule.getPositions}:
   * when `pairAddresses` is omitted, all factory pairs are scanned; when
   * `includeEmpty` is false or omitted, zero-balance positions are filtered out.
   *
   * Aggregate formula:
   *
   * `totalValueUsd = sum(position.currentValueUsd)`
   *
   * @param owner - Wallet address that holds the LP tokens.
   * @param options - Position filters plus current USD prices and optional token decimals.
   * @returns A portfolio summary with valued positions and aggregate USD value.
   * @throws {ValidationError} If the owner, prices, or decimal values are invalid.
   * @throws If factory, pair, or LP token RPC calls fail.
   * @example
   * ```ts
   * const summary = await portfolio.getPositions("G...owner", {
   *   token0PriceUsd: 0.12,
   *   token1PriceUsd: 1,
   *   pairAddresses: ["C...pair"],
   * });
   *
   * console.log(summary.totalValueUsd);
   * ```
   */
  async getPositions(
    owner: string,
    options: GetPortfolioOptions,
  ): Promise<PortfolioSummary> {
    validateAddress(owner, "owner");
    this.validateValuation(options);

    const summary = await this.positions.getPositions(owner, {
      includeEmpty: options.includeEmpty,
      pairAddresses: options.pairAddresses,
    });

    const positions = summary.positions.map((position) =>
      this.valuePosition(position, options),
    );

    return {
      owner,
      totalPools: positions.length,
      positions,
      totalValueUsd: positions.reduce(
        (total, position) => total + position.currentValueUsd,
        0,
      ),
    };
  }

  /**
   * Calculate PnL for a valued LP position against historical cost basis.
   *
   * PnL methodology:
   *
   * - Cost basis is the USD value of the original token amounts at entry prices.
   * - Unrealized PnL compares the current LP value to that cost basis.
   * - Hold value is the current USD value of the original token amounts if they
   *   had remained outside the pool.
   * - Impermanent loss compares LP value to hold value. It can be positive when
   *   pool fee accrual or price movement leaves the LP ahead of the hold baseline.
   * - Total PnL adds caller-supplied fee income to unrealized PnL.
   *
   * Formulas:
   *
   * `costBasisUsd = entryToken0Amount * entryToken0PriceUsd + entryToken1Amount * entryToken1PriceUsd`
   *
   * `unrealizedPnlUsd = currentValueUsd - costBasisUsd`
   *
   * `holdValueUsd = entryToken0Amount * currentToken0PriceUsd + entryToken1Amount * currentToken1PriceUsd`
   *
   * `impermanentLossUsd = currentValueUsd - holdValueUsd`
   *
   * `totalPnlUsd = unrealizedPnlUsd + feesEarnedUsd`
   *
   * @param position - A valued portfolio position returned by {@link getPosition} or {@link getPositions}.
   * @param costBasis - Original deposited token amounts, entry prices, decimals, and optional fee income.
   * @returns PnL, return, and impermanent-loss metrics denominated in USD and basis points.
   * @throws {ValidationError} If cost-basis amounts, prices, decimals, or fees are invalid.
   * @example
   * ```ts
   * const pnl = portfolio.calculatePositionPnL(position, {
   *   token0Amount: 100_0000000n,
   *   token1Amount: 100_0000000n,
   *   token0PriceUsd: 0.10,
   *   token1PriceUsd: 1,
   *   feesEarnedUsd: 3.25,
   * });
   *
   * console.log(pnl.totalPnlUsd, pnl.impermanentLossBps);
   * ```
   */
  calculatePositionPnL(
    position: PortfolioPosition,
    costBasis: PortfolioCostBasis,
  ): PortfolioPnL {
    this.validateCostBasis(costBasis);

    const entryToken0Amount = this.toDecimalAmount(
      costBasis.token0Amount,
      costBasis.token0Decimals,
    );
    const entryToken1Amount = this.toDecimalAmount(
      costBasis.token1Amount,
      costBasis.token1Decimals,
    );

    const feesEarnedUsd = costBasis.feesEarnedUsd ?? 0;
    const costBasisUsd =
      entryToken0Amount * costBasis.token0PriceUsd +
      entryToken1Amount * costBasis.token1PriceUsd;
    const holdValueUsd =
      entryToken0Amount * position.token0PriceUsd +
      entryToken1Amount * position.token1PriceUsd;
    const unrealizedPnlUsd = position.currentValueUsd - costBasisUsd;
    const totalPnlUsd = unrealizedPnlUsd + feesEarnedUsd;
    const impermanentLossUsd = position.currentValueUsd - holdValueUsd;

    return {
      currentValueUsd: position.currentValueUsd,
      costBasisUsd,
      holdValueUsd,
      unrealizedPnlUsd,
      feesEarnedUsd,
      totalPnlUsd,
      impermanentLossUsd,
      impermanentLossBps: this.toBps(impermanentLossUsd, holdValueUsd),
      unrealizedReturnBps: this.toBps(unrealizedPnlUsd, costBasisUsd),
      totalReturnBps: this.toBps(totalPnlUsd, costBasisUsd),
    };
  }

  /**
   * Estimate impermanent loss from relative price movement only.
   *
   * This pure calculation uses the standard balanced constant-product AMM
   * formula, independent of position size:
   *
   * `priceRatio = (token0CurrentPriceUsd / token1CurrentPriceUsd) / (token0EntryPriceUsd / token1EntryPriceUsd)`
   *
   * `impermanentLossRatio = (2 * sqrt(priceRatio)) / (1 + priceRatio) - 1`
   *
   * `impermanentLossBps = impermanentLossRatio * 10000`
   *
   * The result excludes fees and assumes the initial deposit matched the pool
   * ratio. Use {@link calculatePositionPnL} when you have actual current LP
   * amounts and cost basis.
   *
   * @param input - Entry and current USD prices for both pool assets.
   * @returns Relative price ratio and impermanent loss as a decimal ratio and basis points.
   * @throws {ValidationError} If any price is zero, negative, NaN, or infinite.
   * @example
   * ```ts
   * const il = portfolio.calculateImpermanentLoss({
   *   token0EntryPriceUsd: 1,
   *   token1EntryPriceUsd: 1,
   *   token0CurrentPriceUsd: 2,
   *   token1CurrentPriceUsd: 1,
   * });
   *
   * console.log(il.impermanentLossBps);
   * ```
   */
  calculateImpermanentLoss(input: ImpermanentLossInput): ImpermanentLossResult {
    this.validatePositiveFiniteNumber(input.token0EntryPriceUsd, "token0EntryPriceUsd");
    this.validatePositiveFiniteNumber(input.token1EntryPriceUsd, "token1EntryPriceUsd");
    this.validatePositiveFiniteNumber(input.token0CurrentPriceUsd, "token0CurrentPriceUsd");
    this.validatePositiveFiniteNumber(input.token1CurrentPriceUsd, "token1CurrentPriceUsd");

    const entryRelativePrice = input.token0EntryPriceUsd / input.token1EntryPriceUsd;
    const currentRelativePrice =
      input.token0CurrentPriceUsd / input.token1CurrentPriceUsd;
    const priceRatio = currentRelativePrice / entryRelativePrice;
    const impermanentLossRatio =
      (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;

    return {
      priceRatio,
      impermanentLossRatio,
      impermanentLossBps: impermanentLossRatio * 10000,
    };
  }

  /**
   * Check whether an address holds any LP tokens in a pair.
   *
   * This is a convenience pass-through to {@link PositionsModule.hasPosition}.
   * It does not calculate valuation or PnL.
   *
   * @param pairAddress - Pair contract address to query.
   * @param owner - Wallet address to check.
   * @returns `true` when the LP token balance is greater than zero.
   * @throws {ValidationError} If either address is invalid.
   * @throws If the pair or LP token RPC calls fail.
   * @example
   * ```ts
   * const hasLp = await portfolio.hasPosition("C...pair", "G...owner");
   * ```
   */
  async hasPosition(pairAddress: string, owner: string): Promise<boolean> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");
    return this.positions.hasPosition(pairAddress, owner);
  }

  private valuePosition(
    position: EnrichedLPPosition,
    valuation: PortfolioValuationOptions,
  ): PortfolioPosition {
    const token0AmountDecimal = this.toDecimalAmount(
      position.token0Amount,
      valuation.token0Decimals,
    );
    const token1AmountDecimal = this.toDecimalAmount(
      position.token1Amount,
      valuation.token1Decimals,
    );
    const token0ValueUsd = token0AmountDecimal * valuation.token0PriceUsd;
    const token1ValueUsd = token1AmountDecimal * valuation.token1PriceUsd;

    return {
      ...position,
      token0PriceUsd: valuation.token0PriceUsd,
      token1PriceUsd: valuation.token1PriceUsd,
      token0AmountDecimal,
      token1AmountDecimal,
      token0ValueUsd,
      token1ValueUsd,
      currentValueUsd: token0ValueUsd + token1ValueUsd,
    };
  }

  private validateValuation(valuation: PortfolioValuationOptions): void {
    this.validateNonNegativeFiniteNumber(valuation.token0PriceUsd, "token0PriceUsd");
    this.validateNonNegativeFiniteNumber(valuation.token1PriceUsd, "token1PriceUsd");
    this.validateDecimals(valuation.token0Decimals, "token0Decimals");
    this.validateDecimals(valuation.token1Decimals, "token1Decimals");
  }

  private validateCostBasis(costBasis: PortfolioCostBasis): void {
    if (costBasis.token0Amount < 0n) {
      throw new ValidationError("token0Amount must be non-negative", {
        token0Amount: costBasis.token0Amount.toString(),
      });
    }
    if (costBasis.token1Amount < 0n) {
      throw new ValidationError("token1Amount must be non-negative", {
        token1Amount: costBasis.token1Amount.toString(),
      });
    }

    this.validateNonNegativeFiniteNumber(costBasis.token0PriceUsd, "token0PriceUsd");
    this.validateNonNegativeFiniteNumber(costBasis.token1PriceUsd, "token1PriceUsd");
    this.validateDecimals(costBasis.token0Decimals, "token0Decimals");
    this.validateDecimals(costBasis.token1Decimals, "token1Decimals");

    if (costBasis.feesEarnedUsd !== undefined) {
      this.validateNonNegativeFiniteNumber(costBasis.feesEarnedUsd, "feesEarnedUsd");
    }
  }

  private validateNonNegativeFiniteNumber(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${name} must be a non-negative finite number`, {
        [name]: value,
      });
    }
  }

  private validatePositiveFiniteNumber(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError(`${name} must be a positive finite number`, {
        [name]: value,
      });
    }
  }

  private validateDecimals(value: number | undefined, name: string): void {
    if (value === undefined) return;
    if (!Number.isInteger(value) || value < 0 || value > 30) {
      throw new ValidationError(`${name} must be an integer between 0 and 30`, {
        [name]: value,
      });
    }
  }

  private toDecimalAmount(amount: bigint, decimals = DEFAULT_TOKEN_DECIMALS): number {
    return Number(amount) / 10 ** decimals;
  }

  private toBps(numerator: number, denominator: number): number {
    return denominator > 0 ? (numerator / denominator) * 10000 : 0;
  }
}
