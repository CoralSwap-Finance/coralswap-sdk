
export type TradeType = 'swap' | 'limit-fill' | 'dca-execution' | 'stop-loss-trigger';

export interface Trade {
  type: TradeType;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  price: number;
  timestamp: Date;
  txHash: string;
}

export interface TradeFilter {
  types?: TradeType[];
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
}
