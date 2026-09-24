import { CoralSwapClient } from '../src/client';
import { BlendModule } from '../src/modules/blend';
import { TransactionError } from '../src/errors';
import { Signer } from '../src/types/common';
import { SorobanRpc } from '@stellar/stellar-sdk';

const POOL_ADDRESS =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const LP_TOKEN_ADDRESS =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const USER_ADDRESS =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('BlendModule - idempotent resubmission', () => {
  let client: CoralSwapClient;
  let blend: BlendModule;
  let signer: Signer;
  let server: jest.Mocked<SorobanRpc.Server>;
  let submitTransaction: jest.Mock;

  beforeEach(() => {
    submitTransaction = jest.fn();

    server = {
      getTransaction: jest.fn(),
    } as unknown as jest.Mocked<SorobanRpc.Server>;

    client = {
      submitTransaction,
      server,
    } as unknown as CoralSwapClient;

    signer = {
      publicKey: jest.fn().mockResolvedValue(USER_ADDRESS),
    } as unknown as Signer;

    blend = new BlendModule(client);
  });

  describe('depositCollateral', () => {
    it('does not resubmit when the timed-out transaction already landed', async () => {
      const txHash = 'deposit-landed';

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

      const result = await blend.depositCollateral(
        POOL_ADDRESS,
        LP_TOKEN_ADDRESS,
        100n,
        signer,
      );

      expect(result).toEqual({
        txHash,
        ledger: 200,
      });
      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('does not resubmit when the timed-out transaction genuinely failed on-chain', async () => {
      const txHash = 'deposit-failed';

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
        blend.depositCollateral(
          POOL_ADDRESS,
          LP_TOKEN_ADDRESS,
          100n,
          signer,
        ),
      ).rejects.toThrow(TransactionError);

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('retries when the timed-out transaction was not found on-chain', async () => {
      const originalTxHash = 'deposit-not-found';
      const retryTxHash = 'deposit-retry';

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

      const result = await blend.depositCollateral(
        POOL_ADDRESS,
        LP_TOKEN_ADDRESS,
        100n,
        signer,
      );

      expect(result).toEqual({
        txHash: retryTxHash,
        ledger: 202,
      });
      expect(submitTransaction).toHaveBeenCalledTimes(2);
      expect(server.getTransaction).toHaveBeenCalledWith(originalTxHash);
    });
  });

  describe('withdrawCollateral', () => {
    it('does not resubmit when the timed-out withdrawal already landed', async () => {
      const txHash = 'withdraw-landed';

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
        ledger: 300,
      } as any);

      const result = await blend.withdrawCollateral(
        POOL_ADDRESS,
        LP_TOKEN_ADDRESS,
        100n,
        signer,
      );

      expect(result).toEqual({
        txHash,
        ledger: 300,
      });
      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('does not resubmit when the timed-out withdrawal genuinely failed on-chain', async () => {
      const txHash = 'withdraw-failed';

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
        ledger: 301,
      } as any);

      await expect(
        blend.withdrawCollateral(
          POOL_ADDRESS,
          LP_TOKEN_ADDRESS,
          100n,
          signer,
        ),
      ).rejects.toThrow(TransactionError);

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).toHaveBeenCalledWith(txHash);
    });

    it('retries when the timed-out withdrawal was not found on-chain', async () => {
      const originalTxHash = 'withdraw-not-found';
      const retryTxHash = 'withdraw-retry';

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
            ledger: 302,
          },
        });

      server.getTransaction.mockResolvedValue({
        status: 'NOT_FOUND',
      } as any);

      const result = await blend.withdrawCollateral(
        POOL_ADDRESS,
        LP_TOKEN_ADDRESS,
        100n,
        signer,
      );

      expect(result).toEqual({
        txHash: retryTxHash,
        ledger: 302,
      });
      expect(submitTransaction).toHaveBeenCalledTimes(2);
      expect(server.getTransaction).toHaveBeenCalledWith(originalTxHash);
    });
  });
});
