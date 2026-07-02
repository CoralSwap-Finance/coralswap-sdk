import { SorobanRpc, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import {
  LimitOrderModule,
  parseOrderStatus,
  parseCancelResult,
  parseOrderDetails,
  scValToStringVec,
} from '../src/modules/limit-orders';
import { OrderNotFoundError, InvalidOperationError, ValidationError } from '../src/errors';

function makeScMap(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields).map(([key, val]) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
  );
  return xdr.ScVal.scvMap(entries);
}

function makeOrderVal(
  state: string,
  fillPercent: number,
  executionPrice?: number,
  filledAt?: number,
): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    state: xdr.ScVal.scvSymbol(state),
    fill_percent: xdr.ScVal.scvU32(fillPercent),
  };
  if (executionPrice !== undefined) {
    fields.execution_price = xdr.ScVal.scvU32(executionPrice);
  } else {
    fields.execution_price = xdr.ScVal.scvVoid();
  }
  if (filledAt !== undefined) {
    fields.filled_at = xdr.ScVal.scvU64(new xdr.Uint64(filledAt));
  } else {
    fields.filled_at = xdr.ScVal.scvVoid();
  }
  return makeScMap(fields);
}

function mockSimulationResult(retval: xdr.ScVal): any {
  return {
    result: { retval },
    latestLedger: 12345,
    cost: { cpuInsns: '0', memBytes: '0' },
    transactionData: {},
  };
}

describe('LimitOrderModule', () => {
  let mockServer: jest.Mocked<SorobanRpc.Server>;
  let mockClient: any;
  let module: LimitOrderModule;

  beforeEach(() => {
    const PUBLIC_KEY = 'GAZGE6TCGY5SW4GMFRVY2DMFXBOZVDDWOJ6CJZQ6ZUXY3SQQE2FTCAJF';
    const mockAccount = {
      sequenceNumber: jest.fn().mockReturnValue('12345'),
      accountId: jest.fn().mockReturnValue(PUBLIC_KEY),
      sequenceLedger: jest.fn().mockReturnValue(0),
      sequenceTime: jest.fn().mockReturnValue('0'),
      incrementSequenceNumber: jest.fn(),
    };
    mockServer = {
      getAccount: jest.fn().mockResolvedValue(mockAccount),
      simulateTransaction: jest.fn(),
    } as any;

    mockClient = {
      server: mockServer,
      publicKey: PUBLIC_KEY,
      networkConfig: {
        networkPassphrase: 'Test SDF Network ; September 2015',
        limitOrderAddress: 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM',
      },
      config: {},
    };

    module = new LimitOrderModule(mockClient);
  });

  describe('parseOrderStatus', () => {
    it.each([
      ['open', 0, undefined, undefined],
      ['partial', 50, undefined, undefined],
      ['filled', 100, 100, 1000000],
      ['cancelled', 0, undefined, undefined],
      ['expired', 0, undefined, undefined],
    ])('parses %s state correctly', (state, fillPercent, executionPrice, filledAt) => {
      const val = makeOrderVal(state, fillPercent, executionPrice, filledAt);
      const result = parseOrderStatus(val);

      expect(result.state).toBe(state);
      expect(result.fillPercent).toBe(fillPercent);
      if (executionPrice !== undefined) {
        expect(result.executionPrice).toBe(executionPrice);
      } else {
        expect(result.executionPrice).toBeUndefined();
      }
      if (filledAt !== undefined) {
        expect(result.filledAt).toBe(filledAt);
      } else {
        expect(result.filledAt).toBeUndefined();
      }
    });

    it('throws for invalid state', () => {
      const val = makeScMap({
        state: xdr.ScVal.scvSymbol('invalid_state'),
        fill_percent: xdr.ScVal.scvU32(0),
        execution_price: xdr.ScVal.scvVoid(),
        filled_at: xdr.ScVal.scvVoid(),
      });
      expect(() => parseOrderStatus(val)).toThrow('Invalid order state');
    });

    it('throws for fillPercent out of range', () => {
      const val = makeScMap({
        state: xdr.ScVal.scvSymbol('open'),
        fill_percent: xdr.ScVal.scvU32(150),
        execution_price: xdr.ScVal.scvVoid(),
        filled_at: xdr.ScVal.scvVoid(),
      });
      expect(() => parseOrderStatus(val)).toThrow('Invalid fillPercent');
    });

    it('fillPercent is in 0-100 range for all states', () => {
      const statuses = ['open', 'partial', 'filled', 'cancelled', 'expired'];
      for (const state of statuses) {
        const v = makeOrderVal(state, 0);
        const r = parseOrderStatus(v);
        expect(r.fillPercent).toBeGreaterThanOrEqual(0);
        expect(r.fillPercent).toBeLessThanOrEqual(100);
      }
    });

    it('executionPrice is set only for filled/partial', () => {
      const partial = parseOrderStatus(makeOrderVal('partial', 50, 120));
      expect(partial.executionPrice).toBe(120);

      const filled = parseOrderStatus(makeOrderVal('filled', 100, 150, 2000));
      expect(filled.executionPrice).toBe(150);

      const open = parseOrderStatus(makeOrderVal('open', 0));
      expect(open.executionPrice).toBeUndefined();

      const cancelled = parseOrderStatus(makeOrderVal('cancelled', 0));
      expect(cancelled.executionPrice).toBeUndefined();

      const expired = parseOrderStatus(makeOrderVal('expired', 0));
      expect(expired.executionPrice).toBeUndefined();
    });
  });

  describe('getLimitOrderStatus', () => {
    it('returns open state for an open order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const status = await module.getLimitOrderStatus('order-123');
      expect(status.state).toBe('open');
      expect(status.fillPercent).toBe(0);
    });

    it('returns partial state for a partially filled order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('partial', 50, 105)),
      );

      const status = await module.getLimitOrderStatus('order-456');
      expect(status.state).toBe('partial');
      expect(status.fillPercent).toBe(50);
      expect(status.executionPrice).toBe(105);
    });

    it('returns filled state for a fully filled order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('filled', 100, 110, 2000000)),
      );

      const status = await module.getLimitOrderStatus('order-789');
      expect(status.state).toBe('filled');
      expect(status.fillPercent).toBe(100);
      expect(status.executionPrice).toBe(110);
      expect(status.filledAt).toBe(2000000);
    });

    it('returns cancelled state', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('cancelled', 0)),
      );

      const status = await module.getLimitOrderStatus('order-cancelled');
      expect(status.state).toBe('cancelled');
      expect(status.fillPercent).toBe(0);
    });

    it('returns expired state', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('expired', 0)),
      );

      const status = await module.getLimitOrderStatus('order-expired');
      expect(status.state).toBe('expired');
      expect(status.fillPercent).toBe(0);
    });

    it('throws for empty orderId', async () => {
      await expect(module.getLimitOrderStatus('')).rejects.toThrow(
        'orderId must be a non-empty string',
      );
    });

    it('throws when simulation fails', async () => {
      mockServer.simulateTransaction.mockResolvedValue({
        latestLedger: 0,
        cost: null,
      } as any);

      await expect(
        module.getLimitOrderStatus('order-fail'),
      ).rejects.toThrow('simulation did not succeed');
    });

    it('throws when contract address is missing', () => {
      const badClient = {
        ...mockClient,
        networkConfig: { ...mockClient.networkConfig, limitOrderAddress: undefined },
      };
      expect(() => new LimitOrderModule(badClient)).toThrow(
        'contract address is required',
      );
    });
  });

  describe('watchOrder', () => {
    let unsub: (() => void) | undefined;

    afterEach(() => {
      if (unsub) unsub();
      unsub = undefined;
    });

    it('returns an unsubscribe function', () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const u = module.watchOrder('order-1', jest.fn(), 100000);
      expect(typeof u).toBe('function');
      u();
    });

    it('calls the initial poll and invokes callback', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const callback = jest.fn();
      unsub = module.watchOrder('order-poll', callback);

      await new Promise(r => setTimeout(r, 500));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open', fillPercent: 0 }),
      );
    }, 10000);

    it('polls repeatedly at the specified interval', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const callback = jest.fn();
      unsub = module.watchOrder('order-interval', callback, 100);

      await new Promise(r => setTimeout(r, 350));

      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, 10000);

    it('stops polling after unsubscribe', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const callback = jest.fn();
      const u = module.watchOrder('order-unsub', callback, 50);

      await new Promise(r => setTimeout(r, 120));

      u();
      const callCountAfter = callback.mock.calls.length;

      await new Promise(r => setTimeout(r, 200));

      expect(callback.mock.calls.length).toBe(callCountAfter);
    }, 10000);

    it('uses default interval of 5000ms when not specified', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('open', 0)),
      );

      const callback = jest.fn();
      unsub = module.watchOrder('order-default', callback);

      await new Promise(r => setTimeout(r, 500));

      expect(callback).toHaveBeenCalledTimes(1);
    }, 10000);

    it('survives RPC errors without crashing', async () => {
      mockServer.simulateTransaction
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(mockSimulationResult(makeOrderVal('open', 0)));

      const callback = jest.fn();
      unsub = module.watchOrder('order-error', callback, 100);

      // Wait long enough for the initial (failing) poll and first successful interval
      await new Promise(r => setTimeout(r, 250));

      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open' }),
      );
    }, 10000);
  });

  describe('parseCancelResult', () => {
    it('parses refunded and filled amounts from a cancel result', () => {
      const val = makeScMap({
        refunded_amount: nativeToScVal(1000n, { type: 'i128' }),
        filled_amount: nativeToScVal(0n, { type: 'i128' }),
      });

      const result = parseCancelResult(val);
      expect(result.refundedAmount).toBe(1000n);
      expect(result.filledAmount).toBe(0n);
    });

    it('parses partial fill amounts correctly', () => {
      const val = makeScMap({
        refunded_amount: nativeToScVal(700n, { type: 'i128' }),
        filled_amount: nativeToScVal(300n, { type: 'i128' }),
      });

      const result = parseCancelResult(val);
      expect(result.refundedAmount).toBe(700n);
      expect(result.filledAmount).toBe(300n);
    });

    it('throws for non-map result', () => {
      expect(() => parseCancelResult(xdr.ScVal.scvI32(42))).toThrow(
        'Invalid cancel result',
      );
    });
  });

  describe('cancelLimitOrder', () => {
    beforeEach(() => {
      mockClient.submitTransaction = jest.fn();
    });

    it('cancels a fully open order and refunds 100%', async () => {
      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(makeOrderVal('open', 0)))
        .mockResolvedValueOnce(mockSimulationResult(
          makeScMap({
            refunded_amount: nativeToScVal(1000n, { type: 'i128' }),
            filled_amount: nativeToScVal(0n, { type: 'i128' }),
          }),
        ));
      mockClient.submitTransaction.mockResolvedValue({
        success: true,
        data: { txHash: '0xabc', ledger: 12345 },
      });

      const result = await module.cancelLimitOrder('order-open');

      expect(result.refundedAmount).toBe(1000n);
      expect(result.filledAmount).toBe(0n);
      expect(result.refundTxHash).toBe('0xabc');
    });

    it('cancels a partially filled order and refunds remaining amount', async () => {
      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(makeOrderVal('partial', 30)))
        .mockResolvedValueOnce(mockSimulationResult(
          makeScMap({
            refunded_amount: nativeToScVal(700n, { type: 'i128' }),
            filled_amount: nativeToScVal(300n, { type: 'i128' }),
          }),
        ));
      mockClient.submitTransaction.mockResolvedValue({
        success: true,
        data: { txHash: '0xdef', ledger: 12346 },
      });

      const result = await module.cancelLimitOrder('order-partial');

      expect(result.refundedAmount).toBe(700n);
      expect(result.filledAmount).toBe(300n);
      expect(result.refundTxHash).toBe('0xdef');
    });

    it('throws OrderNotFoundError for an already-cancelled order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('cancelled', 0)),
      );

      await expect(
        module.cancelLimitOrder('order-cancelled'),
      ).rejects.toThrow(OrderNotFoundError);
    });

    it('throws InvalidOperationError for an already-filled order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('filled', 100, 110, 2000000)),
      );

      await expect(
        module.cancelLimitOrder('order-filled'),
      ).rejects.toThrow(InvalidOperationError);
    });

    it('throws InvalidOperationError for an expired order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderVal('expired', 0)),
      );

      await expect(
        module.cancelLimitOrder('order-expired'),
      ).rejects.toThrow(InvalidOperationError);
    });

    it('throws for empty orderId', async () => {
      await expect(module.cancelLimitOrder('')).rejects.toThrow(
        'orderId must be a non-empty string',
      );
    });

    it('throws when cancel simulation fails', async () => {
      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(makeOrderVal('open', 0)))
        .mockResolvedValueOnce({ latestLedger: 0, cost: null } as any);

      await expect(
        module.cancelLimitOrder('order-fail'),
      ).rejects.toThrow('simulation did not succeed');
    });

    it('throws when transaction submission fails', async () => {
      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(makeOrderVal('open', 0)))
        .mockResolvedValueOnce(mockSimulationResult(
          makeScMap({
            refunded_amount: nativeToScVal(1000n, { type: 'i128' }),
            filled_amount: nativeToScVal(0n, { type: 'i128' }),
          }),
        ));
      mockClient.submitTransaction.mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Transaction failed' },
      });

      await expect(
        module.cancelLimitOrder('order-submit-fail'),
      ).rejects.toThrow('Transaction failed');
    });

    it('accepts a custom signer parameter', async () => {
      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(makeOrderVal('open', 0)))
        .mockResolvedValueOnce(mockSimulationResult(
          makeScMap({
            refunded_amount: nativeToScVal(500n, { type: 'i128' }),
            filled_amount: nativeToScVal(0n, { type: 'i128' }),
          }),
        ));
      mockClient.submitTransaction.mockResolvedValue({
        success: true,
        data: { txHash: '0xcustom', ledger: 12347 },
      });

      const customSigner = 'GAZGE6TCGY5SW4GMFRVY2DMFXBOZVDDWOJ6CJZQ6ZUXY3SQQE2FTCAJF';
      const result = await module.cancelLimitOrder('order-signer', customSigner);

      expect(result.refundedAmount).toBe(500n);
      expect(result.refundTxHash).toBe('0xcustom');
    });
  });

  describe('parseOrderDetails', () => {
    function makeOrderDetailsVal(
      id: string,
      state: string,
      fillPercent: number,
      amountFilled: bigint,
      amountRemaining: bigint,
      createdAt: number,
      executionPrice?: number,
      filledAt?: number,
    ): xdr.ScVal {
      const fields: Record<string, xdr.ScVal> = {
        id: xdr.ScVal.scvString(id),
        state: xdr.ScVal.scvSymbol(state),
        fill_percent: xdr.ScVal.scvU32(fillPercent),
        amount_filled: nativeToScVal(amountFilled, { type: 'i128' }),
        amount_remaining: nativeToScVal(amountRemaining, { type: 'i128' }),
        created_at: xdr.ScVal.scvU64(new xdr.Uint64(createdAt)),
      };
      if (executionPrice !== undefined) {
        fields.execution_price = xdr.ScVal.scvU32(executionPrice);
      } else {
        fields.execution_price = xdr.ScVal.scvVoid();
      }
      if (filledAt !== undefined) {
        fields.filled_at = xdr.ScVal.scvU64(new xdr.Uint64(filledAt));
      } else {
        fields.filled_at = xdr.ScVal.scvVoid();
      }
      return makeScMap(fields);
    }

    it('parses an open order correctly', () => {
      const val = makeOrderDetailsVal('order-1', 'open', 0, 0n, 1000n, 1000000);
      const result = parseOrderDetails(val);

      expect(result.id).toBe('order-1');
      expect(result.status.state).toBe('open');
      expect(result.status.fillPercent).toBe(0);
      expect(result.amountFilled).toBe(0n);
      expect(result.amountRemaining).toBe(1000n);
      expect(result.createdAt).toBe(1000000);
    });

    it('parses a filled order with execution details', () => {
      const val = makeOrderDetailsVal('order-2', 'filled', 100, 1000n, 0n, 1000000, 150, 2000000);
      const result = parseOrderDetails(val);

      expect(result.id).toBe('order-2');
      expect(result.status.state).toBe('filled');
      expect(result.status.fillPercent).toBe(100);
      expect(result.status.executionPrice).toBe(150);
      expect(result.status.filledAt).toBe(2000000);
      expect(result.amountFilled).toBe(1000n);
      expect(result.amountRemaining).toBe(0n);
      expect(result.createdAt).toBe(1000000);
    });

    it('parses a partially filled order', () => {
      const val = makeOrderDetailsVal('order-3', 'partial', 40, 400n, 600n, 1000000, 120);
      const result = parseOrderDetails(val);

      expect(result.id).toBe('order-3');
      expect(result.status.state).toBe('partial');
      expect(result.status.fillPercent).toBe(40);
      expect(result.amountFilled).toBe(400n);
      expect(result.amountRemaining).toBe(600n);
    });
  });

  describe('scValToStringVec', () => {
    it('parses a vec of strings', () => {
      const val = xdr.ScVal.scvVec([
        xdr.ScVal.scvString('order-1'),
        xdr.ScVal.scvString('order-2'),
        xdr.ScVal.scvString('order-3'),
      ]);
      const result = scValToStringVec(val);
      expect(result).toEqual(['order-1', 'order-2', 'order-3']);
    });

    it('returns empty array for empty vec', () => {
      const val = xdr.ScVal.scvVec([]);
      const result = scValToStringVec(val);
      expect(result).toEqual([]);
    });

    it('throws for non-vec value', () => {
      expect(() => scValToStringVec(xdr.ScVal.scvI32(42))).toThrow('Expected Vec');
    });
  });

  describe('placeLimitOrder', () => {
    beforeEach(() => {
      mockClient.submitTransaction = jest.fn();
    });

    const TOKEN_IN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const TOKEN_OUT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
    const PAIR_ADDR = 'CAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSBFLM';

    const validParams = {
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1000n,
      targetPrice: 1.5,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pairAddress: PAIR_ADDR,
    };

    it('places an order and returns the order ID', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(xdr.ScVal.scvString('new-order-id')),
      );
      mockClient.submitTransaction.mockResolvedValue({
        success: true,
        data: { txHash: '0xplace', ledger: 12350 },
      });

      const result = await module.placeLimitOrder(validParams);

      expect(result.orderId).toBe('new-order-id');
    });

    it('uses default signer when none provided', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(xdr.ScVal.scvString('default-signer-order')),
      );
      mockClient.submitTransaction.mockResolvedValue({
        success: true,
        data: { txHash: '0xdefault', ledger: 12351 },
      });

      const result = await module.placeLimitOrder(validParams);

      expect(result.orderId).toBe('default-signer-order');
    });

    it('throws ValidationError for zero targetPrice', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, targetPrice: 0 }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative targetPrice', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, targetPrice: -1 }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for excessive targetPrice', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, targetPrice: 1_000_001 }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for past expiry', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, expiry: Math.floor(Date.now() / 1000) - 10 }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for zero amountIn', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, amountIn: 0n }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative amountIn', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, amountIn: -100n }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for same-token swaps', async () => {
      await expect(
        module.placeLimitOrder({ ...validParams, tokenOut: TOKEN_IN }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when pair address does not exist on-chain', async () => {
      mockClient.getPairAddress = jest.fn().mockResolvedValue(null);
      await expect(
        module.placeLimitOrder(validParams),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when pair address does not match on-chain pair', async () => {
      mockClient.getPairAddress = jest.fn().mockResolvedValue('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
      await expect(
        module.placeLimitOrder(validParams),
      ).rejects.toThrow(ValidationError);
    });

    it('throws when simulation fails', async () => {
      mockServer.simulateTransaction.mockResolvedValue({
        latestLedger: 0,
        cost: null,
      } as any);

      await expect(
        module.placeLimitOrder(validParams),
      ).rejects.toThrow('simulation did not succeed');
    });

    it('throws when submission fails', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(xdr.ScVal.scvString('fail-order')),
      );
      mockClient.submitTransaction.mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Submission failed' },
      });

      await expect(
        module.placeLimitOrder(validParams),
      ).rejects.toThrow('Submission failed');
    });
  });

  describe('getLimitOrder', () => {
    function makeOrderDetailsVal(
      id: string,
      state: string,
      fillPercent: number,
      amountFilled: bigint,
      amountRemaining: bigint,
      createdAt: number,
      executionPrice?: number,
      filledAt?: number,
    ): xdr.ScVal {
      const fields: Record<string, xdr.ScVal> = {
        id: xdr.ScVal.scvString(id),
        state: xdr.ScVal.scvSymbol(state),
        fill_percent: xdr.ScVal.scvU32(fillPercent),
        amount_filled: nativeToScVal(amountFilled, { type: 'i128' }),
        amount_remaining: nativeToScVal(amountRemaining, { type: 'i128' }),
        created_at: xdr.ScVal.scvU64(new xdr.Uint64(createdAt)),
      };
      if (executionPrice !== undefined) {
        fields.execution_price = xdr.ScVal.scvU32(executionPrice);
      } else {
        fields.execution_price = xdr.ScVal.scvVoid();
      }
      if (filledAt !== undefined) {
        fields.filled_at = xdr.ScVal.scvU64(new xdr.Uint64(filledAt));
      } else {
        fields.filled_at = xdr.ScVal.scvVoid();
      }
      return makeScMap(fields);
    }

    it('returns full order details for an open order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderDetailsVal('order-1', 'open', 0, 0n, 1000n, 1000000)),
      );

      const details = await module.getLimitOrder('order-1');

      expect(details.id).toBe('order-1');
      expect(details.status.state).toBe('open');
      expect(details.amountRemaining).toBe(1000n);
      expect(details.createdAt).toBe(1000000);
    });

    it('returns full order details for a filled order', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(makeOrderDetailsVal('order-2', 'filled', 100, 1000n, 0n, 1000000, 150, 2000000)),
      );

      const details = await module.getLimitOrder('order-2');

      expect(details.id).toBe('order-2');
      expect(details.status.state).toBe('filled');
      expect(details.status.executionPrice).toBe(150);
      expect(details.status.filledAt).toBe(2000000);
      expect(details.amountFilled).toBe(1000n);
    });

    it('throws for empty orderId', async () => {
      await expect(module.getLimitOrder('')).rejects.toThrow(
        'orderId must be a non-empty string',
      );
    });
  });

  describe('getOpenOrders', () => {
    function makeOrderDetailsVal(
      id: string,
      state: string,
      fillPercent: number,
      amountFilled: bigint,
      amountRemaining: bigint,
      createdAt: number,
    ): xdr.ScVal {
      const fields: Record<string, xdr.ScVal> = {
        id: xdr.ScVal.scvString(id),
        state: xdr.ScVal.scvSymbol(state),
        fill_percent: xdr.ScVal.scvU32(fillPercent),
        amount_filled: nativeToScVal(amountFilled, { type: 'i128' }),
        amount_remaining: nativeToScVal(amountRemaining, { type: 'i128' }),
        created_at: xdr.ScVal.scvU64(new xdr.Uint64(createdAt)),
        execution_price: xdr.ScVal.scvVoid(),
        filled_at: xdr.ScVal.scvVoid(),
      };
      return makeScMap(fields);
    }

    it('returns open and partial orders for an address', async () => {
      const orderIds = xdr.ScVal.scvVec([
        xdr.ScVal.scvString('open-order'),
        xdr.ScVal.scvString('partial-order'),
        xdr.ScVal.scvString('filled-order'),
      ]);

      mockServer.simulateTransaction
        .mockResolvedValueOnce(mockSimulationResult(orderIds))
        .mockResolvedValueOnce(mockSimulationResult(makeOrderDetailsVal('open-order', 'open', 0, 0n, 1000n, 1000000)))
        .mockResolvedValueOnce(mockSimulationResult(makeOrderDetailsVal('partial-order', 'partial', 50, 500n, 500n, 1000000)))
        .mockResolvedValueOnce(mockSimulationResult(makeOrderDetailsVal('filled-order', 'filled', 100, 1000n, 0n, 1000000)));

      const orders = await module.getOpenOrders('GAZGE6TCGY5SW4GMFRVY2DMFXBOZVDDWOJ6CJZQ6ZUXY3SQQE2FTCAJF');

      expect(orders).toHaveLength(2);
      expect(orders[0].id).toBe('open-order');
      expect(orders[0].status.state).toBe('open');
      expect(orders[1].id).toBe('partial-order');
      expect(orders[1].status.state).toBe('partial');
    });

    it('returns empty array when address has no orders', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        mockSimulationResult(xdr.ScVal.scvVec([])),
      );

      const orders = await module.getOpenOrders('GAZGE6TCGY5SW4GMFRVY2DMFXBOZVDDWOJ6CJZQ6ZUXY3SQQE2FTCAJF');

      expect(orders).toEqual([]);
    });

    it('throws for invalid address', async () => {
      await expect(module.getOpenOrders('')).rejects.toThrow();
    });
  });
});
