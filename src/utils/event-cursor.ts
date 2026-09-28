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
import { xdr, rpc } from "@stellar/stellar-sdk";
import { ValidationError } from "@/errors";
import { EventParser } from "./events";
import { CoralSwapEvent } from "@/types/events";

/**
 * Lowest ledger sequence that can legally be passed as `startLedger`.
 * Ledger 0 does not exist, so anchoring must never clamp below this.
 */
export const MIN_START_LEDGER = 1;

/** Maximum number of events that can be requested in a single scan call. */
export const MAX_EVENT_LIMIT = 10_000;

/**
 * Decode a topic segment from a `getEvents` **response** back to its symbol.
 *
 * The counterpart to the encoding done by `encodeTopics`. Response topics
 * arrive either already parsed into `xdr.ScVal`s or, over raw JSON-RPC, as
 * base64 XDR strings — both are handled.
 *
 * A bare, unencoded string (e.g. the literal `"swap"`) is deliberately **not**
 * accepted and decodes to `""`. Real RPC never returns one, so tolerating it
 * would only let hand-rolled test fixtures paper over the raw-string topic bug
 * this helper is meant to surface.
 *
 * @param topic - A topic segment from an event response.
 * @returns The decoded symbol/string, or `""` if it is not valid topic XDR.
 */
export function decodeEventTopic(topic: unknown): string {
  if (topic === null || topic === undefined) return "";

  let val: xdr.ScVal;
  if (typeof topic === "string") {
    try {
      val = xdr.ScVal.fromXdr(topic, "base64");
    } catch {
      return "";
    }
  } else {
    val = topic as xdr.ScVal;
  }

  try {
    switch (val.type) {
      case "scvSymbol":
        return val.sym.toString();
      case "scvString":
        return val.str.toString();
      default:
        return "";
    }
  } catch {
    return "";
  }
}

export interface EventCursorOptions {
  /** How many ledgers to look back when anchoring the initial cursor. */
  defaultWindow?: number;
  /** Default per-request limit passed to getEvents. */
  defaultLimit?: number;
}

/**
 * EventCursor — shared utility to scan Soroban `getEvents` safely and
 * consistently across modules.
 *
 * Behaviour highlights:
 * - Anchors an initial cursor by calling `server.getLatestLedger()` and
 *   using `latestLedger - defaultWindow` (clamped to 0). This guarantees
 *   we never default to ledger 0/1 arbitrarily.
 * - Encodes topic filters as base64 XDR `ScVal` via
 *   `xdr.ScVal.scvSymbol(...).toXdr('base64')` so callers must not pass
 *   raw strings directly to RPC filters.
 * - Persists a cursor in-memory per-instance and advances it as scans
 *   progress.
 * - Handles pagination by looping while RPC responses are full (== limit)
 *   and advancing the start ledger to `lastEvent.ledger + 1`.
 *
 * Usage example:
 *
 * ```ts
 * const cursor = new EventCursor(server);
 * // scan for "swap" topic from a pair contract
 * const events = await cursor.scan({
 *   contractIds: [pairAddress],
 *   topics: ["swap"],
 *   limit: 500,
 * });
 * ```
 */
export class EventCursor {
  private server: rpc.Server;
  private cursor?: number;
  private readonly defaultWindow: number;
  private readonly defaultLimit: number;

  constructor(server: rpc.Server, opts: EventCursorOptions = {}) {
    this.server = server;
    this.defaultWindow = opts.defaultWindow ?? 1000;
    this.defaultLimit = opts.defaultLimit ?? 200;
  }

  /** Reset the stored cursor. Useful for tests. */
  reset(): void {
    this.cursor = undefined;
  }

  private async anchorIfNeeded(): Promise<void> {
    if (this.cursor !== undefined) return;
    const latest = await this.server.getLatestLedger();
    const seq = typeof latest.sequence === 'number' ? latest.sequence : Number(latest.sequence);
    // Clamp to MIN_START_LEDGER, not 0: ledger 0 does not exist, and RPC
    // rejects `startLedger: 0`. On a young network (or a large defaultWindow)
    // `seq - defaultWindow` goes non-positive, which is the zero-anchored
    // cursor bug this utility exists to prevent.
    this.cursor = Math.max(MIN_START_LEDGER, seq - this.defaultWindow);
  }

  private encodeTopics(topics?: string[]): string[][] | undefined {
    if (!topics || topics.length === 0) return undefined;
    // RPC expects an array-of-arrays for topic positions (preserve simple
    // callers by placing all symbols in the first position array).
    const encoded = topics.map((t) => xdr.ScVal.scvSymbol(t).toXdr('base64'));
    return [encoded];
  }

  /**
   * Scan events using the server.getEvents API, handling cursor anchoring,
   * topic encoding, persistence, and simple pagination.
   */
  async scan(params: {
    contractIds?: string[];
    topics?: string[];
    fromLedger?: number;
    toLedger?: number;
    limit?: number;
  } = {}): Promise<Array<rpc.Api.EventResponse> & {
    pageInfo?: {
      startLedger?: number;
      endLedger?: number;
      limit?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
      [key: string]: unknown;
    };
    truncated?: boolean;
  }> {
    await this.anchorIfNeeded();

    const limit = params.limit ?? this.defaultLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      throw new ValidationError(
        `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}, got ${limit}`,
        { field: "limit", constraint: `integer 1-${MAX_EVENT_LIMIT}`, actual: limit },
      );
    }
    const toLedger = params.toLedger; // may be undefined -> will be treated as open

    let startLedger = params.fromLedger ?? this.cursor!;
    const contractIds = params.contractIds ?? [];
    const topics = this.encodeTopics(params.topics);

    const allEvents: rpc.Api.EventResponse[] = [];
    let pageInfo: {
      startLedger?: number;
      endLedger?: number;
      limit?: number;
      hasMore?: boolean;
      nextCursor?: string | null;
      [key: string]: unknown;
    } = {
      startLedger,
      endLedger: startLedger,
      limit,
      hasMore: false,
      nextCursor: null,
    };

    let currentCursor: string | undefined = undefined;

    while (true) {
      // Soroban RPC rejects a request that carries both a cursor and a ledger
      // range: the first page is fetched by ledger range, every following
      // page continues from the cursor of the previous one so that events
      // beyond the page limit inside a single ledger are never skipped.
      const request: Record<string, unknown> = {
        ...(currentCursor ? {} : { startLedger }),
        filters: [
          {
            type: 'contract',
            contractIds,
            topics: topics ?? [],
          },
        ],
        limit,
      };

      if (currentCursor) {
        request.cursor = currentCursor;
      }

      const res = await this.server.getEvents(request as any);
      const events = Array.isArray(res?.events) ? res.events : [];
      if (events.length === 0) {
        if (typeof res?.latestLedger === 'number') this.cursor = res.latestLedger;
        break;
      }

      allEvents.push(...(events as rpc.Api.EventResponse[]));

      const lastEvent = events[events.length - 1] as any;
      const lastLedger =
        lastEvent?.ledger ??
        (typeof res.latestLedger === 'number' ? res.latestLedger : undefined);

      const resCursor =
        typeof res?.cursor === "string" && res.cursor.length > 0
          ? res.cursor
          : typeof lastEvent?.pagingToken === "string"
          ? lastEvent.pagingToken
          : null;

      if (lastLedger !== undefined) {
        pageInfo = {
          startLedger,
          endLedger: lastLedger,
          limit,
          hasMore: events.length >= limit,
          nextCursor: resCursor,
        };
      }

      if (lastLedger === undefined) break;

      if (resCursor) {
        currentCursor = resCursor;
        this.cursor = lastLedger;
      } else {
        startLedger = lastLedger + 1;
        this.cursor = startLedger;
      }

      if (toLedger !== undefined && lastLedger > toLedger) break;
      if (events.length < limit) break;
    }

    const pagedEvents = allEvents as typeof allEvents & {
      pageInfo?: typeof pageInfo;
      truncated?: boolean;
    };
    pagedEvents.pageInfo = pageInfo;
    pagedEvents.truncated = (pageInfo.hasMore ?? false) || allEvents.length >= limit;
    return pagedEvents;
  }
}

/**
 * Per-scan overrides for a {@link TypedEventCursor}. The `contractIds`/`topics`
 * filters are fixed for the lifetime of the cursor (they are the whole point of
 * composing a single filtered cursor), so only the ledger window and page limit
 * are adjustable here.
 */
export interface TypedEventScanParams {
  /** Explicit start ledger. Defaults to the cursor's anchored position. */
  fromLedger?: number;
  /** Explicit end ledger. When omitted the scan runs to the chain head. */
  toLedger?: number;
  /** Per-request page limit passed through to `getEvents`. */
  limit?: number;
}

/**
 * TypedEventCursor — a single, filtered, cursor-pagination-aware stream of
 * typed {@link CoralSwapEvent}s.
 *
 * Composed listeners historically forked topic filtering per module, each
 * re-issuing `getEvents` and re-decoding raw responses. This cursor bakes the
 * contract and topic filters in once (applied at the cursor level via the
 * shared {@link EventCursor}) and decodes every page through the shared
 * {@link EventParser}, so multiple listeners can compose over one cursor
 * instead of each re-filtering.
 *
 * Pagination semantics are inherited verbatim from {@link EventCursor}:
 * ledger-window anchoring against `getLatestLedger()`, base64-XDR topic
 * encoding, in-memory cursor advancement, and full-page pagination.
 *
 * @example
 * ```ts
 * const cursor = client.allEvents(pairAddress, ["swap", "sync"]);
 * for await (const event of cursor.stream()) {
 *   if (event.type === "swap") console.log(event.amountIn, event.amountOut);
 * }
 * ```
 */
export class TypedEventCursor {
  private readonly cursor: EventCursor;
  private readonly parser: EventParser;
  private readonly contractId?: string;
  private readonly topicFilters?: string[];

  /**
   * @param server - Soroban RPC server used for `getEvents`.
   * @param contractId - Contract whose events are streamed. When omitted,
   *   events from any contract are returned (still topic-filtered).
   * @param filters - Topic symbols to filter on at the cursor level (e.g.
   *   `["swap", "sync"]`). Omit for all recognised topics.
   * @param opts - Ledger-window / page-limit defaults for the underlying cursor.
   */
  constructor(
    server: rpc.Server,
    contractId?: string,
    filters?: string[],
    opts: EventCursorOptions = {},
  ) {
    this.cursor = new EventCursor(server, opts);
    this.parser = new EventParser(contractId ? [contractId] : []);
    this.contractId = contractId;
    this.topicFilters = filters;
  }

  /** Reset the underlying cursor position. Useful for tests / re-scans. */
  reset(): void {
    this.cursor.reset();
  }

  /**
   * Scan the next window and return the decoded, typed events.
   *
   * Applies the cursor's fixed contract/topic filters, advances the shared
   * pagination cursor, and decodes each raw response into a typed event
   * (undecodable / unrecognised entries are dropped).
   */
  async scan(params: TypedEventScanParams = {}): Promise<CoralSwapEvent[]> {
    const raw = await this.cursor.scan({
      contractIds: this.contractId ? [this.contractId] : [],
      topics: this.topicFilters,
      fromLedger: params.fromLedger,
      toLedger: params.toLedger,
      limit: params.limit,
    });
    return this.decode(raw);
  }

  /**
   * Stream the decoded, typed events one at a time.
   *
   * A thin async-iterable wrapper over {@link scan} so listeners can consume
   * the filtered cursor with `for await`.
   */
  async *stream(
    params: TypedEventScanParams = {},
  ): AsyncGenerator<CoralSwapEvent, void, unknown> {
    for (const event of await this.scan(params)) {
      yield event;
    }
  }

  private decode(raw: rpc.Api.EventResponse[]): CoralSwapEvent[] {
    const decoded: CoralSwapEvent[] = [];
    for (const event of raw) {
      const typed = this.parser.fromEventResponse(event);
      if (typed) decoded.push(typed);
    }
    return decoded;
  }
}


export default EventCursor;
