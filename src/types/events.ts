/**
 * Base contract event from Soroban.
 */
export interface ContractEvent {
  /** Event type identifier string */
  type: string;
  /** Address of the Soroban contract emitting the event */
  contractId: string;
  /** Ledger sequence number where the event was emitted */
  ledger: number;
  /** Unix timestamp in seconds when the event was emitted */
  timestamp: number;
  /** Transaction hash containing this event */
  txHash: string;
}

/**
 * Swap event emitted by pair contracts.
 */
export interface SwapEvent extends ContractEvent {
  /** Literal type tag for swap */
  type: "swap";
  /** Address of the account initiating the swap */
  sender: string;
  /** Address of the input token */
  tokenIn: string;
  /** Address of the output token */
  tokenOut: string;
  /** Amount of input token provided */
  amountIn: bigint;
  /** Amount of output token received */
  amountOut: bigint;
  /** Fee charged for this swap in basis points */
  feeBps: number;
}

/**
 * Liquidity add/remove event.
 */
export interface LiquidityEvent extends ContractEvent {
  /** Literal type tag */
  type: "add_liquidity" | "remove_liquidity";
  /** Address of the liquidity provider */
  provider: string;
  /** Address of token A */
  tokenA: string;
  /** Address of token B */
  tokenB: string;
  /** Amount of token A added or removed */
  amountA: bigint;
  /** Amount of token B added or removed */
  amountB: bigint;
  /** Amount of LP tokens minted or burned */
  liquidity: bigint;
}

/**
 * Flash loan event.
 */
export interface FlashLoanEvent extends ContractEvent {
  /** Literal type tag */
  type: "flash_loan";
  /** Address receiving the flash loan */
  borrower: string;
  /** Address of the token borrowed */
  token: string;
  /** Amount of tokens borrowed */
  amount: bigint;
  /** Fee paid for the flash loan */
  fee: bigint;
}

/**
 * Mint event emitted when LP tokens are minted (liquidity added).
 */
export interface MintEvent extends ContractEvent {
  /** Literal type tag */
  type: "mint";
  /** Address that initiated the mint */
  sender: string;
  /** Amount of token A deposited */
  amountA: bigint;
  /** Amount of token B deposited */
  amountB: bigint;
  /** Amount of LP tokens minted */
  liquidity: bigint;
}

/**
 * Burn event emitted when LP tokens are burned (liquidity removed).
 */
export interface BurnEvent extends ContractEvent {
  /** Literal type tag */
  type: "burn";
  /** Address that initiated the burn */
  sender: string;
  /** Amount of token A withdrawn */
  amountA: bigint;
  /** Amount of token B withdrawn */
  amountB: bigint;
  /** Amount of LP tokens burned */
  liquidity: bigint;
  /** Address where the withdrawn tokens are sent */
  to: string;
}

/**
 * Sync event emitted when reserves are updated.
 */
export interface SyncEvent extends ContractEvent {
  /** Literal type tag */
  type: "sync";
  /** Updated reserve amount for token 0 */
  reserve0: bigint;
  /** Updated reserve amount for token 1 */
  reserve1: bigint;
}

/**
 * Fee update event from dynamic fee engine.
 */
export interface FeeUpdateEvent extends ContractEvent {
  /** Literal type tag */
  type: "fee_update";
  /** The previous fee in basis points */
  previousFeeBps: number;
  /** The new updated fee in basis points */
  newFeeBps: number;
  /** Current calculated volatility metric */
  volatility: bigint;
}

/**
 * Governance proposal event.
 */
export interface ProposalEvent extends ContractEvent {
  /** Literal type tag */
  type: "proposal_signed" | "proposal_executed";
  /** Hash of the proposed action */
  actionHash: string;
  /** Address of the signee (if proposal_signed) */
  signer: string;
  /** Current total number of signatures */
  signaturesCount: number;
}

/**
 * Union of all CoralSwap contract events.
 */
export type CoralSwapEvent =
  | SwapEvent
  | LiquidityEvent
  | FlashLoanEvent
  | MintEvent
  | BurnEvent
  | SyncEvent
  | FeeUpdateEvent
  | ProposalEvent;
