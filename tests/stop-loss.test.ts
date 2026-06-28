import { CoralSwapClient } from '../src/client';
import { StopLossModule } from '../src/modules/stop-loss';
import { ValidationError, TransactionError } from '../src/errors';
import { Network } from '../src/types/common';
import type { StopLossParams } from '../src/types/stop-loss';
import type { SimulateTransactionResult } from '../src/types/common';
import { nativeToScVal } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const MANAGER = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ORACLE = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';
const TOKEN_IN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_OUT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const OWNER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

const TEST_TX_HASH = 'stop-loss-tx-123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<StopLossParams> = {}): StopLossParams {
  return {
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: 1000_0000000n,
    triggerPrice: 900_0000n, // below the mocked current price of 1_000_0000
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('StopLossModule', () => {
  let client: CoralSwapClient;
  let stopLoss: StopLossModule;
  let mockSigner: { publicKey: jest.Mock; signTransaction: jest.Mock };

  beforeEach(() => {
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

  /** Mock the oracle price read (get_price) to return a fixed price. */
  function mockOraclePrice(price: bigint): jest.SpyInstance {
    return jest
      .spyOn(client, 'simulateTransaction')
      .mockResolvedValue(makeSimResult(price.toString()));
  }

  function mockSubmitSuccess(): jest.SpyInstance {
    return jest.spyOn(client, 'submitTransaction').mockResolvedValue({
      success: true,
      txHash: TEST_TX_HASH,
      data: { txHash: TEST_TX_HASH, ledger: 1000 },
    });
  }

  // -------------------------------------------------------------------------
  // createStopLoss()
  // -------------------------------------------------------------------------

  describe('createStopLoss()', () => {
    it('returns an order ID when the trigger is below market price', async () => {
      mockOraclePrice(1_000_0000n); // current price > trigger (900_0000)
      mockSubmitSuccess();

      const id = await stopLoss.createStopLoss(makeParams(), mockSigner);

      expect(id).toBe(TEST_TX_HASH);
      expect(mockSigner.publicKey).toHaveBeenCalled();
    });

    it('rejects a trigger price at or above the current market price', async () => {
      mockOraclePrice(900_0000n); // equal to trigger

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow('triggerPrice must be below the current market price');
    });

    it('rejects a trigger price above the current market price', async () => {
      mockOraclePrice(800_0000n); // below trigger of 900_0000

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for an invalid tokenIn address', async () => {
      await expect(
        stopLoss.createStopLoss(
          makeParams({ tokenIn: 'not-an-address' }),
          mockSigner,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when tokenIn and tokenOut are identical', async () => {
      await expect(
        stopLoss.createStopLoss(
          makeParams({ tokenOut: TOKEN_IN }),
          mockSigner,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the amount is zero', async () => {
      await expect(
        stopLoss.createStopLoss(makeParams({ amount: 0n }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the trigger price is zero', async () => {
      await expect(
        stopLoss.createStopLoss(makeParams({ triggerPrice: 0n }), mockSigner),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when the oracle asset is empty', async () => {
      await expect(
        stopLoss.createStopLoss(makeParams({ oracleAsset: '' }), mockSigner),
      ).rejects.toThrow('oracleAsset must not be empty');
    });

    it('throws TransactionError when submitTransaction reports failure', async () => {
      mockOraclePrice(1_000_0000n);
      jest.spyOn(client, 'submitTransaction').mockResolvedValue({
        success: false,
        error: { code: 'TX_FAILED', message: 'Escrow transfer failed' },
      });

      await expect(
        stopLoss.createStopLoss(makeParams(), mockSigner),
      ).rejects.toThrow(TransactionError);
    });
  });

  // -------------------------------------------------------------------------
  // getStopLoss()
  // -------------------------------------------------------------------------

  describe('getStopLoss()', () => {
    it('reports triggered=false while price is above the trigger', async () => {
      const spy = jest.spyOn(client, 'simulateTransaction');
      // First call: get_order; second call: get_price
      spy.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      spy.mockResolvedValueOnce(makeSimResult('10000000')); // 10_000_000 > 9_000_000

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.id).toBe('order-1');
      expect(order.triggerPrice).toBe(9_000_000n);
      expect(order.currentPrice).toBe(10_000_000n);
      expect(order.triggered).toBe(false);
      expect(order.status).toBe('active');
    });

    it('reports triggered=true once price falls to the trigger', async () => {
      const spy = jest.spyOn(client, 'simulateTransaction');
      spy.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      spy.mockResolvedValueOnce(makeSimResult('9000000')); // equal to trigger

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.currentPrice).toBe(9_000_000n);
      expect(order.triggered).toBe(true);
    });

    it('reports triggered=true when price falls below the trigger', async () => {
      const spy = jest.spyOn(client, 'simulateTransaction');
      spy.mockResolvedValueOnce(makeSimResult(makeOrderNative()));
      spy.mockResolvedValueOnce(makeSimResult('8500000'));

      const order = await stopLoss.getStopLoss('order-1');

      expect(order.triggered).toBe(true);
    });

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
});
