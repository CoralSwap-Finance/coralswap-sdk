/**
 * TypeScript types for the CoralSwap GovernanceModule.
 *
 * Covers proposal lifecycle, voting, and LP-token delegation.
 */

/**
 * Valid vote choices for a governance proposal.
 */
export type VoteType = 'for' | 'against' | 'abstain';

/**
 * Lifecycle status of a governance proposal.
 */
export type ProposalStatus = 'active' | 'passed' | 'rejected' | 'expired';

/**
 * A single on-chain action bundled inside a governance proposal.
 */
export interface ProposalAction {
  /** Address of the contract to invoke. */
  contractAddress: string;
  /** Name of the function to call. */
  functionName: string;
  /** Encoded arguments for the function call. */
  args: unknown[];
}

/**
 * Full representation of a governance proposal.
 */
export interface Proposal {
  /** Unique identifier returned by the governance contract. */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Full description / motivation text. */
  description: string;
  /** Current lifecycle status. */
  status: ProposalStatus;
  /** Cumulative voting power cast in favour. */
  votesFor: bigint;
  /** Cumulative voting power cast against. */
  votesAgainst: bigint;
  /** Cumulative voting power that abstained. */
  votesAbstain: bigint;
  /** Unix timestamp (seconds) after which voting closes. */
  deadline: number;
  /** Unix timestamp (seconds) when the proposal was executed, if applicable. */
  executedAt?: number;
  /** Stellar address of the account that created the proposal. */
  proposer: string;
  /** Ledger sequence number at which the proposal was created. */
  createdAt: number;
  /** Actions to be executed if the proposal passes. */
  actions: ProposalAction[];
}

/**
 * Voting-power delegation state for a single wallet.
 */
export interface DelegationState {
  /**
   * Address this wallet has delegated its power to, or `null` when no
   * active delegation exists.
   */
  delegatedTo: string | null;
  /** Addresses of wallets that have delegated their power to this wallet. */
  delegatedFrom: string[];
  /** Total voting power available: `ownPower` plus all delegated power. */
  totalVotingPower: bigint;
  /** Voting power from this wallet's own LP-token balance. */
  ownPower: bigint;
}

/**
 * Filter parameters for `getProposalHistory()`.
 */
export interface ProposalFilter {
  /** Restrict results to a specific terminal status. */
  status?: 'passed' | 'rejected' | 'expired';
  /** Only return proposals created at or after this ledger sequence. */
  fromLedger?: number;
  /** Maximum number of results to return (newest-first). */
  limit?: number;
}
