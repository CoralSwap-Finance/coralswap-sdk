import { CoralSwapClient } from "@/client";
import { fromSorobanAmount } from "@/utils/amounts";
import { validateAddress } from "@/utils/validation";
import { EventCursor } from "@/utils/event-cursor";
import { SwapEvent, LiquidityEvent } from "@/types/events";

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
 * Event fetching is delegated to {@link EventCursor}, which encapsulates all
 * `getEvents` request building and raw ScVal decoding — including the correct
 * i128 unsigned-lo-word masking that prevents silent sign-extension bugs.
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

    const [swapRows, liquidityRows] = await Promise.all([
      this.fetchSwapRows(address, startLedger),
      this.fetchLiquidityRows(address, startLedger),
    ]);

    const rows: TaxReportRow[] = [...swapRows, ...liquidityRows].sort((a, b) =>
      a.date.localeCompare(b.date),
    );

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
  // Private helpers — event fetching via EventCursor
  // ---------------------------------------------------------------------------

  private async fetchSwapRows(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const cursor = new EventCursor(this.client.server, {
      startLedger,
      topics: [["swap"]],
    });

    const events = await cursor.fetchAll();
    const rows: TaxReportRow[] = [];

    for (const ev of events) {
      if (ev.type !== "swap") continue;
      const swap = ev as SwapEvent;

      // Apply per-address filter
      if (swap.sender && swap.sender !== address) continue;

      const feeAmount = (swap.amountIn * BigInt(swap.feeBps)) / 10000n;

      rows.push({
        date: ledgerClosedAtToIso(swap.timestamp),
        type: "swap",
        tokenIn: swap.tokenIn,
        amountIn: fromSorobanAmount(swap.amountIn, TOKEN_DECIMALS),
        tokenOut: swap.tokenOut,
        amountOut: fromSorobanAmount(swap.amountOut, TOKEN_DECIMALS),
        fee: fromSorobanAmount(feeAmount, TOKEN_DECIMALS),
        usdValue: "0.00",
        txHash: swap.txHash,
      });
    }

    return rows;
  }

  private async fetchLiquidityRows(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const cursor = new EventCursor(this.client.server, {
      startLedger,
      topics: [["add_liquidity"], ["remove_liquidity"]],
    });

    const events = await cursor.fetchAll();
    const rows: TaxReportRow[] = [];

    for (const ev of events) {
      if (ev.type !== "add_liquidity" && ev.type !== "remove_liquidity")
        continue;
      const liq = ev as LiquidityEvent;

      // Apply per-address filter
      if (liq.provider && liq.provider !== address) continue;

      rows.push({
        date: ledgerClosedAtToIso(liq.timestamp),
        type: liq.type,
        tokenIn: liq.tokenA,
        amountIn: fromSorobanAmount(liq.amountA, TOKEN_DECIMALS),
        tokenOut: liq.tokenB,
        amountOut: fromSorobanAmount(liq.amountB, TOKEN_DECIMALS),
        fee: "0.0000000",
        usdValue: "0.00",
        txHash: liq.txHash,
      });
    }

    return rows;
  }
}

// ---------------------------------------------------------------------------
// Module-private utilities
// ---------------------------------------------------------------------------

/**
 * Convert a Unix timestamp (seconds) to an ISO-8601 date string.
 * The EventCursor stores `timestamp` as seconds since epoch.
 */
function ledgerClosedAtToIso(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString();
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
