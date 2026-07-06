import { nativeToScVal } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { StopLossModule } from '../src/modules/stop-loss';
import {
  StaleOracleError,
  TransactionError,
  ValidationError,
} from '../src/errors';
import { Network } from '../src/types/common';
import type {
  StopLossOrder,
  StopLossParams,
} from '../src/types/stop-loss';
import type { SimulateTransactionResult } from '../src/types/common';

const TEST_SECRET =
  'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const MANAGER =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ORACLE =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const TOKEN_IN =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_OUT =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const TOKEN_MID =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const PAIR =
  'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OWNER =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const TEST_TX_HASH = 'stop-loss-tx-123';
const NOW_MS = 1_720_000_000_000;

function makeParams(overrides: Partial<StopLossParams> = {}): StopLossParams {
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: 1_000_0000000n,
    triggerPrice: 9_000_000n,
    pairAddress: PAIR,
    oracleAsset: 'XLM',
    ...overrides,
  };
}

function makeOrderNative(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'order-1',
    owner: OWNER,
    token_in: TOKEN_IN,
    token_out: TOKEN_OUT,
    amount: '10000000000',
    trigger_price: '9000000',
    oracle_asset: 'XLM',
    status: 'active',
    created_at: NOW_MS - 60_000,
    ...overrides,
  };
}

function makeOrder(
  overrides: Partial<StopLossOrder> = {},
): StopLossOrder {
  return {
    id: 'order-1',
    owner: OWNER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: 1_000_0000000n,
    triggerPrice: 9_000_000n,
    currentPrice: 10_000_000n,
    oracleAsset: 'XLM',
    status: 'active',
    triggered: false,
    createdAt: NOW_MS - 60_000,
    ...overrides,
  };
}

function makeSimResult(native: unknown): SimulateTransactionResult {
  return {
    success: true,
    returnValue: nativeToScVal(native),
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

function makeEmptySimResult(): SimulateTransactionResult {
  return {
    success: true,
    returnValue: null,
    auth: [],
    minResourceFee: '100',
    cost: { cpuInsns: '1000', memBytes: '512' },
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error: null,
    raw: {} as never,
  };
}

function makeFailedSimResult(error = 'simulation failed'): SimulateTransactionResult {
  return {
    success: false,
    returnValue: null,
    auth: [],
    minResourceFee: '',
    cost: null,
    transactionData: null,
    latestLedger: 12345,
    events: [],
    error,
    raw: {} as never,
  };
}

describe('StopLossModule', () => {
  let client: CoralSwapClient;
  let stopLoss: StopLossModule;
  let mockSigner: { publicKey: jest.Mock; signTransaction: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    stopLoss = new StopLossModule(client, MANAGER, ORACLE);

    mockSigner = {
      publicKey: jest.fn().mockResolvedValue(OWNER),
      signTransaction: jest.fn().mockResolvedValue('signed-xdr'),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockSubmitSuccess(): jest.SpyInstance {
    return jest.spyOn(client, 'submitTransaction').mockResolvedValue({
      success: true,
      txHash: TEST_TX_HASH,
      data: { txHash: TEST_TX_HASH, ledger: 1000 },
    });
  }

  describe('createStopLoss()', () => {
    it('returns an order ID when the trigger is below market price', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('10000000'));
      mockSubmitSuccess();

      const id = await stopLoss.createStopLoss(makeParams(), mockSigner);

      expect(id).toBe(TEST_TX_HASH);
      expect(mockSigner.publicKey).toHaveBeenCalled();
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('rejects a trigger price at market price', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('9000000'));

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow('triggerPrice must be below the current market price');
    });

    it('rejects a trigger price above market price', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('8000000'));

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('accepts a very small trigger distance below market', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('9000001'));
      mockSubmitSuccess();

      const id = await stopLoss.createStopLoss(makeParams(), mockSigner);

      expect(id).toBe(TEST_TX_HASH);
    });

    it('throws ValidationError when amount is zero', async () => {
      await expect(
        stopLoss.createStopLoss(makeParams({ amount: 0n }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when token addresses are identical', async () => {
      await expect(
        stopLoss.createStopLoss(
          makeParams({ tokenOut: TOKEN_IN }),
          mockSigner,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws TransactionError when submitTransaction fails', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('10000000'));
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Escrow transfer failed' },
      });

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow(TransactionError);
    });
  });

  describe('getStopLossOrders()', () => {
    it('sorts orders by createdAt descending by default', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(
        makeSimResult([
          makeOrderNative({ id: 'oldest', created_at: NOW_MS - 3_000 }),
          makeOrderNative({ id: 'newest', created_at: NOW_MS - 1_000 }),
          makeOrderNative({ id: 'middle', created_at: NOW_MS - 2_000 }),
        ]),
      );
      simulate
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'));

      const orders = await stopLoss.getStopLossOrders(OWNER);

      expect(orders.map((order) => order.id)).toEqual([
        'newest',
        'middle',
        'oldest',
      ]);
    });

    it('filters by triggered state', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(
        makeSimResult([
          makeOrderNative({ id: 'safe', trigger_price: '9000000' }),
          makeOrderNative({ id: 'hit', trigger_price: '9500000' }),
        ]),
      );
      simulate
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('9000000'));

      const orders = await stopLoss.getStopLossOrders(OWNER, {
        triggered: true,
      });

      expect(orders).toHaveLength(1);
      expect(orders[0].id).toBe('hit');
      expect(orders[0].triggered).toBe(true);
    });

    it('filters by status and sorts by trigger price ascending', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(
        makeSimResult([
          makeOrderNative({
            id: 'cancelled',
            status: 'cancelled',
            trigger_price: '8700000',
          }),
          makeOrderNative({
            id: 'active-high',
            status: 'active',
            trigger_price: '9300000',
          }),
          makeOrderNative({
            id: 'active-low',
            status: 'active',
            trigger_price: '8800000',
          }),
        ]),
      );
      simulate
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'));

      const orders = await stopLoss.getStopLossOrders(OWNER, {
        statuses: ['active'],
        sortBy: 'triggerPrice',
        sortDirection: 'asc',
      });

      expect(orders.map((order) => order.id)).toEqual([
        'active-low',
        'active-high',
      ]);
    });

    it('returns an empty array when the manager returns no orders', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult([]));

      const orders = await stopLoss.getStopLossOrders(OWNER);

      expect(orders).toEqual([]);
    });

    it('throws ValidationError for an empty address', async () => {
      await expect(stopLoss.getStopLossOrders('')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('estimateStopLossGas()', () => {
    it('returns a realistic estimate for a single-hop stop-loss', async () => {
      const simulate = jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult(null));

      const gas = await stopLoss.estimateStopLossGas(makeParams());

      expect(gas.fee).toBe(100);
      expect(gas.feeXLM).toBe('0.00001 XLM');
      expect(simulate).toHaveBeenCalledTimes(1);
      expect((simulate.mock.calls[0][0] as unknown[])).toHaveLength(1);
    });

    it('includes an extra pricing operation for multi-hop routes', async () => {
      const simulate = jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue({
          ...makeSimResult(null),
          minResourceFee: '275',
        });

      const gas = await stopLoss.estimateStopLossGas(makeParams(), {
        route: [TOKEN_IN, TOKEN_MID, TOKEN_OUT],
      });

      expect(gas.fee).toBe(275);
      expect(gas.feeXLM).toBe('0.00003 XLM');
      expect((simulate.mock.calls[0][0] as unknown[])).toHaveLength(2);
    });

    it('rejects invalid route addresses for multi-hop pricing', async () => {
      await expect(
        stopLoss.estimateStopLossGas(makeParams(), {
          route: [TOKEN_IN, 'not-an-address', TOKEN_OUT],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('propagates simulation failure from mocked RPC', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeFailedSimResult('out of budget'));

      await expect(
        stopLoss.estimateStopLossGas(makeParams()),
      ).rejects.toThrow('out of budget');
    });
  });

  describe('trigger detection', () => {
    it('marks an order as triggered when price crosses below the threshold', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      simulate.mockResolvedValueOnce(makeSimResult('8500000'));

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.currentPrice).toBe(8_500_000n);
      expect(order.triggered).toBe(true);
    });

    it('marks an order as triggered when price exactly equals the threshold', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      simulate.mockResolvedValueOnce(makeSimResult('9000000'));

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.triggered).toBe(true);
    });

    it('does not trigger when price barely misses the threshold by one unit', async () => {
      const simulate = jest.spyOn(client, 'simulateTransaction');
      simulate.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      simulate.mockResolvedValueOnce(makeSimResult('9000001'));

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.currentPrice).toBe(9_000_001n);
      expect(order.triggered).toBe(false);
    });

    it('returns false from direct trigger evaluation when market is above trigger', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeSimResult('10000000'));

      await expect(
        stopLoss.isStopLossTriggered(makeOrder()),
      ).resolves.toBe(false);
    });

    it('throws StaleOracleError when oracle timestamp is older than max age', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult({
          price: '8500000',
          timestamp: NOW_MS - 301_000,
        }),
      );

      await expect(
        stopLoss.isStopLossTriggered(makeOrder(), { staleAfterMs: 300_000 }),
      ).rejects.toThrow(StaleOracleError);
    });

    it('accepts fresh oracle data at the staleness boundary', async () => {
      jest.spyOn(client, 'simulateTransaction').mockResolvedValue(
        makeSimResult({
          price: '8500000',
          timestamp: NOW_MS - 300_000,
        }),
      );

      await expect(
        stopLoss.isStopLossTriggered(makeOrder(), { staleAfterMs: 300_000 }),
      ).resolves.toBe(true);
    });
  });

  describe('getStopLoss()', () => {
    it('throws ValidationError for an empty orderId', async () => {
      await expect(stopLoss.getStopLoss('')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the order does not exist', async () => {
      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValue(makeEmptySimResult());

      await expect(stopLoss.getStopLoss('missing')).rejects.toThrow(
        'Stop-loss order not found',
      );
    });
  });

  describe('distancePercent calculation', () => {
    it('calculates positive distancePercent when price is above trigger', async () => {
      jest.spyOn(client, 'simulateTransaction');
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult(makeOrderNative())
      );
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult('12000000') // 33% above trigger of 9000000
      );

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.distancePercent).toBeGreaterThan(0);
      expect(order.distancePercent).toBeCloseTo(33.33, 1);
    });

    it('calculates negative distancePercent when price is below trigger', async () => {
      jest.spyOn(client, 'simulateTransaction');
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult(makeOrderNative())
      );
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult('6000000') // 33% below trigger of 9000000
      );

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.distancePercent).toBeLessThan(0);
      expect(order.distancePercent).toBeCloseTo(-33.33, 1);
    });

    it('calculates zero distancePercent when price equals trigger', async () => {
      jest.spyOn(client, 'simulateTransaction');
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult(makeOrderNative())
      );
      (client.simulateTransaction as jest.Mock).mockResolvedValueOnce(
        makeSimResult('9000000') // Exactly at trigger
      );

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.distancePercent).toBeCloseTo(0, 1);
    });
  });

  describe('getStopLossOrders() with distancePercent sorting', () => {
    it('includes distancePercent in each order', async () => {
      const order1 = makeOrderNative({ id: 'order-1', trigger_price: '9000000' });
      const order2 = makeOrderNative({ id: 'order-2', trigger_price: '8000000' });

      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValueOnce(
          makeSimResult([order1, order2])
        )
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'));

      const orders = await stopLoss.getStopLossOrders(OWNER);

      expect(orders.length).toBe(2);
      for (const order of orders) {
        expect(order.distancePercent).toBeDefined();
        expect(typeof order.distancePercent).toBe('number');
      }
    });

    it('sorts orders by distancePercent ascending (closest to trigger first)', async () => {
      const order1 = makeOrderNative({
        id: 'order-1',
        trigger_price: '9000000',
      });
      const order2 = makeOrderNative({
        id: 'order-2',
        trigger_price: '7000000',
      });

      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValueOnce(
          makeSimResult([order1, order2])
        )
        .mockResolvedValueOnce(makeSimResult('9100000'))
        .mockResolvedValueOnce(makeSimResult('9100000'));

      const orders = await stopLoss.getStopLossOrders(OWNER, {
        sortBy: 'distancePercent',
        sortDirection: 'asc',
      });

      expect(orders).toHaveLength(2);
      expect(orders[0].distancePercent).toBeLessThanOrEqual(
        orders[1].distancePercent
      );
    });

    it('sorts orders by distancePercent descending', async () => {
      const order1 = makeOrderNative({
        id: 'order-1',
        trigger_price: '9000000',
      });
      const order2 = makeOrderNative({
        id: 'order-2',
        trigger_price: '7000000',
      });

      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValueOnce(
          makeSimResult([order1, order2])
        )
        .mockResolvedValueOnce(makeSimResult('9100000'))
        .mockResolvedValueOnce(makeSimResult('9100000'));

      const orders = await stopLoss.getStopLossOrders(OWNER, {
        sortBy: 'distancePercent',
        sortDirection: 'desc',
      });

      expect(orders).toHaveLength(2);
      expect(orders[0].distancePercent).toBeGreaterThanOrEqual(
        orders[1].distancePercent
      );
    });

    it('default sorting still uses createdAt when sortBy is not specified', async () => {
      const order1 = makeOrderNative({
        id: 'order-1',
        created_at: NOW_MS - 100_000,
      });
      const order2 = makeOrderNative({
        id: 'order-2',
        created_at: NOW_MS - 200_000,
      });

      jest
        .spyOn(client, 'simulateTransaction')
        .mockResolvedValueOnce(
          makeSimResult([order1, order2])
        )
        .mockResolvedValueOnce(makeSimResult('10000000'))
        .mockResolvedValueOnce(makeSimResult('10000000'));

      const orders = await stopLoss.getStopLossOrders(OWNER);

      expect(orders[0].createdAt).toBeGreaterThan(
        orders[1].createdAt ?? 0
      );
    });
  });
});
