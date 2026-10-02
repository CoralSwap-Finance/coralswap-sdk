/**
 * MockProvider — an offline drop-in replacement for rpc.Server.
 *
 * Implements every method on rpc.Server so the CoralSwap SDK client
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
 *   mock.script('getContractData', () => { throw new NotConfiguredError(...); });
 *   mock.reset();
 *
 * Design notes
 * ------------
 *  - Queued transactions are consumed once in FIFO order, matching the real
 *    send→poll lifecycle and making retry-logic tests straightforward.
 *  - getLedgerEntries returns an empty entries array (not an error) when
 *    nothing is registered, matching real RPC behaviour.
 *  - Methods not relevant to the core SDK surface (getContractData,
 *    getEvents, getNetwork, etc. -- see StubMethodName) reject with a loud
 *    "not implemented" error by default, so mis-configured tests fail
 *    immediately instead of silently passing with undefined. Call
 *    script(method, response) to configure a canned value, a thrown error
 *    (including a typed subclass), or a per-call function for any of them.
 */

import {
  Account,
  Address,
  Contract,
  FeeBumpTransaction,
  Transaction,
  xdr,
  rpc,
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
    return key.toXdr('base64');
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
// Scriptable stub methods
// ---------------------------------------------------------------------------

/**
 * The rpc.Server methods this mock loud-fails on by default (see the "stub
 * methods" section below) and that {@link MockProvider.script} can be used
 * to configure instead.
 */
export type StubMethodName =
  | 'getContractData'
  | 'getContractWasmByContractId'
  | 'getContractWasmByHash'
  | '_getLedgerEntries'
  | '_getTransaction'
  | 'getTransactions'
  | 'getEvents'
  | '_getEvents'
  | 'getNetwork'
  | '_simulateTransaction'
  | 'prepareTransaction'
  | '_sendTransaction'
  | 'requestAirdrop'
  | 'getFeeStats'
  | 'getVersionInfo';

/**
 * A scripted response for {@link MockProvider.script}:
 *  - a plain value, returned as-is (resolved) on every call;
 *  - an `Error` instance (including a typed subclass), thrown (rejected) on
 *    every call -- this is how a test proves a typed failure propagates
 *    correctly through the SDK;
 *  - a function, invoked with the call's arguments on each call -- for
 *    responses that vary by argument or by call count.
 */
export type ScriptedResponse =
  | unknown
  | Error
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ((...args: any[]) => unknown | Promise<unknown>);

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

/**
 * Offline implementation of {@link rpc.Server} for use in tests.
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
  private _ledgerEntries = new Map<string, rpc.Api.LedgerEntryResult>();

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

  /** Scripted responses registered via script(), keyed by method name. */
  private _scripts = new Map<StubMethodName, ScriptedResponse>();

  // -------------------------------------------------------------------------
  // Expose serverURL so the class structurally satisfies rpc.Server
  // -------------------------------------------------------------------------

  /**
   * Placeholder serverURL — not used in mock but required by the rpc.Server
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
  setLedgerEntry(key: xdr.LedgerKey, value: rpc.Api.LedgerEntryResult): void {
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
   * Script a canned response (or error) for one of the rpc.Server methods
   * this mock otherwise loud-fails on by default -- e.g. getContractData,
   * getEvents, getNetwork. See {@link ScriptedResponse} for the accepted
   * shapes.
   *
   * Scripted responses persist until reset() or clearScript() is called.
   * A method with no script still loud-fails exactly as before, so a test
   * that forgets to script a method it actually calls fails immediately
   * with a clear message rather than silently returning undefined.
   *
   * @example
   * // Static value:
   * mock.script('getNetwork', { passphrase: 'Test SDF Network ; September 2015' });
   *
   * @example
   * // Typed failure, once NotConfiguredError/DecodeError land (#662, #676):
   * mock.script('getContractData', new NotConfiguredError('router not set'));
   *
   * @example
   * // Argument- or call-count-aware response:
   * mock.script('getContractData', (contract, key) => { ... });
   */
  script(method: StubMethodName, response: ScriptedResponse): void {
    this._scripts.set(method, response);
  }

  /** Remove a previously-scripted response, reverting the method to loud-fail. */
  clearScript(method: StubMethodName): void {
    this._scripts.delete(method);
  }

  /**
   * Resolve a scripted response for `method`, or loud-fail if none was
   * configured. Shared by every stub method below.
   */
  private async _resolveScripted(method: StubMethodName, args: unknown[]): Promise<unknown> {
    if (!this._scripts.has(method)) {
      return MockProvider._notImplemented(method);
    }
    const scripted = this._scripts.get(method);
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (typeof scripted === 'function') {
      return (scripted as (...a: unknown[]) => unknown | Promise<unknown>)(...args);
    }
    return scripted;
  }

  /**
   * Reset all staged state, including scripted responses.
   *
   * Call this in afterEach() / beforeEach() to guarantee test isolation.
   */
  reset(): void {
    this._accounts.clear();
    this._ledgerEntries.clear();
    this._txQueue = [];
    this._txResults.clear();
    this._latestLedgerSequence = DEFAULT_LEDGER_SEQUENCE;
    this._scripts.clear();
  }

  // =========================================================================
  // rpc.Server — core methods
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
  async getHealth(): Promise<rpc.Api.GetHealthResponse> {
    return {
      latestLedger: this._latestLedgerSequence,
      ledgerRetentionWindow: 17280,
      oldestLedger: this._latestLedgerSequence - 17280,
      status: 'healthy',
    };
  }

  /**
   * Return ledger entries for the given keys.
   *
   * Returns an empty entries array when no entries were staged (not an
   * error), matching real RPC behaviour.
   */
  async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
    const entries: rpc.Api.LedgerEntryResult[] = [];
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
  ): Promise<rpc.Api.SendTransactionResponse> {
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
        status: 'ERROR' as rpc.Api.SendTransactionStatus,
        errorResult: undefined,
        diagnosticEvents: undefined,
      };
    }

    // SUCCESS and NOT_FOUND both start as PENDING from sendTransaction's
    // perspective; the final state is surfaced via getTransaction().
    return {
      ...base,
      status: 'PENDING' as rpc.Api.SendTransactionStatus,
    };
  }

  /**
   * Retrieve the current status of a submitted transaction.
   *
   * Supports SUCCESS, FAILED, and NOT_FOUND states.  Returns the
   * appropriate discriminated union shape so the SDK polling loop
   * works correctly.
   */
  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
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
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      } as rpc.Api.GetMissingTransactionResponse;
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
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        returnValue: undefined,
      } as rpc.Api.GetSuccessfulTransactionResponse;
    }

    // FAILED
    return {
      ...baseFinished,
      status: rpc.Api.GetTransactionStatus.FAILED,
    } as rpc.Api.GetFailedTransactionResponse;
  }

  /**
   * Return the latest ledger metadata.
   *
   * Defaults to sequence 1000; override with mock.setLatestLedger(n).
   */
  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    return {
      id: `mock-ledger-${this._latestLedgerSequence}`,
      sequence: this._latestLedgerSequence,
      protocolVersion: '21',
      closeTime: String(Math.floor(Date.now() / 1000)),
      headerXdr: this.buildMockLedgerHeader(),
      metadataXdr: this.buildMockLedgerCloseMeta(),
    };
  }

  /**
   * Construct a minimal but valid LedgerCloseMeta XDR object.
   *
   * Uses the v0 variant with empty tx processing, upgrade, and SCP arrays so
   * the object round-trips through the SDK's XDR encoding/decoding without
   * carrying real ledger data.
   */
  private buildMockLedgerCloseMeta(): xdr.LedgerCloseMeta {
    const headerEntry = new xdr.LedgerHeaderHistoryEntry({
      hash: new Uint8Array(32),
      header: this.buildMockLedgerHeader(),
      ext: xdr.LedgerHeaderHistoryEntryExt.v0(),
    });
    const txSet = new xdr.TransactionSet({
      previousLedgerHash: new Uint8Array(32),
      txs: [],
    });
    const v0 = new xdr.LedgerCloseMetaV0({
      ledgerHeader: headerEntry,
      txSet,
      txProcessing: [],
      upgradesProcessing: [],
      scpInfo: [],
    });
    return xdr.LedgerCloseMeta.v0(v0);
  }

  /**
   * Construct a minimal but valid LedgerHeader XDR object.
   */
  private buildMockLedgerHeader(): xdr.LedgerHeader {
    const zeroHash = new Uint8Array(32);
    return new xdr.LedgerHeader({
      ledgerVersion: 20,
      previousLedgerHash: zeroHash,
      scpValue: new xdr.StellarValue({
        txSetHash: zeroHash,
        closeTime: BigInt(Math.floor(Date.now() / 1000)),
        upgrades: [],
        ext: xdr.StellarValueExt.stellarValueBasic(),
      }),
      txSetResultHash: zeroHash,
      bucketListHash: zeroHash,
      ledgerSeq: this._latestLedgerSequence,
      totalCoins: 0n,
      feePool: 0n,
      inflationSeq: 0,
      idPool: 0n,
      baseFee: 100,
      baseReserve: 5000000,
      maxTxSetSize: 1000,
      skipList: [],
      ext: xdr.LedgerHeaderExt.v0(),
    });
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
    _addlResources?: rpc.Server.ResourceLeeway,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return {
      id: 'mock-sim-id',
      latestLedger: this._latestLedgerSequence,
      events: [],
      transactionData: new xdr.SorobanTransactionData({
        ext: xdr.SorobanTransactionDataExt.v0() as xdr.SorobanTransactionDataExt,
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({
            readOnly: [],
            readWrite: [],
          }),
          instructions: 0,
          diskReadBytes: 0,
          writeBytes: 0,
        }),
        resourceFee: 0n,
      }),
      minResourceFee: '100',
      result: undefined,
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
  }

  // =========================================================================
  // rpc.Server — stub methods (loud failures)
  // =========================================================================

  /**
   * Helper to generate a rejection for stub methods.
   */
  private static _notImplemented(methodName: string): Promise<never> {
    return Promise.reject(
      new Error(
        `MockProvider: ${methodName}() is not implemented. ` +
          `If your test needs this method, configure a response with ` +
          `mock.script('${methodName}', ...) (see MockProvider.script), or ` +
          'override it directly on the mock instance.',
      ),
    );
  }

  async getContractData(
    contract: string | Address | Contract,
    key: xdr.ScVal,
    durability?: rpc.Durability,
  ): Promise<rpc.Api.LedgerEntryResult> {
    return this._resolveScripted('getContractData', [contract, key, durability]) as Promise<
      rpc.Api.LedgerEntryResult
    >;
  }

  async getContractWasmByContractId(contractId: string): Promise<Buffer> {
    return this._resolveScripted('getContractWasmByContractId', [contractId]) as Promise<Buffer>;
  }

  async getContractWasmByHash(
    wasmHash: Buffer | string,
    format?: undefined | 'hex' | 'base64',
  ): Promise<Buffer> {
    return this._resolveScripted('getContractWasmByHash', [wasmHash, format]) as Promise<Buffer>;
  }

  async _getLedgerEntries(
    ...keys: xdr.LedgerKey[]
  ): Promise<rpc.Api.RawGetLedgerEntriesResponse> {
    return this._resolveScripted('_getLedgerEntries', keys) as Promise<
      rpc.Api.RawGetLedgerEntriesResponse
    >;
  }

  async _getTransaction(
    hash: string,
  ): Promise<rpc.Api.RawGetTransactionResponse> {
    return this._resolveScripted('_getTransaction', [hash]) as Promise<
      rpc.Api.RawGetTransactionResponse
    >;
  }

  async getTransactions(
    request: rpc.Api.GetTransactionsRequest,
  ): Promise<rpc.Api.GetTransactionsResponse> {
    return this._resolveScripted('getTransactions', [request]) as Promise<
      rpc.Api.GetTransactionsResponse
    >;
  }

  async getEvents(
    request: rpc.Server.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse> {
    return this._resolveScripted('getEvents', [request]) as Promise<rpc.Api.GetEventsResponse>;
  }

  async _getEvents(
    request: rpc.Server.GetEventsRequest,
  ): Promise<rpc.Api.RawGetEventsResponse> {
    return this._resolveScripted('_getEvents', [request]) as Promise<
      rpc.Api.RawGetEventsResponse
    >;
  }

  async getNetwork(): Promise<rpc.Api.GetNetworkResponse> {
    return this._resolveScripted('getNetwork', []) as Promise<rpc.Api.GetNetworkResponse>;
  }

  async _simulateTransaction(
    transaction: Transaction | FeeBumpTransaction,
    addlResources?: rpc.Server.ResourceLeeway,
  ): Promise<rpc.Api.RawSimulateTransactionResponse> {
    return this._resolveScripted('_simulateTransaction', [transaction, addlResources]) as Promise<
      rpc.Api.RawSimulateTransactionResponse
    >;
  }

  async prepareTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Transaction> {
    return this._resolveScripted('prepareTransaction', [tx]) as Promise<Transaction>;
  }

  async _sendTransaction(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.RawSendTransactionResponse> {
    return this._resolveScripted('_sendTransaction', [transaction]) as Promise<
      rpc.Api.RawSendTransactionResponse
    >;
  }

  async requestAirdrop(
    address: string | Pick<Account, 'accountId'>,
    friendbotUrl?: string,
  ): Promise<Account> {
    return this._resolveScripted('requestAirdrop', [address, friendbotUrl]) as Promise<Account>;
  }

  async getFeeStats(): Promise<rpc.Api.GetFeeStatsResponse> {
    return this._resolveScripted('getFeeStats', []) as Promise<rpc.Api.GetFeeStatsResponse>;
  }

  async getVersionInfo(): Promise<rpc.Api.GetVersionInfoResponse> {
    return this._resolveScripted('getVersionInfo', []) as Promise<rpc.Api.GetVersionInfoResponse>;
  }
}
