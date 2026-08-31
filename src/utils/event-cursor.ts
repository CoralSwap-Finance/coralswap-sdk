import { xdr, rpc } from "@stellar/stellar-sdk";
import { EventParser } from "./events";
import { CoralSwapEvent } from "@/types/events";

/**
 * Lowest ledger sequence that can legally be passed as `startLedger`.
 * Ledger 0 does not exist, so anchoring must never clamp below this.
 */
export const MIN_START_LEDGER = 1;

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
  } = {}): Promise<rpc.Api.EventResponse[]> {
    await this.anchorIfNeeded();

    const limit = params.limit ?? this.defaultLimit;
    const toLedger = params.toLedger; // may be undefined -> will be treated as open

    let startLedger = params.fromLedger ?? this.cursor!;
    const contractIds = params.contractIds ?? [];
    const topics = this.encodeTopics(params.topics);

    const allEvents: rpc.Api.EventResponse[] = [];

    while (true) {
      const request: rpc.Server.GetEventsRequest = {
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds,
            topics: topics ?? [],
          },
        ],
        limit,
      } as unknown as rpc.Server.GetEventsRequest;

      const res = await this.server.getEvents(request as any);
      const events = Array.isArray(res?.events) ? res.events : [];
      if (events.length === 0) {
        // Update cursor to latest inspected ledger (if RPC returns latestLedger)
        if (typeof res?.latestLedger === 'number') this.cursor = res.latestLedger;
        break;
      }

      allEvents.push(...events as rpc.Api.EventResponse[]);

      // Determine last seen ledger to advance the cursor and next startLedger
      const lastLedger = (events[events.length - 1] as any).ledger ??
        (typeof res.latestLedger === 'number' ? res.latestLedger : undefined);

      if (lastLedger === undefined) break;

      // Advance to the ledger after the last event to avoid duplicates
      startLedger = lastLedger + 1;
      this.cursor = startLedger;

      // Stop if we've reached an explicit toLedger
      if (toLedger !== undefined && startLedger > toLedger) break;

      // If fewer than limit results returned, no more pages
      if (events.length < limit) break;
    }

    return allEvents;
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
