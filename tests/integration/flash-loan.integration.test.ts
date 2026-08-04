import { CoralSwapClient } from '../../src/client';
import { FlashLoanModule } from '../../src/modules/flash-loan';
import { FlashLoanError } from '../../src/errors';
import { Network } from '../../src/types/common';
import { encodeFlashLoanData } from '../../src/contracts/flash-receiver';

/**
 * Integration test: execute a real flash loan against a deployed receiver on Stellar Testnet.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET          – must be 'true' to run
 *   TEST_KEYPAIR             – funded testnet secret key (S...)
 *   FLASH_LOAN_PAIR_ADDRESS  – deployed CoralSwap pair contract address
 *   FLASH_LOAN_TOKEN         – token contract address to borrow
 *   FLASH_LOAN_RECEIVER      – deployed receiver that repays successfully
 *   FLASH_LOAN_FAILING_RECEIVER – deployed receiver that intentionally fails to repay
 *   FLASH_LOAN_AMOUNT        – optional amount to borrow (default: 1000000)
 *   TEST_RPC_URL             – optional RPC override
 */
const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Flash loan module (testnet)', () => {
  let client: CoralSwapClient;
  let flashLoan: FlashLoanModule;
  let pairAddress: string;
  let tokenAddress: string;
  let successReceiverAddress: string;
  let failingReceiverAddress: string;
  let amount: bigint;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    flashLoan = new FlashLoanModule(client);
    pairAddress = requireEnv('FLASH_LOAN_PAIR_ADDRESS');
    tokenAddress = requireEnv('FLASH_LOAN_TOKEN');
    successReceiverAddress = requireEnv('FLASH_LOAN_RECEIVER');
    failingReceiverAddress = requireEnv('FLASH_LOAN_FAILING_RECEIVER');
    amount = BigInt(process.env.FLASH_LOAN_AMOUNT ?? '1000000');

    const config = await flashLoan.getConfig(pairAddress);
    expect(config.flashFeeBps).toBeGreaterThan(0);
    expect(config.locked).toBe(false);
  });

  afterAll(async () => {
    // No persistent state is created by this suite; the receiver contracts are
    // externally deployed test fixtures and are not mutated by the SDK.
    await Promise.resolve();
  });

  it('executes a successful flash loan and verifies repayment and fee', async () => {
    const feeEstimate = await flashLoan.estimateFee(pairAddress, tokenAddress, amount);
    const expectedRepayment = flashLoan.calculateRepayment(amount, feeEstimate.feeBps);

    const result = await flashLoan.execute({
      pairAddress,
      token: tokenAddress,
      amount,
      receiverAddress: successReceiverAddress,
      callbackData: encodeFlashLoanData({
        operation: 'integration-success',
        timestamp: Date.now(),
      }),
    });

    const borrowedAmount = result.event?.borrowedAmount ?? amount;
    const feePaid = result.event?.feePaid ?? feeEstimate.feeAmount;

    expect(result.txHash).toBeTruthy();
    expect(result.amount).toBe(amount);
    expect(result.fee).toBe(feeEstimate.feeAmount);
    expect(result.event).toBeDefined();
    expect(borrowedAmount).toBe(amount);
    expect(feePaid).toBe(feeEstimate.feeAmount);
    expect(result.event?.callbackAddress).toBe(successReceiverAddress);
    expect(borrowedAmount + feePaid).toBe(expectedRepayment);
  });

  it('surfaces a FlashLoanError when repayment fails', async () => {
    let thrown: unknown;

    try {
      await flashLoan.execute({
        pairAddress,
        token: tokenAddress,
        amount,
        receiverAddress: failingReceiverAddress,
        callbackData: encodeFlashLoanData({
          operation: 'integration-failure',
          timestamp: Date.now(),
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FlashLoanError);
    expect(thrown).toBeDefined();

    const flashError = thrown as FlashLoanError;
    expect(flashError.message).toMatch(/callback|repayment|repay|revert|failed/i);
  });
});
