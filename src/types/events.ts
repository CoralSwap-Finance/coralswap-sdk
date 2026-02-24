/**
 * Base contract event from Soroban.
 */
export interface ContractEvent {
  type: string;
  contractId: string;
  ledger: number;
  timestamp: number;
  txHash: string;
}

/**
 * Swap event emitted by pair contracts.
 */
export interface SwapEvent extends ContractEvent {
  type: 'swap';
  sender: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  feeBps: number;
}

/**
 * Liquidity add/remove event.
 */
export interface LiquidityEvent extends ContractEvent {
  type: 'add_liquidity' | 'remove_liquidity';
  provider: string;
  tokenA: string;
  tokenB: string;
  amountA: bigint;
  amountB: bigint;
  liquidity: bigint;
}

/**
 * Flash loan event.
 */
export interface FlashLoanEvent extends ContractEvent {
  type: 'flash_loan';
  borrower: string;
  token: string;
  amount: bigint;
  fee: bigint;
}

/**
 * Mint event emitted when LP tokens are minted (liquidity added).
 */
export interface MintEvent extends ContractEvent {
  type: 'mint';
  sender: string;
  amountA: bigint;
  amountB: bigint;
  liquidity: bigint;
}

/**
 * Burn event emitted when LP tokens are burned (liquidity removed).
 */
export interface BurnEvent extends ContractEvent {
  type: 'burn';
  sender: string;
  amountA: bigint;
  amountB: bigint;
  liquidity: bigint;
  to: string;
}

/**
 * Sync event emitted when reserves are updated.
 */
export interface SyncEvent extends ContractEvent {
  type: 'sync';
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Fee update event from dynamic fee engine.
 */
export interface FeeUpdateEvent extends ContractEvent {
  type: 'fee_update';
  previousFeeBps: number;
  newFeeBps: number;
  volatility: bigint;
}

/**
 * Governance proposal event.
 */
export interface ProposalEvent extends ContractEvent {
  type: 'proposal_signed' | 'proposal_executed';
  actionHash: string;
  signer: string;
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
