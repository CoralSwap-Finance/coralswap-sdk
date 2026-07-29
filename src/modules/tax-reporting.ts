import { CoralSwapClient } from "@/client";
import { fromSorobanAmount } from "@/utils/amounts";
import { validateAddress } from "@/utils/validation";
import { EventCursor, fieldI128, fieldU32, fieldAddress } from "@/utils/event-cursor";

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
 * Event fetching and decoding is performed via the shared {@link EventCursor}
 * utility, which uses correctly-typed XDR accessors and avoids the ad-hoc
 * ScVal duck-typing that was present in earlier versions of this module.
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
      this.fetchSwapEvents(address, startLedger),
      this.fetchLiquidityEvents(address, startLedger),
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
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchSwapEvents(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const cursor = new EventCursor({
      server: this.client.server,
      startLedger,
      topics: ["swap"],
      contractIds: [],
      limit: 200,
    });

    const events = await cursor.fetch();
    const rows: TaxReportRow[] = [];

    for (const ev of events) {
      // Filter by sender address
      const senderVal = ev.fields.get("sender");
      if (!senderVal) continue;
      let sender: string;
      try {
        sender = fieldAddress(senderVal);
      } catch {
        continue;
      }
      if (sender !== address) continue;

      // Decode required fields
      const tokenInVal = ev.fields.get("token_in");
      const tokenOutVal = ev.fields.get("token_out");
      const amountInVal = ev.fields.get("amount_in");
      const amountOutVal = ev.fields.get("amount_out");
      const feeBpsVal = ev.fields.get("fee_bps");
      if (!tokenInVal || !tokenOutVal || !amountInVal || !amountOutVal) continue;

      let tokenIn: string;
      let tokenOut: string;
      let amountIn: bigint;
      let amountOut: bigint;
      let feeBps: number;
      try {
        tokenIn = fieldAddress(tokenInVal);
        tokenOut = fieldAddress(tokenOutVal);
        amountIn = fieldI128(amountInVal);
        amountOut = fieldI128(amountOutVal);
        feeBps = feeBpsVal ? fieldU32(feeBpsVal) : 0;
      } catch {
        continue;
      }

      const feeAmount = (amountIn * BigInt(feeBps)) / 10000n;

      rows.push({
        date: new Date(ev.timestamp * 1000).toISOString(),
        type: "swap",
        tokenIn,
        amountIn: fromSorobanAmount(amountIn, TOKEN_DECIMALS),
        tokenOut,
        amountOut: fromSorobanAmount(amountOut, TOKEN_DECIMALS),
        fee: fromSorobanAmount(feeAmount, TOKEN_DECIMALS),
        usdValue: "0.00",
        txHash: ev.txHash,
      });
    }

    return rows;
  }

  private async fetchLiquidityEvents(
    address: string,
    startLedger: number,
  ): Promise<TaxReportRow[]> {
    const [addCursor, removeCursor] = [
      new EventCursor({
        server: this.client.server,
        startLedger,
        topics: ["add_liquidity"],
        contractIds: [],
        limit: 200,
      }),
      new EventCursor({
        server: this.client.server,
        startLedger,
        topics: ["remove_liquidity"],
        contractIds: [],
        limit: 200,
      }),
    ];

    const [addEvents, removeEvents] = await Promise.all([
      addCursor.fetch(),
      removeCursor.fetch(),
    ]);

    const rows: TaxReportRow[] = [];

    for (const ev of [...addEvents, ...removeEvents]) {
      const isAdd = ev.topicName === "add_liquidity";

      // Filter by provider address
      const providerVal = ev.fields.get("provider");
      if (!providerVal) continue;
      let provider: string;
      try {
        provider = fieldAddress(providerVal);
      } catch {
        continue;
      }
      if (provider !== address) continue;

      // Decode required fields
      const tokenAVal = ev.fields.get("token_a");
      const tokenBVal = ev.fields.get("token_b");
      const amountAVal = ev.fields.get("amount_a");
      const amountBVal = ev.fields.get("amount_b");
      if (!tokenAVal || !tokenBVal || !amountAVal || !amountBVal) continue;

      let tokenA: string;
      let tokenB: string;
      let amountA: bigint;
      let amountB: bigint;
      try {
        tokenA = fieldAddress(tokenAVal);
        tokenB = fieldAddress(tokenBVal);
        amountA = fieldI128(amountAVal);
        amountB = fieldI128(amountBVal);
      } catch {
        continue;
      }

      rows.push({
        date: new Date(ev.timestamp * 1000).toISOString(),
        type: isAdd ? "add_liquidity" : "remove_liquidity",
        tokenIn: tokenA,
        amountIn: fromSorobanAmount(amountA, TOKEN_DECIMALS),
        tokenOut: tokenB,
        amountOut: fromSorobanAmount(amountB, TOKEN_DECIMALS),
        fee: "0.0000000",
        usdValue: "0.00",
        txHash: ev.txHash,
      });
    }

    return rows;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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
