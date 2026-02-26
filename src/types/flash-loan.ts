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
