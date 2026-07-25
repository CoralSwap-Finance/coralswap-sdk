
import { CoralSwapClient } from '@/client';
import {
  Proposal,
  ProposalAction,
  ProposalFilter,
  DelegationState,
  VoteType,
} from '@/types/governance';
import { Signer } from '@/types/common';
import {
  ValidationError,
  InvalidOperationError,
  TransactionError,
} from '@/errors';
import {
  validateAddress,
  validateStringLength,
  validateEnumValue,
} from '@/utils/validation';
import {
  Contract,
  nativeToScVal,
  xdr,
  Address,
  scValToNative,
} from '@stellar/stellar-sdk';

/**
 * Governance module — proposal creation, voting, and LP-token delegation.
 *
 * The CoralSwap governance system lets LP token holders create and vote on
 * proposals that can execute on-chain actions.  Voting power is proportional
 * to the amount of LP tokens held by each wallet.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
 * │  LP Holders  │────▶│  GovernanceModule│────▶│ GovernanceContract│
 * │ (delegation) │     │  (this class)    │     │   (on Soroban)   │
 * └─────────────┘     └──────────────────┘     └─────────────────┘
 *                            │
 *                     ┌──────┴──────┐
 *                     │             │
 *               ┌─────▼──┐   ┌─────▼──┐
 *               │Proposal │   │  Vote   │
 *               │Lifecycle│   │Tallies  │
 *               └─────────┘   └─────────┘
 * ```
 *
 * ### Proposal lifecycle
 *
 * 1. **Submission** — a wallet with an LP position calls `createProposal()`.
 *    The proposal enters the `active` state and is votable until `deadline`.
 * 2. **Voting** — wallets cast `for`, `against`, or `abstain` votes via
 *    `castVote()`.  Voting power may be delegated (see below).
 * 3. **Resolution** — after `deadline` passes, the proposal transitions to
 *    `passed` (more `for` than `against`) or `rejected`.
 * 4. **Execution** — a passed proposal's bundled actions are executed
 *    on-chain, and its status changes to `executed`.
 *
 * ### Delegation
 *
 * Wallets may delegate their voting power to another address without
 * transferring LP tokens.  The `delegate()` / `undelegate()` methods
 * manage this relationship.  The `getDelegationState()` query returns
 * the full delegation graph for a given wallet.
 *
 * All write operations (`createProposal`, `castVote`, `delegate`,
 * `undelegate`) require a {@link Signer} to authorise the on-chain
 * transaction.  Read operations (`getProposal`, `getActiveProposals`,
 * `getProposalHistory`, `getDelegationState`) are free and do not
 * need signing.
 *
 * @example
 * ```typescript
 * import { GovernanceModule } from '@coralswap/sdk';
 * import { KeypairSigner } from '@coralswap/sdk';
 *
 * const signer = new KeypairSigner('S…secret…');
 * const gov = new GovernanceModule(client, 'C…governance…');
 *
 * const id = await gov.createProposal(
 *   'Adjust fee tier for USDC/XLM pool',
 *   'Proposal to change the dynamic fee parameters…',
 *   [{ contractAddress: 'C…pair…', functionName: 'set_fee', args: [50] }],
 *   signer,
 * );
 * ```
 */
export class GovernanceModule {
  private readonly client: CoralSwapClient;
  private readonly contractAddress: string;

  constructor(client: CoralSwapClient, contractAddress: string) {
    this.client = client;
    this.contractAddress = contractAddress;
  }

  // ---------------------------------------------------------------------------
  // Write operations (require signing)
  // ---------------------------------------------------------------------------

  /**
   * Submit a new governance proposal.
   *
   * Once submitted, the proposal enters the `active` state and becomes
   * votable until `deadline`.  The caller must hold LP tokens in at least
   * one CoralSwap pool to have voting power.
   *
   * @param title - Short human-readable title (must not be empty)
   * @param description - Full motivation / specification text
   * @param actions - On-chain actions to execute if the proposal passes.
   *   Each action specifies a target contract address, function name, and
   *   an array of encoded arguments.
   * @param signer - Wallet signer that authorises the submission
   * @returns The transaction hash of the submission, which doubles as a
   *   stable proposal reference
   * @throws {ValidationError} For empty title, description, or invalid
   *   action contract addresses
   * @throws {TransactionError} If the transaction is rejected on-chain
   *
   * @example
   * ```typescript
   * const txHash = await gov.createProposal(
   *   'Upgrade oracle contract',
   *   'Replace the current TWAP oracle with the new verifiable feed…',
   *   [
   *     {
   *       contractAddress: 'C…oracle…',
   *       functionName: 'upgrade_implementation',
   *       args: [newAddressScVal],
   *     },
   *   ],
   *   signer,
   * );
   * console.log('Proposal submitted:', txHash);
   * ```
   */
  async createProposal(
    title: string,
    description: string,
    actions: ProposalAction[],
    signer: Signer,
  ): Promise<string> {
    validateStringLength(title, 'title', 1, 200);
    validateStringLength(description, 'description', 1, 5000);
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new ValidationError('actions must be a non-empty array', {
        field: 'actions',
        constraint: 'non-empty array',
        operation: 'createProposal',
      });
    }
    for (const action of actions) {
      validateAddress(action.contractAddress, 'action.contractAddress');
    }

    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const actionsScVal = nativeToScVal(
      actions.map((a) => ({
        contract_address: new Address(a.contractAddress),
        function_name: a.functionName,
        args: a.args,
      })),
    );

    const op = contract.call(
      'create_proposal',
      nativeToScVal(title, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
      actionsScVal,
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `createProposal failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
        { operation: 'createProposal', title, description },
      );
    }

    // The contract returns the proposal ID as a string in the return value.
    // The txHash doubles as a stable reference when the contract return value
    // cannot be extracted from the polling result.
    return result.txHash!;
  }

  /**
   * Cast a vote on an active proposal.
   *
   * Voting power is determined by the signer's LP-token balance (plus any
   * delegated power) at the time the vote is submitted.  Each wallet may
   * only vote once per proposal; subsequent calls overwrite the previous
   * choice.
   *
   * @param proposalId - ID of the proposal to vote on
   * @param voteType - Vote choice: `'for'`, `'against'`, or `'abstain'`
   * @param signer - Wallet signer that authorises the vote
   * @returns Transaction hash of the submitted vote
   * @throws {ValidationError} For empty proposalId or invalid voteType
   * @throws {TransactionError} If the proposal has expired, the voter
   *   already cast a final vote, or the transaction is otherwise rejected
   *
   * @example
   * ```typescript
   * await gov.castVote(proposalId, 'for', signer);
   * ```
   */
  async castVote(
    proposalId: string,
    voteType: VoteType,
    signer: Signer,
  ): Promise<string> {
    if (!proposalId || proposalId.trim().length === 0) {
      throw new ValidationError('proposalId must not be empty', {
        field: 'proposalId',
        constraint: 'non-empty string',
        operation: 'castVote',
      });
    }
    validateEnumValue(voteType, 'voteType', ['for', 'against', 'abstain']);

    try {
      await this.getProposal(proposalId);
    } catch (err) {
      if (err instanceof InvalidOperationError) {
        throw new ValidationError(
          `proposalId does not reference an existing proposal: ${proposalId}`,
          {
            field: 'proposalId',
            constraint: 'existing proposal',
            proposalId,
            operation: 'castVote',
          },
        );
      }
      throw err;
    }

    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const op = contract.call(
      'cast_vote',
      nativeToScVal(proposalId, { type: 'string' }),
      nativeToScVal(voteType, { type: 'symbol' }),
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `castVote failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
        { operation: 'castVote', proposalId, voteType },
      );
    }

    return result.txHash!;
  }

  /**
   * Delegate voting power to another address.
   *
   * Delegation lets a wallet assign its full voting power to another
   * wallet without transferring LP tokens.  The delegate can then cast
   * votes on behalf of the delegator.  Only one active delegation is
   * allowed per wallet; calling `delegate` again overwrites the previous
   * target.
   *
   * @param toAddress - Stellar address to delegate power to.  Must be a
   *   valid public key (G…) and must not equal the signer's own address.
   * @param signer - Wallet signer that authorises the delegation
   * @returns Transaction hash of the delegation transaction
   * @throws {ValidationError} If `toAddress` is invalid or equals the
   *   signer's own address
   * @throws {TransactionError} If the transaction is rejected on-chain
   *
   * @example
   * ```typescript
   * const txHash = await gov.delegate(
   *   'GB…delegate…',
   *   signer,
   * );
   * console.log('Delegation submitted:', txHash);
   * ```
   */
  async delegate(toAddress: string, signer: Signer): Promise<string> {
    validateAddress(toAddress, 'toAddress');

    const signerPublicKey = await signer.publicKey();

    if (toAddress === signerPublicKey) {
      throw new ValidationError('Cannot delegate to self', {
        field: 'toAddress',
        constraint: 'must differ from signer public key',
        delegateAddress: toAddress,
        operation: 'delegate',
      });
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'delegate',
      new Address(toAddress).toScVal(),
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `delegate failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
        { operation: 'delegate', delegateAddress: toAddress },
      );
    }

    return result.txHash!;
  }

  /**
   * Revoke an existing delegation and reclaim voting power.
   *
   * After a successful undelegation the signer's full voting power is
   * once again controlled directly by their own address.  Has no effect
   * if no active delegation exists.
   *
   * @param signer - Wallet signer that owns the active delegation to
   *   revoke
   * @returns Transaction hash of the undelegation transaction
   * @throws {TransactionError} If no active delegation exists or the
   *   transaction is rejected on-chain
   *
   * @example
   * ```typescript
   * await gov.undelegate(signer);
   * console.log('Delegation revoked');
   * ```
   */
  async undelegate(signer: Signer): Promise<string> {
    const signerPublicKey = await signer.publicKey();
    const contract = new Contract(this.contractAddress);

    const op = contract.call(
      'undelegate',
      new Address(signerPublicKey).toScVal(),
    );

    const result = await this.client.submitTransaction([op], signerPublicKey);

    if (!result.success) {
      throw new TransactionError(
        `undelegate failed: ${result.error?.message ?? 'Unknown error'}`,
        result.txHash,
        { operation: 'undelegate' },
      );
    }

    return result.txHash!;
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single proposal by its ID.
   *
   * Returns the full proposal state including current vote tallies,
   * status, deadline, and the bundled on-chain actions.  Use this
   * method to render a proposal detail view in a dApp UI.
   *
   * @param proposalId - Unique proposal identifier (returned by
   *   `createProposal` or `getActiveProposals`)
   * @returns The full proposal object with vote tallies and metadata
   * @throws {ValidationError} If `proposalId` is empty
   * @throws {InvalidOperationError} If no proposal exists for the given ID

   * @example
   * ```typescript
   * const proposal = await gov.getProposal(proposalId);
   * console.log(proposal.title, proposal.status, {
   *   for: proposal.votesFor,
   *   against: proposal.votesAgainst,
   * });
   * ```
   */
  async getProposal(proposalId: string): Promise<Proposal> {
    if (!proposalId || proposalId.trim().length === 0) {
      throw new ValidationError('proposalId must not be empty', {
        field: 'proposalId',
        constraint: 'non-empty string',
        operation: 'getProposal',
      });
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_proposal',
      nativeToScVal(proposalId, { type: 'string' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new InvalidOperationError('Proposal not found', {
        operation: 'getProposal',
        proposalId,
      });
    }

    return this.decodeProposal(sim.returnValue);
  }

  /**
   * Fetch all proposals currently in their voting period.
   *
   * Proposals whose `deadline` has not yet passed are considered active.
   * The result set is ordered by creation time (newest first).  Returns
   * an empty array when no proposals are being voted on.
   *
   * @returns Array of active proposals, ordered newest-first (may be
   *   empty when none are being voted on)
   *
   * @example
   * ```typescript
   * const active = await gov.getActiveProposals();
   * for (const p of active) {
   *   const remaining = p.deadline - Math.floor(Date.now() / 1000);
   *   console.log(`${p.title} — ${remaining}s remaining`);
   * }
   * ```
   */
  async getActiveProposals(): Promise<Proposal[]> {
    const contract = new Contract(this.contractAddress);
    const op = contract.call('get_active_proposals');

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      return [];
    }

    const items = sim.returnValue.vec();
    if (!items) return [];
    return items.map((v) => this.decodeProposal(v));
  }

  /**
   * Fetch historical proposals with optional filtering.
   *
   * Results are ordered newest-first by default.  Client-side filtering
   * is applied after the contract response — when the on-chain result
   * set is large, consider passing `fromLedger` and `limit` in the
   * filter to paginate efficiently.
   *
   * @param filter - Optional filters:
   *   - `status` — restrict to a terminal status (`passed`, `rejected`,
   *     or `expired`)
   *   - `fromLedger` — only proposals created at or after this ledger
   *     sequence
   *   - `limit` — maximum results to return (applied after ordering)
   * @returns Array of matching proposals, newest-first (empty when the
   *   filter matches no results)
   * @throws {ValidationError} If filter values are invalid
   *
   * @example
   * ```typescript
   * const recentPassed = await gov.getProposalHistory({
   *   status: 'passed',
   *   limit: 10,
   * });
   * console.log(`Found ${recentPassed.length} recently passed proposals`);
   * ```
   */
  async getProposalHistory(filter?: ProposalFilter): Promise<Proposal[]> {
    if (filter?.limit !== undefined) {
      if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000) {
        throw new ValidationError('filter.limit must be an integer between 1 and 1000', {
          field: 'filter.limit',
          constraint: 'integer 1-1000',
          actual: filter.limit,
          operation: 'getProposalHistory',
        });
      }
    }
    if (filter?.fromLedger !== undefined) {
      if (!Number.isInteger(filter.fromLedger) || filter.fromLedger < 0) {
        throw new ValidationError('filter.fromLedger must be a non-negative integer', {
          field: 'filter.fromLedger',
          constraint: 'non-negative integer',
          actual: filter.fromLedger,
          operation: 'getProposalHistory',
        });
      }
    }
    if (filter?.status !== undefined) {
      validateEnumValue(filter.status, 'filter.status', ['passed', 'rejected', 'expired']);
    }

    const contract = new Contract(this.contractAddress);

    const statusArg = filter?.status
      ? nativeToScVal(filter.status, { type: 'symbol' })
      : xdr.ScVal.scvVoid();

    const fromLedgerArg =
      filter?.fromLedger !== undefined
        ? nativeToScVal(filter.fromLedger, { type: 'u32' })
        : xdr.ScVal.scvVoid();

    const limitArg =
      filter?.limit !== undefined
        ? nativeToScVal(filter.limit, { type: 'u32' })
        : xdr.ScVal.scvVoid();

    const op = contract.call(
      'get_proposal_history',
      statusArg,
      fromLedgerArg,
      limitArg,
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      return [];
    }

    const items = sim.returnValue.vec();
    if (!items) return [];

    let proposals = items.map((v) => this.decodeProposal(v));

    if (filter?.status) {
      proposals = proposals.filter((p) => p.status === filter.status);
    }

    if (filter?.limit !== undefined) {
      proposals = proposals.slice(0, filter.limit);
    }

    return proposals;
  }

  /**
   * Fetch the delegation state for a wallet address.
   *
   * Returns who the wallet has delegated to (if anyone), which wallets
   * have delegated to it, and the computed total voting power.  Useful
   * for rendering delegation UI or verifying power before a vote.
   *
   * @param address - Stellar address (G…) to query
   * @returns Current delegation state, or a zeroed state if the address
   *   has never interacted with the governance contract
   * @throws {ValidationError} If `address` is not a valid Stellar
   *   public key
   *
   * @example
   * ```typescript
   * const state = await gov.getDelegationState('G…voter…');
   * console.log('Own power:', state.ownPower.toString());
   * console.log('Delegated to:', state.delegatedTo ?? '(none)');
   * console.log('Total power:', state.totalVotingPower.toString());
   * ```
   */
  async getDelegationState(address: string): Promise<DelegationState> {
    validateAddress(address, 'address');

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_delegation_state',
      new Address(address).toScVal(),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      return {
        delegatedTo: null,
        delegatedFrom: [],
        totalVotingPower: 0n,
        ownPower: 0n,
      };
    }

    return this.decodeDelegationState(sim.returnValue);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private decodeProposal(val: xdr.ScVal): Proposal {
    const native = scValToNative(val) as Record<string, unknown>;

    return {
      id: String(native['id'] ?? ''),
      title: String(native['title'] ?? ''),
      description: String(native['description'] ?? ''),
      status: (native['status'] as Proposal['status']) ?? 'active',
      votesFor: BigInt(String(native['votes_for'] ?? '0')),
      votesAgainst: BigInt(String(native['votes_against'] ?? '0')),
      votesAbstain: BigInt(String(native['votes_abstain'] ?? '0')),
      deadline: Number(native['deadline'] ?? 0),
      executedAt: native['executed_at'] != null
        ? Number(native['executed_at'])
        : undefined,
      proposer: String(native['proposer'] ?? ''),
      createdAt: Number(native['created_at'] ?? 0),
      actions: [],
    };
  }

  private decodeDelegationState(val: xdr.ScVal): DelegationState {
    const native = scValToNative(val) as Record<string, unknown>;

    return {
      delegatedTo: native['delegated_to'] != null
        ? String(native['delegated_to'])
        : null,
      delegatedFrom: Array.isArray(native['delegated_from'])
        ? (native['delegated_from'] as unknown[]).map(String)
        : [],
      totalVotingPower: BigInt(String(native['total_voting_power'] ?? '0')),
      ownPower: BigInt(String(native['own_power'] ?? '0')),
    };
  }
}
