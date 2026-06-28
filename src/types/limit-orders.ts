export type LimitOrderState = 'open' | 'partial' | 'filled' | 'cancelled' | 'expired';

export interface OrderStatus {
  state: LimitOrderState;
  fillPercent: number;
  executionPrice?: number;
  filledAt?: number;
}

export interface CancelResult {
  refundedAmount: bigint;
  filledAmount: bigint;
  refundTxHash: string;
}

export interface LimitOrderParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  targetPrice: number;
  expiry: number;
  pairAddress: string;
}

export interface LimitOrderDetails {
  id: string;
  status: OrderStatus;
  amountFilled: bigint;
  amountRemaining: bigint;
  createdAt: number;
}

export interface PlaceLimitOrderResult {
  orderId: string;
}
