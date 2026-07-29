import { CoralSwapClient } from '@/client';
import { Contract, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { Signer, Result } from '@/types/common';
import { TransactionError, ValidationError } from '@/errors';
import { validateAddress, validatePositiveAmount } from '@/utils/validation';
import { idempotentSubmit } from '@/utils/idempotent-resubmission';

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

    const submitFn = async () => this.client.submitTransaction([op]);

    // Initial submission to get a txHash
    const initialResult = await submitFn();
    if (!initialResult.txHash) {
      throw new TransactionError('Deposit failed to produce a transaction hash');
    }

    return idempotentSubmit(
      initialResult.txHash,
      submitFn,
      this.client.server,
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

    const submitFn = async () => this.client.submitTransaction([op]);

    // Initial submission to get a txHash
    const initialResult = await submitFn();
    if (!initialResult.txHash) {
      throw new TransactionError('Withdrawal failed to produce a transaction hash');
    }

    return idempotentSubmit(
      initialResult.txHash,
      submitFn,
      this.client.server,
    );
  }
}
