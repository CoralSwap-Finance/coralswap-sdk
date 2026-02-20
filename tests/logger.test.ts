import { CoralSwapClient } from '../src/client';
import { Network, Logger } from '../src/types/common';

/**
 * Tests for request/response logging middleware.
 *
 * Validates that CoralSwapClient emits debug, info, and error logs
 * for all RPC interactions when a Logger is provided, and remains
 * silent when no logger is configured (backward compatibility).
 */

/**
 * Create a mock Logger where every method is a jest.fn().
 */
function createMockLogger(): Logger & {
  debug: jest.Mock;
  info: jest.Mock;
  error: jest.Mock;
} {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  };
}

describe('Logger Middleware', () => {
  describe('config acceptance', () => {
    it('accepts a custom logger in config', () => {
      const logger = createMockLogger();
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: 'GABCDEFG',
        logger,
      });
      expect(client.config.logger).toBe(logger);
    });

    it('defaults to undefined when no logger is provided', () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: 'GABCDEFG',
      });
      expect(client.config.logger).toBeUndefined();
    });

    it('does not throw when logger is undefined (backward compatible)', () => {
      expect(() => {
        new CoralSwapClient({
          network: Network.TESTNET,
          publicKey: 'GABCDEFG',
        });
      }).not.toThrow();
    });
  });

  describe('submitTransaction logging', () => {
    it('emits debug log for getAccount call', async () => {
      const logger = createMockLogger();
      const mockAccount = {
        accountId: () => 'GABCDEFG',
        sequenceNumber: () => '1',
        sequence: '1',
      };

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        secretKey: undefined,
        publicKey: 'GABCDEFG',
        logger,
      });

      // Mock server methods to isolate logging behavior
      (client.server as unknown as Record<string, unknown>).getAccount = jest
        .fn()
        .mockRejectedValue(new Error('mock: stop after getAccount'));

      try {
        await client.submitTransaction([]);
      } catch {
        // Expected to fail -- we only care about the log call
      }

      // The debug log for getAccount should have been called before the error
      expect(logger.debug).toHaveBeenCalledWith(
        'getAccount: fetching account',
        expect.objectContaining({ sourceKey: 'GABCDEFG' }),
      );
    });

    it('emits error log when submitTransaction catches unexpected error', async () => {
      const logger = createMockLogger();

      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: 'GABCDEFG',
        logger,
      });

      (client.server as unknown as Record<string, unknown>).getAccount = jest
        .fn()
        .mockRejectedValue(new Error('RPC connection lost'));

      const result = await client.submitTransaction([]);
      expect(result.success).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'submitTransaction: unexpected error',
        expect.any(Error),
      );
    });

    it('does not throw when logger is undefined during submitTransaction', async () => {
      const client = new CoralSwapClient({
        network: Network.TESTNET,
        publicKey: 'GABCDEFG',
      });

      (client.server as unknown as Record<string, unknown>).getAccount = jest
        .fn()
        .mockRejectedValue(new Error('fail'));

      const result = await client.submitTransaction([]);
      expect(result.success).toBe(false);
      // No throws -- logger?.method() safely no-ops
    });
  });

  describe('logger interface contract', () => {
    it('Logger methods receive string message and optional data', () => {
      const logger = createMockLogger();

      logger.debug('test debug', { key: 'value' });
      logger.info('test info', { key: 'value' });
      logger.error('test error', new Error('e'));

      expect(logger.debug).toHaveBeenCalledWith('test debug', { key: 'value' });
      expect(logger.info).toHaveBeenCalledWith('test info', { key: 'value' });
      expect(logger.error).toHaveBeenCalledWith('test error', expect.any(Error));
    });

    it('Logger methods can be called without data argument', () => {
      const logger = createMockLogger();

      logger.debug('debug only');
      logger.info('info only');
      logger.error('error only');

      expect(logger.debug).toHaveBeenCalledWith('debug only');
      expect(logger.info).toHaveBeenCalledWith('info only');
      expect(logger.error).toHaveBeenCalledWith('error only');
    });
  });
});
