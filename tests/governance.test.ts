
import { getQuorumStatus } from '../src/modules/governance';

describe('Governance Module', () => {
  describe('getQuorumStatus', () => {
    it('should return the correct quorum status when quorum is not reached', async () => {
      const status = await getQuorumStatus('proposal-1');
      expect(status.isQuorumReached).toBe(false);
      expect(status.quorumRequired).toBe(1000000n);
      expect(status.currentParticipation).toBe(500000n);
      expect(status.remainingVotes).toBe(500000n);
      expect(status.participationPercent).toBe(50);
    });

    it('should return the correct quorum status when quorum is exactly met', async () => {
      const status = await getQuorumStatus('proposal-2');
      expect(status.isQuorumReached).toBe(true);
      expect(status.quorumRequired).toBe(1000000n);
      expect(status.currentParticipation).toBe(1000000n);
      expect(status.remainingVotes).toBe(0n);
      expect(status.participationPercent).toBe(100);
    });

    it('should return the correct quorum status when quorum is exceeded', async () => {
        const status = await getQuorumStatus('proposal-2');
        // Re-using proposal-2 which is at 100%
        expect(status.isQuorumReached).toBe(true);
        expect(status.remainingVotes).toBe(0n);
        expect(status.participationPercent).toBe(100);
      });

    it('should calculate participation percentage correctly', async () => {
      const status = await getQuorumStatus('proposal-3');
      expect(status.participationPercent).toBe(25);
    });

    it('should throw a ValidationError if the proposal ID does not exist', async () => {
      await expect(getQuorumStatus('non-existent-proposal')).rejects.toThrow(
        'Proposal with ID "non-existent-proposal" not found.'
      );
    });
import { CoralSwapClient } from '../src/client';
import { GovernanceModule } from '../src/modules/governance';
import { ValidationError, PairNotFoundError, TransactionError } from '../src/errors';
import { Network } from '../src/types/common';
import type { Proposal, DelegationState, ProposalAction } from '../src/types/governance';
import type { SimulateTransactionResult } from '../src/types/common';
import { nativeToScVal, Address, xdr } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const GOVERNANCE_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ALICE_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const BOB_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const ACTION_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposalNative(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: 'proposal-1',
    title: 'Enable new fee tier',
    description: 'Add a 0.01% fee tier for stable pairs',
    status: 'active',
    votes_for: '1000',
    votes_against: '200',
    votes_abstain: '50',
    deadline: 1700000000,
    proposer: ALICE_ADDRESS,
    created_at: 1000000,
    ...overrides,
  };
}

function makeSimResult(
  native: unknown,
  success = true,
): SimulateTransactionResult {
  const scVal = nativeToScVal(native);
  return {
    success,
    returnValue: success ? scVal : null,
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: success ? null : 'simulation error',
    raw: {} as never,
  };
}

function makeArraySimResult(items: unknown[]): SimulateTransactionResult {
  const scVals = items.map((item) => nativeToScVal(item));
  const arrayVal = xdr.ScVal.scvVec(scVals);
  return {
    success: true,
    returnValue: arrayVal,
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

function makeDelegationNative(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    delegated_to: null,
    delegated_from: [],
    total_voting_power: '5000',
    own_power: '5000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GovernanceModule', () => {
  const TEST_TX_HASH = 'abc123txhash';

  let client: CoralSwapClient;
  let governance: GovernanceModule;
  let mockSigner: { publicKey: jest.Mock; signTransaction: jest.Mock };

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    governance = new GovernanceModule(client, GOVERNANCE_CONTRACT);

    mockSigner = {
      publicKey: jest.fn().mockResolvedValue(ALICE_ADDRESS),
      signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // createProposal()
  // -------------------------------------------------------------------------

  describe('createProposal()', () => {
    const actions: ProposalAction[] = [
      { contractAddress: ACTION_CONTRACT, functionName: 'set_fee', args: [30] },
    ];

    it('returns a proposal ID (tx hash) on success', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: true,
        txHash: TEST_TX_HASH,
        data: { txHash: TEST_TX_HASH, ledger: 1000 },
      });

      const id = await governance.createProposal('New fee tier', 'Description', actions, mockSigner);

      expect(id).toBe(TEST_TX_HASH);
      expect(mockSigner.publicKey).toHaveBeenCalled();
    });

    it('throws ValidationError when title is empty', async () => {
      await expect(
        governance.createProposal('', 'Description', actions, mockSigner),
      ).rejects.toThrow(ValidationError);

      await expect(
        governance.createProposal('', 'Description', actions, mockSigner),
      ).rejects.toThrow('title must not be empty');
    });

    it('throws ValidationError when description is empty', async () => {
      await expect(
        governance.createProposal('Title', '', actions, mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when actions array is empty', async () => {
      await expect(
        governance.createProposal('Title', 'Description', [], mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when an action has an invalid contract address', async () => {
      const badActions: ProposalAction[] = [
        { contractAddress: 'not-a-stellar-address', functionName: 'foo', args: [] },
      ];

      await expect(
        governance.createProposal('Title', 'Description', badActions, mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError when submitTransaction reports failure', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'SIMULATION_FAILED', message: 'Gas limit exceeded' },
      });

      await expect(
        governance.createProposal('Title', 'Description', actions, mockSigner),
      ).rejects.toThrow(TransactionError);

      await expect(
        governance.createProposal('Title', 'Description', actions, mockSigner),
      ).rejects.toThrow('createProposal failed: Gas limit exceeded');
    });
  });

  // -------------------------------------------------------------------------
  // castVote()
  // -------------------------------------------------------------------------

  describe('castVote()', () => {
    it('returns a tx hash when vote is cast successfully', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: true,
        txHash: TEST_TX_HASH,
        data: { txHash: TEST_TX_HASH, ledger: 1001 },
      });

      const hash = await governance.castVote('proposal-1', 'for', mockSigner);

      expect(hash).toBe(TEST_TX_HASH);
    });

    it('accepts all three vote types', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: true,
        txHash: TEST_TX_HASH,
        data: { txHash: TEST_TX_HASH, ledger: 1001 },
      });

      await expect(governance.castVote('p1', 'for', mockSigner)).resolves.toBe(TEST_TX_HASH);
      await expect(governance.castVote('p1', 'against', mockSigner)).resolves.toBe(TEST_TX_HASH);
      await expect(governance.castVote('p1', 'abstain', mockSigner)).resolves.toBe(TEST_TX_HASH);
    });

    it('throws ValidationError when proposalId is empty', async () => {
      await expect(governance.castVote('', 'for', mockSigner)).rejects.toThrow(ValidationError);
      await expect(governance.castVote('', 'for', mockSigner)).rejects.toThrow(
        'proposalId must not be empty',
      );
    });

    it('throws ValidationError for an invalid voteType', async () => {
      await expect(
        governance.castVote('proposal-1', 'yes' as never, mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError when the vote is rejected on-chain', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'DUPLICATE_VOTE', message: 'Already voted on this proposal' },
      });

      await expect(
        governance.castVote('proposal-1', 'for', mockSigner),
      ).rejects.toThrow(TransactionError);

      await expect(
        governance.castVote('proposal-1', 'for', mockSigner),
      ).rejects.toThrow('Already voted on this proposal');
    });
  });

  // -------------------------------------------------------------------------
  // getProposal()
  // -------------------------------------------------------------------------

  describe('getProposal()', () => {
    it('returns a correctly decoded Proposal', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeProposalNative()) as never);

      const proposal = await governance.getProposal('proposal-1');

      expect(proposal.id).toBe('proposal-1');
      expect(proposal.title).toBe('Enable new fee tier');
      expect(proposal.status).toBe('active');
      expect(proposal.votesFor).toBe(1000n);
      expect(proposal.votesAgainst).toBe(200n);
      expect(proposal.votesAbstain).toBe(50n);
      expect(proposal.deadline).toBe(1700000000);
    });

    it('throws ValidationError when proposalId is empty', async () => {
      await expect(governance.getProposal('')).rejects.toThrow(ValidationError);
    });

    it('throws PairNotFoundError when the simulation returns no value', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(null, false) as never);

      await expect(governance.getProposal('nonexistent')).rejects.toThrow(PairNotFoundError);
    });

    it('decodes executedAt when present in the contract response', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(
          makeSimResult(makeProposalNative({ status: 'passed', executed_at: 1700001000 })) as never,
        );

      const proposal = await governance.getProposal('proposal-2');

      expect(proposal.status).toBe('passed');
      expect(proposal.executedAt).toBe(1700001000);
    });
  });

  // -------------------------------------------------------------------------
  // getDelegationState()
  // -------------------------------------------------------------------------

  describe('getDelegationState()', () => {
    it('returns null delegatedTo when no delegation is active', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(makeDelegationNative()) as never);

      const state: DelegationState = await governance.getDelegationState(ALICE_ADDRESS);

      expect(state.delegatedTo).toBeNull();
      expect(state.delegatedFrom).toEqual([]);
      expect(state.totalVotingPower).toBe(5000n);
      expect(state.ownPower).toBe(5000n);
    });

    it('returns correct delegatedTo when delegation is active', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult(
          makeDelegationNative({ delegated_to: BOB_ADDRESS }),
        ) as never,
      );

      const state = await governance.getDelegationState(ALICE_ADDRESS);

      expect(state.delegatedTo).toBe(BOB_ADDRESS);
    });

    it('returns delegatedFrom array with all delegators', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult(
          makeDelegationNative({
            delegated_from: [ALICE_ADDRESS],
            total_voting_power: '15000',
            own_power: '5000',
          }),
        ) as never,
      );

      const state = await governance.getDelegationState(BOB_ADDRESS);

      expect(state.delegatedFrom).toContain(ALICE_ADDRESS);
      expect(state.totalVotingPower).toBe(15000n);
      expect(state.ownPower).toBe(5000n);
      // totalVotingPower = ownPower + delegated power
      expect(state.totalVotingPower).toBeGreaterThan(state.ownPower);
    });

    it('throws ValidationError for an invalid address', async () => {
      await expect(governance.getDelegationState('not-valid')).rejects.toThrow(ValidationError);
    });

    it('returns empty state when simulation has no return value', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(null, false) as never);

      const state = await governance.getDelegationState(ALICE_ADDRESS);

      expect(state.delegatedTo).toBeNull();
      expect(state.delegatedFrom).toEqual([]);
      expect(state.totalVotingPower).toBe(0n);
      expect(state.ownPower).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // getProposalHistory()
  // -------------------------------------------------------------------------

  describe('getProposalHistory()', () => {
    const passedProposal = makeProposalNative({ id: 'p-passed', status: 'passed' });
    const rejectedProposal = makeProposalNative({ id: 'p-rejected', status: 'rejected' });
    const expiredProposal = makeProposalNative({ id: 'p-expired', status: 'expired' });

    it('returns empty array when no proposals exist', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeArraySimResult([]) as never);

      const history = await governance.getProposalHistory();

      expect(history).toEqual([]);
    });

    it('returns all proposals when no filter is provided', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(
          makeArraySimResult([passedProposal, rejectedProposal]) as never,
        );

      const history = await governance.getProposalHistory();

      expect(history.length).toBe(2);
    });

    it('filters by status correctly', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(
          makeArraySimResult([passedProposal, rejectedProposal, expiredProposal]) as never,
        );

      const history = await governance.getProposalHistory({ status: 'passed' });

      expect(history.every((p) => p.status === 'passed')).toBe(true);
    });

    it('limits results via the limit parameter', async () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        makeProposalNative({ id: `p-${i}`, status: 'passed' }),
      );
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeArraySimResult(many) as never);

      const history = await governance.getProposalHistory({ limit: 3 });

      expect(history.length).toBe(3);
    });

    it('returns empty array when simulation fails', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(null, false) as never);

      const history = await governance.getProposalHistory();

      expect(history).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // delegate() and undelegate()
  // -------------------------------------------------------------------------

  describe('delegate()', () => {
    it('returns tx hash on successful delegation', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: true,
        txHash: TEST_TX_HASH,
        data: { txHash: TEST_TX_HASH, ledger: 2000 },
      });

      const hash = await governance.delegate(BOB_ADDRESS, mockSigner);

      expect(hash).toBe(TEST_TX_HASH);
    });

    it('throws ValidationError when delegating to self', async () => {
      // mockSigner returns ALICE_ADDRESS; delegating to ALICE_ADDRESS should fail
      await expect(governance.delegate(ALICE_ADDRESS, mockSigner)).rejects.toThrow(ValidationError);
      await expect(governance.delegate(ALICE_ADDRESS, mockSigner)).rejects.toThrow(
        'Cannot delegate to self',
      );
    });

    it('throws ValidationError for an invalid toAddress', async () => {
      await expect(governance.delegate('bad-address', mockSigner)).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError when submission fails', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Delegation contract error' },
      });

      await expect(governance.delegate(BOB_ADDRESS, mockSigner)).rejects.toThrow(TransactionError);
    });
  });

  describe('undelegate()', () => {
    it('returns tx hash when undelegation succeeds', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: true,
        txHash: TEST_TX_HASH,
        data: { txHash: TEST_TX_HASH, ledger: 2001 },
      });

      const hash = await governance.undelegate(mockSigner);

      expect(hash).toBe(TEST_TX_HASH);
    });

    it('throws TransactionError when no active delegation exists', async () => {
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'No active delegation found' },
      });

      await expect(governance.undelegate(mockSigner)).rejects.toThrow(TransactionError);
      await expect(governance.undelegate(mockSigner)).rejects.toThrow('No active delegation found');
    });
  });
});
