/**
 * TypeScript types for the CoralSwap {@link GovernanceModule}.
 *
 * The governance system allows LP token holders to create proposals,
 * cast votes (weighted by LP balance), and delegate voting power to
 * other wallets without transferring tokens.
 *
 * ## Type hierarchy
 *
 * ```
 * ProposalAction  ───┐
 *                    ├──▶  Proposal     ◀── ProposalFilter
 * VoteType          │
 * ProposalStatus ◀──┘
 *
 * DelegationState  (query result, not stored on-chain as a single type)
 * ```
 *
 * @packageDocumentation
 * @module types/governance
 */

/**
 * Valid vote choices for a governance proposal.
 *
 * - `'for'` — the voter supports the proposal
 * - `'against'` — the voter opposes the proposal
 * - `'abstain'` — the voter participates but takes no side (counted
 *   toward quorum requirements)
 */
export type VoteType = 'for' | 'against' | 'abstain';

/**
 * Lifecycle status of a governance proposal.
 *
 * Proposals transition through these states in order:
 * `active → passed|rejected`, and optionally `passed → executed`.
 * The `expired` status is terminal and occurs when a proposal's
 * deadline passes without enough votes to reach a decision.
 */
export type ProposalStatus = 'active' | 'passed' | 'rejected' | 'expired';

/**
 * A single on-chain action bundled inside a governance proposal.
 *
 * When a proposal passes, each action is executed sequentially by the
 * governance contract.  Actions are atomic — if any action fails, the
 * entire execution is reverted.
 *
 * @example
 * ```typescript
 * const action: ProposalAction = {
 *   contractAddress: 'C…pair…',
 *   functionName: 'set_fee',
 *   args: [nativeToScVal(30, { type: 'u32' })],
 * };
 * ```
 */
export interface ProposalAction {
  /** Address of the Soroban contract to invoke. */
  contractAddress: string;
  /** Exact function name as defined in the target contract. */
  functionName: string;
  /**
   * Encoded arguments for the function call.
   *
   * Each element must be a valid `xdr.ScVal` produced by
   * `nativeToScVal()` from `@stellar/stellar-sdk`.  Raw JS values
   * (`string`, `number`, `bigint`) are **not** automatically converted.
   */
  args: unknown[];
}

/**
 * Full representation of a governance proposal.
 *
 * Returned by {@link GovernanceModule.getProposal},
 * {@link GovernanceModule.getActiveProposals}, and
 * {@link GovernanceModule.getProposalHistory}.
 */
export interface Proposal {
  /**
   * Unique identifier returned by the governance contract at creation
   * time.  Pass this value to `castVote()`, `getProposal()`, etc.
   */
  id: string;

  /** Short human-readable title (set by the proposer). */
  title: string;

  /** Full description or motivation text (set by the proposer). */
  description: string;

  /** Current lifecycle status.  See {@link ProposalStatus}. */
  status: ProposalStatus;

  /**
   * Cumulative voting power (in LP-token smallest units) cast in
   * favour of the proposal.
   */
  votesFor: bigint;

  /**
   * Cumulative voting power (in LP-token smallest units) cast
   * against the proposal.
   */
  votesAgainst: bigint;

  /**
   * Cumulative voting power (in LP-token smallest units) that
   * abstained from the decision.
   */
  votesAbstain: bigint;

  /**
   * Unix timestamp (seconds) after which voting closes.
   *
   * Once `Math.floor(Date.now() / 1000) >= deadline`, the proposal is
   * no longer votable and transitions to `passed`, `rejected`, or
   * `expired` depending on the tally.
   */
  deadline: number;

  /**
   * Unix timestamp (seconds) when the proposal was executed on-chain.
   *
   * Only present when the proposal has been executed (`status` was
   * `passed` and execution succeeded).  `undefined` otherwise.
   */
  executedAt?: number;

  /**
   * Stellar address (G…) of the wallet that created the proposal.
   */
  proposer: string;

  /**
   * Ledger sequence number at which the proposal was created.
   *
   * Can be used as a cursor for pagination in `getProposalHistory`.
   */
  createdAt: number;

  /**
   * Ordered list of on-chain actions to execute when the proposal
   * passes.  May be empty for informational ("signalling") proposals.
   */
  actions: ProposalAction[];
}

/**
 * Voting-power delegation state for a single wallet.
 *
 * Returned by {@link GovernanceModule.getDelegationState}.  Describes
 * both incoming and outgoing delegation relationships as well as the
 * computed voting power.
 */
export interface DelegationState {
  /**
   * Address this wallet has delegated its voting power to.
   *
   * `null` when the wallet has no active delegation (its full power
   * is self-controlled).
   */
  delegatedTo: string | null;

  /**
   * Addresses of wallets that have delegated their voting power **to**
   * this wallet.
   *
   * An empty array when no other wallet has delegated here.
   */
  delegatedFrom: string[];

  /**
   * Total voting power available to this wallet.
   *
   * Computed as `ownPower + sum(delegatedFrom voting powers)`.
   * This is the effective power used when this wallet casts a vote.
   */
  totalVotingPower: bigint;

  /**
   * Voting power originating from this wallet's own LP-token balance.
   *
   * Does **not** include power delegated from other wallets.  Use
   * `totalVotingPower` for the effective voting weight.
   */
  ownPower: bigint;
}

/**
 * Filter parameters for {@link GovernanceModule.getProposalHistory}.
 *
 * All fields are optional.  When multiple fields are provided they are
 * applied as a logical AND.  Omitted fields return all values in that
 * dimension.
 */
export interface ProposalFilter {
  /**
   * Restrict results to proposals that have reached a specific
   * terminal status.  Only `passed`, `rejected`, and `expired` are
   * valid — `active` proposals are intentionally excluded here since
   * they are better served by `getActiveProposals()`.
   */
  status?: 'passed' | 'rejected' | 'expired';

  /**
   * Only return proposals created at or after this ledger sequence
   * number.  Useful for incremental polling or pagination.
   */
  fromLedger?: number;

  /**
   * Maximum number of results to return.
   *
   * Results are ordered newest-first, so `limit: 10` returns the ten
   * most recent matching proposals.
   */
  limit?: number;
}
