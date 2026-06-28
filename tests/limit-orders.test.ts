import { SorobanRpc, xdr } from '@stellar/stellar-sdk';
import { LimitOrderModule, parseOrderStatus } from '../src/modules/limit-orders';

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
});
