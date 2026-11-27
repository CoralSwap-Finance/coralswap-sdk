import { ConnectionPool, ConnectionPoolOptions } from '../src/utils/connection-pool';
import { ConnectionPoolExhaustedError } from '../src/errors';

describe('ConnectionPool', () => {
  const createPool = (options?: ConnectionPoolOptions): ConnectionPool => {
    return new ConnectionPool(options);
  };

  describe('addEndpoint and removeEndpoint', () => {
    it('adds endpoints to the pool', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(2);
    });

    it('ignores duplicate endpoints', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc1.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(1);
    });

    it('removes endpoints from the pool', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');
      pool.removeEndpoint('https://rpc1.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(1);
      expect(pool.getHealthyEndpoints()[0]).toBe('https://rpc2.example.com');
    });

    it('removes failure state when endpoint is removed', () => {
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
      const pool = createPool({ failureTimeoutMs: 100 });
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');
      pool.markFailed('https://rpc1.example.com');
      pool.removeEndpoint('https://rpc1.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(1);
      dateNowSpy.mockRestore();
    });
  });

  describe('getNextEndpoint', () => {
    it('throws ConnectionPoolExhaustedError when pool is empty', () => {
      const pool = createPool();
      expect(() => pool.getNextEndpoint()).toThrow(ConnectionPoolExhaustedError);
    });

    it('returns the single endpoint for a single-endpoint pool', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');

      expect(pool.getNextEndpoint()).toBe('https://rpc1.example.com');
      expect(pool.getNextEndpoint()).toBe('https://rpc1.example.com');
    });

    it('throws ConnectionPoolExhaustedError when all endpoints are failed', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.markFailed('https://rpc1.example.com');

      expect(() => pool.getNextEndpoint()).toThrow(ConnectionPoolExhaustedError);
    });

    it('distributes evenly across healthy endpoints in round-robin order', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');
      pool.addEndpoint('https://rpc3.example.com');

      const counts: Record<string, number> = {};
      for (let i = 0; i < 6; i++) {
        const endpoint = pool.getNextEndpoint();
        counts[endpoint] = (counts[endpoint] || 0) + 1;
      }

      expect(counts['https://rpc1.example.com']).toBe(2);
      expect(counts['https://rpc2.example.com']).toBe(2);
      expect(counts['https://rpc3.example.com']).toBe(2);
    });

    it('skips failed endpoints and rotates to the next healthy one', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');
      pool.addEndpoint('https://rpc3.example.com');

      pool.markFailed('https://rpc2.example.com');

      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(pool.getNextEndpoint());
      }

      expect(results).toEqual([
        'https://rpc1.example.com',
        'https://rpc3.example.com',
        'https://rpc1.example.com',
      ]);
    });
  });

  describe('markFailed and automatic recovery', () => {
    it('excludes failed endpoints from rotation temporarily', () => {
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
      const pool = createPool({ failureTimeoutMs: 100 });
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      pool.markFailed('https://rpc1.example.com');

      expect(pool.getNextEndpoint()).toBe('https://rpc2.example.com');
      expect(pool.getNextEndpoint()).toBe('https://rpc2.example.com');
      dateNowSpy.mockRestore();
    });

    it('recovers failed endpoints after the timeout expires', () => {
      const dateNowSpy = jest.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(0);
      const pool = createPool({ failureTimeoutMs: 100 });
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      pool.markFailed('https://rpc1.example.com');
      expect(pool.getNextEndpoint()).toBe('https://rpc2.example.com');

      dateNowSpy.mockReturnValue(150);
      expect(pool.getNextEndpoint()).toBe('https://rpc1.example.com');

      dateNowSpy.mockRestore();
    });

    it('does not return failed endpoints from getHealthyEndpoints', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      pool.markFailed('https://rpc1.example.com');

      expect(pool.getHealthyEndpoints()).toEqual(['https://rpc2.example.com']);
    });

    it('returns recovered endpoints in getHealthyEndpoints after timeout', () => {
      const dateNowSpy = jest.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(0);
      const pool = createPool({ failureTimeoutMs: 100 });
      pool.addEndpoint('https://rpc1.example.com');

      pool.markFailed('https://rpc1.example.com');
      expect(pool.getHealthyEndpoints()).toHaveLength(0);

      dateNowSpy.mockReturnValue(150);
      expect(pool.getHealthyEndpoints()).toEqual(['https://rpc1.example.com']);

      dateNowSpy.mockRestore();
    });
  });

  describe('getHealthyEndpoints', () => {
    it('returns all endpoints when none have failed', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(2);
    });

    it('returns empty array when all endpoints have failed', () => {
      const pool = createPool();
      pool.addEndpoint('https://rpc1.example.com');
      pool.addEndpoint('https://rpc2.example.com');

      pool.markFailed('https://rpc1.example.com');
      pool.markFailed('https://rpc2.example.com');

      expect(pool.getHealthyEndpoints()).toHaveLength(0);
    });
  });
});
