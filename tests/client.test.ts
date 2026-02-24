import { Keypair, SorobanRpc, xdr, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { Network, Signer } from '../src/types/common';
import { SignerError } from '../src/errors';
import { DEFAULTS } from '../src/config';

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

    it('allows custom config overrides', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        defaultSlippageBps: 100,
        defaultDeadlineSec: 600,
        maxRetries: 5,
        retryDelayMs: 2000,
      });

      expect(client.config.defaultSlippageBps).toBe(100);
      expect(client.config.defaultDeadlineSec).toBe(600);
      expect(client.config.maxRetries).toBe(5);
      expect(client.config.retryDelayMs).toBe(2000);
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
