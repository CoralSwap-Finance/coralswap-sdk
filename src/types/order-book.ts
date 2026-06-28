
export type OrderType = "limit" | "dca" | "stop-loss";

export interface UnifiedOrder {
  id: string;
  type: OrderType;
  tokenIn: string;
  tokenOut: string;
  status: "open" | "filled" | "cancelled";
  createdAt: Date;
  details: Record<string, any>;
}

export interface OrderSummary {
  totalOpenOrders: number;
  totalValueLocked: number;
  byType: {
    limit: number;
    dca: number;
    stopLoss: number;
  };
}
