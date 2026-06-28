
import { getOpenOrders, getOrderSummary } from '../src/modules/order-book';
import { CoralSwapClient } from '../src/client';
import { OracleModule } from '../src/modules/oracle';
import { Network } from '../src/types/common';

// Mock the client and modules
jest.mock('../src/client');
jest.mock('../src/modules/oracle');

describe('OrderBook Module', () => {
  let client: CoralSwapClient;

  beforeEach(() => {
    // Set up a mock CoralSwapClient
    client = new CoralSwapClient({
      network: 'testnet' as Network,
      rpcUrl: 'https://test.rpc.url',
    });

    // Mock the oracle module's getSpotPrice method
    (OracleModule.prototype.getSpotPrice as jest.Mock).mockImplementation(
      async (pairAddress: string) => {
        if (pairAddress.includes('USDC-ETH')) {
          return { price0Per1: 2000n * 10n ** 7n, price1Per0: (10n ** 7n) / 2000n };
        }
        if (pairAddress.includes('USDC-BTC')) {
          return { price0Per1: 50000n * 10n ** 7n, price1Per0: (10n ** 7n) / 50000n };
        }
        if (pairAddress.includes('BTC-USDC')) {
            return { price0Per1: (10n ** 7n) / 50000n, price1Per0: 50000n * 10n ** 7n };
        }
        return { price0Per1: 0n, price1Per0: 0n };
      }
    );
  });

  describe('getOpenOrders', () => {
    it('should return an aggregated list of open orders sorted by creation date', async () => {
      const openOrders = await getOpenOrders('test_address');
      expect(openOrders).toHaveLength(3);
      expect(openOrders[0].id).toBe('stop-loss-1');
      expect(openOrders[1].id).toBe('limit-1');
      expect(openOrders[2].id).toBe('dca-1');
    });
  });

  describe('getOrderSummary', () => {
    it('should return a summary of open orders', async () => {
      const summary = await getOrderSummary('test_address', client);
      expect(summary.totalOpenOrders).toBe(3);
      expect(summary.byType.limit).toBe(1);
      expect(summary.byType.dca).toBe(1);
      expect(summary.byType.stopLoss).toBe(1);
    });

    it('should calculate the total value locked correctly', async () => {
        const summary = await getOrderSummary('test_address', client);
        // Expected value:
        // limit-1: 1000000000n (USDC) * 1 = 1000000000
        // dca-1: 5000000000n (USDC) * 1 = 5000000000
        // stop-loss-1: 100000000n (BTC) * 50000 = 5000000000000
        // Total: 5006000000000
        expect(summary.totalValueLocked).toBe(5006000000000);
      });
  });
});
