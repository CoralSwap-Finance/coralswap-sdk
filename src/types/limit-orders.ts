export type LimitOrderState = 'open' | 'partial' | 'filled' | 'cancelled' | 'expired';

export interface OrderStatus {
  state: LimitOrderState;
  fillPercent: number;
  executionPrice?: number;
  filledAt?: number;
}
