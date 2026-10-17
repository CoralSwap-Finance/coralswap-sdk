import { SorobanRpc } from "@stellar/stellar-sdk";
import {
  CoralSwapEvent,
  SwapEvent,
  LiquidityEvent,
  FlashLoanContractEvent,
} from "@/types/events";
import { EVENT_TOPICS } from "./events";

// ---------------------------------------------------------------------------
// Raw event shape returned by SorobanRpc.Server.getEvents()
// ---------------------------------------------------------------------------

/**
 * Minimal representation of a raw event returned by
 * `SorobanRpc.Server.getEvents()`. The `value` field holds an already-decoded
 * ScVal object with accessor methods injected by the stellar-sdk.
 *
 * This is intentionally separate from `xdr.DiagnosticEvent`, which comes from
 * transaction result meta XDR. RPC event responses use a different wire format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawRpcEvent = SorobanRpc.Api.EventResponse & Record<string, any>;

// ---------------------------------------------------------------------------
// ScVal accessor helpers (typed, safe)
// ---------------------------------------------------------------------------

/**
 * Decode an i128 ScVal accessor object to a bigint.
 *
 * The stellar-sdk returns the high/low halves as signed i64 accessors.
 * The low half MUST be treated as unsigned (mask with 0xFFFFFFFFFFFFFFFFn)
 * to avoid sign-extension errors when bit 63 is set.
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeRpcI128(val: any): bigint {
  const parts = val.i128();
  const hi = BigInt(parts.hi().toString());
  // Mask lo to treat as unsigned 64-bit value, preventing sign-extension bugs.
  const lo = BigInt(parts.lo().toString()) & 0xFFFFFFFFFFFFFFFFn;
  return (hi << 64n) | lo;
}

/**
 * Decode an address ScVal accessor object to a string.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeRpcAddress(val: any): string {
  if (typeof val.address === "function") return val.address().toString();
  if (typeof val._value?.toString === "function") return val._value.toString();
  throw new Error("Cannot decode address ScVal");
}

/**
 * Decode a u32 ScVal accessor object to a number.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeRpcU32(val: any): number {
  return val.u32();
}

/**
 * Build a key-lookup helper from an ScMap returned by the RPC event value.
 *
 * The stellar-sdk decodes ScMap entries as objects with `.key` and `.val`
 * accessors. Keys are ScVal symbols or strings; we decode them to plain
 * JS strings for convenient lookup.
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMapLookup(entries: any[]): (key: string) => any {
  const map = new Map<string, unknown>();
  for (const entry of entries) {
    const k = entry.key;
    let keyStr: string | undefined;
    try {
      if (typeof k.sym === "function") keyStr = k.sym().toString();
      else if (typeof k.str === "function") keyStr = k.str().toString();
    } catch { /* skip malformed entries */ }
    if (keyStr !== undefined) map.set(keyStr, entry.val);
  }
  return (key: string) => map.get(key);
}

/**
 * Extract the ScMap entries from an RPC event value, calling `.map()` if it
 * is a function (the normal sdk accessor pattern) or falling back to `._value`
 * for pre-decoded objects used in tests.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractMapEntries(value: any): any[] | null {
  if (!value) return null;
  const entries: unknown =
    typeof value.map === "function" ? value.map() : value._value;
  if (!Array.isArray(entries)) return null;
  return entries;
}

// ---------------------------------------------------------------------------
// Per-event decoders
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeSwapEvent(rawEvent: RawRpcEvent): SwapEvent {
  const entries = extractMapEntries(rawEvent.value);
  if (!entries) throw new Error("Swap event value is not an ScMap");

  const get = buildMapLookup(entries);

  const senderVal = get("sender");
  const tokenInVal = get("token_in");
  const tokenOutVal = get("token_out");
  const amountInVal = get("amount_in");
  const amountOutVal = get("amount_out");
  const feeBpsVal = get("fee_bps");

  if (!senderVal || !tokenInVal || !tokenOutVal || !amountInVal || !amountOutVal || !feeBpsVal) {
    throw new Error("Swap event missing required fields");
  }

  const ledger: number = rawEvent.ledger ?? 0;
  const timestamp: number = rawEvent.ledgerClosedAt
    ? Math.floor(new Date(rawEvent.ledgerClosedAt as string).getTime() / 1000)
    : ledger;

  return {
    type: "swap",
    contractId: rawEvent.contractId ?? "",
    ledger,
    timestamp,
    txHash: rawEvent.txHash ?? "",
    sender: decodeRpcAddress(senderVal),
    tokenIn: decodeRpcAddress(tokenInVal),
    tokenOut: decodeRpcAddress(tokenOutVal),
    amountIn: decodeRpcI128(amountInVal),
    amountOut: decodeRpcI128(amountOutVal),
    feeBps: decodeRpcU32(feeBpsVal),
  };
}

function decodeLiquidityEvent(
  rawEvent: RawRpcEvent,
  type: "add_liquidity" | "remove_liquidity",
): LiquidityEvent {
  const entries = extractMapEntries(rawEvent.value);
  if (!entries) throw new Error("Liquidity event value is not an ScMap");

  const get = buildMapLookup(entries);

  const providerVal = get("provider");
  const tokenAVal = get("token_a");
  const tokenBVal = get("token_b");
  const amountAVal = get("amount_a");
  const amountBVal = get("amount_b");

  if (!providerVal || !tokenAVal || !tokenBVal || !amountAVal || !amountBVal) {
    throw new Error("Liquidity event missing required fields");
  }

  const ledger: number = rawEvent.ledger ?? 0;
  const timestamp: number = rawEvent.ledgerClosedAt
    ? Math.floor(new Date(rawEvent.ledgerClosedAt as string).getTime() / 1000)
    : ledger;

  // `liquidity` field is optional in some event shapes; default to 0n if absent.
  const liquidityVal = get("liquidity");

  return {
    type,
    contractId: rawEvent.contractId ?? "",
    ledger,
    timestamp,
    txHash: rawEvent.txHash ?? "",
    provider: decodeRpcAddress(providerVal),
    tokenA: decodeRpcAddress(tokenAVal),
    tokenB: decodeRpcAddress(tokenBVal),
    amountA: decodeRpcI128(amountAVal),
    amountB: decodeRpcI128(amountBVal),
    liquidity: liquidityVal ? decodeRpcI128(liquidityVal) : 0n,
  };
}

function decodeFlashLoanEvent(rawEvent: RawRpcEvent): FlashLoanContractEvent {
  const entries = extractMapEntries(rawEvent.value);
  if (!entries) throw new Error("FlashLoan event value is not an ScMap");

  const get = buildMapLookup(entries);

  const borrowerVal = get("borrower");
  const tokenVal = get("token");
  const amountVal = get("amount");
  const feeVal = get("fee");

  if (!borrowerVal || !tokenVal || !amountVal || !feeVal) {
    throw new Error("FlashLoan event missing required fields");
  }

  const ledger: number = rawEvent.ledger ?? 0;
  const timestamp: number = rawEvent.ledgerClosedAt
    ? Math.floor(new Date(rawEvent.ledgerClosedAt as string).getTime() / 1000)
    : ledger;

  return {
    type: "flash_loan",
    contractId: rawEvent.contractId ?? "",
    ledger,
    timestamp,
    txHash: rawEvent.txHash ?? "",
    borrower: decodeRpcAddress(borrowerVal),
    token: decodeRpcAddress(tokenVal),
    amount: decodeRpcI128(amountVal),
    fee: decodeRpcI128(feeVal),
  };
}

// ---------------------------------------------------------------------------
// EventCursor
// ---------------------------------------------------------------------------

/**
 * Options for creating an EventCursor.
 */
export interface EventCursorOptions {
  /**
   * Contract address(es) to scope the query to. Pass an empty array (the
   * default) to query events from all contracts.
   */
  contractIds?: string[];

  /**
   * Inclusive start ledger for the event query.
   * Passed directly as `startLedger` to `getEvents`.
   */
  startLedger: number;

  /**
   * Inclusive end ledger for client-side filtering.
   * Events with `ledger > endLedger` are discarded.
   * The Soroban RPC only accepts `startLedger`, not `endLedger`.
   */
  endLedger?: number;

  /**
   * Maximum number of raw events to request per page.
   * Defaults to 200.
   */
  limit?: number;

  /**
   * Event topic filter arrays, each inner array is OR-matched.
   * Each element should be a plain string symbol (e.g. "swap").
   *
   * @example
   * // Fetch only swap events
   * topics: [["swap"]]
   *
   * // Fetch swap OR add_liquidity events
   * topics: [["swap"], ["add_liquidity"]]
   */
  topics: string[][];
}

/**
 * A typed, iterable cursor over Soroban contract events returned by the
 * Soroban RPC `getEvents` endpoint.
 *
 * EventCursor centralises all `getEvents` request building and raw ScVal
 * decoding so that modules never need to hand-roll topic encoding, ledger
 * cursor logic, or ScVal accessor patterns.
 *
 * ### Key correctness guarantees
 *
 * - **i128 decoding**: The low half of an i128 is always masked with
 *   `0xFFFFFFFFFFFFFFFFn` before the bigint is assembled. This prevents
 *   silent sign-extension errors when bit 63 of the low word is set.
 * - **Topic strings**: Topics are passed as plain symbol strings (`"swap"`,
 *   `"add_liquidity"`, etc.) and forwarded to the RPC as-is, matching the
 *   shape expected by `SorobanRpc.Server.GetEventsRequest`.
 * - **endLedger clamping**: Because the RPC only accepts `startLedger`, events
 *   beyond `endLedger` are filtered out client-side.
 *
 * @example
 * ```ts
 * const cursor = new EventCursor(client.server, {
 *   contractIds: [pairAddress],
 *   startLedger: fromLedger,
 *   endLedger: toLedger,
 *   limit: 200,
 *   topics: [["swap"]],
 * });
 *
 * const events = await cursor.fetchAll();
 * for (const ev of events) {
 *   if (ev.type === "swap") {
 *     console.log(ev.sender, ev.amountIn, ev.amountOut);
 *   }
 * }
 * ```
 */
export class EventCursor {
  private readonly server: SorobanRpc.Server;
  private readonly options: Required<Omit<EventCursorOptions, "endLedger">> & {
    endLedger: number | undefined;
  };

  constructor(server: SorobanRpc.Server, options: EventCursorOptions) {
    this.server = server;
    this.options = {
      contractIds: options.contractIds ?? [],
      startLedger: options.startLedger,
      endLedger: options.endLedger,
      limit: options.limit ?? 200,
      topics: options.topics,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fetch all events matching the cursor options and decode them into typed
   * CoralSwapEvent objects.
   *
   * Unrecognised event types and malformed entries are silently skipped.
   *
   * @returns Array of typed CoralSwapEvent objects, oldest first.
   */
  async fetchAll(): Promise<CoralSwapEvent[]> {
    const rawEvents = await this.fetchRaw();
    const results: CoralSwapEvent[] = [];

    for (const rawEvent of rawEvents) {
      try {
        const ev = this.decodeRawEvent(rawEvent);
        if (ev) results.push(ev);
      } catch {
        // Skip malformed events — same lenient behaviour as EventParser
      }
    }

    return results;
  }

  /**
   * Fetch raw RPC event responses without decoding them.
   *
   * Applies `endLedger` filtering client-side.
   *
   * @returns Array of raw `SorobanRpc.Api.EventResponse` entries.
   */
  async fetchRaw(): Promise<RawRpcEvent[]> {
    const { contractIds, startLedger, endLedger, limit, topics } =
      this.options;

    // Build one filter per topic array so the RPC can OR them correctly.
    // Each filter specifies the same contractIds but a different topic set.
    const filters: SorobanRpc.Server.GetEventsRequest["filters"] = topics.map(
      (topicList) => ({
        type: "contract" as const,
        contractIds,
        topics: [topicList],
      }),
    );

    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger,
      filters,
      limit,
    };

    const response = await this.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) return [];

    const events = response.events as unknown as RawRpcEvent[];

    // The RPC only supports startLedger, not endLedger — filter client-side.
    if (endLedger !== undefined) {
      return events.filter((ev) => (ev.ledger ?? 0) <= endLedger);
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Internal decoding
  // -------------------------------------------------------------------------

  /**
   * Decode a single raw RPC event into a typed CoralSwapEvent.
   * Returns null if the event type is not recognised.
   *
   * @internal
   */
  private decodeRawEvent(rawEvent: RawRpcEvent): CoralSwapEvent | null {
    // topic is an array of decoded ScVal strings from the RPC
    const topics: string[] = Array.isArray(rawEvent.topic)
      ? (rawEvent.topic as string[])
      : [];

    if (topics.length === 0) return null;

    const topicName = topics[0];

    switch (topicName) {
      case EVENT_TOPICS.SWAP:
        return decodeSwapEvent(rawEvent);
      case EVENT_TOPICS.ADD_LIQUIDITY:
        return decodeLiquidityEvent(rawEvent, "add_liquidity");
      case EVENT_TOPICS.REMOVE_LIQUIDITY:
        return decodeLiquidityEvent(rawEvent, "remove_liquidity");
      case EVENT_TOPICS.FLASH_LOAN:
        return decodeFlashLoanEvent(rawEvent);
      default:
        return null;
    }
  }
}
