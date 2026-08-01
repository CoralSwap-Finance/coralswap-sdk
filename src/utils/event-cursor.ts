import { xdr, SorobanRpc } from "@stellar/stellar-sdk";
import type { Api } from "@stellar/stellar-sdk/lib/rpc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  return xdr.ScVal.scvSymbol(value).toXDR("base64").toString();
}

// ---------------------------------------------------------------------------
// EventCursor
// ---------------------------------------------------------------------------

/**
 * Options for constructing an EventCursor instance.
 */
export interface EventCursorOptions {
  /** The Soroban RPC server instance. */
  server: SorobanRpc.Server;
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
}

/**
 * Result of a single EventCursor.fetchNext() call.
 */
export interface EventCursorPage {
  /** Events returned in this page, as raw SDK EventResponse objects. */
  events: Api.EventResponse[];
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

  constructor(options: EventCursorOptions) {
    this.server = options.server;
    this.contractIds = options.contractIds ?? [];
    this.topics = options.topics ?? [];
    this.startLedger = options.startLedger ?? 0;
    this.limit = options.limit ?? 100;
    this._cursor = options.cursor;
    this._hasMore = true;
  }

  /**
   * Whether more pages may be available.
   */
  get hasMore(): boolean {
    return this._hasMore;
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

    // Encode string topics as base64-encoded ScVal symbols
    const topicsEncoded: string[][] = [];
    for (const topic of this.topics) {
      topicsEncoded.push([encodeTopicForFilter(topic)]);
    }

    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger: this.startLedger,
      filters: [
        {
          type: "contract",
          contractIds:
            this.contractIds.length > 0 ? this.contractIds : undefined,
          topics: topicsEncoded.length > 0 ? topicsEncoded : undefined,
        },
      ],
      limit: this.limit,
    };

    // Attach cursor for pagination (top-level field)
    if (this._cursor) {
      request.cursor = this._cursor;
    }

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

    // Update cursor for next page from the last event's paging token
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      this._cursor = lastEvent.pagingToken;
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
  async fetchAll(maxEvents?: number): Promise<Api.EventResponse[]> {
    const allEvents: Api.EventResponse[] = [];

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
}
