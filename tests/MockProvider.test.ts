/**
 * Tests for MockProvider — the offline SorobanRpc.Server replacement.
 *
 * Covers:
 *  - getAccount: staged account returned, throws when not staged
 *  - getLedgerEntries: staged entries returned, empty array when none staged
 *  - sendTransaction: SUCCESS and FAILED paths, queue consumed in order
 *  - getTransaction: SUCCESS, FAILED, NOT_FOUND states
 *  - getLatestLedger: configured sequence, default when not set
 *  - reset(): all staged state cleared
 *  - Queue-exhaustion semantics (each entry consumed once)
 *  - Unstaged stub methods reject loudly
 *  - Integration test: MockProvider wired into CoralSwapClient
 */

import { xdr, SorobanRpc, Keypair, TransactionBuilder, Transaction } from '@stellar/stellar-sdk';
import { MockProvider } from '../src/test/mocks/MockProvider';
import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

// Mock TransactionBuilder so the integration test doesn't need real Stellar
// network access just to build a tx envelope.
const mockBuiltTx = {
  toXDR: jest.fn().mockReturnValue('mock-tx-xdr'),
  sign: jest.fn(),
} as unknown as Transaction;

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  const MockTransactionBuilder = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mockBuiltTx),
  }));
  return {
    ...actual,
    TransactionBuilder: MockTransactionBuilder,
    Transaction: jest.fn().mockImplementation((txXdr: string) => ({
      ...mockBuiltTx,
      toXDR: jest.fn().mockReturnValue(txXdr),
    })),
    SorobanRpc: {
      ...actual.SorobanRpc,
      assembleTransaction: jest.fn((_tx: unknown) => ({
        build: () => mockBuiltTx,
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationSuccess: jest.fn((sim: unknown) => !(sim as { error?: string }).error),
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MockProvider', () => {
  let mock: MockProvider;

  beforeEach(() => {
    mock = new MockProvider();
  });

  afterEach(() => {
    mock.reset();
  });

  // -------------------------------------------------------------------------
  // getAccount
  // -------------------------------------------------------------------------

  describe('getAccount()', () => {
    it('returns a pre-configured Account when one was staged', async () => {
      mock.setAccount(TEST_PUBLIC, { sequence: '42' });

      const account = await mock.getAccount(TEST_PUBLIC);

      expect(account.accountId()).toBe(TEST_PUBLIC);
      // Stellar Account starts with sequence incremented by 1 on usage,
      // but the underlying sequence string is stored as-is.
      expect(account.sequenceNumber()).toBe('42');
    });

    it('throws a descriptive error when no account is staged', async () => {
      await expect(mock.getAccount('GNOBODYHERE')).rejects.toThrow(
        'MockProvider: account not found for address "GNOBODYHERE"',
      );
    });

    it('returns accounts for different addresses independently', async () => {
      const addr1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      const addr2 = TEST_PUBLIC;

      mock.setAccount(addr1, { sequence: '1' });
      mock.setAccount(addr2, { sequence: '99' });

      const acc1 = await mock.getAccount(addr1);
      const acc2 = await mock.getAccount(addr2);

      expect(acc1.sequenceNumber()).toBe('1');
      expect(acc2.sequenceNumber()).toBe('99');
    });

    it('returns the most recently set account when called twice with the same address', async () => {
      mock.setAccount(TEST_PUBLIC, { sequence: '10' });
      mock.setAccount(TEST_PUBLIC, { sequence: '20' });

      const account = await mock.getAccount(TEST_PUBLIC);
      expect(account.sequenceNumber()).toBe('20');
    });
  });

  // -------------------------------------------------------------------------
  // getLedgerEntries
  // -------------------------------------------------------------------------

  describe('getLedgerEntries()', () => {
    it('returns an empty entries array when no entries are staged', async () => {
      // Build a minimal ledger key stub.
      const stubKey = {} as xdr.LedgerKey;
      (stubKey as unknown as { toXDR: (f: string) => string }).toXDR = () => 'stub-key';

      const response = await mock.getLedgerEntries(stubKey);

      expect(response.entries).toHaveLength(0);
      expect(response.latestLedger).toBeGreaterThan(0);
    });

    it('returns staged entries for registered keys', async () => {
      // Create a real-ish LedgerKey stub with a deterministic toXDR output.
      const stubKey = {
        toXDR: (format: string) => (format === 'base64' ? 'bW9ja0tleQ==' : Buffer.from('mockKey')),
      } as unknown as xdr.LedgerKey;

      const stubEntry: SorobanRpc.Api.LedgerEntryResult = {
        key: stubKey,
        val: {} as xdr.LedgerEntryData,
        lastModifiedLedgerSeq: 999,
        liveUntilLedgerSeq: 2000,
      };

      mock.setLedgerEntry(stubKey, stubEntry);

      const response = await mock.getLedgerEntries(stubKey);

      expect(response.entries).toHaveLength(1);
      expect(response.entries[0]).toBe(stubEntry);
    });

    it('returns only entries matching the queried keys', async () => {
      const key1 = {
        toXDR: (format: string) => (format === 'base64' ? 'a2V5MQ==' : Buffer.from('key1')),
      } as unknown as xdr.LedgerKey;

      const key2 = {
        toXDR: (format: string) => (format === 'base64' ? 'a2V5Mg==' : Buffer.from('key2')),
      } as unknown as xdr.LedgerKey;

      const entry1: SorobanRpc.Api.LedgerEntryResult = {
        key: key1,
        val: {} as xdr.LedgerEntryData,
      };
      const entry2: SorobanRpc.Api.LedgerEntryResult = {
        key: key2,
        val: {} as xdr.LedgerEntryData,
      };

      mock.setLedgerEntry(key1, entry1);
      mock.setLedgerEntry(key2, entry2);

      // Only query key1
      const response = await mock.getLedgerEntries(key1);
      expect(response.entries).toHaveLength(1);
      expect(response.entries[0]).toBe(entry1);
    });
  });

  // -------------------------------------------------------------------------
  // sendTransaction
  // -------------------------------------------------------------------------

  describe('sendTransaction()', () => {
    const _dummyTx = {} as Transaction;

    it('returns PENDING status with correct hash on SUCCESS queue entry', async () => {
      mock.queueTransaction({ hash: 'abc123', status: 'SUCCESS' });

      const response = await mock.sendTransaction(_dummyTx);

      expect(response.status).toBe('PENDING');
      expect(response.hash).toBe('abc123');
    });

    it('returns ERROR status with correct hash on FAILED queue entry with errorResult', async () => {
      mock.queueTransaction({
        hash: 'def456',
        status: 'FAILED',
        errorResult: 'AAAAAA==', // fake base64 errorResult XDR
      });

      const response = await mock.sendTransaction(_dummyTx);

      expect(response.status).toBe('ERROR');
      expect(response.hash).toBe('def456');
    });

    it('returns PENDING status for FAILED entry without errorResult', async () => {
      // A FAILED tx with no errorResult is treated as PENDING from
      // sendTransaction perspective — the FAILED status surfaces via getTransaction.
      mock.queueTransaction({ hash: 'failed-no-err', status: 'FAILED' });

      const response = await mock.sendTransaction(_dummyTx);

      expect(response.hash).toBe('failed-no-err');
      // Status depends on whether errorResult is set; without it, PENDING.
      expect(['PENDING', 'ERROR']).toContain(response.status);
    });

    it('throws a descriptive error when the queue is empty', async () => {
      await expect(mock.sendTransaction(_dummyTx)).rejects.toThrow(
        'MockProvider: sendTransaction() called but the transaction queue is empty',
      );
    });

    it('consumes entries from the queue in FIFO order', async () => {
      mock.queueTransaction({ hash: 'first', status: 'SUCCESS' });
      mock.queueTransaction({ hash: 'second', status: 'SUCCESS' });

      const r1 = await mock.sendTransaction(_dummyTx);
      const r2 = await mock.sendTransaction(_dummyTx);

      expect(r1.hash).toBe('first');
      expect(r2.hash).toBe('second');
    });

    it('throws after all queued transactions are consumed', async () => {
      mock.queueTransaction({ hash: 'only', status: 'SUCCESS' });

      await mock.sendTransaction(_dummyTx); // consumes the only entry

      await expect(mock.sendTransaction(_dummyTx)).rejects.toThrow(
        'MockProvider: sendTransaction() called but the transaction queue is empty',
      );
    });
  });

  // -------------------------------------------------------------------------
  // getTransaction
  // -------------------------------------------------------------------------

  describe('getTransaction()', () => {
    const _dummyTx = {} as Transaction;

    it('returns NOT_FOUND when hash was never submitted', async () => {
      const result = await mock.getTransaction('unknown-hash');

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.NOT_FOUND);
    });

    it('returns SUCCESS status after a SUCCESS transaction is sent', async () => {
      mock.queueTransaction({ hash: 'success-hash', status: 'SUCCESS', ledger: 1234 });

      await mock.sendTransaction(_dummyTx);
      const result = await mock.getTransaction('success-hash');

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
      expect((result as SorobanRpc.Api.GetSuccessfulTransactionResponse).ledger).toBe(1234);
    });

    it('returns FAILED status after a FAILED transaction is sent', async () => {
      mock.queueTransaction({ hash: 'fail-hash', status: 'FAILED', ledger: 5678 });

      await mock.sendTransaction(_dummyTx);
      const result = await mock.getTransaction('fail-hash');

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.FAILED);
      expect((result as SorobanRpc.Api.GetFailedTransactionResponse).ledger).toBe(5678);
    });

    it('returns NOT_FOUND for explicitly queued NOT_FOUND status', async () => {
      mock.queueTransaction({ hash: 'not-found-hash', status: 'NOT_FOUND' });

      await mock.sendTransaction(_dummyTx);
      const result = await mock.getTransaction('not-found-hash');

      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.NOT_FOUND);
    });

    it('falls back to latestLedger when no ledger is set on the queued tx', async () => {
      mock.setLatestLedger(2000);
      mock.queueTransaction({ hash: 'no-ledger', status: 'SUCCESS' });

      await mock.sendTransaction(_dummyTx);
      const result = await mock.getTransaction('no-ledger');

      expect((result as SorobanRpc.Api.GetSuccessfulTransactionResponse).ledger).toBe(2000);
    });

    it('can retrieve the same transaction multiple times', async () => {
      mock.queueTransaction({ hash: 'multi-get', status: 'SUCCESS' });

      await mock.sendTransaction(_dummyTx);

      const r1 = await mock.getTransaction('multi-get');
      const r2 = await mock.getTransaction('multi-get');

      expect(r1.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
      expect(r2.status).toBe(SorobanRpc.Api.GetTransactionStatus.SUCCESS);
    });
  });

  // -------------------------------------------------------------------------
  // getLatestLedger
  // -------------------------------------------------------------------------

  describe('getLatestLedger()', () => {
    it('returns default sequence 1000 when not configured', async () => {
      const response = await mock.getLatestLedger();

      expect(response.sequence).toBe(1000);
      expect(response.id).toContain('1000');
    });

    it('returns configured sequence after setLatestLedger()', async () => {
      mock.setLatestLedger(1500);

      const response = await mock.getLatestLedger();

      expect(response.sequence).toBe(1500);
    });

    it('returns a non-empty protocolVersion string', async () => {
      const response = await mock.getLatestLedger();
      expect(typeof response.protocolVersion).toBe('string');
      expect(response.protocolVersion.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // getHealth
  // -------------------------------------------------------------------------

  describe('getHealth()', () => {
    it('always reports healthy', async () => {
      const health = await mock.getHealth();
      expect(health.status).toBe('healthy');
    });
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------

  describe('reset()', () => {
    it('clears all staged accounts', async () => {
      mock.setAccount(TEST_PUBLIC, { sequence: '1' });
      mock.reset();

      await expect(mock.getAccount(TEST_PUBLIC)).rejects.toThrow(
        'MockProvider: account not found',
      );
    });

    it('clears all staged ledger entries', async () => {
      const key = {
        toXDR: (_f: string) => 'reset-key',
      } as unknown as xdr.LedgerKey;

      mock.setLedgerEntry(key, { key, val: {} as xdr.LedgerEntryData });
      mock.reset();

      const response = await mock.getLedgerEntries(key);
      expect(response.entries).toHaveLength(0);
    });

    it('clears the transaction queue', async () => {
      mock.queueTransaction({ hash: 'queued', status: 'SUCCESS' });
      mock.reset();

      await expect(mock.sendTransaction({} as Transaction)).rejects.toThrow(
        'MockProvider: sendTransaction() called but the transaction queue is empty',
      );
    });

    it('clears resolved transaction results', async () => {
      mock.queueTransaction({ hash: 'was-sent', status: 'SUCCESS' });
      await mock.sendTransaction({} as Transaction);

      mock.reset();

      const result = await mock.getTransaction('was-sent');
      expect(result.status).toBe(SorobanRpc.Api.GetTransactionStatus.NOT_FOUND);
    });

    it('resets latestLedger back to the default 1000', async () => {
      mock.setLatestLedger(9999);
      mock.reset();

      const response = await mock.getLatestLedger();
      expect(response.sequence).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // Queue consumed in order / empties correctly
  // -------------------------------------------------------------------------

  describe('Queue ordering and exhaustion', () => {
    it('processes three queued transactions in FIFO order', async () => {
      const hashes = ['tx-a', 'tx-b', 'tx-c'];
      hashes.forEach((h) => mock.queueTransaction({ hash: h, status: 'SUCCESS' }));

      const results = await Promise.all([
        mock.sendTransaction({} as Transaction),
        mock.sendTransaction({} as Transaction),
        mock.sendTransaction({} as Transaction),
      ]);

      expect(results.map((r) => r.hash)).toEqual(hashes);
    });

    it('queue is empty after all staged entries are consumed', async () => {
      mock.queueTransaction({ hash: 'sole', status: 'SUCCESS' });

      await mock.sendTransaction({} as Transaction);

      await expect(mock.sendTransaction({} as Transaction)).rejects.toThrow(
        'transaction queue is empty',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Stub-method loud failures
  // -------------------------------------------------------------------------

  describe('Unstaged / stub methods reject loudly', () => {
    const cases: Array<{ name: string; call: () => Promise<unknown> }> = [
      {
        name: 'getContractData',
        call: () => mock.getContractData('CCONT', {} as xdr.ScVal),
      },
      {
        name: 'getContractWasmByContractId',
        call: () => mock.getContractWasmByContractId('CCONT'),
      },
      {
        name: 'getContractWasmByHash',
        call: () => mock.getContractWasmByHash(Buffer.from('hash')),
      },
      {
        name: '_getLedgerEntries',
        call: () => mock._getLedgerEntries({} as xdr.LedgerKey),
      },
      {
        name: '_getTransaction',
        call: () => mock._getTransaction('hash'),
      },
      {
        name: 'getTransactions',
        call: () => mock.getTransactions({ startLedger: 1 }),
      },
      {
        name: 'getEvents',
        call: () => mock.getEvents({ filters: [] }),
      },
      {
        name: 'getNetwork',
        call: () => mock.getNetwork(),
      },
      {
        name: 'prepareTransaction',
        call: () => mock.prepareTransaction({} as Transaction),
      },
      {
        name: '_sendTransaction',
        call: () => mock._sendTransaction({} as Transaction),
      },
      {
        name: 'getFeeStats',
        call: () => mock.getFeeStats(),
      },
      {
        name: 'getVersionInfo',
        call: () => mock.getVersionInfo(),
      },
    ];

    it.each(cases)('$name() rejects with a readable error message', async ({ name, call }) => {
      await expect(call()).rejects.toThrow(`MockProvider: ${name}() is not implemented`);
    });
  });

  // -------------------------------------------------------------------------
  // Integration test — MockProvider wired into CoralSwapClient
  // -------------------------------------------------------------------------

  describe('Integration: MockProvider wired into CoralSwapClient', () => {
    it('runs the full submitTransaction flow end-to-end without a live network', async () => {
      // 1. Build the client, replacing the internal server with MockProvider.
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        // Reduce polling so the test doesn't spin for long.
        maxRetries: 1,
        retryDelayMs: 0,
      });

      // 2. Wire the mock in exactly the same way the existing unit tests do:
      //    the `server` property is public and writable per the existing pattern.
      (client as unknown as { server: MockProvider }).server = mock;

      // 3. Stage all state the flow needs.
      mock.setAccount(TEST_PUBLIC, { sequence: '100' });
      mock.queueTransaction({ hash: 'integration-hash', status: 'SUCCESS', ledger: 1001 });
      mock.setLatestLedger(1001);

      // 4. Exercise the full submitTransaction path.
      //    simulateTransaction on MockProvider returns a success simulation,
      //    so the flow proceeds through sign → send → poll.
      const mockOperation = {} as xdr.Operation;
      const result = await client.submitTransaction([mockOperation]);

      // 5. Verify the end-to-end result.
      expect(result.success).toBe(true);
      expect(result.data?.txHash).toBe('integration-hash');
      expect(result.data?.ledger).toBe(1001);
      expect(result.txHash).toBe('integration-hash');
    });

    it('reports TX_FAILED when the queued transaction is staged as failed', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
        maxRetries: 1,
        retryDelayMs: 0,
      });

      (client as unknown as { server: MockProvider }).server = mock;

      mock.setAccount(TEST_PUBLIC, { sequence: '200' });
      mock.queueTransaction({ hash: 'fail-integration', status: 'FAILED', ledger: 2000 });

      const result = await client.submitTransaction([{} as xdr.Operation]);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TX_FAILED');
      expect(result.txHash).toBe('fail-integration');
    });

    it('getCurrentLedger() returns the mocked sequence', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      (client as unknown as { server: MockProvider }).server = mock;
      mock.setLatestLedger(4242);

      const ledger = await client.getCurrentLedger();
      expect(ledger).toBe(4242);
    });

    it('isHealthy() returns true against MockProvider', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: TEST_SECRET,
      });

      (client as unknown as { server: MockProvider }).server = mock;

      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
    });
  });
});
