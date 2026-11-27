import { SquidModule } from '../src/modules/squid';
import { CrossChainError } from '../src/errors';
import { CrossChainQuote } from '../src/types/squid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BRIDGED_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABRDG';
const TO_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADEST';

function buildQuote(overrides: Partial<CrossChainQuote> = {}): CrossChainQuote {
  return {
    routeId: 'route-1',
    isStellarNative: false,
    fromChain: 'ethereum',
    fromAsset: '0xUSDC',
    bridgedAsset: BRIDGED_TOKEN,
    toAsset: TO_TOKEN,
    amountIn: 1_000_000n,
    bridgedAmount: 990_000n,
    estimatedAmountOut: 980_000n,
    amountOutMin: 970_000n,
    bridgeFee: 5_000n,
    swapFee: 1_000n,
    totalSlippageBps: 50,
    estimatedTimeSeconds: 60,
    deadline: 9_999_999_999,
    steps: [],
    ...overrides,
  };
}

/**
 * Build a minimal mock CoralSwapClient with controllable submitTransaction
 * and server.getTransaction responses (mirrors the pattern used by
 * tests/flash-loan.test.ts).
 */
function buildMockClient(options: { submitResults?: object[]; txResult?: object } = {}) {
  const {
    submitResults = [{ success: true, txHash: 'SWAP_TX', data: { ledger: 100 } }],
    txResult = { status: 'NOT_FOUND' },
  } = options;

  const submitTransaction = jest.fn();
  submitResults.forEach((r) => submitTransaction.mockResolvedValueOnce(r));

  return {
    publicKey: 'GTEST_SENDER',
    getDeadline: jest.fn().mockReturnValue(9_999_999_999),
    router: {
      buildSwapExactIn: jest.fn().mockReturnValue('mock_swap_op'),
    },
    submitTransaction,
    server: {
      getTransaction: jest.fn().mockResolvedValue(txResult),
    },
  };
}

/** Build a mock fetch that dispatches based on whether the URL is a bridge execute or status call. */
function buildMockFetch(handlers: {
  execute?: () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  status?: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}) {
  return jest.fn(async (url: string) => {
    if (url.includes('/execute')) {
      if (!handlers.execute) throw new Error('unexpected /execute call');
      return handlers.execute();
    }
    if (url.includes('/status')) {
      if (!handlers.status) throw new Error('unexpected /status call');
      return handlers.status();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SquidModule.executeCrossChainSwap — idempotent resubmission', () => {
  describe('Stellar-native bypass', () => {
    it('skips the bridge leg entirely and never calls the Squid API', async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({});
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const quote = buildQuote({ isStellarNative: true, bridgedAsset: '0xNATIVE', bridgedAmount: 1_000_000n });
      const result = await module.executeCrossChainSwap(quote);

      expect(result.bridgeTxHash).toBeUndefined();
      expect(result.swapTxHash).toBe('SWAP_TX');
      expect(result.ledger).toBe(100);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('bridge leg (Squid API-tracked status)', () => {
    it('does not resubmit when the Squid API call times out but the route already landed', async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        execute: () => Promise.reject(new Error('Request timeout')),
        status: () =>
          okJson({ status: 'success', toChain: { transactionHash: 'BRIDGE_TX_LANDED' } }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const result = await module.executeCrossChainSwap(buildQuote());

      expect(result.bridgeTxHash).toBe('BRIDGE_TX_LANDED');
      expect(result.swapTxHash).toBe('SWAP_TX');
      // exactly one failed execute attempt + one status check, no resubmission
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not resubmit when the route is still ongoing', async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        execute: () => Promise.reject(new Error('socket hang up')),
        status: () =>
          okJson({ status: 'ongoing', toChain: { transactionHash: 'BRIDGE_TX_INFLIGHT' } }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const result = await module.executeCrossChainSwap(buildQuote());

      expect(result.bridgeTxHash).toBe('BRIDGE_TX_INFLIGHT');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('throws and does not resubmit when the bridge genuinely failed', async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        execute: () => Promise.reject(new Error('connection timeout')),
        status: () => okJson({ status: 'failed' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(CrossChainError);

      // one failed execute attempt + one status check; never a second execute
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    it('resubmits exactly once when Squid never saw the route land', async () => {
      const client = buildMockClient();
      let executeCalls = 0;
      const fetchFn = buildMockFetch({
        execute: () => {
          executeCalls += 1;
          if (executeCalls === 1) return Promise.reject(new Error('timeout'));
          return okJson({ transactionHash: 'BRIDGE_TX_RETRIED' }) as any;
        },
        status: () => okJson({ status: 'not_found' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const result = await module.executeCrossChainSwap(buildQuote());

      expect(result.bridgeTxHash).toBe('BRIDGE_TX_RETRIED');
      expect(executeCalls).toBe(2);
      // 2 execute attempts + 1 status check
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('propagates a non-retryable bridge error immediately without checking status', async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        execute: () => Promise.resolve({ ok: false, status: 400, json: async () => ({}) }),
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(CrossChainError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('swap leg (on-chain Soroban status)', () => {
    it('does not resubmit when submission times out but the swap already landed', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'SWAP_TX' },
        ],
        txResult: { status: 'SUCCESS', ledger: 555 },
      });
      const fetchFn = buildMockFetch({
        execute: () => okJson({ transactionHash: 'BRIDGE_TX' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const result = await module.executeCrossChainSwap(buildQuote());

      expect(result.swapTxHash).toBe('SWAP_TX');
      expect(result.ledger).toBe(555);
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
      expect(client.server.getTransaction).toHaveBeenCalledWith('SWAP_TX');
    });

    it('throws and does not resubmit when the swap genuinely failed on-chain', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'SWAP_TX' },
        ],
        txResult: { status: 'FAILED', ledger: 555 },
      });
      const fetchFn = buildMockFetch({
        execute: () => okJson({ transactionHash: 'BRIDGE_TX' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(CrossChainError);
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('resubmits with a fresh transaction when the swap was never found on-chain', async () => {
      const client = buildMockClient({
        submitResults: [
          { success: false, error: { code: 'TX_TIMEOUT', message: 'Transaction confirmation timed out' }, txHash: 'SWAP_TX_1' },
          { success: true, txHash: 'SWAP_TX_2', data: { ledger: 777 } },
        ],
        txResult: { status: 'NOT_FOUND' },
      });
      const fetchFn = buildMockFetch({
        execute: () => okJson({ transactionHash: 'BRIDGE_TX' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      const result = await module.executeCrossChainSwap(buildQuote());

      expect(result.swapTxHash).toBe('SWAP_TX_2');
      expect(result.ledger).toBe(777);
      expect(client.submitTransaction).toHaveBeenCalledTimes(2);
      expect(client.router.buildSwapExactIn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately when the failed submission has no txHash to check', async () => {
      const client = buildMockClient({
        submitResults: [{ success: false, error: { code: 'SIMULATION_FAILED', message: 'Simulation failed' } }],
      });
      const fetchFn = buildMockFetch({
        execute: () => okJson({ transactionHash: 'BRIDGE_TX' }) as any,
      });
      const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

      await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(CrossChainError);
      expect(client.server.getTransaction).not.toHaveBeenCalled();
    });
  });
});
