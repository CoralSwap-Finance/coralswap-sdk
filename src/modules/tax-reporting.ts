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
    return response.events as RawEvent[];
  }
}

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

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
    } catch { /* skip */ }
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
    if (typeof val._value?.toString === "function") return val._value.toString();
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readI128(map: Map<string, any>, key: string): bigint | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.i128 === "function") {
      const parts = val.i128();
      return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
    }
  } catch { /* skip */ }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readU32(map: Map<string, any>, key: string): number | undefined {
  const val = map.get(key);
  if (!val) return undefined;
  try {
    if (typeof val.u32 === "function") return val.u32();
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
