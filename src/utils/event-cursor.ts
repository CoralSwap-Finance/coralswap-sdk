import { xdr, SorobanRpc } from "@stellar/stellar-sdk";

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
 * ## Behaviour
 *
 * - **Cursor anchoring** — calls `server.getLatestLedger()` on first use and
 *   sets the start ledger to `latestLedger - defaultWindow` (clamped to 0).
 *   This guarantees we never default to ledger 0/1 arbitrarily.
 * - **Topic encoding** — encodes topic filters as base64 XDR `ScVal` via
 *   `xdr.ScVal.scvSymbol(...).toXDR('base64')` so callers must not pass
 *   raw strings directly to RPC filters — a common source of silent bugs.
 * - **Cursor persistence** — stores the cursor in-memory per-instance and
 *   advances it as scans progress.
 * - **Pagination** — loops while RPC responses are full (count === limit)
 *   and advances the start ledger to `lastEvent.ledger + 1`.
 *
 * @example
 * ```ts
 * const cursor = new EventCursor(server);
 *
 * // Scan for "swap" events from a pair contract
 * const events = await cursor.scan({
 *   contractIds: [pairAddress],
 *   topics: ["swap"],
 *   limit: 500,
 * });
 * ```
 */
export class EventCursor {
  private server: SorobanRpc.Server;
  private cursor?: number;
  private readonly defaultWindow: number;
  private readonly defaultLimit: number;

  constructor(server: SorobanRpc.Server, opts: EventCursorOptions = {}) {
    this.server = server;
    this.defaultWindow = opts.defaultWindow ?? 1000;
    this.defaultLimit = opts.defaultLimit ?? 200;
  }

  /** Reset the stored cursor (useful for tests). */
  reset(): void {
    this.cursor = undefined;
  }

  private async anchorIfNeeded(): Promise<void> {
    if (this.cursor !== undefined) return;
    const latest = await this.server.getLatestLedger();
    const seq = typeof latest.sequence === 'number' ? latest.sequence : Number(latest.sequence);
    this.cursor = Math.max(0, seq - this.defaultWindow);
  }

  private encodeTopics(topics?: string[]): string[][] | undefined {
    if (!topics || topics.length === 0) return undefined;
    // RPC expects an array-of-arrays for topic positions.
    // Place all symbols in the first (position-0) array.
    const encoded = topics.map((t) => xdr.ScVal.scvSymbol(t).toXDR('base64'));
    return [encoded];
  }

  /**
   * Scan events using the server.getEvents API, handling cursor anchoring,
   * topic encoding, persistence, and simple pagination.
   *
   * @param params - Scan parameters.
   * @param params.contractIds - Optional contract IDs to filter by.
   * @param params.topics - Optional event topic symbols to filter by.
   * @param params.fromLedger - Override the start ledger (default: anchored cursor).
   * @param params.toLedger - Stop scanning at this ledger (default: no upper bound).
   * @param params.limit - Max events per page (default: `defaultLimit`).
   * @returns Aggregated array of `EventResponse` objects.
   */
  async scan(
    params: {
      contractIds?: string[];
      topics?: string[];
      fromLedger?: number;
      toLedger?: number;
      limit?: number;
    } = {},
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    await this.anchorIfNeeded();

    const limit = params.limit ?? this.defaultLimit;
    const toLedger = params.toLedger; // may be undefined → open-ended

    let startLedger = params.fromLedger ?? this.cursor!;
    const contractIds = params.contractIds ?? [];
    const topics = this.encodeTopics(params.topics);

    const allEvents: SorobanRpc.Api.EventResponse[] = [];

    while (true) {
      const request = {
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds,
            topics: topics ?? [],
          },
        ],
        limit,
      } as unknown as SorobanRpc.Server.GetEventsRequest;

      const res = await this.server.getEvents(request as any);
      const events = Array.isArray(res?.events) ? res.events : [];
      if (events.length === 0) {
        // Update cursor to latest inspected ledger if RPC returns it
        if (typeof res?.latestLedger === 'number') this.cursor = res.latestLedger;
        break;
      }

      allEvents.push(...(events as SorobanRpc.Api.EventResponse[]));

      // Determine last-seen ledger to advance the cursor
      const lastLedger =
        (events[events.length - 1] as any).ledger ??
        (typeof res.latestLedger === 'number' ? res.latestLedger : undefined);

      if (lastLedger === undefined) break;

      // Advance to the ledger after the last event to avoid duplicates
      startLedger = lastLedger + 1;
      this.cursor = startLedger;

      // Stop if we have reached an explicit toLedger
      if (toLedger !== undefined && startLedger > toLedger) break;

      // If fewer than limit results were returned, no more pages
      if (events.length < limit) break;
    }

    return allEvents;
  }
}

export default EventCursor;
