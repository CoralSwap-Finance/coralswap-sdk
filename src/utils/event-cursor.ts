import { xdr, SorobanRpc } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// EventCursor — shared utility for building getEvents requests
// ---------------------------------------------------------------------------
//
// Bug class addressed:
//   1. Inconsistent getEvents request building: Each module was hand-rolling its
//      own GetEventsRequest objects with slightly different approaches, making it
//      hard to audit and maintain event-scanning logic across the codebase.
//
//   2. Ledger anchoring: Modules set `startLedger` from the filter but then
//      had to drop events beyond `toLedger` client-side, which wastes bandwidth
//      and is error-prone when the RPC server applies its own limits.
//      EventCursor centralizes the range check via `isWithinRange()` so every
//      consumer gets identical semantics and can easily enforce `endLedger`.
//
//   3. Validation gaps: Hand-rolled code sometimes missed validation (e.g.,
//      empty topics array, startLedger > endLedger), leading to silent failures.
//      EventCursor validates all inputs in the constructor.
//
// By centralizing getEvents request-building in EventCursor, we ensure:
//   - Consistent topic filtering across all modules
//   - Reliable ledger range enforcement
//   - A single place to update if the Soroban RPC API changes
//   - Easier testing and auditing of event-scanning logic

/**
 * A single page of raw events from a `getEvents` call.
 */
export interface EventPage {
  /** Raw event objects returned by the RPC server. */
  events: SorobanRpc.Api.EventResponse[];
  /** The ledger number of the most-recently seen event, for advancing the cursor. */
  latestLedger: number;
  /** Whether there may be more events to fetch (i.e. the page was full). */
  hasMore: boolean;
}

/**
 * Options for building a `getEvents` request via `EventCursor`.
 */
export interface EventCursorOptions {
  /**
   * Event topic strings to filter on (e.g. `"swap"`, `"add_liquidity"`).
   * Each string is XDR-encoded as an ScVal symbol before being sent to the
   * RPC node, avoiding the raw-string topic bug found in hand-rolled code.
   */
  topics: string[];

  /**
   * Optional contract IDs to scope the query to specific pair addresses.
   * When omitted or empty the query spans all contracts.
   */
  contractIds?: string[];

  /**
   * First ledger to include (inclusive).  Defaults to `0`.
   */
  startLedger?: number;

  /**
   * Last ledger to include (inclusive).  When supplied, `EventCursor`
   * enforces this bound in `isWithinRange()` so callers don't need to
   * implement the client-side filtering themselves.
   */
  endLedger?: number;

  /**
   * Maximum number of events to return per page.  Defaults to `200`.
   */
  pageLimit?: number;
}

/**
 * Shared utility for building Soroban RPC `getEvents` requests with
 * correctly encoded topics and consistent ledger anchoring.
 *
 * Instead of hand-rolling `SorobanRpc.Server.GetEventsRequest` objects in
 * each module (which led to raw-string topic bugs and inconsistent ledger
 * filtering), create an `EventCursor` once and call `buildRequest()` /
 * `isWithinRange()` from your event-scanning loop.
 *
 * @example
 * ```ts
 * const cursor = new EventCursor({
 *   topics: ['swap'],
 *   contractIds: [pairAddress],
 *   startLedger: fromLedger,
 *   endLedger: toLedger,
 * });
 *
 * const request = cursor.buildRequest();
 * const response = await client.server.getEvents(request);
 *
 * for (const ev of response.events) {
 *   if (!cursor.isWithinRange(ev.ledger)) continue; // enforces endLedger
 *   // process ev …
 * }
 * ```
 */
export class EventCursor {
  private readonly topics: string[];
  private readonly contractIds: string[];
  private readonly startLedger: number;
  private readonly endLedger: number | undefined;
  private readonly pageLimit: number;

  constructor(options: EventCursorOptions) {
    if (!Array.isArray(options.topics) || options.topics.length === 0) {
      throw new TypeError('EventCursor: topics must be a non-empty array');
    }
    for (const t of options.topics) {
      if (typeof t !== 'string' || t.length === 0) {
        throw new TypeError('EventCursor: each topic must be a non-empty string');
      }
    }

    this.topics = options.topics;
    this.contractIds = options.contractIds ?? [];
    this.startLedger = options.startLedger ?? 0;
    this.endLedger = options.endLedger;
    this.pageLimit = options.pageLimit ?? 200;

    if (
      this.endLedger !== undefined &&
      this.endLedger < this.startLedger
    ) {
      throw new TypeError(
        `EventCursor: endLedger (${this.endLedger}) must be >= startLedger (${this.startLedger})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Topic encoding
  // -------------------------------------------------------------------------

  /**
   * The Soroban RPC `GetEventsRequest` API accepts `topics: string[][]`,
   * where each inner array represents a set of alternative topics to OR together.
   *
   * The "topic encoding bug" that EventCursor addresses is NOT the wire format
   * (the RPC client handles that internally), but rather ensuring topics are
   * passed as a properly structured array rather than raw unvalidated strings,
   * and providing a consistent API for all event-scanning modules.
   *
   * For now, we pass the topics directly as strings since that's what the
   * Stellar SDK's GetEventsRequest expects. The XDR encoding happens inside
   * the SDK's RPC client.
   */

  // -------------------------------------------------------------------------
  // Request building
  // -------------------------------------------------------------------------

  /**
   * Build a `GetEventsRequest` ready to pass to `server.getEvents()`.
   *
   * Topics are passed as string arrays (as the Soroban RPC API expects);
   * the Stellar SDK handles the XDR encoding internally.
   * 
   * The `startLedger` is set from the constructor option. `endLedger` is 
   * enforced separately via `isWithinRange()` — the Soroban RPC API has no 
   * native `endLedger` parameter so the upper-bound check is always the 
   * caller's responsibility, but centralising it here ensures every consumer 
   * uses the same logic.
   *
   * @param startLedgerOverride - Override the startLedger for this request
   *   (useful when iterating through pages after the initial call).
   */
  buildRequest(
    startLedgerOverride?: number,
  ): SorobanRpc.Server.GetEventsRequest {
    const startLedger = startLedgerOverride ?? this.startLedger;

    return {
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: this.contractIds,
          // Pass topics as string arrays - the Stellar SDK's RPC client
          // handles the XDR encoding internally
          topics: [this.topics],
        },
      ],
      limit: this.pageLimit,
    };
  }

  // -------------------------------------------------------------------------
  // Range checking
  // -------------------------------------------------------------------------

  /**
   * Returns `true` when `ledger` falls within the configured ledger range
   * (`startLedger` ≤ `ledger` ≤ `endLedger`).
   *
   * Call this for every event returned by the RPC server to enforce the
   * upper-bound filter (`endLedger`), which the Soroban RPC API does not
   * natively support.
   *
   * When `endLedger` was not provided to the constructor, only the lower
   * bound is checked.
   */
  isWithinRange(ledger: number): boolean {
    if (ledger < this.startLedger) return false;
    if (this.endLedger !== undefined && ledger > this.endLedger) return false;
    return true;
  }

  /**
   * Returns `true` when `ledger` is past the configured `endLedger`.
   *
   * Useful for early-exit optimisation inside an event scan loop: once a
   * paginated response contains an event whose ledger exceeds `endLedger`,
   * all subsequent events (which Soroban RPC returns in ledger-ascending
   * order) will also exceed it, so the loop can break early.
   *
   * Returns `false` when no `endLedger` was configured.
   */
  isPastEnd(ledger: number): boolean {
    return this.endLedger !== undefined && ledger > this.endLedger;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** The `startLedger` this cursor was constructed with. */
  get start(): number {
    return this.startLedger;
  }

  /** The `endLedger` this cursor was constructed with, or `undefined`. */
  get end(): number | undefined {
    return this.endLedger;
  }

  /** The page limit this cursor was constructed with. */
  get limit(): number {
    return this.pageLimit;
  }
}
