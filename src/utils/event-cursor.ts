import { xdr, Address, SorobanRpc } from "@stellar/stellar-sdk";
import { ValidationError } from "@/errors";

// ---------------------------------------------------------------------------
// EventCursor
// ---------------------------------------------------------------------------

/**
 * Options for constructing an {@link EventCursor}.
 */
export interface EventCursorOptions {
  /** Soroban RPC server instance to query. */
  server: SorobanRpc.Server;
  /**
   * Ledger sequence number to start fetching events from (inclusive).
   * The Soroban RPC `getEvents` endpoint requires a `startLedger`.
   */
  startLedger: number;
  /**
   * Optional upper-bound ledger sequence (inclusive). Events from ledgers
   * beyond `toLedger` are discarded client-side, since the RPC only supports
   * a `startLedger` lower bound.
   */
  toLedger?: number;
  /**
   * Topic strings to filter events by (e.g. `["swap"]`, `["add_liquidity"]`).
   * Each element is matched against the **first** topic of an event.
   */
  topics: string[];
  /**
   * Optional contract addresses to restrict the query to. An empty array
   * means "any contract" (no address filter).
   */
  contractIds?: string[];
  /**
   * Maximum number of events to fetch in a single RPC call. Defaults to 200.
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Decoded event types
// ---------------------------------------------------------------------------

/**
 * A fully-decoded event returned by {@link EventCursor.fetch}.
 */
export interface RpcEvent {
  /** The first topic string (e.g. `"swap"`, `"add_liquidity"`). */
  topicName: string;
  /** Map of event data fields, keyed by field name. */
  fields: Map<string, xdr.ScVal>;
  /** Contract address that emitted the event. */
  contractId: string;
  /** Ledger sequence number in which the event appeared. */
  ledger: number;
  /**
   * Ledger close time as a Unix timestamp (seconds since epoch).
   * Derived from `ledgerClosedAt` ISO string.
   */
  timestamp: number;
  /** Transaction hash. */
  txHash: string;
}

// ---------------------------------------------------------------------------
// Helper: decode an ScVal symbol or string to a JS string
// ---------------------------------------------------------------------------

function scValToString(val: xdr.ScVal): string {
  const tag = val.switch().name;
  if (tag === "scvSymbol") return val.sym().toString();
  if (tag === "scvString") return val.str().toString();
  const v = val.value();
  return v != null ? String(v) : "";
}

// ---------------------------------------------------------------------------
// Helper: build an ScMap lookup map from an ScVal
// ---------------------------------------------------------------------------

function buildFieldMap(data: xdr.ScVal): Map<string, xdr.ScVal> {
  if (data.switch().name !== "scvMap") {
    throw new ValidationError(
      `Expected ScMap in event data, got ${data.switch().name}`,
    );
  }
  const entries = data.map() ?? [];
  const map = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    const k = entry.key();
    const tag = k.switch().name;
    let key: string | undefined;
    if (tag === "scvSymbol") key = k.sym().toString();
    else if (tag === "scvString") key = k.str().toString();
    if (key !== undefined) map.set(key, entry.val());
  }
  return map;
}

// ---------------------------------------------------------------------------
// ScVal field decoders (exported for use in consumers)
// ---------------------------------------------------------------------------

/**
 * Decode an i128 ScVal to a bigint.
 *
 * Correctly handles the unsigned 64-bit low half so that large values
 * above 2^63 are not sign-extended incorrectly.
 *
 * @param val - An ScVal of type scvI128.
 * @returns The value as a bigint.
 * @throws {ValidationError} If the ScVal is not an i128.
 */
export function fieldI128(val: xdr.ScVal): bigint {
  if (val.switch().name !== "scvI128") {
    throw new ValidationError(
      `Expected scvI128, got ${val.switch().name}`,
    );
  }
  const parts = val.i128();
  // lo() is an xdr.Uint64 — must be treated as unsigned
  const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
  const hi = BigInt(parts.hi().toString());
  return (hi << 64n) + lo;
}

/**
 * Decode a u32 ScVal to a number.
 *
 * @param val - An ScVal of type scvU32.
 * @returns The value as a number.
 * @throws {ValidationError} If the ScVal is not a u32.
 */
export function fieldU32(val: xdr.ScVal): number {
  if (val.switch().name !== "scvU32") {
    throw new ValidationError(
      `Expected scvU32, got ${val.switch().name}`,
    );
  }
  return val.u32();
}

/**
 * Decode an address ScVal to a Stellar account/contract address string.
 *
 * @param val - An ScVal of type scvAddress.
 * @returns The address as a string (G… for account, C… for contract).
 * @throws {ValidationError} If the ScVal is not an address.
 */
export function fieldAddress(val: xdr.ScVal): string {
  if (val.switch().name !== "scvAddress") {
    throw new ValidationError(
      `Expected scvAddress, got ${val.switch().name}`,
    );
  }
  return Address.fromScVal(val).toString();
}

// ---------------------------------------------------------------------------
// EventCursor
// ---------------------------------------------------------------------------

/**
 * Utility for fetching and decoding CoralSwap contract events from the
 * Soroban RPC `getEvents` endpoint.
 *
 * Eliminates hand-rolled request-building and fragile ad-hoc ScVal decoding
 * by centralising topic encoding, ledger-range handling, and field extraction.
 *
 * **Why not use {@link EventParser}?**
 * `EventParser` works on `xdr.DiagnosticEvent` objects extracted from
 * *transaction result meta XDR*. The RPC `getEvents` endpoint returns a
 * different shape (`SorobanRpc.Api.EventResponse`) where `topic` is
 * `xdr.ScVal[]` and `value` is `xdr.ScVal`. `EventCursor` handles this
 * shape correctly using typed XDR accessors rather than the raw JavaScript
 * object duck-typing that caused the known decoding bugs.
 *
 * @example
 * ```ts
 * const cursor = new EventCursor({
 *   server: client.server,
 *   startLedger: 1000,
 *   toLedger: 2000,
 *   topics: ['swap'],
 *   contractIds: [pairAddress],
 * });
 *
 * const events = await cursor.fetch();
 * for (const ev of events) {
 *   const amountIn = fieldI128(ev.fields.get('amount_in')!);
 *   const sender   = fieldAddress(ev.fields.get('sender')!);
 * }
 * ```
 */
export class EventCursor {
  private readonly server: SorobanRpc.Server;
  private readonly startLedger: number;
  private readonly toLedger: number | undefined;
  private readonly topics: string[];
  private readonly contractIds: string[];
  private readonly limit: number;

  constructor(opts: EventCursorOptions) {
    this.server = opts.server;
    this.startLedger = opts.startLedger;
    this.toLedger = opts.toLedger;
    this.topics = opts.topics;
    this.contractIds = opts.contractIds ?? [];
    this.limit = opts.limit ?? 200;
  }

  /**
   * Fetch and decode events from the Soroban RPC.
   *
   * Builds the `GetEventsRequest` with the configured topic and contract
   * filters, then decodes each `EventResponse` into a typed {@link RpcEvent}.
   * Events beyond `toLedger` (if set) are discarded. Malformed events are
   * silently skipped.
   *
   * @returns Array of decoded {@link RpcEvent} objects, oldest first.
   */
  async fetch(): Promise<RpcEvent[]> {
    const request: SorobanRpc.Server.GetEventsRequest = {
      startLedger: this.startLedger,
      filters: [
        {
          type: "contract",
          contractIds: this.contractIds,
          // topics filter: wrap in array-of-arrays so the RPC matches
          // events whose first topic is one of the provided strings
          topics: [this.topics],
        },
      ],
      limit: this.limit,
    };

    let response: SorobanRpc.Api.GetEventsResponse;
    try {
      response = await this.server.getEvents(request);
    } catch {
      return [];
    }

    if (!response || !Array.isArray(response.events)) {
      return [];
    }

    const results: RpcEvent[] = [];
    for (const raw of response.events) {
      // Enforce optional upper-bound ledger filter
      if (this.toLedger !== undefined && raw.ledger > this.toLedger) continue;

      try {
        const decoded = this.decodeEvent(raw);
        if (decoded) results.push(decoded);
      } catch {
        // Skip malformed events — same lenient behaviour as EventParser
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private decodeEvent(raw: SorobanRpc.Api.EventResponse): RpcEvent | null {
    // Decode the first topic as a string
    const topicArray = raw.topic;
    if (!topicArray || topicArray.length === 0) return null;

    const topicName = scValToString(topicArray[0]);
    if (!topicName) return null;

    // Decode the event data map
    const fields = buildFieldMap(raw.value);

    // Resolve the contract address string
    const contractId = raw.contractId ? raw.contractId.toString() : "";

    // Parse timestamp from ISO string
    const timestamp = raw.ledgerClosedAt
      ? Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000)
      : raw.ledger;

    return {
      topicName,
      fields,
      contractId,
      ledger: raw.ledger,
      timestamp,
      txHash: raw.txHash ?? "",
    };
  }
}
