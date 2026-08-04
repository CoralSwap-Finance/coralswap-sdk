import { Keypair, SorobanRpc, xdr, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { ConnectionPool } from '../src';
import { Network, Signer } from '../src/types/common';
import { SignerError } from '../src/errors';
import { DEFAULTS } from '../src/config';
import { resetCircuitBreakers, DeadlineError } from '../src/utils/retry';

// Mock transaction for testing
const mockTx = {
  toXDR: jest.fn().mockReturnValue('mock-tx-xdr'),
  sign: jest.fn(),
} as unknown as Transaction;

// Mock TransactionBuilder
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  
  const MockTransactionBuilder = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mockTx),
  }));

  return {
    ...actual,
    TransactionBuilder: MockTransactionBuilder,
    Transaction: jest.fn().mockImplementation((xdr: string) => ({
      ...mockTx,
      toXDR: jest.fn().mockReturnValue(xdr),
    })),
    SorobanRpc: {
      ...actual.SorobanRpc,
      assembleTransaction: jest.fn((tx: any) => ({
        build: () => mockTx,
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationSuccess: jest.fn((sim: any) => !sim.error),
      },
    },
  };
});

/**
 * Tests for CoralSwapClient transaction lifecycle.
 *
 * Covers constructor, publicKey resolution, deadline calculation,
 * health checks, transaction submission, and polling logic.
 */
describe('CoralSwapClient', () => {
  const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
  const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

  describe('Constructor', () => {
    it('creates client with valid testnet config', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      expect(client.network).toBe(Network.TESTNET);
      expect(client.networkConfig.networkPassphrase).toBe('Test SDF Network ; September 2015');
      expect(client.networkConfig.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    });

    it('creates client with valid mainnet config', () => {
      const client = new CoralSwapClient({
        network: Network.MAINNET,
        secretKey: TEST_SECRET,
      });

      expect(client.network).toBe(Network.MAINNET);
      expect(client.networkConfig.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
      expect(client.networkConfig.rpcUrl).toBe('https://soroban.stellar.org');
    });

    it('sets correct defaults for optional config fields', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      expect(client.config.defaultSlippageBps).toBe(DEFAULTS.slippageBps);
      expect(client.config.defaultDeadlineSec).toBe(DEFAULTS.deadlineSec);
      expect(client.config.maxRetries).toBe(DEFAULTS.maxRetries);
      expect(client.config.retryDelayMs).toBe(DEFAULTS.retryDelayMs);
    });

    it('allows custom RPC URL override', () => {
      const customRpcUrl = 'https://custom-rpc.example.com';
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        rpcUrl: customRpcUrl,
      });

      expect(client.networkConfig.rpcUrl).toBe(customRpcUrl);
    });

    it('exports ConnectionPool from the package root', () => {
      expect(ConnectionPool).toBeDefined();
    });

    it('allows custom config overrides', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        defaultSlippageBps: 100,
        defaultDeadlineSec: 600,
        maxRetries: 5,
        retryDelayMs: 2000,
        deadlineMs: 5000,
      });

      expect(client.config.defaultSlippageBps).toBe(100);
      expect(client.config.defaultDeadlineSec).toBe(600);
      expect(client.config.maxRetries).toBe(5);
      expect(client.config.retryDelayMs).toBe(2000);
      expect(client.config.deadlineMs).toBe(5000);
    });
  });

  describe('publicKey getter', () => {
    it('returns key from secretKey when provided', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      expect(client.publicKey).toBe(TEST_PUBLIC);
    });

    it('returns publicKey from config when provided', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: TEST_PUBLIC,
      });

      expect(client.publicKey).toBe(TEST_PUBLIC);
    });

    it('throws when neither secretKey nor publicKey is configured', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
      });

      expect(() => client.publicKey).toThrow(SignerError);
    });

    it('returns cached key after resolvePublicKey is called', async () => {
      const mockSigner: Signer = {
        publicKey: jest.fn().mockResolvedValue(TEST_PUBLIC),
        signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        signer: mockSigner,
      });

      await client.resolvePublicKey();
      expect(client.publicKey).toBe(TEST_PUBLIC);
    });
  });

  describe('getDeadline()', () => {
    it('returns current timestamp + default offset', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const now = Math.floor(Date.now() / 1000);
      const deadline = client.getDeadline();

      expect(deadline).toBeGreaterThanOrEqual(now + DEFAULTS.deadlineSec);
      expect(deadline).toBeLessThanOrEqual(now + DEFAULTS.deadlineSec + 2);
    });

    it('returns current timestamp + custom offset', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const customOffset = 300;
      const now = Math.floor(Date.now() / 1000);
      const deadline = client.getDeadline(customOffset);

      expect(deadline).toBeGreaterThanOrEqual(now + customOffset);
      expect(deadline).toBeLessThanOrEqual(now + customOffset + 2);
    });

    it('uses config defaultDeadlineSec when no offset provided', () => {
      const customDefault = 600;
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        defaultDeadlineSec: customDefault,
      });

      const now = Math.floor(Date.now() / 1000);
      const deadline = client.getDeadline();

      expect(deadline).toBeGreaterThanOrEqual(now + customDefault);
      expect(deadline).toBeLessThanOrEqual(now + customDefault + 2);
    });
  });

  describe('isHealthy()', () => {
    it('returns true when server responds healthy', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetHealth = jest.fn().mockResolvedValue({ status: 'healthy' });
      client.server.getHealth = mockGetHealth;

      const result = await client.isHealthy();

      expect(result).toBe(true);
      expect(mockGetHealth).toHaveBeenCalledTimes(1);
    });

    it('returns false when server throws', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetHealth = jest.fn().mockRejectedValue(new Error('Connection failed'));
      client.server.getHealth = mockGetHealth;

      const result = await client.isHealthy();

      expect(result).toBe(false);
      expect(mockGetHealth).toHaveBeenCalledTimes(1);
    });

    it('returns false when server responds unhealthy', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetHealth = jest.fn().mockResolvedValue({ status: 'unhealthy' });
      client.server.getHealth = mockGetHealth;

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });
  });

  describe('submitTransaction()', () => {
    const mockAccount = {
      accountId: () => TEST_PUBLIC,
      sequenceNumber: () => '1234567890',
      incrementSequenceNumber: jest.fn(),
    };

    // Create a minimal mock operation - we don't need real XDR for unit tests
    const mockOperation = {} as xdr.Operation;

    it('returns success result when simulation succeeds', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'test-tx-hash',
      });
      const mockGetTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        ledger: 12346,
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;
      client.server.sendTransaction = mockSendTransaction;
      client.server.getTransaction = mockGetTransaction;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(true);
      expect(result.data?.txHash).toBe('test-tx-hash');
      expect(result.data?.ledger).toBe(12346);
      expect(mockGetAccount).toHaveBeenCalledWith(TEST_PUBLIC);
      expect(mockSimulate).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it('returns SIMULATION_FAILED error for bad simulation', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        error: 'Simulation failed',
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SIMULATION_FAILED');
      expect(result.error?.message).toBe('Transaction simulation failed');
    });

    it('returns NO_SIGNER error when no keypair configured', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: TEST_PUBLIC,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_SIGNER');
      expect(result.error?.message).toContain('No signing key configured');
    });

    it('returns SUBMIT_FAILED error on submission failure', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResultXdr: 'error-xdr',
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;
      client.server.sendTransaction = mockSendTransaction;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SUBMIT_FAILED');
      expect(result.error?.message).toBe('Transaction submission failed');
    });

    it('returns UNEXPECTED_ERROR on exception', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockRejectedValue(new Error('Network error'));
      client.server.getAccount = mockGetAccount;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNEXPECTED_ERROR');
      expect(result.error?.message).toBe('Network error');
    });
  });

  describe('pollTransaction()', () => {
    const mockAccount = {
      accountId: () => TEST_PUBLIC,
      sequenceNumber: () => '1234567890',
      incrementSequenceNumber: jest.fn(),
    };

    const mockOperation = {} as xdr.Operation;

    it('returns success for completed transaction', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'test-tx-hash',
      });
      const mockGetTransaction = jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        ledger: 12346,
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;
      client.server.sendTransaction = mockSendTransaction;
      client.server.getTransaction = mockGetTransaction;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(true);
      expect(result.txHash).toBe('test-tx-hash');
      expect(result.data?.ledger).toBe(12346);
    });

    it('returns TX_FAILED for failed transaction', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'test-tx-hash',
      });
      const mockGetTransaction = jest.fn().mockResolvedValue({
        status: 'FAILED',
        ledger: 12346,
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;
      client.server.sendTransaction = mockSendTransaction;
      client.server.getTransaction = mockGetTransaction;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TX_FAILED');
      expect(result.error?.message).toBe('Transaction failed on-chain');
      expect(result.txHash).toBe('test-tx-hash');
    });

    it('returns TX_TIMEOUT after max retries exhausted', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        maxRetries: 1,
        retryDelayMs: 10,
        maxPollingAttempts: 2,
        pollingIntervalMs: 0,
      });

      const mockGetAccount = jest.fn().mockResolvedValue(mockAccount);
      const mockSimulate = jest.fn().mockResolvedValue({
        transactionData: {} as xdr.SorobanTransactionData,
        minResourceFee: '100',
        cost: { cpuInsns: '1000', memBytes: '1000' },
        latestLedger: 12345,
      });
      const mockSendTransaction = jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'test-tx-hash',
      });
      const mockGetTransaction = jest.fn().mockResolvedValue({
        status: 'NOT_FOUND',
      });

      client.server.getAccount = mockGetAccount;
      client.server.simulateTransaction = mockSimulate;
      client.server.sendTransaction = mockSendTransaction;
      client.server.getTransaction = mockGetTransaction;

      const result = await client.submitTransaction([mockOperation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TX_TIMEOUT');
      expect(result.error?.message).toContain('timed out');
      expect(result.txHash).toBe('test-tx-hash');
    });
  });
});

/**
 * Isolated tests for executeWithFallback retry / fallback behaviour.
 *
 * These tests drive the private method indirectly through isHealthy() which
 * is a thin single-call wrapper — the simplest public surface that exercises
 * the fallback loop without needing a full transaction stack.
 */
describe('executeWithFallback', () => {
  const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';

  beforeEach(() => {
    resetCircuitBreakers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('surfaces a non-retryable error immediately without cycling through fallback endpoints', async () => {
    // Three RPC URLs configured — only the first should ever be attempted.
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: [
        'https://rpc1.example.com',
        'https://rpc2.example.com',
        'https://rpc3.example.com',
      ],
      maxRetries: 0,
      retryDelayMs: 0,
    });

    // A non-retryable error: plain validation failure with no timeout/429/503 signal.
    const nonRetryableError = new Error('ValidationError: bad simulation parameters');
    const mockGetHealth = jest.fn().mockRejectedValue(nonRetryableError);
    client.server.getHealth = mockGetHealth;

    await expect(client.isHealthy()).resolves.toBe(false);

    // Must only hit the RPC once — no rotation to rpc2 or rpc3.
    expect(mockGetHealth).toHaveBeenCalledTimes(1);
  });

  it('falls back across all endpoints for retryable errors (network/timeout/429/503)', async () => {
    const rpcUrls = [
      'https://rpc1.example.com',
      'https://rpc2.example.com',
      'https://rpc3.example.com',
    ];

    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: rpcUrls,
      maxRetries: 0,   // one attempt per endpoint, no per-endpoint retries
      retryDelayMs: 0,
    });

    // Retryable error: 503 Service Unavailable
    const retryableError = Object.assign(
      new Error('503 Service Unavailable'),
      { response: { status: 503 } },
    );

    // Every endpoint fails with the retryable error.
    const mockGetHealth = jest.fn().mockRejectedValue(retryableError);
    client.server.getHealth = mockGetHealth;

    // isHealthy() catches all errors and returns false — confirm it tried all endpoints.
    await expect(client.isHealthy()).resolves.toBe(false);

    // Should have been called once per RPC endpoint (3 total).
    expect(mockGetHealth).toHaveBeenCalledTimes(rpcUrls.length);
  });

  it('stops retrying once the configured deadlineMs is exceeded and throws DeadlineError', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      // 50ms total-time budget per RPC call.
      deadlineMs: 50,
      maxRetries: 10,
      retryDelayMs: 10,
    });

    // Retryable error that keeps failing — the deadline must stop the retries.
    const retryableError = Object.assign(
      new Error('503 Service Unavailable'),
      { response: { status: 503 } },
    );
    const mockGetLatestLedger = jest.fn().mockRejectedValue(retryableError);
    client.server.getLatestLedger = mockGetLatestLedger;

    const promise = client.getCurrentLedger().catch((e) => e);

    // Advances past the 50ms deadline; without a deadline the 10 retries
    // with backoff would keep going well beyond this window.
    await jest.advanceTimersByTimeAsync(5000);

    const err = await promise;
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.message).not.toContain('503');

    // attempt 1 at t=0, attempt 2 at t=10, attempt 3 at t=30 — the
    // deadline check fires at t=70 before a 4th attempt can start.
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(3);
  });
});
