import { xdr, rpc } from "@stellar/stellar-sdk";

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
        if (typeof res?.latestLedger === 'number') this.cursor = res.latestLedger;
        break;
      }

      allEvents.push(...events as rpc.Api.EventResponse[]);

      const lastEvent = events[events.length - 1] as any;
      const lastLedger = lastEvent?.ledger ??
        (typeof res.latestLedger === 'number' ? res.latestLedger : undefined);

      if (lastLedger !== undefined) {
        pageInfo = {
          startLedger,
          endLedger: lastLedger,
          limit,
          hasMore: events.length >= limit,
          nextCursor: typeof res?.cursor === 'string' && res.cursor.length > 0 ? res.cursor : null,
        };
      }

      if (lastLedger === undefined) break;

      startLedger = lastLedger + 1;
      this.cursor = startLedger;

      if (toLedger !== undefined && startLedger > toLedger) break;
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

export default EventCursor;
