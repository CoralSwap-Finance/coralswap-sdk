import { xdr, Address, rpc } from "@stellar/stellar-sdk";
import {
  CoralSwapEvent,
  ContractEvent,
  SwapEvent,
  LiquidityEvent,
  FlashLoanContractEvent,
  MintEvent,
  BurnEvent,
  SyncEvent,
  FeeUpdateEvent,
} from "@/types/events";
import { ValidationError } from "@/errors";

/** Response type that may include hash/id for transaction identifier. */
type TxWithOptionalHash = rpc.Api.GetSuccessfulTransactionResponse & {
  hash?: string;
  id?: string;
};

// ---------------------------------------------------------------------------
// Known event topic symbols emitted by CoralSwap Pair contracts
// ---------------------------------------------------------------------------

/** Recognised event topic identifiers. */
export const EVENT_TOPICS = {
  SWAP: "swap",
  ADD_LIQUIDITY: "add_liquidity",
  REMOVE_LIQUIDITY: "remove_liquidity",
  FLASH_LOAN: "flash_loan",
  MINT: "mint",
  BURN: "burn",
  SYNC: "sync",
  FEE_UPDATE: "fee_update",
} as const;

const KNOWN_TOPICS = new Set<string>(Object.values(EVENT_TOPICS));

// ---------------------------------------------------------------------------
// ScVal decoding helpers (safe-guarded against invalid XDR)
// ---------------------------------------------------------------------------

/**
 * Decode an ScVal i128 to a bigint.
 * Throws ValidationError on type mismatch rather than fabricating a zero fallback.
 */
function decodeI128(val: xdr.ScVal): bigint {
  if (val.type !== "scvI128") {
    throw new ValidationError(`Expected i128 ScVal, got ${val.type}`);
  }
  const i128 = val.i128 as unknown;
  if (typeof i128 === "bigint") return i128;
  const parts = i128 as { hi: bigint; lo: bigint };
  return (parts.hi << 64n) + parts.lo;
}

/**
 * Decode an ScVal u32 to a number.
 * Throws ValidationError on type mismatch rather than fabricating a zero fallback.
 */
function decodeU32(val: xdr.ScVal): number {
  if (val.type !== "scvU32") {
    throw new ValidationError(`Expected u32 ScVal, got ${val.type}`);
  }
  return val.u32;
}

/**
 * Decode an ScVal address to a string.
 * Throws ValidationError on invalid address ScVal.
 */
function decodeAddress(val: xdr.ScVal): string {
  try {
    return Address.fromScVal(val).toString();
  } catch (err) {
    throw new ValidationError(
      `Invalid address ScVal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Decode an ScVal symbol or string to a JS string.
 * Throws ValidationError on type mismatch rather than fabricating an empty string.
 */
function decodeString(val: xdr.ScVal): string {
  if (val.type === "scvSymbol") return val.sym.toString();
  if (val.type === "scvString") return val.str.toString();
  throw new ValidationError(`Expected symbol or string ScVal, got ${val.type}`);
}

/**
 * Safely extract a value from an ScMap by key name.
 */
function getMapValue(
  map: xdr.ScMapEntry[],
  key: string,
): xdr.ScVal | undefined {
  for (const entry of map) {
    const k = entry.key;
    let keyStr: string | undefined;
    if (k.type === "scvSymbol") keyStr = k.sym.toString();
    else if (k.type === "scvString") keyStr = k.str.toString();
    if (keyStr === key) return entry.val;
  }
  return undefined;
}

/**
 * Require a value from an ScMap by key, throwing if absent.
 */
function requireMapValue(map: xdr.ScMapEntry[], key: string): xdr.ScVal {
  const val = getMapValue(map, key);
  if (!val) {
    throw new ValidationError(`Missing required event field: ${key}`);
  }
  return val;
}

/**
 * Extract the contract ID from an xdr.DiagnosticEvent.
 * Returns an empty string if unavailable.
 */
function extractContractId(evt: xdr.DiagnosticEvent): string {
  try {
    const contractId = evt.event.contractId;
    if (contractId) {
      return Address.contract(contractId as unknown as Uint8Array).toString();
    }
  } catch {
    // contractId may be absent for system events
  }
  return "";
}

/**
 * Extract the topic ScVal array from a DiagnosticEvent.
 */
function extractTopics(evt: xdr.DiagnosticEvent): xdr.ScVal[] {
  const body = evt.event.body;
  if (body.type !== "v0") return [];
  return body.v0.topics;
}

/**
 * Extract the data ScVal from a DiagnosticEvent.
 */
function extractData(evt: xdr.DiagnosticEvent): xdr.ScVal {
  const body = evt.event.body;
  if (body.type !== "v0") {
    throw new ValidationError("Unsupported event body version");
  }
  return body.v0.data;
}

// ---------------------------------------------------------------------------
// EventParser
// ---------------------------------------------------------------------------

/**
 * Utility for parsing Soroban contract events emitted by CoralSwap Pair
 * contracts into typed {@link CoralSwapEvent} objects.
 *
 * Supports two primary entry points:
 * - {@link parse} — accepts an array of `xdr.DiagnosticEvent` (from
 *   transaction simulation or result meta).
 * - {@link fromTransaction} — extracts and parses events directly from a
 *   successful Soroban transaction response.
 *
 * Events with unrecognised topics or from non-CoralSwap contracts are
 * silently skipped. Use {@link parseStrict} to throw on any parse failure.
 *
 * @example
 * ```ts
 * import { EventParser } from '@coralswap/sdk';
 *
 * const parser = new EventParser();
 *
 * // From a successful transaction response
 * const events = parser.fromTransaction(txResponse);
 *
 * // From raw DiagnosticEvent array
 * const parsed = parser.parse(diagnosticEvents);
 * ```
 */
export class EventParser {
  private readonly contractIds: Set<string>;

  /**
   * @param contractIds - Optional set of CoralSwap contract addresses. When
   *   provided, only events from these contracts are parsed; all others are
   *   ignored. Pass an empty array to parse events from any contract.
   */
  constructor(contractIds: string[] = []) {
    this.contractIds = new Set(contractIds);
  }

  /**
   * Parse an array of `xdr.DiagnosticEvent`, skipping unrecognised entries.
   *
   * @param events - Diagnostic events from transaction result meta.
   * @param txHash - Transaction hash to attach to parsed events.
   * @param ledger - Ledger sequence number.
   * @returns Array of typed CoralSwapEvent (only successfully parsed events).
   */
  parse(
    events: xdr.DiagnosticEvent[],
    txHash = "",
    ledger = 0,
  ): CoralSwapEvent[] {
    const parsed: CoralSwapEvent[] = [];
    for (const evt of events) {
      try {
        const result = this.decodeSingle(evt, txHash, ledger);
        if (result) parsed.push(result);
      } catch {
        // Skip malformed events in lenient mode
      }
    }
    return parsed;
  }

  /**
   * Parse events, throwing on any decode failure.
   *
   * @param events - Diagnostic events from transaction result meta.
   * @param txHash - Transaction hash to attach to parsed events.
   * @param ledger - Ledger sequence number.
   * @returns Array of typed CoralSwapEvent.
   * @throws {ValidationError} If any recognised event cannot be decoded.
   */
  parseStrict(
    events: xdr.DiagnosticEvent[],
    txHash = "",
    ledger = 0,
  ): CoralSwapEvent[] {
    const parsed: CoralSwapEvent[] = [];
    for (const evt of events) {
      const result = this.decodeSingle(evt, txHash, ledger);
      if (result) parsed.push(result);
    }
    return parsed;
  }

  /**
   * Extract and parse events from a successful Soroban transaction response.
   *
   * @param response - A successful transaction response from Soroban RPC.
   * @returns Array of typed CoralSwapEvent.
   */
  fromTransaction(
    response: rpc.Api.GetSuccessfulTransactionResponse,
  ): CoralSwapEvent[] {
    const meta = response.resultMetaXdr;
    if (meta.type !== "v3") return [];
    const diagnosticEvents = meta.v3.sorobanMeta?.diagnosticEvents ?? [];
    const tx = response as TxWithOptionalHash;
    const txHash = tx.hash ?? tx.id ?? '';

    const ledger = response.ledger ?? 0;
    return this.parse(diagnosticEvents, txHash, ledger);
  }

  // -------------------------------------------------------------------------
  // Internal decode logic
  // -------------------------------------------------------------------------

  /**
   * Decode a single DiagnosticEvent. Returns null when the event is not a
   * recognised CoralSwap event (unknown topic or filtered contract).
   */
  private decodeSingle(
    evt: xdr.DiagnosticEvent,
    txHash: string,
    ledger: number,
  ): CoralSwapEvent | null {
    // Only process contract-type events that ran in a successful call
    if (!evt.inSuccessfulContractCall) return null;

    const contractId = extractContractId(evt);

    // If contract filter is configured, skip non-matching contracts
    if (this.contractIds.size > 0 && !this.contractIds.has(contractId)) {
      return null;
    }

    let topics: xdr.ScVal[];
    let data: xdr.ScVal;
    try {
      topics = extractTopics(evt);
      data = extractData(evt);
    } catch {
      return null;
    }

    if (topics.length === 0) return null;

    let topicName: string;
    try {
      topicName = decodeString(topics[0]);
    } catch {
      return null;
    }
    if (!KNOWN_TOPICS.has(topicName)) return null;

    const base: Omit<ContractEvent, "type"> = {
      contractId,
      ledger,
      timestamp: ledger,
      txHash,
      decodeStatus: "complete",
    };

    switch (topicName) {
      case EVENT_TOPICS.SWAP:
        return this.parseSwap(data, base);
      case EVENT_TOPICS.ADD_LIQUIDITY:
      case EVENT_TOPICS.REMOVE_LIQUIDITY:
        return this.parseLiquidity(
          data,
          base,
          topicName as "add_liquidity" | "remove_liquidity",
        );
      case EVENT_TOPICS.FLASH_LOAN:
        return this.parseFlashLoan(data, base);
      case EVENT_TOPICS.MINT:
        return this.parseMint(data, base);
      case EVENT_TOPICS.BURN:
        return this.parseBurn(data, base);
      case EVENT_TOPICS.SYNC:
        return this.parseSync(data, base);
      case EVENT_TOPICS.FEE_UPDATE:
        return this.parseFeeUpdate(data, base);
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Per-event parsers
  // -------------------------------------------------------------------------

  private parseSwap(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): SwapEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("Swap event data is not an ScMap");

    return {
      ...base,
      type: "swap",
      sender: decodeAddress(requireMapValue(map, "sender")),
      tokenIn: decodeAddress(requireMapValue(map, "token_in")),
      tokenOut: decodeAddress(requireMapValue(map, "token_out")),
      amountIn: decodeI128(requireMapValue(map, "amount_in")),
      amountOut: decodeI128(requireMapValue(map, "amount_out")),
      feeBps: decodeU32(requireMapValue(map, "fee_bps")),
    };
  }

  private parseLiquidity(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
    type: "add_liquidity" | "remove_liquidity",
  ): LiquidityEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("Liquidity event data is not an ScMap");

    return {
      ...base,
      type,
      provider: decodeAddress(requireMapValue(map, "provider")),
      tokenA: decodeAddress(requireMapValue(map, "token_a")),
      tokenB: decodeAddress(requireMapValue(map, "token_b")),
      amountA: decodeI128(requireMapValue(map, "amount_a")),
      amountB: decodeI128(requireMapValue(map, "amount_b")),
      liquidity: decodeI128(requireMapValue(map, "liquidity")),
    };
  }

  private parseFlashLoan(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): FlashLoanContractEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("FlashLoan event data is not an ScMap");

    return {
      ...base,
      type: "flash_loan",
      borrower: decodeAddress(requireMapValue(map, "borrower")),
      token: decodeAddress(requireMapValue(map, "token")),
      amount: decodeI128(requireMapValue(map, "amount")),
      fee: decodeI128(requireMapValue(map, "fee")),
    };
  }

  private parseMint(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): MintEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("Mint event data is not an ScMap");

    return {
      ...base,
      type: "mint",
      sender: decodeAddress(requireMapValue(map, "sender")),
      amountA: decodeI128(requireMapValue(map, "amount_a")),
      amountB: decodeI128(requireMapValue(map, "amount_b")),
      liquidity: decodeI128(requireMapValue(map, "liquidity")),
    };
  }

  private parseBurn(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): BurnEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("Burn event data is not an ScMap");

    return {
      ...base,
      type: "burn",
      sender: decodeAddress(requireMapValue(map, "sender")),
      amountA: decodeI128(requireMapValue(map, "amount_a")),
      amountB: decodeI128(requireMapValue(map, "amount_b")),
      liquidity: decodeI128(requireMapValue(map, "liquidity")),
      to: decodeAddress(requireMapValue(map, "to")),
    };
  }

  private parseSync(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): SyncEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("Sync event data is not an ScMap");

    return {
      ...base,
      type: "sync",
      reserve0: decodeI128(requireMapValue(map, "reserve0")),
      reserve1: decodeI128(requireMapValue(map, "reserve1")),
    };
  }

  private parseFeeUpdate(
    data: xdr.ScVal,
    base: Omit<ContractEvent, "type">,
  ): FeeUpdateEvent {
    const map = data.type === "scvMap" ? data.map : undefined;
    if (!map) throw new ValidationError("FeeUpdate event data is not an ScMap");

    return {
      ...base,
      type: "fee_update",
      previousFeeBps: decodeU32(requireMapValue(map, "previous_fee_bps")),
      newFeeBps: decodeU32(requireMapValue(map, "new_fee_bps")),
      volatility: decodeI128(requireMapValue(map, "volatility")),
    };
  }
}

// ---------------------------------------------------------------------------
// decodeEvents utility
// ---------------------------------------------------------------------------

export interface DecodeEventsOptions {
  contractId?: string;
  strict?: boolean;
}

/**
 * Decode Pair contract events from a successful Soroban transaction response.
 *
 * This utility extracts and parses Swap, Mint, Burn, and Sync events (among
 * others) from the transaction result meta XDR into strongly-typed objects.
 *
 * @param response - A successful transaction response from Soroban RPC.
 * @param options - Optional configuration for filtering and parsing behavior.
 * @param options.contractId - If provided, only events from this contract are decoded.
 * @param options.strict - If true, throws on malformed event data. Defaults to false.
 * @returns Array of typed CoralSwapEvent objects.
 *
 * @example
 * ```ts
 * import { decodeEvents } from '@coralswap/sdk';
 *
 * const events = decodeEvents(txResponse);
 * for (const event of events) {
 *   if (event.type === 'swap') {
 *     console.log(`Swapped ${event.amountIn} for ${event.amountOut}`);
 *   }
 * }
 * ```
 *
 * @example
 * ```ts
 * // Filter events from a specific pair contract
 * const pairEvents = decodeEvents(txResponse, {
 *   contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
 * });
 * ```
 */
export function decodeEvents(
  response: rpc.Api.GetSuccessfulTransactionResponse,
  options: DecodeEventsOptions = {},
): CoralSwapEvent[] {
  const contractIds = options.contractId ? [options.contractId] : [];
  const parser = new EventParser(contractIds);

  const meta = response.resultMetaXdr;
  if (meta.type !== "v3") return [];
  const diagnosticEvents = meta.v3.sorobanMeta?.diagnosticEvents ?? [];
  const tx = response as TxWithOptionalHash;
  const txHash = tx.hash ?? tx.id ?? "";
  const ledger = response.ledger ?? 0;

  if (options.strict) {
    return parser.parseStrict(diagnosticEvents, txHash, ledger);
  }
  return parser.parse(diagnosticEvents, txHash, ledger);
}

/**
 * Decode Pair contract events from raw XDR diagnostic events.
 *
 * Use this when you have direct access to the DiagnosticEvent array from
 * transaction simulation or result meta, rather than the full transaction
 * response.
 *
 * @param events - Array of xdr.DiagnosticEvent from transaction result meta.
 * @param options - Optional configuration for filtering and parsing behavior.
 * @param options.contractId - If provided, only events from this contract are decoded.
 * @param options.strict - If true, throws on malformed event data. Defaults to false.
 * @param txHash - Transaction hash to attach to parsed events.
 * @param ledger - Ledger sequence number.
 * @returns Array of typed CoralSwapEvent objects.
 *
 * @example
 * ```ts
 * import { decodeEventsFromXdr } from '@coralswap/sdk';
 *
 * const meta = txResponse.resultMetaXdr;
 * if (meta.type === 'v3') {
 *   const diagnosticEvents = meta.v3.sorobanMeta?.diagnosticEvents ?? [];
 *   const events = decodeEventsFromXdr(diagnosticEvents);
 * }
 * ```
 */
export function decodeEventsFromXdr(
  events: xdr.DiagnosticEvent[],
  options: DecodeEventsOptions = {},
  txHash = "",
  ledger = 0,
): CoralSwapEvent[] {
  const contractIds = options.contractId ? [options.contractId] : [];
  const parser = new EventParser(contractIds);

  if (options.strict) {
    return parser.parseStrict(events, txHash, ledger);
  }
  return parser.parse(events, txHash, ledger);
}
