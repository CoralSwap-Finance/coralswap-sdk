import { FlashLoanModule } from '../src/modules/flash-loan';
import { FlashLoanError } from '../src/errors';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock CoralSwapClient with controllable submitTransaction
 * and server.getTransaction responses.
 */
function buildMockClient(options: {
  submitResult?: object;
  txResult?: object;
  flashFeeBps?: number;
  locked?: boolean;
}) {
  const {
    submitResult = { success: true, txHash: 'MOCK_TX', data: { txHash: 'MOCK_TX', ledger: 1000 } },
    txResult = { status: 'NOT_FOUND' },
    flashFeeBps = 9,
    locked = false,
  } = options;

  return {
    publicKey: 'GTEST_SENDER',
    pair: jest.fn().mockReturnValue({
      getFlashLoanConfig: jest.fn().mockResolvedValue({
        flashFeeBps,
        flashFeeFloor: 5,
        locked,
      }),
      buildFlashLoan: jest.fn().mockReturnValue('mock_flash_op'),
      getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_000n, reserve1: 1_000_000n }),
      getTokens: jest.fn().mockResolvedValue({ token0: 'TOKEN_A', token1: 'TOKEN_B' }),
    }),
    submitTransaction: jest.fn().mockResolvedValue(submitResult),
    server: {
      getTransaction: jest.fn().mockResolvedValue(txResult),
    },
  };
}

/**
 * Build a mock xdr.TransactionMeta v3 object whose sorobanMeta().events()
 * returns the provided events list.
 */
function buildMockMeta(events: xdr.ContractEvent[]): xdr.TransactionMeta {
  return {
    v3: () => ({
      sorobanMeta: () => ({
        events: () => events,
      }),
    }),
  } as unknown as xdr.TransactionMeta;
}

/**
 * Build a Soroban contract event with a Symbol topic and a map data payload.
 *
 * Uses js-xdr's low-level constructor API (struct/union new() forms) since
 * stellar-sdk v12 does not expose named static factory methods on xdr types.
 */
function buildContractEvent(
  topicSymbol: string,
  dataMap: Record<string, unknown>,
): xdr.ContractEvent {
  // Encode the data map as a Soroban ScVal map: { symbol_key -> scval }
  const mapEntries = Object.entries(dataMap).map(([k, v]) => {
    const valScVal =
      typeof v === 'bigint'
        ? nativeToScVal(v, { type: 'i128' })
        : xdr.ScVal.scvString(Buffer.from(String(v)));
    return new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol(k),
      val: valScVal,
    });
  });

  const topicScVal = xdr.ScVal.scvSymbol(topicSymbol);
  const dataScVal = xdr.ScVal.scvMap(mapEntries);

  // js-xdr union constructors accept (switchValue, armValue) at runtime even
  // though the TypeScript declarations expose them as static numeric methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AnyContractEventBody = xdr.ContractEventBody as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AnyExtensionPoint = xdr.ExtensionPoint as any;

  const v0 = new xdr.ContractEventV0({ topics: [topicScVal], data: dataScVal });
  const body = new AnyContractEventBody(0, v0) as xdr.ContractEventBody;
  const ext = new AnyExtensionPoint(0) as xdr.ExtensionPoint;

  return new xdr.ContractEvent({
    ext,
    contractId: null,
    type: xdr.ContractEventType.contract(),
    body,
  });
}

// ---------------------------------------------------------------------------
// Base request fixture
// ---------------------------------------------------------------------------

const FLASH_REQUEST = {
  pairAddress: 'PAIR_ADDR',
  token: 'TOKEN_A',
  amount: 1_000_000n,
  receiverAddress: 'RECEIVER_ADDR',
  callbackData: Buffer.from('test'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlashLoanModule.execute()', () => {
  describe('successful loan — event parsing', () => {
    it('returns FlashLoanResult with borrowedAmount and feePaid from decoded event', async () => {
      const event = buildContractEvent('FlashLoanExecuted', {
        amount: 1_000_000n,
        fee: 90n,
        callback: 'RECEIVER_ADDR',
        token: 'TOKEN_A',
      });

      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([event]),
        },
      });

      const module = new FlashLoanModule(client as any);
      const result = await module.execute(FLASH_REQUEST);

      expect(result.txHash).toBe('MOCK_TX');
      expect(result.event.type).toBe('FlashLoanExecuted');
      expect(result.event.borrowedAmount).toBe(1_000_000n);
      expect(result.event.feePaid).toBe(90n);
      expect(result.event.token).toBe('TOKEN_A');
      expect(result.event.callbackAddress).toBe('RECEIVER_ADDR');
    });

    it('exposes borrowedAmount and feePaid at top-level via event', async () => {
      const event = buildContractEvent('FlashLoanExecuted', {
        amount: 500_000n,
        fee: 50n,
        callback: 'RECEIVER_ADDR',
        token: 'TOKEN_A',
      });

      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([event]),
        },
      });

      const module = new FlashLoanModule(client as any);
      const result = await module.execute(FLASH_REQUEST);

      // Acceptance criteria: borrowedAmount and feePaid directly accessible
      const { borrowedAmount, feePaid } = result.event;
      expect(borrowedAmount).toBe(500_000n);
      expect(feePaid).toBe(50n);
    });

    it('falls back to request values when no FlashLoanExecuted event is present', async () => {
      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([]), // no events
        },
      });

      const module = new FlashLoanModule(client as any);
      const result = await module.execute(FLASH_REQUEST);

      expect(result.txHash).toBe('MOCK_TX');
      // Fallback event still satisfies the interface
      expect(result.event.type).toBe('FlashLoanExecuted');
      expect(result.event.borrowedAmount).toBe(FLASH_REQUEST.amount);
    });

    it('ignores events when getTransaction returns non-SUCCESS status', async () => {
      const client = buildMockClient({
        txResult: { status: 'NOT_FOUND' },
      });

      const module = new FlashLoanModule(client as any);
      const result = await module.execute(FLASH_REQUEST);

      expect(result.txHash).toBe('MOCK_TX');
      expect(result.event.type).toBe('FlashLoanExecuted');
    });
  });

  describe('failed loan — FlashLoanFailed event', () => {
    it('throws FlashLoanError when FlashLoanFailed event is present', async () => {
      const event = buildContractEvent('FlashLoanFailed', {
        amount: 1_000_000n,
        token: 'TOKEN_A',
        reason: 'insufficient_balance',
      });

      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([event]),
        },
      });

      const module = new FlashLoanModule(client as any);

      await expect(module.execute(FLASH_REQUEST)).rejects.toBeInstanceOf(FlashLoanError);
    });

    it('thrown FlashLoanError carries the decoded event details', async () => {
      const event = buildContractEvent('FlashLoanFailed', {
        amount: 1_000_000n,
        token: 'TOKEN_A',
        reason: 'callback_revert',
      });

      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([event]),
        },
      });

      const module = new FlashLoanModule(client as any);

      let caught: FlashLoanError | null = null;
      try {
        await module.execute(FLASH_REQUEST);
      } catch (err) {
        caught = err as FlashLoanError;
      }

      expect(caught).not.toBeNull();
      expect(caught!.event).toBeDefined();
      expect(caught!.event!.type).toBe('FlashLoanFailed');
      expect(caught!.event!.borrowedAmount).toBe(1_000_000n);
      expect(caught!.event!.token).toBe('TOKEN_A');
      expect(caught!.event!.reason).toBe('callback_revert');
    });

    it('throws FlashLoanError (without event) when submitTransaction fails', async () => {
      const client = buildMockClient({
        submitResult: {
          success: false,
          error: { code: 'TX_FAILED', message: 'rejected by contract' },
        },
      });

      const module = new FlashLoanModule(client as any);

      await expect(module.execute(FLASH_REQUEST)).rejects.toBeInstanceOf(FlashLoanError);
    });

    it('error message includes the failure reason from the event', async () => {
      const event = buildContractEvent('FlashLoanFailed', {
        amount: 1_000_000n,
        token: 'TOKEN_A',
        reason: 'repayment_too_low',
      });

      const client = buildMockClient({
        txResult: {
          status: 'SUCCESS',
          resultMetaXdr: buildMockMeta([event]),
        },
      });

      const module = new FlashLoanModule(client as any);

      await expect(module.execute(FLASH_REQUEST)).rejects.toThrow('repayment_too_low');
    });
  });

  describe('locked pair guard', () => {
    it('throws when flash loans are locked on the pair', async () => {
      const client = buildMockClient({ locked: true });
      const module = new FlashLoanModule(client as any);

      await expect(module.execute(FLASH_REQUEST)).rejects.toThrow(
        'Flash loans are currently disabled for this pair',
      );
    });
  });
});

describe('FlashLoanModule.estimateFee()', () => {
  it('calculates fee using feeBps', async () => {
    const client = buildMockClient({ flashFeeBps: 9 });
    const module = new FlashLoanModule(client as any);

    const estimate = await module.estimateFee('PAIR_ADDR', 'TOKEN_A', 10_000n);
    // 10000 * 9 / 10000 = 9; floor is 5; result is max(9, 5) = 9
    expect(estimate.feeAmount).toBe(9n);
  });

  it('applies fee floor when calculated fee is below it', async () => {
    const client = buildMockClient({ flashFeeBps: 1 });
    const module = new FlashLoanModule(client as any);

    const estimate = await module.estimateFee('PAIR_ADDR', 'TOKEN_A', 1_000n);
    // 1000 * 1 / 10000 = 0; floor is 5; result is 5
    expect(estimate.feeAmount).toBe(5n);
  });
});
