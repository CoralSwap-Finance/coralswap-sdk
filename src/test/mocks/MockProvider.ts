/**
 * MockProvider — an offline drop-in replacement for SorobanRpc.Server.
 *
 * Implements every method on SorobanRpc.Server so the CoralSwap SDK client
 * can be instantiated and exercised in tests without a live network.
 *
 * Usage
 * -----
 *   const mock = new MockProvider();
 *
 *   mock.setAccount('GABC...', { sequence: '100', balances: [] });
 *   mock.setLedgerEntry(key, value);
 *   mock.queueTransaction({ hash: 'abc123', status: 'SUCCESS', resultMetaXdr: '...' });
 *   mock.queueTransaction({ hash: 'def456', status: 'FAILED', errorResult: '...' });
 *   mock.setLatestLedger(1500);
 *   mock.reset();
 *
 * Design notes
 * ------------
 *  - Queued transactions are consumed once in FIFO order, matching the real
 *    send→poll lifecycle and making retry-logic tests straightforward.
 *  - getLedgerEntries returns an empty entries array (not an error) when
 *    nothing is registered, matching real RPC behaviour.
 *  - All methods not relevant to the SDK surface reject with a loud
 *    "not implemented" error so mis-configured tests fail immediately
 *    instead of silently passing with undefined.
 */

import {
  Account,
  Address,
  Contract,
  FeeBumpTransaction,
  Transaction,
  xdr,
  SorobanRpc,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Public configuration types
// ---------------------------------------------------------------------------

/** Minimal account record shape that the SDK needs to build a TransactionBuilder. */
export interface MockAccountRecord {
  /** Stellar sequence number as a string (matches Account constructor). */
  sequence: string;
  balances?: unknown[];
}

/** Configuration for a queued sendTransaction success response. */
export interface MockSendSuccess {
  hash: string;
  status: 'SUCCESS';
  /** Optional XDR string attached to GetTransaction SUCCESS response. */
  resultMetaXdr?: string;
  /** Ledger number reported on the SUCCESS GetTransaction response. */
  ledger?: number;
}

/** Configuration for a queued sendTransaction failure response. */
export interface MockSendFailure {
  hash: string;
  status: 'FAILED';
  /** ErrorResult XDR string (base64) reported on the FAILED response. */
  errorResult?: string;
  /** Ledger number reported on the FAILED GetTransaction response. */
  ledger?: number;
}

/** Configuration for a queued sendTransaction NOT_FOUND response. */
export interface MockSendNotFound {
  hash: string;
  status: 'NOT_FOUND';
}

export type QueuedTransaction = MockSendSuccess | MockSendFailure | MockSendNotFound;

// ---------------------------------------------------------------------------
// Internal ledger-entry key helper
// ---------------------------------------------------------------------------

/**
 * Produce a stable string key from an xdr.LedgerKey so we can store/retrieve
 * entries from a plain Map without reference equality issues.
 */
function ledgerKeyId(key: xdr.LedgerKey): string {
  try {
    return key.toXDR('base64');
  } catch {
    // Fallback for non-XDR-serializable stubs used in tests.
    return String(key);
  }
}

// ---------------------------------------------------------------------------
// Default ledger sequence
// ---------------------------------------------------------------------------

const DEFAULT_LEDGER_SEQUENCE = 1000;

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

/**
 * Offline implementation of {@link SorobanRpc.Server} for use in tests.
 *
 * Every method on the real Server exists here. Core SDK methods are
 * fully implemented with configurable staged state; methods not called
 * by the SDK reject loudly so unexpected invocations surface immediately.
 */
export class MockProvider {
  // -------------------------------------------------------------------------
  // Staged state
  // -------------------------------------------------------------------------

  /** Accounts registered via setAccount(), keyed by Stellar address. */
  private _accounts = new Map<string, MockAccountRecord>();

  /**
   * Ledger entries registered via setLedgerEntry(), keyed by the base64-XDR
   * representation of the LedgerKey.
   */
  private _ledgerEntries = new Map<string, SorobanRpc.Api.LedgerEntryResult>();

  /**
   * FIFO queue of transactions staged via queueTransaction().
   *
   * sendTransaction() consumes the front entry and stashes the resolved
   * response so that subsequent getTransaction() calls can retrieve it.
   */
  private _txQueue: QueuedTransaction[] = [];

  /**
   * Resolved transaction responses, keyed by hash.
   * Populated when sendTransaction() is called and the queue is consumed.
   */
  private _txResults = new Map<string, QueuedTransaction>();

  /** Configured ledger sequence returned by getLatestLedger(). */
  private _latestLedgerSequence = DEFAULT_LEDGER_SEQUENCE;

  // -------------------------------------------------------------------------
  // Expose serverURL so the class structurally satisfies SorobanRpc.Server
  // -------------------------------------------------------------------------

  /**
   * Placeholder serverURL — not used in mock but required by the SorobanRpc.Server
   * structural interface. Typed as `unknown` to avoid a dependency on `@types/urijs`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly serverURL: any = { toString: () => 'http://mock.local' };

  // =========================================================================
  // Configuration API
  // =========================================================================

  /**
   * Register an account so it can be returned by getAccount().
   *
   * @param address - Stellar public key (G...).
   * @param record  - Account data (sequence number is required).
   */
  setAccount(address: string, record: MockAccountRecord): void {
    this._accounts.set(address, record);
  }

  /**
   * Register a ledger entry so it can be returned by getLedgerEntries().
   *
   * @param key   - The xdr.LedgerKey identifying the entry.
   * @param value - The full LedgerEntryResult to return.
   */
  setLedgerEntry(key: xdr.LedgerKey, value: SorobanRpc.Api.LedgerEntryResult): void {
    this._ledgerEntries.set(ledgerKeyId(key), value);
  }

  /**
   * Enqueue a transaction result.
   *
   * Results are consumed in FIFO order when sendTransaction() is called.
   * Each call to sendTransaction() pops the front entry, stages it under
   * its hash, and returns the appropriate SendTransactionResponse.
   *
   * @param tx - The queued transaction descriptor.
   */
  queueTransaction(tx: QueuedTransaction): void {
    this._txQueue.push(tx);
  }

  /**
   * Override the sequence number returned by getLatestLedger().
   *
   * @param sequence - The ledger sequence to report (default: 1000).
   */
  setLatestLedger(sequence: number): void {
    this._latestLedgerSequence = sequence;
  }

  /**
   * Reset all staged state.
   *
   * Call this in afterEach() / beforeEach() to guarantee test isolation.
   */
  reset(): void {
    this._accounts.clear();
    this._ledgerEntries.clear();
    this._txQueue = [];
    this._txResults.clear();
    this._latestLedgerSequence = DEFAULT_LEDGER_SEQUENCE;
  }

  // =========================================================================
  // SorobanRpc.Server — core methods
  // =========================================================================

  /**
   * Return the pre-configured Account for the given address.
   *
   * @throws if no account was registered for this address.
   */
  async getAccount(address: string): Promise<Account> {
    const record = this._accounts.get(address);
    if (!record) {
      throw new Error(
        `MockProvider: account not found for address "${address}". ` +
          'Call mock.setAccount(address, { sequence }) before using this address.',
      );
    }
    return new Account(address, record.sequence);
  }

  /**
   * Return health status.  Always reports healthy so tests exercising
   * CoralSwapClient.isHealthy() work out of the box.
   */
  async getHealth(): Promise<SorobanRpc.Api.GetHealthResponse> {
    return { status: 'healthy' };
  }

  /**
   * Return ledger entries for the given keys.
   *
   * Returns an empty entries array when no entries were staged (not an
   * error), matching real RPC behaviour.
   */
  async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<SorobanRpc.Api.GetLedgerEntriesResponse> {
    const entries: SorobanRpc.Api.LedgerEntryResult[] = [];
    for (const key of keys) {
      const entry = this._ledgerEntries.get(ledgerKeyId(key));
      if (entry) {
        entries.push(entry);
      }
    }
    return {
      entries,
      latestLedger: this._latestLedgerSequence,
    };
  }

  /**
   * Submit a transaction.
   *
   * Pops the next entry from the tx queue, stages it under its hash,
   * and returns a PENDING or ERROR SendTransactionResponse.
   *
   * @throws if the queue is empty — configure a result first with
   *         mock.queueTransaction(...).
   */
  async sendTransaction(
    _transaction: Transaction | FeeBumpTransaction,
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    if (this._txQueue.length === 0) {
      throw new Error(
        'MockProvider: sendTransaction() called but the transaction queue is empty. ' +
          'Call mock.queueTransaction({ hash, status }) to stage a result.',
      );
    }

    const queued = this._txQueue.shift()!;
    // Stage the result so getTransaction() can retrieve it.
    this._txResults.set(queued.hash, queued);

    const base = {
      hash: queued.hash,
      latestLedger: this._latestLedgerSequence,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000),
    } as const;

    if (queued.status === 'FAILED' && (queued as MockSendFailure).errorResult) {
      return {
        ...base,
        status: 'ERROR' as SorobanRpc.Api.SendTransactionStatus,
        errorResult: undefined,
        diagnosticEvents: undefined,
      };
    }

    // SUCCESS and NOT_FOUND both start as PENDING from sendTransaction's
    // perspective; the final state is surfaced via getTransaction().
    return {
      ...base,
      status: 'PENDING' as SorobanRpc.Api.SendTransactionStatus,
    };
  }

  /**
   * Retrieve the current status of a submitted transaction.
   *
   * Supports SUCCESS, FAILED, and NOT_FOUND states.  Returns the
   * appropriate discriminated union shape so the SDK polling loop
   * works correctly.
   */
  async getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const staged = this._txResults.get(hash);

    const baseAny = {
      latestLedger: this._latestLedgerSequence,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000),
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
    } as const;

    if (!staged || staged.status === 'NOT_FOUND') {
      return {
        ...baseAny,
        status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
      } as SorobanRpc.Api.GetMissingTransactionResponse;
    }

    const ledger = (staged as MockSendSuccess | MockSendFailure).ledger ?? this._latestLedgerSequence;
    const baseFinished = {
      ...baseAny,
      ledger,
      createdAt: Math.floor(Date.now() / 1000),
      applicationOrder: 1,
      feeBump: false,
      // Provide minimal XDR stubs so the SDK can destructure without crashing.
      // Tests that need real XDR values should set them via queueTransaction().
      envelopeXdr: {} as xdr.TransactionEnvelope,
      resultXdr: {} as xdr.TransactionResult,
      resultMetaXdr: {} as xdr.TransactionMeta,
    };

    if (staged.status === 'SUCCESS') {
      return {
        ...baseFinished,
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: undefined,
      } as SorobanRpc.Api.GetSuccessfulTransactionResponse;
    }

    // FAILED
    return {
      ...baseFinished,
      status: SorobanRpc.Api.GetTransactionStatus.FAILED,
    } as SorobanRpc.Api.GetFailedTransactionResponse;
  }

  /**
   * Return the latest ledger metadata.
   *
   * Defaults to sequence 1000; override with mock.setLatestLedger(n).
   */
  async getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse> {
    return {
      id: `mock-ledger-${this._latestLedgerSequence}`,
      sequence: this._latestLedgerSequence,
      protocolVersion: '21',
    };
  }

  /**
   * Simulate a transaction.
   *
   * Returns a minimal success simulation so that CoralSwapClient's
   * submitTransaction() can proceed past the simulation step.
   *
   * Override this method on the instance in tests that need to exercise
   * simulation-failure paths:
   *
   *   mock.simulateTransaction = jest.fn().mockResolvedValue({ error: 'fail' });
   */
  async simulateTransaction(
    _tx: Transaction | FeeBumpTransaction,
    _addlResources?: SorobanRpc.Server.ResourceLeeway,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return {
      id: 'mock-sim-id',
      latestLedger: this._latestLedgerSequence,
      events: [],
      transactionData: new (xdr.SorobanTransactionData as unknown as new () => xdr.SorobanTransactionData)(),
      minResourceFee: '100',
      cost: { cpuInsns: '100000', memBytes: '10000' },
      result: undefined,
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  }

  // =========================================================================
  // SorobanRpc.Server — stub methods (loud failures)
  // =========================================================================

  /**
   * Helper to generate a rejection for stub methods.
   */
  private static _notImplemented(methodName: string): Promise<never> {
    return Promise.reject(
      new Error(
        `MockProvider: ${methodName}() is not implemented. ` +
          'If your test needs this method, override it on the mock instance.',
      ),
    );
  }

  async getContractData(
    _contract: string | Address | Contract,
    _key: xdr.ScVal,
    _durability?: SorobanRpc.Durability,
  ): Promise<SorobanRpc.Api.LedgerEntryResult> {
    return MockProvider._notImplemented('getContractData');
  }

  async getContractWasmByContractId(_contractId: string): Promise<Buffer> {
    return MockProvider._notImplemented('getContractWasmByContractId');
  }

  async getContractWasmByHash(
    _wasmHash: Buffer | string,
    _format?: undefined | 'hex' | 'base64',
  ): Promise<Buffer> {
    return MockProvider._notImplemented('getContractWasmByHash');
  }

  async _getLedgerEntries(
    ..._keys: xdr.LedgerKey[]
  ): Promise<SorobanRpc.Api.RawGetLedgerEntriesResponse> {
    return MockProvider._notImplemented('_getLedgerEntries');
  }

  async _getTransaction(
    _hash: string,
  ): Promise<SorobanRpc.Api.RawGetTransactionResponse> {
    return MockProvider._notImplemented('_getTransaction');
  }

  async getTransactions(
    _request: SorobanRpc.Api.GetTransactionsRequest,
  ): Promise<SorobanRpc.Api.GetTransactionsResponse> {
    return MockProvider._notImplemented('getTransactions');
  }

  async getEvents(
    _request: SorobanRpc.Server.GetEventsRequest,
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return MockProvider._notImplemented('getEvents');
  }

  async _getEvents(
    _request: SorobanRpc.Server.GetEventsRequest,
  ): Promise<SorobanRpc.Api.RawGetEventsResponse> {
    return MockProvider._notImplemented('_getEvents');
  }

  async getNetwork(): Promise<SorobanRpc.Api.GetNetworkResponse> {
    return MockProvider._notImplemented('getNetwork');
  }

  async _simulateTransaction(
    _transaction: Transaction | FeeBumpTransaction,
    _addlResources?: SorobanRpc.Server.ResourceLeeway,
  ): Promise<SorobanRpc.Api.RawSimulateTransactionResponse> {
    return MockProvider._notImplemented('_simulateTransaction');
  }

  async prepareTransaction(
    _tx: Transaction | FeeBumpTransaction,
  ): Promise<Transaction> {
    return MockProvider._notImplemented('prepareTransaction');
  }

  async _sendTransaction(
    _transaction: Transaction | FeeBumpTransaction,
  ): Promise<SorobanRpc.Api.RawSendTransactionResponse> {
    return MockProvider._notImplemented('_sendTransaction');
  }

  async requestAirdrop(
    _address: string | Pick<Account, 'accountId'>,
    _friendbotUrl?: string,
  ): Promise<Account> {
    return MockProvider._notImplemented('requestAirdrop');
  }

  async getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse> {
    return MockProvider._notImplemented('getFeeStats');
  }

  async getVersionInfo(): Promise<SorobanRpc.Api.GetVersionInfoResponse> {
    return MockProvider._notImplemented('getVersionInfo');
  }
}
