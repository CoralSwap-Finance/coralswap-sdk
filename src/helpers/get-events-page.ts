import { rpc, xdr } from '@stellar/stellar-sdk';
import { MIN_START_LEDGER } from '@/utils/event-cursor';

/**
 * Options for fetching a single page of events.
 *
 * Consolidates all common parameters from getEvents calls across modules:
 * - Contract scoping
 * - Topic filtering
 * - Ledger range specification
 * - Cursor-based pagination
 * - Per-page limit
 */
export interface EventsPageOptions {
  /**
   * Soroban contract address(es) to filter events by.
   * If empty, queries all contracts.
   */
  contractIds?: string[];

  /**
   * Event topic filters (e.g., "swap", "add_liquidity").
   * Topics are automatically encoded as base64 XDR ScVal symbols.
   * If empty or omitted, no topic filter is applied.
   */
  topics?: string[];

  /**
   * Starting ledger (inclusive). Defaults to 1 (MIN_START_LEDGER).
   * Use Math.max(MIN_START_LEDGER, ...) to avoid ledger 0.
   */
  startLedger?: number;

  /**
   * Ending ledger (inclusive). Optional; if omitted, RPC uses current ledger.
   */
  endLedger?: number;

  /**
   * Cursor for pagination. Typically the endCursor from a previous page.
   * If omitted, starts from the beginning of the ledger range.
   */
  cursor?: string;

  /**
   * Maximum number of events to return per page.
   * Defaults to 100. Larger values may increase latency.
   */
  limit?: number;
}

/**
 * Pagination metadata for a page of events.
 */
export interface PageInfo {
  /**
   * Cursor pointing to the first event in this page.
   * null if the page is empty.
   */
  startCursor: string | null;

  /**
   * Cursor pointing to the last event in this page.
   * null if the page is empty.
   * Use this as the cursor for the next page request.
   */
  endCursor: string | null;

  /**
   * true if there are more events after this page (results === limit).
   * false if this is the last page (results < limit).
   */
  hasNextPage: boolean;

  /**
   * true if a cursor was provided (indicating a prior page exists).
   * false if this is the first page.
   */
  hasPreviousPage: boolean;
}

/**
 * Ledger range metadata for a page of events.
 */
export interface LedgerRange {
  /**
   * The starting ledger of the query.
   */
  startLedger: number;

  /**
   * The ledger of the last event in the response.
   * For empty pages, equals startLedger.
   */
  endLedger: number;
}

/**
 * Deserialized event as returned by Soroban RPC.
 *
 * Topics and values are converted from XDR format to readable strings/XDR.
 */
export interface RawEvent {
  /** Unique event identifier from RPC. */
  id: string;

  /** Event type (e.g., "contract"). */
  type: string;

  /** Ledger sequence number in which the event was recorded. */
  ledger: number;

  /** Timestamp (ISO 8601) of ledger close. */
  ledgerClosedAt: string;

  /** Soroban contract address that emitted the event. */
  contractId: string;

  /** Event topics, decoded from XDR ScVal to base64 strings. */
  topics: string[];

  /** Event value, encoded as base64 XDR (caller decodes as needed). */
  value: string;

  /** true if the contract invocation that emitted this event succeeded. */
  inSuccessfulContractCall: boolean;
}

/**
 * Single page of events with pagination metadata.
 *
 * All modules must use this unified structure to ensure consistent pagination
 * and cursor handling across the SDK.
 */
export interface EventsPage {
  /**
   * Array of deserialized events in this page.
   * Empty if no events match the query.
   */
  events: RawEvent[];

  /**
   * Pagination metadata (cursors, hasNextPage, etc.).
   */
  pageInfo: PageInfo;

  /**
   * Ledger range of the query.
   */
  ledgerRange: LedgerRange;
}

/**
 * Encode bare topic strings as base64 XDR ScVal symbols.
 *
 * Converts caller-friendly topic names ("swap", "add_liquidity", etc.)
 * into the XDR format expected by Soroban RPC.
 *
 * @param topics - Array of bare topic strings
 * @returns Array-of-arrays format expected by RPC filters, or undefined if empty
 * @private
 */
function encodeTopics(topics?: string[]): string[][] | undefined {
  if (!topics || topics.length === 0) return undefined;

  // RPC expects an array-of-arrays for topic positions.
  // All topics are placed in the first position array.
  const encoded = topics.map(t => xdr.ScVal.scvSymbol(t).toXdr('base64'));
  return [encoded];
}

/**
 * Fetch a single page of events from Soroban RPC.
 *
 * This is the unified, shared implementation of getEvents pagination.
 * All modules must use this helper — never implement their own pagination logic.
 *
 * **Ledger Anchoring:**
 * - startLedger defaults to MIN_START_LEDGER (1), not 0 (which doesn't exist)
 * - Callers should use Math.max(MIN_START_LEDGER, ...) to anchor against chain head
 *
 * **Topic Encoding:**
 * - Topics are automatically encoded as base64 XDR ScVal symbols
 * - Callers pass bare strings; RPC receives encoded XDR
 *
 * **Cursor Handling:**
 * - Cursor is typically the endCursor from a previous page
 * - undefined means start from the beginning
 *
 * **Pagination Detection:**
 * - hasNextPage = results.length === limit (full page → more data likely exists)
 * - hasPreviousPage = !!cursor (cursor present → not the first page)
 *
 * @param server - Soroban RPC Server instance
 * @param options - Query options (contracts, topics, ledger range, cursor, limit)
 * @returns EventsPage with events and pagination metadata
 * @throws If server.getEvents fails or response is malformed
 */
export async function getEventsPage(
  server: rpc.Server,
  options: EventsPageOptions,
): Promise<EventsPage> {
  const limit = options.limit ?? 100;
  const startLedger = options.startLedger ?? MIN_START_LEDGER;
  const contractIds = options.contractIds ?? [];
  const encodedTopics = encodeTopics(options.topics);

  // Build the RPC request
  const request: rpc.Server.GetEventsRequest = {
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds,
        topics: encodedTopics ?? [],
      },
    ],
    cursor: options.cursor,
    limit,
  };

  // Fetch from RPC
  const response = await server.getEvents(request);
  const rawEvents = response?.events ?? [];

  // Deserialize events: convert XDR to readable format
  const events: RawEvent[] = rawEvents.map(e => ({
    id: e.id,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    contractId: e.contractId?.toString?.() ?? e.contractId ?? '',
    // Topics: convert from XDR ScVal to base64 string
    topics: (e.topic ?? []).map(t => {
      if (typeof t === 'string') return t;
      try {
        return t.toXDR('base64');
      } catch {
        return '';
      }
    }),
    // Value: convert to base64 XDR string
    value: (() => {
      if (typeof e.value === 'string') return e.value;
      try {
        return e.value.toXDR('base64');
      } catch {
        return '';
      }
    })(),
    inSuccessfulContractCall: e.inSuccessfulContractInvocation ?? false,
  }));

  // Determine pagination state
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  return {
    events,
    pageInfo: {
      startCursor: firstEvent?.id ?? null,
      endCursor: lastEvent?.id ?? null,
      hasNextPage: events.length === limit,
      hasPreviousPage: !!options.cursor,
    },
    ledgerRange: {
      startLedger,
      endLedger: lastEvent?.ledger ?? startLedger,
    },
  };
}

/**
 * Fetch ALL events across multiple pages automatically.
 *
 * Continuously calls getEventsPage with cursor-based pagination until no more
 * pages are available (hasNextPage = false).
 *
 * **Use this for:**
 * - Historical data exports (all swaps by user, all liquidity events, etc.)
 * - Analytics and reporting (total fees, leaderboard rankings, etc.)
 * - Any query where you need complete results across all pages
 *
 * **Limitations:**
 * - Does not stop at endLedger; fetches until RPC has no more data
 * - If endLedger is important, the caller must filter results post-fetch
 *
 * @param server - Soroban RPC Server instance
 * @param options - Query options (contracts, topics, ledger range, limit)
 * @returns Combined array of all events from all pages
 * @throws If any page fetch fails
 */
export async function getAllEvents(
  server: rpc.Server,
  options: Omit<EventsPageOptions, 'cursor'>,
): Promise<RawEvent[]> {
  const allEvents: RawEvent[] = [];
  let cursor: string | undefined = undefined;

  do {
    const page = await getEventsPage(server, { ...options, cursor });

    // Add all events from this page
    allEvents.push(...page.events);

    // Determine next cursor
    if (page.pageInfo.hasNextPage && page.pageInfo.endCursor) {
      cursor = page.pageInfo.endCursor;
    } else {
      cursor = undefined; // No more pages
    }
  } while (cursor);

  return allEvents;
}

export default {
  getEventsPage,
  getAllEvents,
};
