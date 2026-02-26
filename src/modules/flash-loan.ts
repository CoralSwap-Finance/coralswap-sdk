import { CoralSwapClient } from "@/client";
import {
  FlashLoanRequest,
  FlashLoanResult,
  FlashLoanFeeEstimate,
} from "@/types/flash-loan";
import { FlashLoanConfig } from "@/types/pool";
import {
  calculateRepayment,
  validateFeeFloor,
} from "@/contracts/flash-receiver";
import { FlashLoanError, TransactionError } from "@/errors";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";

/**
 * Flash Loan module -- first-class flash loan support for CoralSwap.
 *
 * Enables atomic borrow-and-repay operations within a single Soroban
 * transaction. The borrower must deploy a flash receiver contract that
 * implements the on_flash_loan callback.
 */
export class FlashLoanModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Estimate the flash loan fee for a given amount.
   *
   * @param pairAddress - The address of the pair providing the flash loan
   * @param token - The token being borrowed
   * @param amount - The amount requested to borrow
   * @returns Estimated total fee information
   * @throws {FlashLoanError} If flash loans are locked for the pair
   * @example
   * const est = await client.flashLoans.estimateFee('C...', 'C...', 1000n);
   */
  async estimateFee(
    pairAddress: string,
    token: string,
    amount: bigint,
  ): Promise<FlashLoanFeeEstimate> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(token, "token");
    validatePositiveAmount(amount, "amount");

    const pair = this.client.pair(pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress,
        },
      );
    }

    const feeAmount = (amount * BigInt(config.flashFeeBps)) / BigInt(10000);
    const feeFloorAmount = BigInt(config.flashFeeFloor);
    const actualFee = feeAmount > feeFloorAmount ? feeAmount : feeFloorAmount;

    return {
      token,
      amount,
      feeBps: config.flashFeeBps,
      feeAmount: actualFee,
      feeFloor: config.flashFeeFloor,
    };
  }

  /**
   * Execute a flash loan transaction.
   *
   * The receiver contract at receiverAddress must implement the
   * on_flash_loan(sender, token, amount, fee, data) callback.
   *
   * @param request - Parameters required to execute the flash loan
   * @returns Receipt containing the transaction hash and flash loan details
   * @throws {FlashLoanError} If flash loans are locked or if fee config is invalid
   * @throws {TransactionError} If the execution on-chain fails
   * @example
   * const result = await client.flashLoans.execute({
   *   pairAddress: 'C...', token: 'C...', amount: 1000n, receiverAddress: 'C...', callbackData: Buffer.from('')
   * });
   */
  async execute(request: FlashLoanRequest): Promise<FlashLoanResult> {
    validateAddress(request.pairAddress, "pairAddress");
    validateAddress(request.token, "token");
    validatePositiveAmount(request.amount, "amount");
    validateAddress(request.receiverAddress, "receiverAddress");

    const pair = this.client.pair(request.pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress: request.pairAddress,
        },
      );
    }

    if (!validateFeeFloor(config.flashFeeBps, config.flashFeeFloor)) {
      throw new FlashLoanError("Flash loan fee below protocol floor", {
        feeBps: config.flashFeeBps,
        feeFloor: config.flashFeeFloor,
      });
    }

    const feeEstimate = await this.estimateFee(
      request.pairAddress,
      request.token,
      request.amount,
    );

    const op = pair.buildFlashLoan(
      this.client.publicKey,
      request.token,
      request.amount,
      request.receiverAddress,
      request.callbackData,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Flash loan failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return {
      txHash: result.txHash!,
      token: request.token,
      amount: request.amount,
      fee: feeEstimate.feeAmount,
      ledger: result.data!.ledger,
    };
  }

  /**
   * Get the flash loan configuration for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns Current setup for flash loans including floor and bps
   * @example
   * const config = await client.flashLoans.getConfig('C...');
   */
  async getConfig(pairAddress: string): Promise<FlashLoanConfig> {
    const pair = this.client.pair(pairAddress);
    return pair.getFlashLoanConfig();
  }

  /**
   * Check if flash loans are available for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns True if the flash pool is unlocked
   * @example
   * const canFlash = await client.flashLoans.isAvailable('C...');
   */
  async isAvailable(pairAddress: string): Promise<boolean> {
    try {
      const config = await this.getConfig(pairAddress);
      return !config.locked;
    } catch {
      return false;
    }
  }

  /**
   * Calculate the total repayment amount (principal + fee).
   *
   * @param amount - The principal loaned amount
   * @param feeBps - The fee in basis points
   * @returns Total amount required for full repayment
   * @example
   * const totalDue = client.flashLoans.calculateRepayment(100n, 5);
   */
  calculateRepayment(amount: bigint, feeBps: number): bigint {
    return calculateRepayment(amount, feeBps);
  }

  /**
   * Get the maximum flash-borrowable amount for a token in a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param token - The address of the token to check limit for
   * @returns Maximum safe borrow limit accounting for a safety margin
   * @example
   * const maxBorrow = await client.flashLoans.getMaxBorrowable('C...', 'C...');
   */
  async getMaxBorrowable(pairAddress: string, token: string): Promise<bigint> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    // Maximum borrowable is the full reserve minus a safety margin
    const reserve = tokens.token0 === token ? reserve0 : reserve1;
    const safetyMargin = reserve / 100n; // 1% buffer
    return reserve - safetyMargin;
  }
}
