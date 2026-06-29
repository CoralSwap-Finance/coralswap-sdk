import { SorobanRpc } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import { PortfolioPnL, PositionPnL } from "@/types/positions";
import { validateAddress } from "@/utils/validation";
import { PositionsModule } from "./positions";

/**
 * Default ledger lookback window (~7 days at ~5 s/ledger).
 * Callers can override via GetPortfolioPnLOptions.startLedger.
 */
const DEFAULT_LOOKBACK_LEDGERS = 120_960;

/**
 * Options for getPortfolioPnL.
 */
export interface GetPortfolioPnLOptions {
  /**
   * Token address → current USD price (as a plain number).
   * If omitted or a token is missing, its contribution to USD values is 0.
   * Derive these from a price oracle (e.g. RedStone) before calling.
   */
  tokenPricesUSD?: Record<string, number>;
  /**
   * Specific pair addresses to analyse.
   * Defaults to all pairs returned by the factory.
   */
  pairAddresses?: string[];
  /**
   * Ledger sequence number to start fetching events from.
   * Defaults to (currentLedger - DEFAULT_LOOKBACK_LEDGERS).
   */
  startLedger?: number;
}

/**
 * Portfolio PnL module — computes LP position profitability from on-chain
 * add/remove-liquidity events and current pool state.
 *
 * USD amounts require caller-supplied token prices (tokenPricesUSD option).
 * Without prices every USD field is 0, but netPnLUSD still reflects whether
 * the position grew or shrank relative to its cost basis.
 *
 * @example
 * ```ts
 * const portfolio = new PortfolioModule(client);
 * const result = await portfolio.getPortfolioPnL('G...wallet', {
 *   tokenPricesUSD: { 'CUSDC...': 1.0, 'CXLM...': 0.12 },
 * });
 * console.log(`Total P&L: $${result.totalPnLUSD.toFixed(2)}`);
 * ```
 */
export class PortfolioModule {
  private client: CoralSwapClient;
  private positions: PositionsModule;

  constructor(client: CoralSwapClient) {
    this.client = client;
    this.positions = new PositionsModule(client);
  }

  /**
   * Compute PnL for all active LP positions held by `address`.
   *
   * Positions with a zero LP balance are skipped (brand-new / never-added
   * addresses naturally return `{ totalPnLUSD: 0, byPosition: [] }`).
   *
   * @param address - Stellar account or contract address to analyse
   * @param options - Price map, pair filter, event window
   * @returns Aggregate and per-position PnL
   */
  async getPortfolioPnL(
    address: string,
    options: GetPortfolioPnLOptions = {},
  ): Promise<PortfolioPnL> {
    validateAddress(address, "address");

    const { tokenPricesUSD = {}, pairAddresses } = options;

    const pairs =
      pairAddresses && pairAddresses.length > 0
        ? pairAddresses
        : await this.client.factory.getAllPairs();

    if (pairs.length === 0) {
      return { totalPnLUSD: 0, totalPnLPercent: 0, byPosition: [] };
    }

    // Find pairs where the address currently holds LP tokens
    const positionResults = await Promise.allSettled(
      pairs.map((addr) => this.positions.getPosition(addr, address)),
    );

    const activePairs: string[] = [];
    for (let i = 0; i < positionResults.length; i++) {
      const result = positionResults[i];
      if (result.status === "fulfilled" && result.value.balance > 0n) {
        activePairs.push(pairs[i]);
      }
    }

    if (activePairs.length === 0) {
      return { totalPnLUSD: 0, totalPnLPercent: 0, byPosition: [] };
    }

    const startLedger =
      options.startLedger ?? (await this.resolveStartLedger());

    const pnlResults = await Promise.allSettled(
      activePairs.map((pairAddr) =>
        this.computePositionPnL(pairAddr, address, tokenPricesUSD, startLedger),
      ),
    );

    const byPosition: PositionPnL[] = [];
    for (const result of pnlResults) {
      if (result.status === "fulfilled") {
        byPosition.push(result.value);
      }
    }

    const totalEntryUSD = byPosition.reduce((s, p) => s + p.entryValueUSD, 0);
    const totalPnLUSD = byPosition.reduce((s, p) => s + p.netPnLUSD, 0);
    const totalPnLPercent =
      totalEntryUSD > 0 ? (totalPnLUSD / totalEntryUSD) * 100 : 0;

    return { totalPnLUSD, totalPnLPercent, byPosition };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveStartLedger(): Promise<number> {
    const current = await this.client.getCurrentLedger();
    return Math.max(0, current - DEFAULT_LOOKBACK_LEDGERS);
  }

  private async computePositionPnL(
    pairAddress: string,
    owner: string,
    tokenPricesUSD: Record<string, number>,
    startLedger: number,
  ): Promise<PositionPnL> {
    const [position, addEvents, removeEvents] = await Promise.all([
      this.positions.getPosition(pairAddress, owner),
      this.fetchLiquidityEvents(pairAddress, "add_liquidity", startLedger),
      this.fetchLiquidityEvents(pairAddress, "remove_liquidity", startLedger),
    ]);

    // Aggregate deposited and withdrawn token amounts for this address
    let grossDepositA = 0n;
    let grossDepositB = 0n;
    let grossWithdrawA = 0n;
    let grossWithdrawB = 0n;

    for (const ev of addEvents.filter((e) => e.provider === owner)) {
      grossDepositA += ev.amountA;
      grossDepositB += ev.amountB;
    }

    for (const ev of removeEvents.filter((e) => e.provider === owner)) {
      grossWithdrawA += ev.amountA;
      grossWithdrawB += ev.amountB;
    }

    // Net amounts still notionally "in" the pool from this LP's perspective.
    // Guards against underflow if withdrawals exceed visible deposits
    // (e.g. history older than startLedger).
    const netAmountA =
      grossDepositA > grossWithdrawA ? grossDepositA - grossWithdrawA : 0n;
    const netAmountB =
      grossDepositB > grossWithdrawB ? grossDepositB - grossWithdrawB : 0n;

    const priceA = tokenPricesUSD[position.token0] ?? 0;
    const priceB = tokenPricesUSD[position.token1] ?? 0;

    const DECIMALS = 1e7; // Soroban standard: 7 decimal places

    // Cost basis: net deposited amounts valued at current prices.
    // This equals the HODL value (what you'd have if you simply held),
    // so netPnL captures the structural LP effect (fees vs IL).
    const entryValueUSD =
      (Number(netAmountA) / DECIMALS) * priceA +
      (Number(netAmountB) / DECIMALS) * priceB;

    // Current LP position value
    const currentValueUSD =
      position.totalSupply > 0n
        ? (Number(position.balance) / Number(position.totalSupply)) *
          ((Number(position.reserve0) / DECIMALS) * priceA +
            (Number(position.reserve1) / DECIMALS) * priceB)
        : 0;

    // IL: LP underperformed vs cost basis — always >= 0
    const ilUSD = Math.max(0, entryValueUSD - currentValueUSD);

    // Fees: LP outperformed cost basis — always >= 0
    // Exactly one of (ilUSD, feeEarnedUSD) is non-zero.
    const feeEarnedUSD = Math.max(0, currentValueUSD - entryValueUSD);

    // netPnLUSD === feeEarnedUSD - ilUSD === currentValueUSD - entryValueUSD
    const netPnLUSD = currentValueUSD - entryValueUSD;

    return {
      pairAddress,
      entryValueUSD,
      currentValueUSD,
      feeEarnedUSD,
      ilUSD,
      netPnLUSD,
    };
  }

  private async fetchLiquidityEvents(
    pairAddress: string,
    type: "add_liquidity" | "remove_liquidity",
    startLedger: number,
  ): Promise<ParsedLiquidityEvent[]> {
    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [pairAddress],
          topics: [[type]],
        },
      ],
      limit: 200,
    };

    let response: SorobanRpc.Api.GetEventsResponse;
    try {
      response = await this.client.server.getEvents(request);
    } catch {
      return [];
    }

    if (!response || !Array.isArray(response.events)) return [];

    const results: ParsedLiquidityEvent[] = [];
    for (const ev of response.events as unknown as RawEvent[]) {
      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const provider = readAddress(data, "provider");
      if (!provider) continue;

      results.push({
        provider,
        amountA: readI128(data, "amount_a") ?? 0n,
        amountB: readI128(data, "amount_b") ?? 0n,
        liquidity: readI128(data, "liquidity") ?? 0n,
      });
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Internal raw-event decode helpers (mirrors TaxReportingModule pattern)
// ---------------------------------------------------------------------------

interface ParsedLiquidityEvent {
  provider: string;
  amountA: bigint;
  amountB: bigint;
  liquidity: bigint;
}

interface RawEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  topic?: string[];
  txHash?: string;
  ledgerClosedAt?: string | number;
  ledger?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeMapEvent(value: any): Map<string, any> | null {
  const entries: unknown[] =
    typeof value?.map === "function" ? value.map() : value?._value;
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries as Array<{ key: unknown; val: unknown }>) {
    const k = entry.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch {
      /* skip malformed entry */
    }
    if (key) map.set(key, entry.val);
  }
  return map as Map<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAddress(map: Map<string, any>, key: string): string | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.address === "function") return val.address().toString();
    if (typeof val._value?.toString === "function")
      return val._value.toString();
  } catch {
    /* skip */
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readI128(map: Map<string, any>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.i128 === "function") {
      const parts = val.i128();
      return (
        (BigInt(parts.hi().toString()) << 64n) +
        BigInt(parts.lo().toString())
      );
    }
  } catch {
    /* skip */
  }
  return undefined;
}
