import { xdr, rpc as SorobanRpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Encode a plain string value into a base64-encoded ScVal symbol for use as
 * a Soroban RPC getEvents topic filter.
 *
 * On-chain CoralSwap events use `scvSymbol` for topic names (e.g. "swap",
 * "add_liquidity"), so the topic filter MUST be encoded as an ScVal symbol
 * to match correctly. Hand-rolled raw-string topic filters (e.g. `["swap"]`)
 * silently produce no matches against a real network.
 */
export function encodeTopicForFilter(value: string): string {
  return xdr.ScVal.scvSymbol(value).toXdr("base64").toString();
}

// ---------------------------------------------------------------------------
// EventCursor
// ---------------------------------------------------------------------------

/**
 * Options for constructing an EventCursor instance.
 */
export interface EventCursorOptions {
  /** The Soroban RPC server instance. */
  server?: SorobanRpc.Server;
  /** Optional contract IDs to filter events by. */
  contractIds?: string[];
  /**
   * Topic filter values (one per filter slot).
   *
   * Each entry is a string topic value (e.g. "swap") that will be properly
   * encoded as an ScVal symbol before being sent to the RPC.
   *
   * When multiple entries are provided they are OR'd together — an event
   * matching ANY topic in the array will be returned (subject to other
   * filters).
   */
  topics?: string[];
  /** Inclusive start ledger. */
  startLedger?: number;
  /** Cursor for pagination (returned by a previous response). */
  cursor?: string;
  /** Maximum number of events per page. */
  limit?: number;
  /** How many ledgers to look back when anchoring the initial cursor. */
  defaultWindow?: number;
  /** Default per-request limit passed to getEvents. */
  defaultLimit?: number;
}

/**
 * Result of a single EventCursor.fetchNext() call.
 */
export interface EventCursorPage {
  /** Events returned in this page, as raw SDK EventResponse objects. */
  events: SorobanRpc.Api.EventResponse[];
  /** Paging token for the next page. */
  pagingToken?: string;
  /** Whether there are potentially more events. */
  hasMore: boolean;
  /** The latest ledger known to the RPC at query time. */
  latestLedger: number;
}

/**
 * Cursor-based paginator for Soroban RPC `getEvents`.
 *
 * Automatically encodes topic filters as proper ScVal symbols, handles
 * cursor-based pagination, and returns raw SDK {@link Api.EventResponse}
 * objects for downstream parsing.
 *
 * @example
 * ```ts
 * const cursor = new EventCursor({
 *   server: client.server,
 *   contractIds: [pairAddress],
 *   topics: ["swap"],
 *   startLedger: 1000,
 *   limit: 100,
 * });
 *
 * const page = await cursor.fetchNext();
 * for (const ev of page.events) {
 *   console.log(ev.ledger, ev.txHash);
 * }
 * ```
 */
export class EventCursor {
  private server: SorobanRpc.Server;
  private contractIds: string[];
  private topics: string[];
  private startLedger: number;
  private limit: number;
  private _cursor: string | undefined;
  private _hasMore: boolean;
  private cursor?: number;
  private readonly defaultWindow: number;
  private readonly defaultLimit: number;

  constructor(options: EventCursorOptions);
  constructor(
    server: SorobanRpc.Server,
    options?: Omit<EventCursorOptions, "server">,
  );
  constructor(
    serverOrOptions: SorobanRpc.Server | EventCursorOptions,
    options: Omit<EventCursorOptions, "server"> = {},
  ) {
    if (typeof (serverOrOptions as SorobanRpc.Server).getLatestLedger === "function") {
      const server = serverOrOptions as SorobanRpc.Server;
      this.server = server;
      this.contractIds = options.contractIds ?? [];
      this.topics = options.topics ?? [];
      this.startLedger = options.startLedger ?? 0;
      this._cursor = options.cursor;
      this._hasMore = true;
      this.defaultWindow = options.defaultWindow ?? 1000;
      this.defaultLimit = options.defaultLimit ?? 200;
      this.limit = options.limit ?? this.defaultLimit;
      this.cursor = undefined;
    } else {
      const opts = serverOrOptions as EventCursorOptions;
      if (!opts.server) {
        throw new Error("EventCursor requires a server");
      }
      this.server = opts.server;
      this.contractIds = opts.contractIds ?? [];
      this.topics = opts.topics ?? [];
      this.startLedger = opts.startLedger ?? 0;
      this.limit = opts.limit ?? 100;
      this._cursor = opts.cursor;
      this._hasMore = true;
      this.defaultWindow = opts.defaultWindow ?? 1000;
      this.defaultLimit = opts.defaultLimit ?? 200;
      this.cursor = undefined;
    }
  }

  /**
   * Whether more pages may be available.
   */
  get hasMore(): boolean {
    return this._hasMore;
  }

  /** Reset the stored cursor. Useful for tests. */
  reset(): void {
    this.cursor = undefined;
    this._cursor = undefined;
    this._hasMore = true;
  }

  private async anchorIfNeeded(): Promise<void> {
    if (this.cursor !== undefined) return;
    const latest = await this.server.getLatestLedger();
    const seq =
      typeof latest.sequence === "number"
        ? latest.sequence
        : Number(latest.sequence);
    // Clamp to MIN_START_LEDGER, not 0: ledger 0 does not exist, and RPC
    // rejects `startLedger: 0`. On a young network (or a large defaultWindow)
    // `seq - defaultWindow` goes non-positive, which is the zero-anchored
    // cursor bug this utility exists to prevent.
    this.cursor = Math.max(MIN_START_LEDGER, seq - this.defaultWindow);
  }

  private encodeTopics(topics?: string[]): string[][] | undefined {
    if (!topics || topics.length === 0) return undefined;
    return topics.map((topic) => [encodeTopicForFilter(topic)]);
  }

  /**
   * Fetch the next page of events from the Soroban RPC.
   *
   * Automatically advances the internal cursor so subsequent calls return
   * subsequent pages. Returns an empty page when no more events are
   * available.
   */
  async fetchNext(): Promise<EventCursorPage> {
    if (!this._hasMore) {
      return { events: [], hasMore: false, latestLedger: 0 };
    }

    const topicsEncoded = this.encodeTopics(this.topics);

    const filters = [
      {
        type: "contract" as const,
        contractIds:
          this.contractIds.length > 0 ? this.contractIds : undefined,
        topics:
          topicsEncoded && topicsEncoded.length > 0
            ? topicsEncoded
            : undefined,
      },
    ];

    const request: SorobanRpc.Api.GetEventsRequest = this._cursor
      ? {
          cursor: this._cursor,
          filters,
          limit: this.limit,
        }
      : {
          startLedger: this.startLedger,
          filters,
          limit: this.limit,
        };

    const response = await this.server.getEvents(request);
    if (!response || !Array.isArray(response.events)) {
      this._hasMore = false;
      return {
        events: [],
        hasMore: false,
        latestLedger: response?.latestLedger ?? 0,
      };
    }

    const events = response.events;

    // v17 RPC responses expose the next cursor on the response. Keep the
    // event-level fallback for older mocks/SDK response shapes.
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      this._cursor =
        response.cursor ??
        (lastEvent as SorobanRpc.Api.EventResponse & { pagingToken?: string }).pagingToken;
    }

    // If fewer events returned than requested, no more pages
    if (events.length < this.limit) {
      this._hasMore = false;
    }

    return {
      events,
      pagingToken: this._cursor,
      hasMore: this._hasMore,
      latestLedger: response.latestLedger,
    };
  }

  /**
   * Fetch ALL remaining events up to an optional maximum.
   *
   * Iterates through all pages until exhaustion. Use with caution on large
   * result sets.
   *
   * @param maxEvents - Optional cap on total events to fetch.
   */
  async fetchAll(maxEvents?: number): Promise<SorobanRpc.Api.EventResponse[]> {
    const allEvents: SorobanRpc.Api.EventResponse[] = [];

    while (this._hasMore) {
      const page = await this.fetchNext();
      allEvents.push(...page.events);
      if (maxEvents !== undefined && allEvents.length >= maxEvents) {
        break;
      }
    }

    if (maxEvents !== undefined) {
      return allEvents.slice(0, maxEvents);
    }

    return allEvents;
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
  } = {}): Promise<SorobanRpc.Api.EventResponse[]> {
    await this.anchorIfNeeded();

    const limit = params.limit ?? this.defaultLimit;
    const toLedger = params.toLedger; // may be undefined -> will be treated as open

    let startLedger = params.fromLedger ?? this.cursor!;
    const contractIds = params.contractIds ?? [];
    const topics = this.encodeTopics(params.topics);

    const allEvents: SorobanRpc.Api.EventResponse[] = [];

    while (true) {
      const request: SorobanRpc.Api.GetEventsRequest = {
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds,
            topics: topics ?? [],
          },
        ],
        limit,
      };

      const res = await this.server.getEvents(request);
      const events = Array.isArray(res?.events) ? res.events : [];
      if (events.length === 0) {
        // Update cursor to latest inspected ledger (if RPC returns latestLedger)
        if (typeof res?.latestLedger === "number") this.cursor = res.latestLedger;
        break;
      }

      allEvents.push(...(events as SorobanRpc.Api.EventResponse[]));

      // Determine last seen ledger to advance the cursor and next startLedger
      const lastLedger =
        (events[events.length - 1] as any).ledger ??
        (typeof res.latestLedger === "number" ? res.latestLedger : undefined);

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

export default EventCursor;
