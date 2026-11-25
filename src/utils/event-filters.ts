import { ValidationError } from "@/errors";

/**
 * Bounds enforced by Soroban RPC's `getEvents` endpoint.
 *
 * A request accepts at most 5 filters and at most 5 contract IDs per request.
 * Keeping these constants in one place lets every event-derived report split
 * a large registry into legal RPC filters without silently dropping pairs.
 */
export const MAX_EVENT_FILTERS = 5;
export const MAX_CONTRACT_IDS_PER_FILTER = 5;

/** Largest registry we can express entirely as RPC contract filters. */
export const MAX_FILTERED_CONTRACT_IDS =
  MAX_EVENT_FILTERS * MAX_CONTRACT_IDS_PER_FILTER;

/** A `getEvents` filter restricted to particular contracts and topics. */
export interface EventFilterSpec {
  type: "contract";
  contractIds: string[];
  topics: string[][];
}

/**
 * Split contract IDs into RPC-legal filters (max 5 IDs per filter, max 5
 * filters). An empty ID list produces a single unscoped contract filter, which
 * callers must only use when they apply a registry check to every returned
 * event themselves.
 *
 * @param contractIds - Contract addresses to include in the filters.
 * @param topics - Already XDR-encoded topic filters shared by every filter.
 */
export function buildEventFilters(
  contractIds: string[] | undefined,
  topics: string[][] = [],
): EventFilterSpec[] {
  const unique = Array.from(new Set((contractIds ?? []).filter(Boolean))).sort();
  if (unique.length > MAX_FILTERED_CONTRACT_IDS) {
    throw new ValidationError(
      `contractIds exceeds the getEvents filter budget of ${MAX_FILTERED_CONTRACT_IDS}`,
      { field: "contractIds", constraint: `max ${MAX_FILTERED_CONTRACT_IDS}`, actual: unique.length },
    );
  }
  if (unique.length === 0) {
    return [{ type: "contract", contractIds: [], topics }];
  }

  const filters: EventFilterSpec[] = [];
  for (
    let offset = 0;
    offset < unique.length && filters.length < MAX_EVENT_FILTERS;
    offset += MAX_CONTRACT_IDS_PER_FILTER
  ) {
    filters.push({
      type: "contract",
      contractIds: unique.slice(offset, offset + MAX_CONTRACT_IDS_PER_FILTER),
      topics,
    });
  }
  return filters;
}
