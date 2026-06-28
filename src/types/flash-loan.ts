/**
 * Flash loan request parameters.
 */
export interface FlashLoanRequest {
  /** Address of the pair to borrow from */
  pairAddress: string;
  /** Address of the token to borrow */
  token: string;
  /** Amount to borrow */
  amount: bigint;
  /** Address of the flash loan receiver contract */
  receiverAddress: string;
  /** Callback data to pass to the receiver */
  callbackData: Buffer;
}

/**
 * Flash loan event emitted by the pair contract.
 */
export interface FlashLoanEventData {
  /** Type of flash loan event */
  type: 'FlashLoanExecuted' | 'FlashLoanFailed';
  /** Amount of tokens borrowed */
  borrowedAmount: bigint | string;
  /** Fee paid for the flash loan */
  feePaid: bigint | string;
  /** Address of the callback receiver contract */
  callbackAddress: string;
}

/**
 * Flash loan execution result.
 */
export interface FlashLoanResult {
  /** Transaction hash containing this event */
  txHash: string;
  /** Address of the token borrowed */
  token: string;
  /** Amount of tokens borrowed */
  amount: bigint;
  /** Fee paid for the flash loan */
  fee: bigint;
  /** Ledger sequence number */
  ledger: number;
  /** Decoded flash loan event from transaction */
  event?: FlashLoanEventData;
}

/**
 * Flash loan fee estimate.
 */
export interface FlashLoanFeeEstimate {
  /** Address of the token borrowed */
  token: string;
  /** Amount of tokens borrowed */
  amount: bigint;
  /** Estimated fee in basis points */
  feeBps: number;
  /** Estimated fee amount */
  feeAmount: bigint;
  /** Minimum fee floor in basis points */
  feeFloor: number;
}

/**
 * Result of comparing a flash loan fee against a regular swap fee
 * for the same pair and amount.
 *
 * Both fees are expressed as absolute token amounts (not basis points),
 * computed as `(amount * feeBps) / 10000n`.
 */
export interface FlashLoanFeeComparison {
  /** Effective flash loan fee for the requested amount. */
  flashLoanFee: bigint;
  /** Effective dynamic swap fee for the requested amount. */
  swapFee: bigint;
  /** Which option is cheaper for the caller, or `'equal'` when identical. */
  cheaperOption: 'flashLoan' | 'swap' | 'equal';
}

/**
 * Interface that flash loan receivers must implement.
 */
export interface FlashLoanReceiverParams {
  /** Address of the sender initiating the flash loan */
  sender: string;
  /** Address of the borrowed token */
  token: string;
  /** Borrowed amount */
  amount: bigint;
  /** Fee to be paid */
  fee: bigint;
  /** Custom data passed to the receiver */
  data: Buffer;
}
