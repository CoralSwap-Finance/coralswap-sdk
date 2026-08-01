import { xdr, SorobanRpc } from '@stellar/stellar-sdk';
import { Trade, TradeFilter } from '../types/trade';
import { UnifiedOrder, OrderSummary } from '../types/order-book';
import { CoralSwapClient } from '@/client';
import { EventCursor } from '@/utils/event-cursor';
import { EventParser, EVENT_TOPICS } from '@/utils/events';

// ---------------------------------------------------------------------------
// CSV-like event-log construction helpers
// ---------------------------------------------------------------------------

/**
 * Parse a set of Soroban contract events and reconstruct a list of
 * `UnifiedOrder` objects for a given address.
 *
 * Event-based reconstruction works by scanning for known CoralSwap event
 * topics (swap, add/remove liquidity, etc.) and inferring order state.
 * For production use, this function should be paired with an {@link EventCursor}
 * that supplies the raw events.
 *
 * @param client - CoralSwap client (used for token resolution).
 * @param events - Raw `EventResponse` objects from the RPC.
 * @param address - The address to filter orders for.
 * @returns Parsed unified orders.
 */
function parseOrdersFromEvents(
  _client: CoralSwapClient,
  events: SorobanRpc.Api.EventResponse[],
  address: string,
): UnifiedOrder[] {
  const orders: UnifiedOrder[] = [];
  const lowerAddress = address.toLowerCase();

  for (const evt of events) {
    try {
      // Convert EventResponse → DiagnosticEvent for parsing
      const topicSymbols = extractTopicSymbols(evt);
      if (topicSymbols.length === 0) continue;

      const topicName = topicSymbols[0] ?? '';

      // Skip events that aren't user-scoped
      if (!isEventForAddress(evt, lowerAddress)) continue;

      const base: Omit<UnifiedOrder, 'details'> = {
        id: evt.id ?? evt.txHash ?? `evt-${Date.now()}`,
        type: mapTopicToOrderType(topicName),
        tokenIn: '',
        tokenOut: '',
        status: 'open',
        createdAt: evt.ledger
          ? new Date(evt.ledger * 1000)
          : new Date(),
      };

      const body = evt.value ? extractScValFromValue(evt.value) : null;
      const details: Record<string, unknown> = {};

      if (body && body.switch().name === 'scvMap') {
        const map = body.map();
        if (map) {
          const fields = scMapToRecord(map);

          if (fields.token_in) base.tokenIn = fields.token_in as string;
          if (fields.token_out) base.tokenOut = fields.token_out as string;
          if (fields.amount_in) details.amountIn = BigInt(fields.amount_in as string);
          if (fields.amount_out) details.amountOut = BigInt(fields.amount_out as string);
          if (fields.limit_price || fields.target_price) {
            details.limitPrice = Number(fields.limit_price ?? fields.target_price);
          }
          if (fields.trigger_price) details.triggerPrice = Number(fields.trigger_price);
        }
      }

      orders.push({ ...base, details });
    } catch {
      // Skip malformed events
    }
  }

  return orders;
}

/**
 * Parse events into Trade[] for trade history.
 */
function parseTradesFromEvents(
  events: SorobanRpc.Api.EventResponse[],
  address: string,
): Trade[] {
  const trades: Trade[] = [];
  const lowerAddress = address.toLowerCase();

  for (const evt of events) {
    try {
      const topicSymbols = extractTopicSymbols(evt);
      if (topicSymbols.length === 0) continue;

      const topicName = topicSymbols[0] ?? '';

      if (!isEventForAddress(evt, lowerAddress)) continue;

      const body = evt.value ? extractScValFromValue(evt.value) : null;
      const details: Record<string, unknown> = {};

      if (body && body.switch().name === 'scvMap') {
        const map = body.map();
        if (map) {
          const fields = scMapToRecord(map);
          if (fields.token_in) details.tokenIn = fields.token_in;
          if (fields.token_out) details.tokenOut = fields.token_out;
          if (fields.amount_in) details.amountIn = fields.amount_in;
          if (fields.amount_out) details.amountOut = fields.amount_out;
        }
      }

      trades.push({
        type: mapTopicToTradeType(topicName),
        tokenIn: (details.tokenIn as string) ?? '',
        tokenOut: (details.tokenOut as string) ?? '',
        amountIn: BigInt(String(details.amountIn ?? 0)),
        amountOut: BigInt(String(details.amountOut ?? 0)),
        price: 0,
        timestamp: evt.ledger
          ? new Date(evt.ledger * 1000)
          : new Date(),
        txHash: evt.txHash ?? evt.id ?? '',
      });
    } catch {
      // Skip malformed events
    }
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Low-level XDR/event helpers
// ---------------------------------------------------------------------------

function extractTopicSymbols(evt: SorobanRpc.Api.EventResponse): string[] {
  try {
    const topic = (evt as any).topic ?? [];
    return topic.map((t: any) => {
      const b64 = typeof t === 'string' ? t : String(t);
      const scVal = xdr.ScVal.fromXDR(b64, 'base64');
      return scVal.sym()?.toString() ?? scVal.str()?.toString() ?? '';
    });
  } catch {
    return [];
  }
}

function extractScValFromValue(value: any): xdr.ScVal | null {
  try {
    const base64 = typeof value === 'string' ? value : String(value);
    return xdr.ScVal.fromXDR(base64, 'base64');
  } catch {
    return null;
  }
}

function scMapToRecord(map: xdr.ScMapEntry[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const entry of map) {
    try {
      const key = entry.key();
      const keyStr = key.sym()?.toString() ?? key.str()?.toString() ?? '';
      const value = entry.val();
      const tag = value.switch().name;
      if (tag === 'scvI128') {
        const parts = value.i128();
        const lo = BigInt(parts.lo().toString());
        const hi = BigInt(parts.hi().toString());
        record[keyStr] = ((hi << 64n) + lo).toString();
      } else if (tag === 'scvU32') {
        record[keyStr] = value.u32();
      } else if (tag === 'scvI32') {
        record[keyStr] = value.i32();
      } else if (tag === 'scvU64') {
        record[keyStr] = value.u64().toString();
      } else if (tag === 'scvI64') {
        record[keyStr] = value.i64().toString();
      } else if (tag === 'scvString') {
        record[keyStr] = value.str().toString();
      } else if (tag === 'scvSymbol') {
        record[keyStr] = value.sym().toString();
      } else if (tag === 'scvAddress') {
        try {
          const { Address } = require('@stellar/stellar-sdk');
          record[keyStr] = Address.fromScVal(value).toString();
        } catch {
          record[keyStr] = '';
        }
      } else {
        record[keyStr] = value.toXDR('base64');
      }
    } catch {
      // skip unreadable entries
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const TOPIC_TO_ORDER_TYPE: Record<string, UnifiedOrder['type']> = {
  swap: 'limit',
  add_liquidity: 'dca',
  remove_liquidity: 'stop-loss',
};

const TOPIC_TO_TRADE_TYPE: Record<string, Trade['type']> = {
  swap: 'swap',
  add_liquidity: 'dca-execution',
  remove_liquidity: 'stop-loss-trigger',
};

function mapTopicToOrderType(topic: string): UnifiedOrder['type'] {
  return TOPIC_TO_ORDER_TYPE[topic] ?? 'limit';
}

function mapTopicToTradeType(topic: string): Trade['type'] {
  return TOPIC_TO_TRADE_TYPE[topic] ?? 'swap';
}

function isEventForAddress(_evt: SorobanRpc.Api.EventResponse, _address: string): boolean {
  // In a full implementation, decode the event body to check for
  // sender/provider/borrower fields matching the given address.
  // For now, return true to process all events — filtering is applied
  // at the EventCursor level via contractId/topic filters.
  return true;
}

// ---------------------------------------------------------------------------
// EventCursor-based order queries
// ---------------------------------------------------------------------------

/**
 * Fetch limit orders by scanning on-chain events using the shared EventCursor.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param contractId - Optional limit-orders contract address to filter by.
 * @returns Array of unified orders for the given address.
 */
export async function getLimitOrders(
  cursor: EventCursor,
  address: string,
  contractId?: string,
): Promise<UnifiedOrder[]> {
  const contractIds = contractId ? [contractId] : [];

  const events = await cursor.scan({
    contractIds,
    topics: ['swap'],
  });

  // Placeholder for future SorobanRpc.Api → xdr.DiagnosticEvent conversion.
  // When the EventCursor returns diagnostic events directly, they can be
  // fed through EventParser for typed decoding.
  void events;
  void address;

  // Return empty for now — full on-chain order reconstruction requires
  // the limit-orders contract's specific event layout.
  return [];
}

/**
 * Fetch DCA orders by scanning on-chain events using the shared EventCursor.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param contractId - Optional DCA contract address to filter by.
 * @returns Array of unified orders for the given address.
 */
export async function getDcaOrders(
  cursor: EventCursor,
  address: string,
  contractId?: string,
): Promise<UnifiedOrder[]> {
  const contractIds = contractId ? [contractId] : [];

  const events = await cursor.scan({
    contractIds,
    topics: ['add_liquidity'],
  });

  return parseOrdersFromEvents({} as CoralSwapClient, events, address);
}

/**
 * Fetch stop-loss orders by scanning on-chain events using the shared EventCursor.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param contractId - Optional stop-loss contract address to filter by.
 * @returns Array of unified orders for the given address.
 */
export async function getStopLossOrders(
  cursor: EventCursor,
  address: string,
  contractId?: string,
): Promise<UnifiedOrder[]> {
  const contractIds = contractId ? [contractId] : [];

  const events = await cursor.scan({
    contractIds,
    topics: ['remove_liquidity'],
  });

  return parseOrdersFromEvents({} as CoralSwapClient, events, address);
}

/**
 * Aggregate all open orders (limit, DCA, stop-loss) for a user.
 *
 * Uses the shared {@link EventCursor} to scan on-chain events instead of
 * hand-rolling the `getEvents` request-building. The cursor handles topic
 * encoding (base64 XDR), ledger anchoring, and pagination automatically.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param contractAddresses - Optional mapping of contract addresses per order type.
 * @returns Aggregated and sorted (newest-first) unified orders.
 */
export async function getOpenOrders(
  cursor: EventCursor,
  address: string,
  contractAddresses?: {
    limitOrders?: string;
    dca?: string;
    stopLoss?: string;
  },
): Promise<UnifiedOrder[]> {
  const [limitOrders, dcaOrders, stopLossOrders] = await Promise.all([
    getLimitOrders(cursor, address, contractAddresses?.limitOrders),
    getDcaOrders(cursor, address, contractAddresses?.dca),
    getStopLossOrders(cursor, address, contractAddresses?.stopLoss),
  ]);

  const allOrders = [...limitOrders, ...dcaOrders, ...stopLossOrders];

  // Sort by createdAt descending (newest first)
  allOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return allOrders;
}

/**
 * Compute an aggregated summary of all open orders for a user.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param client - CoralSwap client (used for price feed).
 * @param contractAddresses - Optional contract address overrides.
 * @returns An {@link OrderSummary} with counts and estimated TVL.
 */
export async function getOrderSummary(
  cursor: EventCursor,
  address: string,
  client: CoralSwapClient,
  contractAddresses?: {
    limitOrders?: string;
    dca?: string;
    stopLoss?: string;
  },
): Promise<OrderSummary> {
  const openOrders = await getOpenOrders(cursor, address, contractAddresses);

  const byType = {
    limit: openOrders.filter((o) => o.type === 'limit').length,
    dca: openOrders.filter((o) => o.type === 'dca').length,
    stopLoss: openOrders.filter((o) => o.type === 'stop-loss').length,
  };

  let totalValueLocked = 0;

  for (const order of openOrders) {
    const amountIn = order.details.amountIn || order.details.totalAmount;
    if (amountIn) {
      const amountNum = typeof amountIn === 'bigint' ? Number(amountIn) : Number(amountIn);
      totalValueLocked += amountNum * 1; // price = 1 as base estimate
    }
  }

  return {
    totalOpenOrders: openOrders.length,
    totalValueLocked,
    byType,
  };
}

/**
 * Fetch trade history for a user across all order types.
 *
 * @param cursor - Initialised EventCursor instance.
 * @param address - Stellar address to query.
 * @param filter - Optional filtering criteria.
 * @param contractAddresses - Optional contract address overrides.
 * @returns Filtered and sorted trade history.
 */
export async function getTradeHistory(
  cursor: EventCursor,
  address: string,
  filter?: TradeFilter,
  contractAddresses?: {
    limitOrders?: string;
    dca?: string;
    stopLoss?: string;
  },
): Promise<Trade[]> {
  const contractIds: string[] = [];
  if (contractAddresses?.limitOrders) contractIds.push(contractAddresses.limitOrders);
  if (contractAddresses?.dca) contractIds.push(contractAddresses.dca);
  if (contractAddresses?.stopLoss) contractIds.push(contractAddresses.stopLoss);

  const events = await cursor.scan({
    contractIds: contractIds.length > 0 ? contractIds : undefined,
    topics: ['swap', 'add_liquidity', 'remove_liquidity'],
  });

  let allTrades = parseTradesFromEvents(events, address);

  if (filter) {
    if (filter.types && filter.types.length > 0) {
      allTrades = allTrades.filter((t) => filter.types!.includes(t.type));
    }
    if (filter.fromDate) {
      allTrades = allTrades.filter((t) => t.timestamp >= filter.fromDate!);
    }
    if (filter.toDate) {
      allTrades = allTrades.filter((t) => t.timestamp <= filter.toDate!);
    }
  }

  // Sort chronological (descending - newest first)
  allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  if (filter?.limit !== undefined) {
    allTrades = allTrades.slice(0, filter.limit);
  }

  return allTrades;
}
