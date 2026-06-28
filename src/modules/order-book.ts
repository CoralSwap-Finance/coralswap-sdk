import { Trade, TradeFilter } from '../types/trade';
import { UnifiedOrder, OrderSummary } from '../types/order-book';
import { OracleModule } from './oracle';
import { CoralSwapClient } from '@/client';

// Mock data for open orders
const MOCK_OPEN_LIMIT_ORDERS: UnifiedOrder[] = [
  {
    id: 'limit-1',
    type: 'limit',
    tokenIn: 'USDC',
    tokenOut: 'ETH',
    status: 'open',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    details: {
      amountIn: 1000000000n,
      limitPrice: 2000,
    },
  },
];

const MOCK_OPEN_DCA_ORDERS: UnifiedOrder[] = [
  {
    id: 'dca-1',
    type: 'dca',
    tokenIn: 'USDC',
    tokenOut: 'BTC',
    status: 'open',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    details: {
      totalAmount: 5000000000n,
      executedAmount: 1000000000n,
      interval: 24 * 60 * 60, // 1 day
      nextExecution: new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  },
];

const MOCK_OPEN_STOP_LOSS_ORDERS: UnifiedOrder[] = [
  {
    id: 'stop-loss-1',
    type: 'stop-loss',
    tokenIn: 'BTC',
    tokenOut: 'USDC',
    status: 'open',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    details: {
      amountIn: 100000000n,
      triggerPrice: 40000,
    },
  },
];

export async function getLimitOrders(_address: string): Promise<UnifiedOrder[]> {
  // This is a mock implementation.
  return MOCK_OPEN_LIMIT_ORDERS;
}

export async function getDcaOrders(_address: string): Promise<UnifiedOrder[]> {
  // This is a mock implementation.
  return MOCK_OPEN_DCA_ORDERS;
}

export async function getStopLossOrders(_address: string): Promise<UnifiedOrder[]> {
  // This is a mock implementation.
  return MOCK_OPEN_STOP_LOSS_ORDERS;
}

export async function getOpenOrders(address: string): Promise<UnifiedOrder[]> {
  const limitOrders = await getLimitOrders(address);
  const dcaOrders = await getDcaOrders(address);
  const stopLossOrders = await getStopLossOrders(address);

  const allOrders = [...limitOrders, ...dcaOrders, ...stopLossOrders];

  // Sort by createdAt descending
  allOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return allOrders;
}

export async function getOrderSummary(
  address: string,
  client: CoralSwapClient,
): Promise<OrderSummary> {
  const openOrders = await getOpenOrders(address);

  const byType = {
    limit: openOrders.filter((o) => o.type === 'limit').length,
    dca: openOrders.filter((o) => o.type === 'dca').length,
    stopLoss: openOrders.filter((o) => o.type === 'stop-loss').length,
  };

  let totalValueLocked = 0;

  // Mock token prices for summary calculation
  const MOCK_PRICES: Record<string, number> = {
    USDC: 1,
    ETH: 2000,
    BTC: 50000,
  };

  for (const order of openOrders) {
    const amountIn = order.details.amountIn || order.details.totalAmount;
    if (amountIn) {
      const price = MOCK_PRICES[order.tokenIn] ?? 0;
      totalValueLocked += Number(amountIn) * price;
    }
  }

  return {
    totalOpenOrders: openOrders.length,
    totalValueLocked,
    byType,
  };
}

export async function getTradeHistory(address: string, filter?: TradeFilter): Promise<Trade[]> {
    // Mock implementations for all trade types
    const limitOrders: Trade[] = [
        {
          type: 'limit-fill',
          tokenIn: 'USDC',
          tokenOut: 'ETH',
          amountIn: 1000000000n,
          amountOut: 500000000000000000n,
          price: 2000,
          timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
          txHash: '0x' + '1'.repeat(64),
        },
      ];
    const dcaExecutions: Trade[] = [
        {
          type: 'dca-execution',
          tokenIn: 'USDC',
          tokenOut: 'BTC',
          amountIn: 500000000n,
          amountOut: 10000000n,
          price: 50000,
          timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
          txHash: '0x' + '2'.repeat(64),
        },
      ];
    
    const swaps: Trade[] = [
      {
        type: 'swap',
        tokenIn: 'ETH',
        tokenOut: 'USDC',
        amountIn: 1000000000000000000n,
        amountOut: 2000000000n,
        price: 2000,
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
        txHash: '0x' + '3'.repeat(64),
      }
    ];
  
    const stopLosses: Trade[] = [
      {
        type: 'stop-loss-trigger',
        tokenIn: 'BTC',
        tokenOut: 'USDC',
        amountIn: 100000000n,
        amountOut: 45000000000n,
        price: 45000,
        timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), // 4 days ago
        txHash: '0x' + '4'.repeat(64),
      }
    ];
  
    let allTrades = [...limitOrders, ...dcaExecutions, ...swaps, ...stopLosses];
  
    if (filter) {
      if (filter.types && filter.types.length > 0) {
        allTrades = allTrades.filter(t => filter.types!.includes(t.type));
      }
      if (filter.fromDate) {
        allTrades = allTrades.filter(t => t.timestamp >= filter.fromDate!);
      }
      if (filter.toDate) {
        allTrades = allTrades.filter(t => t.timestamp <= filter.toDate!);
      }
    }
  
    // Sort chronological (descending - newest first)
    allTrades.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  
    if (filter?.limit !== undefined) {
      allTrades = allTrades.slice(0, filter.limit);
    }
  
    return allTrades;
  }