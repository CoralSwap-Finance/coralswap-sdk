export class CoralSwapSDKError extends Error {
  public orderId?: string;
  public expectedState?: any;
  public actualState?: any;

  constructor(
    message: string,
    orderId?: string,
    expectedState?: any,
    actualState?: any
  ) {
    super(message);
    this.name = "CoralSwapSDKError";
    this.orderId = orderId;
    this.expectedState = expectedState;
    this.actualState = actualState;
  }
}

export const mapContractError = (
  code: number,
  orderId?: string,
  actualState?: string
): CoralSwapSDKError => {
  switch (code) {
    case 101:
      return new CoralSwapSDKError(
        `Order ${orderId || "unknown"} not found. Ensure the order ID is correct and has not been processed.`,
        orderId
      );
    case 102:
      return new CoralSwapSDKError(
        `Insufficient balance for order ${orderId || "unknown"}. Please top up your wallet.`,
        orderId
      );
    case 103:
      return new CoralSwapSDKError(
        `Order ${orderId || "unknown"} has expired. Please create a new order.`,
        orderId,
        "active",
        actualState || "expired"
      );
    default:
      return new CoralSwapSDKError(
        `An unknown error occurred on order ${orderId || "unknown"} (Code: ${code}).`,
        orderId
      );
  }
};
