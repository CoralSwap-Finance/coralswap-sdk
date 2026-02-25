import { xdr, Address, SorobanRpc } from '@stellar/stellar-sdk';
import {
  CoralSwapEvent,
  ContractEvent,
  SwapEvent,
  LiquidityEvent,
  FlashLoanEvent,
  MintEvent,
  BurnEvent,
  SyncEvent,
  FeeUpdateEvent,
} from '../types/events';
import { ValidationError } from '../errors';

/** Response type that may include hash/id for transaction identifier. */
type TxWithOptionalHash = SorobanRpc.Api.GetSuccessfulTransactionResponse & {
  hash?: string;
  id?: string;
};

// ---------------------------------------------------------------------------
// Known event topic symbols emitted by CoralSwap Pair contracts
// ---------------------------------------------------------------------------

/** Recognised event topic identifiers. */
export const EVENT_TOPICS = {
  SWAP: 'swap',
  ADD_LIQUIDITY: 'add_liquidity',
  REMOVE_LIQUIDITY: 'remove_liquidity',
  FLASH_LOAN: 'flash_loan',
  MINT: 'mint',
  BURN: 'burn',
  SYNC: 'sync',
  FEE_UPDATE: 'fee_update',
} as const;

const KNOWN_TOPICS = new Set<string>(Object.values(EVENT_TOPICS));

// ---------------------------------------------------------------------------
// ScVal decoding helpers (safe-guarded against invalid XDR)
// ---------------------------------------------------------------------------

/**
 * Decode an ScVal i128 to a bigint.
 */
function decodeI128(val: xdr.ScVal): bigint {
  const parts = val.i128();
  const lo = BigInt(parts.lo().toString());
  const hi = BigInt(parts.hi().toString());
  return (hi << 64n) + lo;
}

/**
 * Decode an ScVal u32 to a number.
 */
function decodeU32(val: xdr.ScVal): number {
  return val.u32();
}

/**
 * Decode an ScVal address to a string.
 */
function decodeAddress(val: xdr.ScVal): string {
  return Address.fromScVal(val).toString();
}

/**
 * Decode an ScVal symbol or string to a JS string.
 */
function decodeString(val: xdr.ScVal): string {
  const tag = val.switch().name;
  if (tag === 'scvSymbol') return val.sym().toString();
  if (tag === 'scvString') return val.str().toString();
  return val.value()?.toString() ?? '';
}

/**
 * Safely extract a value from an ScMap by key name.
 */
function getMapValue(map: xdr.ScMapEntry[], key: string): xdr.ScVal | undefined {
  for (const entry of map) {
    const k = entry.key();
    const tag = k.switch().name;
    let keyStr: string | undefined;
    if (tag === 'scvSymbol') keyStr = k.sym().toString();
    else if (tag === 'scvString') keyStr = k.str().toString();
    if (keyStr === key) return entry.val();
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
    const ce = evt.event();
    if (ce.contractId()) {
      return Address.contract(ce.contractId()!).toString();
    }
  } catch {
    // contractId may be absent for system events
  }
  return '';
}

/**
 * Extract the topic ScVal array from a DiagnosticEvent.
 */
function extractTopics(evt: xdr.DiagnosticEvent): xdr.ScVal[] {
  const ce = evt.event();
  const body = ce.body();
  return body.v0().topics();
}

/**
 * Extract the data ScVal from a DiagnosticEvent.
 */
function extractData(evt: xdr.DiagnosticEvent): xdr.ScVal {
  const ce = evt.event();
  const body = ce.body();
  return body.v0().data();
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
    txHash = '',
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
    txHash = '',
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
    response: SorobanRpc.Api.GetSuccessfulTransactionResponse,
  ): CoralSwapEvent[] {
    const meta = response.resultMetaXdr;
    const v3 = meta.v3();
    const diagnosticEvents = v3.sorobanMeta()?.diagnosticEvents() ?? [];
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
    if (!evt.inSuccessfulContractCall()) return null;

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

    const topicName = decodeString(topics[0]);
    if (!KNOWN_TOPICS.has(topicName)) return null;

    const base: Omit<ContractEvent, 'type'> = {
      contractId,
      ledger,
      timestamp: ledger,
      txHash,
    };

    switch (topicName) {
      case EVENT_TOPICS.SWAP:
        return this.parseSwap(data, base);
      case EVENT_TOPICS.ADD_LIQUIDITY:
      case EVENT_TOPICS.REMOVE_LIQUIDITY:
        return this.parseLiquidity(data, base, topicName as 'add_liquidity' | 'remove_liquidity');
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
    base: Omit<ContractEvent, 'type'>,
  ): SwapEvent {
    const map = data.map();
    if (!map) throw new ValidationError('Swap event data is not an ScMap');

    return {
      ...base,
      type: 'swap',
      sender: decodeAddress(requireMapValue(map, 'sender')),
      tokenIn: decodeAddress(requireMapValue(map, 'token_in')),
      tokenOut: decodeAddress(requireMapValue(map, 'token_out')),
      amountIn: decodeI128(requireMapValue(map, 'amount_in')),
      amountOut: decodeI128(requireMapValue(map, 'amount_out')),
      feeBps: decodeU32(requireMapValue(map, 'fee_bps')),
    };
  }

  private parseLiquidity(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
    type: 'add_liquidity' | 'remove_liquidity',
  ): LiquidityEvent {
    const map = data.map();
    if (!map) throw new ValidationError('Liquidity event data is not an ScMap');

    return {
      ...base,
      type,
      provider: decodeAddress(requireMapValue(map, 'provider')),
      tokenA: decodeAddress(requireMapValue(map, 'token_a')),
      tokenB: decodeAddress(requireMapValue(map, 'token_b')),
      amountA: decodeI128(requireMapValue(map, 'amount_a')),
      amountB: decodeI128(requireMapValue(map, 'amount_b')),
      liquidity: decodeI128(requireMapValue(map, 'liquidity')),
    };
  }

  private parseFlashLoan(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
  ): FlashLoanEvent {
    const map = data.map();
    if (!map) throw new ValidationError('FlashLoan event data is not an ScMap');

    return {
      ...base,
      type: 'flash_loan',
      borrower: decodeAddress(requireMapValue(map, 'borrower')),
      token: decodeAddress(requireMapValue(map, 'token')),
      amount: decodeI128(requireMapValue(map, 'amount')),
      fee: decodeI128(requireMapValue(map, 'fee')),
    };
  }

  private parseMint(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
  ): MintEvent {
    const map = data.map();
    if (!map) throw new ValidationError('Mint event data is not an ScMap');

    return {
      ...base,
      type: 'mint',
      sender: decodeAddress(requireMapValue(map, 'sender')),
      amountA: decodeI128(requireMapValue(map, 'amount_a')),
      amountB: decodeI128(requireMapValue(map, 'amount_b')),
      liquidity: decodeI128(requireMapValue(map, 'liquidity')),
    };
  }

  private parseBurn(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
  ): BurnEvent {
    const map = data.map();
    if (!map) throw new ValidationError('Burn event data is not an ScMap');

    return {
      ...base,
      type: 'burn',
      sender: decodeAddress(requireMapValue(map, 'sender')),
      amountA: decodeI128(requireMapValue(map, 'amount_a')),
      amountB: decodeI128(requireMapValue(map, 'amount_b')),
      liquidity: decodeI128(requireMapValue(map, 'liquidity')),
      to: decodeAddress(requireMapValue(map, 'to')),
    };
  }

  private parseSync(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
  ): SyncEvent {
    const map = data.map();
    if (!map) throw new ValidationError('Sync event data is not an ScMap');

    return {
      ...base,
      type: 'sync',
      reserve0: decodeI128(requireMapValue(map, 'reserve0')),
      reserve1: decodeI128(requireMapValue(map, 'reserve1')),
    };
  }

  private parseFeeUpdate(
    data: xdr.ScVal,
    base: Omit<ContractEvent, 'type'>,
  ): FeeUpdateEvent {
    const map = data.map();
    if (!map) throw new ValidationError('FeeUpdate event data is not an ScMap');

    return {
      ...base,
      type: 'fee_update',
      previousFeeBps: decodeU32(requireMapValue(map, 'previous_fee_bps')),
      newFeeBps: decodeU32(requireMapValue(map, 'new_fee_bps')),
      volatility: decodeI128(requireMapValue(map, 'volatility')),
    };
  }
}
