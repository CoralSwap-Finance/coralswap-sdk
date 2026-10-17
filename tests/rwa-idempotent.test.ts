import { RWAModule } from '../src/rwa';
import { TransactionError } from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const DEJTRSY = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const NAV_FEED = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PAIR_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

/**
 * Build a minimal mock CoralSwapClient with controllable submitTransaction
 * and server.getTransaction responses (mirrors tests/flash-loan.test.ts).
 */
function buildMockClient(options: {
  submitResults?: object[];
  txResult?: object;
  pairAddress?: string | null;
} = {}) {
  const {
    submitResults = [{ success: true, txHash: 'CREATE_TX', data: { ledger: 1000 } }],
    txResult = { status: 'NOT_FOUND' },
    pairAddress = PAIR_ADDRESS,
  } = options;

  const submitTransaction = jest.fn();
  submitResults.forEach((r) => submitTransaction.mockResolvedValueOnce(r));

  return {
    publicKey: 'GTEST_SENDER',
    factory: {
      buildCreateRWAPair: jest.fn().mockReturnValue('mock_create_rwa_pair_op'),
    },
    getPairAddress: jest.fn().mockResolvedValue(pairAddress),
    submitTransaction,
    server: {
      getTransaction: jest.fn().mockResolvedValue(txResult),
    },
  };
}

const REQUEST = {
  tokenA: USDC,
  tokenB: DEJTRSY,
  navPriceFeedAddress: NAV_FEED,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RWAModule.createRWAPair() — idempotent resubmission', () => {
  it('returns the pair on a normal successful submission', async () => {
    const client = buildMockClient();
    const module = new RWAModule(client as any);

    const result = await module.createRWAPair(REQUEST);

    expect(result.txHash).toBe('CREATE_TX');
    expect(result.ledger).toBe(1000);
    expect(result.pairAddress).toBe(PAIR_ADDRESS);
    expect(client.submitTransaction).toHaveBeenCalledTimes(1);
  });

  describe('timeout-after-landed detection', () => {
    it('does not resubmit when submission times out but the pair creation already landed', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'CREATE_TX' },
        ],
        txResult: { status: 'SUCCESS', ledger: 54321 },
      });
      const module = new RWAModule(client as any);

      const result = await module.createRWAPair(REQUEST);

      expect(result.txHash).toBe('CREATE_TX');
      expect(result.ledger).toBe(54321);
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
      expect(client.server.getTransaction).toHaveBeenCalledWith('CREATE_TX');
    });

    it('throws and does not resubmit when the transaction genuinely failed on-chain', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'CREATE_TX' },
        ],
        txResult: { status: 'FAILED', ledger: 54321 },
      });
      const module = new RWAModule(client as any);

      await expect(module.createRWAPair(REQUEST)).rejects.toThrow(TransactionError);
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('resubmits exactly once when the transaction was never found on-chain', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'CREATE_TX_1' },
          { success: true, txHash: 'CREATE_TX_2', data: { ledger: 777 } },
        ],
        txResult: { status: 'NOT_FOUND' },
      });
      const module = new RWAModule(client as any);

      const result = await module.createRWAPair(REQUEST);

      expect(result.txHash).toBe('CREATE_TX_2');
      expect(result.ledger).toBe(777);
      expect(client.submitTransaction).toHaveBeenCalledTimes(2);
    });

    it('throws after a failed retry when the transaction never lands even after resubmission', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'CREATE_TX_1' },
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' } },
        ],
        txResult: { status: 'NOT_FOUND' },
      });
      const module = new RWAModule(client as any);

      await expect(module.createRWAPair(REQUEST)).rejects.toThrow(TransactionError);
      expect(client.submitTransaction).toHaveBeenCalledTimes(2);
    });

    it('throws immediately when the failed submission has no txHash to check', async () => {
      const client = buildMockClient({
        submitResults: [{ success: false, error: { code: 'SIMULATION_FAILED', message: 'Simulation failed' } }],
      });
      const module = new RWAModule(client as any);

      await expect(module.createRWAPair(REQUEST)).rejects.toThrow(TransactionError);
      expect(client.server.getTransaction).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('rejects an invalid tokenA address before submitting anything', async () => {
      const client = buildMockClient();
      const module = new RWAModule(client as any);

      await expect(
        module.createRWAPair({ ...REQUEST, tokenA: 'not-an-address' }),
      ).rejects.toThrow();
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });
  });
});
