import { CoralSwapClient } from '@/client';
import { Contract, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { Signer } from '@/types/common';
import { TransactionError } from '@/errors';
import { validateAddress, validatePositiveAmount } from '@/utils/validation';
import {
  getTransactionStatus,
  shouldRetrySubmission,
} from '@/utils/idempotent-resubmission';

/**
 * Blend module — manages LP-token collateral operations for Blend pools.
 *
 * Handles depositing and withdrawing LP tokens as collateral,
 * with idempotent resubmission to prevent duplicate transactions
 * when a timeout occurs but the transaction actually landed.
 */
export class BlendModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Deposit LP-token collateral into a Blend pool.
   *
   * @param poolAddress - The Blend pool contract address
   * @param lpTokenAddress - The LP token contract address
   * @param amount - Amount of LP tokens to deposit as collateral
   * @param signer - The signer authorizing the transaction
   * @returns Transaction hash and ledger of the confirmed deposit
   * @throws {TransactionError} If the transaction fails
   */
  async depositCollateral(
    poolAddress: string,
    lpTokenAddress: string,
    amount: bigint,
    signer: Signer,
  ): Promise<{ txHash: string; ledger: number }> {
    validateAddress(poolAddress, 'poolAddress');
    validateAddress(lpTokenAddress, 'lpTokenAddress');
    validatePositiveAmount(amount, 'amount');

    const publicKey = await signer.publicKey();
    const contract = new Contract(poolAddress);

    const op = contract.call(
      'deposit_collateral',
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      nativeToScVal(Address.fromString(lpTokenAddress), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );

    const result = await this.client.submitTransaction([op]);

    if (result.success) {
      return {
        txHash: result.txHash!,
        ledger: result.data!.ledger,
      };
    }

    if (result.txHash) {
      const status = await getTransactionStatus(
        this.client.server,
        result.txHash,
      );
      const decision = shouldRetrySubmission(status);

      if (!decision.shouldRetry) {
        if (status.status === 'SUCCESS') {
          return {
            txHash: status.txHash,
            ledger: status.ledger,
          };
        }

        throw new TransactionError(
          `Deposit failed: ${
            result.error?.message ?? 'Transaction failed on-chain'
          }`,
          result.txHash,
        );
      }

      const retryResult = await this.client.submitTransaction([op]);

      if (retryResult.success) {
        return {
          txHash: retryResult.txHash!,
          ledger: retryResult.data!.ledger,
        };
      }

      throw new TransactionError(
        `Deposit failed after retry: ${
          retryResult.error?.message ?? 'Unknown error'
        }`,
        retryResult.txHash,
      );
    }

    throw new TransactionError(
      `Deposit failed: ${result.error?.message ?? 'Unknown error'}`,
      result.txHash,
    );
  }

  /**
   * Withdraw LP-token collateral from a Blend pool.
   *
   * @param poolAddress - The Blend pool contract address
   * @param lpTokenAddress - The LP token contract address
   * @param amount - Amount of LP tokens to withdraw
   * @param signer - The signer authorizing the transaction
   * @returns Transaction hash and ledger of the confirmed withdrawal
   * @throws {TransactionError} If the transaction fails
   */
  async withdrawCollateral(
    poolAddress: string,
    lpTokenAddress: string,
    amount: bigint,
    signer: Signer,
  ): Promise<{ txHash: string; ledger: number }> {
    validateAddress(poolAddress, 'poolAddress');
    validateAddress(lpTokenAddress, 'lpTokenAddress');
    validatePositiveAmount(amount, 'amount');

    const publicKey = await signer.publicKey();
    const contract = new Contract(poolAddress);

    const op = contract.call(
      'withdraw_collateral',
      nativeToScVal(Address.fromString(publicKey), { type: 'address' }),
      nativeToScVal(Address.fromString(lpTokenAddress), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );

    const result = await this.client.submitTransaction([op]);

    if (result.success) {
      return {
        txHash: result.txHash!,
        ledger: result.data!.ledger,
      };
    }

    if (result.txHash) {
      const status = await getTransactionStatus(
        this.client.server,
        result.txHash,
      );
      const decision = shouldRetrySubmission(status);

      if (!decision.shouldRetry) {
        if (status.status === 'SUCCESS') {
          return {
            txHash: status.txHash,
            ledger: status.ledger,
          };
        }

        throw new TransactionError(
          `Withdrawal failed: ${
            result.error?.message ?? 'Transaction failed on-chain'
          }`,
          result.txHash,
        );
      }

      const retryResult = await this.client.submitTransaction([op]);

      if (retryResult.success) {
        return {
          txHash: retryResult.txHash!,
          ledger: retryResult.data!.ledger,
        };
      }

      throw new TransactionError(
        `Withdrawal failed after retry: ${
          retryResult.error?.message ?? 'Unknown error'
        }`,
        retryResult.txHash,
      );
    }

    throw new TransactionError(
      `Withdrawal failed: ${result.error?.message ?? 'Unknown error'}`,
      result.txHash,
    );
  }
}
