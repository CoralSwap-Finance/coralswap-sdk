import { CoralSwapClient } from '../src/client';
import { GovernanceModule } from '../src/modules/governance';
import { TransactionError } from '../src/errors';
import { Signer } from '../src/types/common';
import { ProposalAction } from '../src/types/governance';
import { SorobanRpc, nativeToScVal } from '@stellar/stellar-sdk';

const GOVERNANCE_CONTRACT =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USER_ADDRESS =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ACTION_CONTRACT =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

describe('GovernanceModule - idempotent resubmission', () => {
  let client: CoralSwapClient;
  let governance: GovernanceModule;
  let signer: Signer;
  let server: jest.Mocked<SorobanRpc.Server>;
  let submitTransaction: jest.Mock;
  let simulateTransaction: jest.Mock;

  const mockActions: ProposalAction[] = [
    {
      contractAddress: ACTION_CONTRACT,
      functionName: 'set_fee',
      args: [nativeToScVal(50)],
    },
  ];

  beforeEach(() => {
    submitTransaction = jest.fn();
    simulateTransaction = jest.fn();

    server = {
      getTransaction: jest.fn(),
    } as unknown as jest.Mocked<SorobanRpc.Server>;

    client = {
      submitTransaction,
      simulateTransaction,
      server,
    } as unknown as CoralSwapClient;

    signer = {
      publicKey: jest.fn().mockResolvedValue(USER_ADDRESS),
    } as unknown as Signer;

    governance = new GovernanceModule(client, GOVERNANCE_CONTRACT);
  });

  describe('createProposal', () => {
    it('does not resubmit when the timed-out proposal creation already landed', async () => {
      const txHash = 'create-proposal-landed';

      submitTransaction.mockResolvedValueOnce({
        success: false,
        txHash,
        error: {
          code: 'TX_TIMEOUT',
          message: 'Transaction confirmation timed out',
        },
      });

      server.getTransaction.mockResolvedValue({
        status: 'SUCCESS',
        ledger: 100,
      } as any);

      const result = await governance.createProposal(
        'Proposal Title',
        'Proposal Description',
        mockActions,
        signer,
      );

      expect(result).toBe(txHash);
      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('does not resubmit when the timed-out proposal creation genuinely failed on-chain', async () => {
      const txHash = 'create-proposal-failed';

      submitTransaction.mockResolvedValueOnce({
        success: false,
        txHash,
        error: {
          code: 'TX_TIMEOUT',
          message: 'Transaction confirmation timed out',
        },
      });

      server.getTransaction.mockResolvedValue({
        status: 'FAILED',
        ledger: 101,
      } as any);

      await expect(
        governance.createProposal(
          'Proposal Title',
          'Proposal Description',
          mockActions,
          signer,
        ),
      ).rejects.toThrow(TransactionError);

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('retries when the timed-out proposal creation was not found on-chain', async () => {
      const originalTxHash = 'create-proposal-not-found';
      const retryTxHash = 'create-proposal-retry';

      submitTransaction
        .mockResolvedValueOnce({
          success: false,
          txHash: originalTxHash,
          error: {
            code: 'TX_TIMEOUT',
            message: 'Transaction confirmation timed out',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          txHash: retryTxHash,
          data: {
            ledger: 102,
          },
        });

      server.getTransaction.mockResolvedValue({
        status: 'NOT_FOUND',
      } as any);

      const result = await governance.createProposal(
        'Proposal Title',
        'Proposal Description',
        mockActions,
        signer,
      );

      expect(result).toBe(retryTxHash);
      expect(submitTransaction).toHaveBeenCalledTimes(2);
      expect(server.getTransaction).toHaveBeenCalledWith(originalTxHash);
    });
  });

  describe('castVote', () => {
    beforeEach(() => {
      // Mock simulateTransaction for getProposal validation
      simulateTransaction.mockResolvedValue({
        success: true,
        returnValue: nativeToScVal({
          id: 'prop-1',
          title: 'Title',
          description: 'Desc',
          status: 'active',
          votes_for: '100',
          votes_against: '0',
          votes_abstain: '0',
          deadline: 2000000,
          proposer: USER_ADDRESS,
          created_at: 1000000,
        }),
      });
    });

    it('does not resubmit when the timed-out vote already landed', async () => {
      const txHash = 'vote-landed';

      submitTransaction.mockResolvedValueOnce({
        success: false,
        txHash,
        error: {
          code: 'TX_TIMEOUT',
          message: 'Transaction confirmation timed out',
        },
      });

      server.getTransaction.mockResolvedValue({
        status: 'SUCCESS',
        ledger: 200,
      } as any);

      const result = await governance.castVote('prop-1', 'for', signer);

      expect(result).toBe(txHash);
      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('does not resubmit when the timed-out vote genuinely failed on-chain', async () => {
      const txHash = 'vote-failed';

      submitTransaction.mockResolvedValueOnce({
        success: false,
        txHash,
        error: {
          code: 'TX_TIMEOUT',
          message: 'Transaction confirmation timed out',
        },
      });

      server.getTransaction.mockResolvedValue({
        status: 'FAILED',
        ledger: 201,
      } as any);

      await expect(
        governance.castVote('prop-1', 'against', signer),
      ).rejects.toThrow(TransactionError);

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('retries when the timed-out vote was not found on-chain', async () => {
      const originalTxHash = 'vote-not-found';
      const retryTxHash = 'vote-retry';

      submitTransaction
        .mockResolvedValueOnce({
          success: false,
          txHash: originalTxHash,
          error: {
            code: 'TX_TIMEOUT',
            message: 'Transaction confirmation timed out',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          txHash: retryTxHash,
          data: {
            ledger: 202,
          },
        });

      server.getTransaction.mockResolvedValue({
        status: 'NOT_FOUND',
      } as any);

      const result = await governance.castVote('prop-1', 'abstain', signer);

      expect(result).toBe(retryTxHash);
      expect(submitTransaction).toHaveBeenCalledTimes(2);
      expect(server.getTransaction).toHaveBeenCalledWith(originalTxHash);
    });
  });
});
