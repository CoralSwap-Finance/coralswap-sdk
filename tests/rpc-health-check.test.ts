import {
  checkRPCHealth,
  checkAllEndpoints,
  getBestEndpoint,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
} from '../src/utils/health-check';
import { RpcError } from '../src/errors';

type ServerMockConfig = {
  getLatestLedgerFn?: (url: string) => Promise<unknown>;
};

const serverMockConfig: ServerMockConfig = {};
const perEndpoint = new Map<string, () => Promise<unknown>>();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: class MockServer {
        public url: string;
        constructor(url: string, _options?: Record<string, unknown>) {
          this.url = url;
          void _options;
        }
        async getLatestLedger(): Promise<unknown> {
          if (serverMockConfig.getLatestLedgerFn) return serverMockConfig.getLatestLedgerFn(this.url);
          throw new Error('getLatestLedger not configured');
        }
      },
    },
  };
});

beforeEach(() => {
  perEndpoint.clear();
  serverMockConfig.getLatestLedgerFn = async (url) => {
    const fn = perEndpoint.get(url);
    if (fn) return fn();
    throw new Error('connection refused');
  };
});

function setLedgerHandler(url: string, impl: () => Promise<unknown>) {
  perEndpoint.set(url, impl);
}

describe('checkRPCHealth()', () => {
  it('returns isHealthy=true with blockHeight and version on success', async () => {
    setLedgerHandler('https://rpc.example.com', async () => ({
      sequence: 12345,
      id: 'abc',
      protocolVersion: '21',
    }));

    const result = await checkRPCHealth('https://rpc.example.com');
    expect(result.isHealthy).toBe(true);
    expect(result.blockHeight).toBe(12345);
    expect(result.version).toBe('21');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns isHealthy=false with latencyMs=-1 when the endpoint errors', async () => {
    setLedgerHandler('https://rpc.example.com', async () => {
      throw new Error('connection refused');
    });

    const result = await checkRPCHealth('https://rpc.example.com');
    expect(result.isHealthy).toBe(false);
    expect(result.latencyMs).toBe(-1);
    expect(result.blockHeight).toBe(0);
    expect(result.version).toBe('unknown');
  });

  it('returns isHealthy=false for an empty URL without constructing a server', async () => {
    const result = await checkRPCHealth('');
    expect(result.isHealthy).toBe(false);
    expect(result.latencyMs).toBe(-1);
  });

  it('marks the endpoint unhealthy when the request exceeds the timeout', async () => {
    setLedgerHandler('https://slow.example.com', () => new Promise(() => {
      // Never resolves -- the timeout race must win.
    }));

    const result = await checkRPCHealth('https://slow.example.com', 20);
    expect(result.isHealthy).toBe(false);
    expect(result.latencyMs).toBe(-1);
  });

  it('defaults the timeout to DEFAULT_HEALTH_CHECK_TIMEOUT_MS (5000ms)', () => {
    expect(DEFAULT_HEALTH_CHECK_TIMEOUT_MS).toBe(5_000);
  });
});

describe('checkAllEndpoints()', () => {
  it('probes every endpoint and preserves input order', async () => {
    setLedgerHandler('https://a.example.com', async () => ({
      sequence: 100, id: 'a', protocolVersion: '21',
    }));
    setLedgerHandler('https://b.example.com', async () => {
      throw new Error('dead');
    });

    const results = await checkAllEndpoints(['https://a.example.com', 'https://b.example.com']);
    expect(results).toHaveLength(2);
    expect(results[0].isHealthy).toBe(true);
    expect(results[0].blockHeight).toBe(100);
    expect(results[1].isHealthy).toBe(false);
  });

  it('returns an empty array for an empty input list', async () => {
    const results = await checkAllEndpoints([]);
    expect(results).toEqual([]);
  });
});

describe('getBestEndpoint()', () => {
  it('throws an RpcError for an empty URL list', async () => {
    await expect(getBestEndpoint([])).rejects.toThrow(RpcError);
  });

  it('throws an RpcError when all endpoints are unhealthy', async () => {
    setLedgerHandler('https://bad-a.example.com', async () => {
      throw new Error('dead');
    });
    setLedgerHandler('https://bad-b.example.com', async () => {
      throw new Error('dead');
    });

    await expect(
      getBestEndpoint(['https://bad-a.example.com', 'https://bad-b.example.com']),
    ).rejects.toThrow(RpcError);
  });

  it('excludes unhealthy endpoints and returns the only healthy one', async () => {
    setLedgerHandler('https://bad.example.com', async () => {
      throw new Error('dead');
    });
    setLedgerHandler('https://healthy.example.com', async () => ({
      sequence: 1, id: 'x', protocolVersion: '21',
    }));

    const result = await getBestEndpoint(['https://bad.example.com', 'https://healthy.example.com']);
    expect(result).toBe('https://healthy.example.com');
  });

  it('picks the lowest-latency endpoint among multiple healthy ones', async () => {
    setLedgerHandler('https://slow.example.com', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { sequence: 1, id: 'x', protocolVersion: '21' };
    });
    setLedgerHandler('https://fast.example.com', async () => ({
      sequence: 1, id: 'x', protocolVersion: '21',
    }));

    const result = await getBestEndpoint(['https://slow.example.com', 'https://fast.example.com']);
    expect(result).toBe('https://fast.example.com');
  });
});
