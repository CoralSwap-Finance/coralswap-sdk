
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
  PairNotFoundError,
  TransactionError,
} from '@/errors';
import { validateAddress } from '@/utils/validation';
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
 * Exposes high-level methods for dApp builders to interact with the
 * CoralSwap governance contract without manual XDR construction.
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
   * @param title - Short human-readable title (must not be empty)
   * @param description - Full motivation / specification text
   * @param actions - On-chain actions to execute if the proposal passes
   * @param signer - Wallet signer that authorises the submission
   * @returns The unique proposal ID assigned by the contract
   * @throws {ValidationError} For empty title, description, or invalid action addresses
   * @throws {TransactionError} If the transaction is rejected on-chain
   */
  async createProposal(
    title: string,
    description: string,
    actions: ProposalAction[],
    signer: Signer,
  ): Promise<string> {
    if (!title || title.trim().length === 0) {
      throw new ValidationError('title must not be empty');
    }
    if (!description || description.trim().length === 0) {
      throw new ValidationError('description must not be empty');
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new ValidationError('actions must be a non-empty array');
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
   * @param proposalId - ID of the proposal to vote on
   * @param voteType - Vote choice: `'for'`, `'against'`, or `'abstain'`
   * @param signer - Wallet signer that authorises the vote
   * @returns Transaction hash of the submitted vote
   * @throws {ValidationError} For empty proposalId or invalid voteType
   * @throws {TransactionError} If the proposal has expired, the vote is a
   *   duplicate, or the transaction is otherwise rejected
   */
  async castVote(
    proposalId: string,
    voteType: VoteType,
    signer: Signer,
  ): Promise<string> {
    if (!proposalId || proposalId.trim().length === 0) {
      throw new ValidationError('proposalId must not be empty');
    }
    if (!['for', 'against', 'abstain'].includes(voteType)) {
      throw new ValidationError(
        `voteType must be 'for', 'against', or 'abstain', got: ${voteType}`,
        { voteType },
      );
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
      );
    }

    return result.txHash!;
  }

  /**
   * Delegate voting power to another address.
   *
   * @param toAddress - Stellar address to delegate power to
   * @param signer - Wallet signer that authorises the delegation
   * @returns Transaction hash
   * @throws {ValidationError} If `toAddress` is invalid or equals the signer's own address
   * @throws {TransactionError} If the transaction is rejected
   */
  async delegate(toAddress: string, signer: Signer): Promise<string> {
    validateAddress(toAddress, 'toAddress');

    const signerPublicKey = await signer.publicKey();

    if (toAddress === signerPublicKey) {
      throw new ValidationError('Cannot delegate to self', { toAddress });
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
      );
    }

    return result.txHash!;
  }

  /**
   * Revoke an existing delegation and reclaim voting power.
   *
   * @param signer - Wallet signer that owns the active delegation
   * @returns Transaction hash
   * @throws {TransactionError} If no active delegation exists or the tx is rejected
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
   * @param proposalId - Unique proposal identifier
   * @returns Full proposal state including vote tallies
   * @throws {ValidationError} If `proposalId` is empty
   * @throws {PairNotFoundError} If no proposal exists for the given ID
   */
  async getProposal(proposalId: string): Promise<Proposal> {
    if (!proposalId || proposalId.trim().length === 0) {
      throw new ValidationError('proposalId must not be empty');
    }

    const contract = new Contract(this.contractAddress);
    const op = contract.call(
      'get_proposal',
      nativeToScVal(proposalId, { type: 'string' }),
    );

    const sim = await this.client.simulateTransaction([op], {});

    if (!sim.success || !sim.returnValue) {
      throw new PairNotFoundError(proposalId, 'governance');
    }

    return this.decodeProposal(sim.returnValue);
  }

  /**
   * Fetch all proposals currently in their voting period.
   *
   * @returns Array of active proposals (may be empty)
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
   * Results are ordered newest-first by default.
   *
   * @param filter - Optional filters for status, ledger range, and result count
   * @returns Array of matching proposals (empty when none exist)
   */
  async getProposalHistory(filter?: ProposalFilter): Promise<Proposal[]> {
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
   * @param address - Stellar address to query
   * @returns Current delegation state for the address
   * @throws {ValidationError} If `address` is invalid
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
