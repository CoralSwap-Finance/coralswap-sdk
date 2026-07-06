import { CoralSwapClient } from "@/client";
import { fromSorobanAmount } from "@/utils/amounts";
import { validateAddress } from "@/utils/validation";
import { SorobanRpc } from "@stellar/stellar-sdk";

/**
 * Options for exporting trade history.
 */
export interface ExportOptions {
  /** Output format: 'csv' (default) or 'json' */
  format?: "csv" | "json";
  /** Filter events from this date (inclusive) */
  fromDate?: Date;
  /** Filter events up to this date (inclusive) */
  toDate?: Date;
  /** IANA timezone string for date formatting (e.g. 'America/New_York'). Defaults to UTC. */
  timezone?: string;
}

/**
 * A single row in the tax report.
 */
export interface TaxReportRow {
  date: string;
  type: "swap" | "add_liquidity" | "remove_liquidity";
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  fee: string;
  usdValue: string;
  txHash: string;
}

/**
 * Cost basis for a token position using FIFO or LIFO accounting.
 */
export interface CostBasis {
  token: string;
  totalQuantity: string;
  totalCost: string;
  averageCost: string;
  method: "FIFO" | "LIFO";
  disposals: CostBasisDisposal[];
}

/**
 * A single disposal event with calculated gain/loss.
 */
export interface CostBasisDisposal {
  date: string;
  quantity: string;
  costBasis: string;
  salePrice: string;
  gain: string;
  loss: string;
  txHash: string;
}

/**
 * Capital gains calculation result.
 */
export interface CapitalGains {
  period: { start: string; end: string };
  shortTermGains: string;
  shortTermLosses: string;
  longTermGains: string;
  longTermLosses: string;
  totalGain: string;
  totalLoss: string;
  netGain: string;
}

/**
 * Options for cost basis calculations.
 */
export interface CostBasisOptions extends ExportOptions {
  method?: "FIFO" | "LIFO";
}

const CSV_HEADERS = [
  "Date",
  "Type",
  "Token In",
  "Amount In",
  "Token Out",
  "Amount Out",
  "Fee",
  "USD Value",
  "Tx Hash",
];

const TOKEN_DECIMALS = 7;

/** Default ledger history window when no date range is provided. */
const DEFAULT_HISTORY_WINDOW = 17280; // ~1 day of ledgers

/**
 * Tax reporting module for CoralSwap.
 *
 * Exports swap and liquidity events as CSV or JSON for use with
 * CoinTracker, Koinly, TokenTax and similar tax tools.
 *
 * All amounts are in human-readable format (not raw stroops).
 * USD values are approximated at 0 when no price feed is available
 * (on-chain USD prices are not natively available on Soroban).
 *
 * @example
 * const tax = new TaxReportingModule(client);
 * const csv = await tax.exportTradeHistory('G...', { format: 'csv', fromDate: new Date('2024-01-01') });
 */
export class TaxReportingModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Export full trade history (swaps + liquidity events) for an address.
   *
   * @param address - Stellar account address (G...) or contract address (C...)
   * @param options - Export format and date range options
   * @returns CSV string or JSON string depending on `options.format`
   */
  async exportTradeHistory(
    address: string,
    options: ExportOptions = {},
  ): Promise<string> {
    validateAddress(address, "address");

    const { format = "csv", fromDate, toDate, timezone = "UTC" } = options;

    const currentLedger = await this.client.getCurrentLedger();
    const startLedger = Math.max(0, currentLedger - DEFAULT_HISTORY_WINDOW);

    const [swapEvents, liquidityEvents] = await Promise.all([
      this.fetchSwapEvents(address, startLedger),
      this.fetchLiquidityEvents(address, startLedger),
    ]);

    const rows: TaxReportRow[] = [
      ...swapEvents,
      ...liquidityEvents,
    ].sort((a, b) => a.date.localeCompare(b.date));

    const filtered = rows.filter((row) => {
      const d = new Date(row.date);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });

    // Re-format dates using requested timezone
    const formatted = filtered.map((row) => ({
      ...row,
      date: formatDate(new Date(row.date), timezone),
    }));

    return format === "json"
      ? JSON.stringify(formatted, null, 2)
      : toCSV(formatted);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchSwapEvents(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const response = await this.fetchEvents(startLedger, ["swap"]);
    const rows: TaxReportRow[] = [];

    for (const ev of response) {
      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const sender = readAddress(data, "sender");
      if (sender && sender !== address) continue;

      const amountIn = readI128(data, "amount_in") ?? 0n;
      const amountOut = readI128(data, "amount_out") ?? 0n;
      const feeBps = readU32(data, "fee_bps") ?? 0;
      const feeAmount = (amountIn * BigInt(feeBps)) / 10000n;

      rows.push({
        date: new Date(ev.ledgerClosedAt ?? 0).toISOString(),
        type: "swap",
        tokenIn: readAddress(data, "token_in") ?? "",
        amountIn: fromSorobanAmount(amountIn, TOKEN_DECIMALS),
        tokenOut: readAddress(data, "token_out") ?? "",
        amountOut: fromSorobanAmount(amountOut, TOKEN_DECIMALS),
        fee: fromSorobanAmount(feeAmount, TOKEN_DECIMALS),
        usdValue: "0.00",
        txHash: ev.txHash ?? "",
      });
    }

    return rows;
  }

  private async fetchLiquidityEvents(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const [addEvents, removeEvents] = await Promise.all([
      this.fetchEvents(startLedger, ["add_liquidity"]),
      this.fetchEvents(startLedger, ["remove_liquidity"]),
    ]);

    const rows: TaxReportRow[] = [];

    for (const ev of [...addEvents, ...removeEvents]) {
      const isAdd = (ev.topic?.[0] ?? "") === "add_liquidity";
      const data = decodeMapEvent(ev.value);
      if (!data) continue;

      const provider = readAddress(data, "provider");
      if (provider && provider !== address) continue;

      const amountA = readI128(data, "amount_a") ?? 0n;
      const amountB = readI128(data, "amount_b") ?? 0n;
      const tokenA = readAddress(data, "token_a") ?? "";
      const tokenB = readAddress(data, "token_b") ?? "";

      rows.push({
        date: new Date(ev.ledgerClosedAt ?? 0).toISOString(),
        type: isAdd ? "add_liquidity" : "remove_liquidity",
        tokenIn: tokenA,
        amountIn: fromSorobanAmount(amountA, TOKEN_DECIMALS),
        tokenOut: tokenB,
        amountOut: fromSorobanAmount(amountB, TOKEN_DECIMALS),
        fee: "0.0000000",
        usdValue: "0.00",
        txHash: ev.txHash ?? "",
      });
    }

    return rows;
  }

  /**
   * Calculate cost basis for a token using FIFO or LIFO accounting method.
   *
   * @param address - Stellar account address
   * @param token - Token address to calculate cost basis for
   * @param options - Cost basis options including method (FIFO or LIFO) and date range
   * @returns Cost basis with all disposals and gains/losses
   */
  async getCostBasis(
    address: string,
    token: string,
    options: CostBasisOptions = {},
  ): Promise<CostBasis> {
    validateAddress(address, "address");
    validateAddress(token, "token");

    const { method = "FIFO", fromDate, toDate, timezone = "UTC" } = options;

    const history = await this.exportTradeHistory(address, {
      format: "json",
      fromDate,
      toDate,
      timezone,
    });

    const rows = JSON.parse(history) as TaxReportRow[];
    const purchases: Array<{
      date: string;
      quantity: bigint;
      costPerUnit: string;
      txHash: string;
    }> = [];
    const disposals: CostBasisDisposal[] = [];

    let totalQuantity = 0n;
    let totalCost = 0n;

    for (const row of rows) {
      if (row.type === "swap" && row.tokenOut === token) {
        const amount = BigInt(Math.floor(parseFloat(row.amountOut) * 10_000_000));
        const costPerUnit = (
          (BigInt(Math.floor(parseFloat(row.amountIn) * 10_000_000)) +
            BigInt(Math.floor(parseFloat(row.fee) * 10_000_000))) /
          amount
        ).toString();
        purchases.push({
          date: row.date,
          quantity: amount,
          costPerUnit,
          txHash: row.txHash,
        });
        totalQuantity += amount;
        totalCost +=
          BigInt(Math.floor(parseFloat(row.amountIn) * 10_000_000)) +
          BigInt(Math.floor(parseFloat(row.fee) * 10_000_000));
      } else if (row.type === "swap" && row.tokenIn === token) {
        const disposalQty = BigInt(
          Math.floor(parseFloat(row.amountIn) * 10_000_000)
        );
        const salePrice = (
          BigInt(Math.floor(parseFloat(row.amountOut) * 10_000_000)) /
          disposalQty
        ).toString();

        const orderedPurchases = method === "FIFO" ? purchases : [...purchases].reverse();
        let remainingDisposal = disposalQty;
        let disposalCostBasis = 0n;

        for (let i = 0; i < orderedPurchases.length && remainingDisposal > 0n; i++) {
          const purchase = orderedPurchases[i];
          const quantity = remainingDisposal > purchase.quantity ? purchase.quantity : remainingDisposal;
          disposalCostBasis += quantity * BigInt(Math.floor(parseFloat(purchase.costPerUnit)));
          remainingDisposal -= quantity;

          if (method === "FIFO") {
            purchases.shift();
          } else {
            purchases.pop();
          }
        }

        const costBasisStr = fromSorobanAmount(disposalCostBasis, TOKEN_DECIMALS);
        const salePriceStr = fromSorobanAmount(
          BigInt(Math.floor(parseFloat(row.amountOut) * 10_000_000)),
          TOKEN_DECIMALS
        );
        const gain =
          BigInt(Math.floor(parseFloat(salePriceStr) * 10_000_000)) -
          disposalCostBasis;

        disposals.push({
          date: row.date,
          quantity: fromSorobanAmount(disposalQty, TOKEN_DECIMALS),
          costBasis: costBasisStr,
          salePrice: salePriceStr,
          gain: gain > 0n ? fromSorobanAmount(gain, TOKEN_DECIMALS) : "0.0000000",
          loss: gain < 0n ? fromSorobanAmount(-gain, TOKEN_DECIMALS) : "0.0000000",
          txHash: row.txHash,
        });

        totalQuantity -= disposalQty;
      }
    }

    return {
      token,
      totalQuantity: fromSorobanAmount(totalQuantity, TOKEN_DECIMALS),
      totalCost: fromSorobanAmount(totalCost, TOKEN_DECIMALS),
      averageCost:
        totalQuantity > 0n
          ? fromSorobanAmount(totalCost / totalQuantity, TOKEN_DECIMALS)
          : "0.0000000",
      method,
      disposals,
    };
  }

  /**
   * Calculate capital gains/losses for a tax year.
   *
   * @param address - Stellar account address
   * @param taxYear - Tax year (e.g., 2024) or date range via options
   * @param options - Options including date range and timezone
   * @returns Capital gains categorized by short-term and long-term
   */
  async getCapitalGains(
    address: string,
    taxYear: number,
    options: ExportOptions = {},
  ): Promise<CapitalGains> {
    validateAddress(address, "address");

    const startDate =
      options.fromDate || new Date(`${taxYear}-01-01T00:00:00Z`);
    const endDate = options.toDate || new Date(`${taxYear}-12-31T23:59:59Z`);

    const history = await this.exportTradeHistory(address, {
      format: "json",
      fromDate: startDate,
      toDate: endDate,
      timezone: options.timezone,
    });

    const rows = JSON.parse(history) as TaxReportRow[];
    const holdingPeriods = new Map<string, { date: string; quantity: bigint }[]>();

    let shortTermGains = 0n;
    let shortTermLosses = 0n;
    let longTermGains = 0n;
    let longTermLosses = 0n;

    for (const row of rows) {
      if (row.type === "swap") {
        if (!holdingPeriods.has(row.tokenOut)) {
          holdingPeriods.set(row.tokenOut, []);
        }
        holdingPeriods.get(row.tokenOut)!.push({
          date: row.date,
          quantity: BigInt(Math.floor(parseFloat(row.amountOut) * 10_000_000)),
        });

        if (holdingPeriods.has(row.tokenIn)) {
          const holdings = holdingPeriods.get(row.tokenIn)!;
          const disposalQty = BigInt(
            Math.floor(parseFloat(row.amountIn) * 10_000_000)
          );

          for (let i = 0; i < holdings.length; i++) {
            if (disposalQty <= 0n) break;
            const holding = holdings[i];
            const qty = disposalQty > holding.quantity ? holding.quantity : disposalQty;
            const holdingDate = new Date(holding.date);
            const disposalDate = new Date(row.date);
            const holdDays =
              (disposalDate.getTime() - holdingDate.getTime()) / (1000 * 60 * 60 * 24);
            const isLongTerm = holdDays > 365;

            const costBasis =
              qty * BigInt(Math.floor(parseFloat(row.amountOut) / parseFloat(row.amountIn) * 10_000_000));
            const gain = costBasis - costBasis;

            if (isLongTerm) {
              if (gain > 0n) longTermGains += gain;
              else longTermLosses += -gain;
            } else {
              if (gain > 0n) shortTermGains += gain;
              else shortTermLosses += -gain;
            }

            holding.quantity -= qty;
            if (holding.quantity <= 0n) {
              holdings.splice(i, 1);
              i--;
            }
          }
        }
      }
    }

    return {
      period: {
        start: startDate.toISOString().split("T")[0],
        end: endDate.toISOString().split("T")[0],
      },
      shortTermGains: fromSorobanAmount(shortTermGains, TOKEN_DECIMALS),
      shortTermLosses: fromSorobanAmount(shortTermLosses, TOKEN_DECIMALS),
      longTermGains: fromSorobanAmount(longTermGains, TOKEN_DECIMALS),
      longTermLosses: fromSorobanAmount(longTermLosses, TOKEN_DECIMALS),
      totalGain: fromSorobanAmount(shortTermGains + longTermGains, TOKEN_DECIMALS),
      totalLoss: fromSorobanAmount(shortTermLosses + longTermLosses, TOKEN_DECIMALS),
      netGain: fromSorobanAmount(
        shortTermGains + longTermGains - shortTermLosses - longTermLosses,
        TOKEN_DECIMALS
      ),
    };
  }

  private async fetchEvents(
    startLedger: number,
    topics: string[],
  ): Promise<RawEvent[]> {
    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger,
      filters: [{ type: "contract", contractIds: [], topics: [topics] }],
      limit: 200,
    };

    const response = await this.client.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) return [];
    return response.events as unknown as RawEvent[];
  }
}

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

interface RawEvent {
  value: unknown;
  topic?: string[];
  txHash?: string;
  ledgerClosedAt?: string | number;
  ledger?: number;
}

function decodeMapEvent(value: unknown): Map<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const valObj = value as Record<string, unknown>;
  const entries: unknown[] =
    typeof valObj.map === "function" ? (valObj.map as () => unknown[])() : (valObj._value as unknown[]);
  if (!Array.isArray(entries)) return null;

  const map = new Map<string, unknown>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const entryObj = entry as { key: unknown; val: unknown };
    const k = entryObj.key as Record<string, () => { toString(): string }>;
    let key: string | undefined;
    try {
      key = k.sym?.().toString() ?? k.str?.().toString();
    } catch { /* skip */ }
    if (key) map.set(key, entryObj.val);
  }
  return map;
}

function readAddress(map: Map<string, unknown>, key: string): string | undefined {
  const val = map.get(key);
  if (!val || typeof val !== "object") return undefined;
  const valObj = val as Record<string, unknown>;
  try {
    if (typeof valObj.address === "function") return (valObj.address as () => { toString(): string })().toString();
    if (typeof valObj._value?.toString === "function") return (valObj._value as { toString(): string }).toString();
  } catch { /* skip */ }
  return undefined;
}

function readI128(map: Map<string, unknown>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val || typeof val !== "object") return undefined;
  const valObj = val as Record<string, unknown>;
  try {
    if (typeof valObj.i128 === "function") {
      const parts = (valObj.i128 as () => { hi(): { toString(): string }; lo(): { toString(): string } })();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch { /* skip */ }
  return undefined;
}

function readU32(map: Map<string, unknown>, key: string): number | undefined {
  const val = map.get(key);
  if (!val || typeof val !== "object") return undefined;
  const valObj = val as Record<string, unknown>;
  try {
    if (typeof valObj.u32 === "function") return (valObj.u32 as () => number)();
  } catch { /* skip */ }
  return undefined;
}

function formatDate(date: Date, timezone: string): string {
  try {
    return date.toLocaleString("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return date.toISOString();
  }
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCSV(rows: TaxReportRow[]): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.type,
        row.tokenIn,
        row.amountIn,
        row.tokenOut,
        row.amountOut,
        row.fee,
        row.usdValue,
        row.txHash,
      ]
        .map(escapeCSV)
        .join(","),
    );
  }
  return lines.join("\n");
}
