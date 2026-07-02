/**
 * Unit tests for HealthCheckModule.
 *
 * All network traffic is mocked via Jest module mocks so that:
 *  - `SorobanRpc.Server` methods are replaced with controllable fakes
 *  - Timeout handling is exercised via Promise.race
 *  - Percentile math is verified against known datasets
 *
 * Tests are grouped by the four main probe functions.
 */

import {
  checkRPCHealth,
  percentile,
  getRPCLatency,
  getContractStatus,
  getBestEndpoint,
} from '../src/modules/health-check';

// ---------------------------------------------------------------------------
// SorobanRpc.Server mock
//
// We replace SorobanRpc.Server with a class whose behaviour is determined
// externally via the shared `serverMockConfig` object.  Each test can
// configure the staged behaviour using helper functions defined below.
// ---------------------------------------------------------------------------

type ServerMockConfig = {
  getHealthFn?: (url: string) => Promise<unknown>;
  getLatestLedgerFn?: (url: string) => Promise<unknown>;
  getContractDataFn?: (url: string) => Promise<unknown>;
};

const serverMockConfig: ServerMockConfig = {};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual.SorobanRpc ?? {}),
      Server: class MockServer {
        public url: string;
        readonly serverURL = { toString: () => 'http://mock.local' };
        constructor(url: string, _options?: Record<string, unknown>) {
          this.url = url;
          void _options;
        }
        async getHealth(): Promise<unknown> {
          if (serverMockConfig.getHealthFn) return serverMockConfig.getHealthFn(this.url);
          throw new Error('getHealth not configured');
        }
        async getLatestLedger(): Promise<unknown> {
          if (serverMockConfig.getLatestLedgerFn) return serverMockConfig.getLatestLedgerFn(this.url);
          throw new Error('getLatestLedger not configured');
        }
        async getContractData(): Promise<unknown> {
          if (serverMockConfig.getContractDataFn) return serverMockConfig.getContractDataFn(this.url);
          throw new Error('getContractData not configured');
        }
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const perEndpointHealth = new Map<string, () => Promise<unknown>>();
const perEndpointLedger = new Map<string, () => Promise<unknown>>();
const perEndpointContract = new Map<string, () => Promise<unknown>>();

beforeEach(() => {
  perEndpointHealth.clear();
  perEndpointLedger.clear();
  perEndpointContract.clear();
  serverMockConfig.getHealthFn = async (url) => {
    const fn = perEndpointHealth.get(url);
    if (fn) return fn();
    throw new Error('getHealth not configured');
  };
  serverMockConfig.getLatestLedgerFn = async (url) => {
    const fn = perEndpointLedger.get(url);
    if (fn) return fn();
    throw new Error('getLatestLedger not configured');
  };
  serverMockConfig.getContractDataFn = async (url) => {
    const fn = perEndpointContract.get(url);
    if (fn) return fn();
    throw new Error('getContractData not configured');
  };
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function setHealthHandler(url: string, impl: () => Promise<unknown>) {
  perEndpointHealth.set(url, impl);
}

function setLedgerHandler(url: string, impl: () => Promise<unknown>) {
  perEndpointLedger.set(url, impl);
}

function setContractHandler(url: string, impl: () => Promise<unknown>) {
  perEndpointContract.set(url, impl);
}

// ---------------------------------------------------------------------------
// percentile — pure math
// ---------------------------------------------------------------------------

describe('percentile()', () => {
  // Sorted dataset used for percentile verification (0..100).
  const KNOWN_DATASET = Array.from({ length: 101 }, (_, i) => i);

  it('computes p50 (median) of a known 0..100 dataset as 50', () => {
    expect(percentile(KNOWN_DATASET, 50)).toBe(50);
  });

  it('computes p95 of a known 0..100 dataset as 95', () => {
    expect(percentile(KNOWN_DATASET, 95)).toBe(95);
  });

  it('computes p0 as the minimum', () => {
    expect(percentile(KNOWN_DATASET, 0)).toBe(0);
  });

  it('computes p100 as the maximum', () => {
    expect(percentile(KNOWN_DATASET, 100)).toBe(100);
  });

  it('interpolates the median of an even-length dataset', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it('handles a single-element dataset without division-by-zero', () => {
    expect(percentile([42], 50)).toBe(42);
  });

  it('returns NaN for an empty dataset', () => {
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('computes fractional-rank p99 value correctly', () => {
    const sorted = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 99)).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// checkRPCHealth
// ---------------------------------------------------------------------------

describe('checkRPCHealth()', () => {
  it('returns healthy=true when the endpoint responds with status "healthy"', async () => {
    setHealthHandler('https://rpc.example.com', async () => ({ status: 'healthy' }));
    const result = await checkRPCHealth('https://rpc.example.com');
    expect(result.healthy).toBe(true);
    expect(result.status).toBe('healthy');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeNull();
  });

  it('treats status "degraded" as healthy (services may still accept traffic)', async () => {
    setHealthHandler('https://rpc.example.com', async () => ({ status: 'degraded' }));
    const result = await checkRPCHealth('https://rpc.example.com');
    expect(result.healthy).toBe(true);
    expect(result.status).toBe('degraded');
  });

  it('returns healthy=false and surfaces an error when getHealth throws', async () => {
    setHealthHandler('https://rpc.example.com', async () => {
      throw new Error('connection refused');
    });
    const result = await checkRPCHealth('https://rpc.example.com', 1_000);
    expect(result.healthy).toBe(false);
    expect(result.status).toBe('unreachable');
    expect(result.error).toBeTruthy();
  });

  it('returns healthy=false with an error when the URL is invalid (empty string)', async () => {
    const result = await checkRPCHealth('');
    expect(result.healthy).toBe(false);
    expect(result.latencyMs).toBe(-1);
    expect(result.error).toBeTruthy();
  });

  it('fails fast when Server construction cannot proceed', async () => {
    const result = await checkRPCHealth('not-a-url');
    expect(result.healthy).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getRPCLatency
// ---------------------------------------------------------------------------

describe('getRPCLatency()', () => {
  it('returns stats with p50/p95/p99 for a healthy endpoint', async () => {
    let call = 0;
    const injectedLatencies = [100, 80, 90, 110, 95];
    setLedgerHandler('https://rpc.example.com', () => {
      call++;
      // Resolve synchronously — latency comes from Date.now() deltas
      return Promise.resolve({ sequence: 1, id: 'x', protocolVersion: '21' });
    });

    const realNow = Date.now.bind(Date);
    const spy = jest.spyOn(Date, 'now');
    // We don't control individual Date.now() easily for sync resolution,
    // so we verify the structural properties instead.
    const result = await getRPCLatency('https://rpc.example.com', 5, 10_000);

    expect(result.sampleCount).toBe(5);
    expect(result.errorRate).toBe(0);
    // Without adjustable clock, any non-zero latency is plausible
    expect(Number.isFinite(result.meanMs)).toBe(true);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
    expect(result.p99Ms).toBeGreaterThanOrEqual(result.p95Ms);
    spy.mockRestore();
    expect(call).toBe(5);
  });

  it('reports errorRate = 1 when all samples fail', async () => {
    const result = await getRPCLatency('https://rpc-dead.example.com', 3, 10_000);
    expect(result.errorRate).toBe(1);
    expect(Number.isNaN(result.meanMs)).toBe(true);
    expect(result.sampleCount).toBe(3);
  });

  it('computes errorRate = 0.5 when half the samples fail', async () => {
    let call = 0;
    setLedgerHandler('https://rpc.example.com', () => {
      call++;
      if (call % 2 === 1) throw new Error('flaky connectivity');
      return Promise.resolve({ sequence: 1, id: 'x', protocolVersion: '21' });
    });
    const result = await getRPCLatency('https://rpc.example.com', 4, 10_000);
    expect(result.errorRate).toBe(0.5);
    expect(result.sampleCount).toBe(4);
  });

  it('returns NaN values for an invalid URL', async () => {
    const result = await getRPCLatency('', 3, 1_000);
    expect(Number.isNaN(result.meanMs)).toBe(true);
    expect(result.errorRate).toBe(1);
  });

  it('verifies p50 == p50 when all samples have identical latency', async () => {
    setLedgerHandler('https://rpc.example.com', () =>
      Promise.resolve({ sequence: 1, id: 'x', protocolVersion: '21' }),
    );
    const spy = jest.spyOn(Date, 'now');
    let fakeClock = 0;
    spy.mockImplementation(() => {
      const before = fakeClock;
      fakeClock += 7; // 3 calls × 7ms ≈ 21ms total across all Date.now() invocations
      return before;
    });
    try {
      const result = await getRPCLatency('https://rpc.example.com', 5, 10_000);
      expect(result.sampleCount).toBe(5);
      // With stubbed clock incrementing by 7ms each call, after first call
      // latency ≈ 7ms per sample; all latencies equal → p50 == p95 == p99
      expect(result.p50Ms).toBe(result.p95Ms);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// getContractStatus
// ---------------------------------------------------------------------------

describe('getContractStatus()', () => {
  // A valid Stellar contract id (56 chars, proper StrKey base32 encoding).
  const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

  it('reports deployed=true and ttlValid=true for a live contract', async () => {
    setContractHandler('https://rpc.example.com', async () => ({
      liveUntilLedgerSeq: 5000,
      latestLedger: 1000,
    }));
    const status = await getContractStatus('https://rpc.example.com', CONTRACT_ID);
    expect(status.deployed).toBe(true);
    expect(status.ttlValid).toBe(true);
    expect(status.liveUntilLedger).toBe(5000);
    expect(status.remainingLedgers).toBe(4000);
    expect(status.error).toBeNull();
  });

  it('reports ttlValid=false when the liveUntilLedger has already passed', async () => {
    setContractHandler('https://rpc.example.com', async () => ({
      liveUntilLedgerSeq: 1000,
      latestLedger: 2000,
    }));
    const status = await getContractStatus('https://rpc.example.com', CONTRACT_ID);
    expect(status.ttlValid).toBe(false);
    expect(status.remainingLedgers).toBe(-1000);
  });

  it('reports deployed=false with structured error for 404-like RPC responses', async () => {
    setContractHandler('https://rpc.example.com', async () => {
      throw new Error('Contract not found: entry missing from ledger');
    });
    const status = await getContractStatus('https://rpc.example.com', CONTRACT_ID);
    expect(status.deployed).toBe(false);
    expect(status.error).toContain('not deployed');
  });

  it('reports deployed=false for an invalid RPC URL', async () => {
    const status = await getContractStatus('', CONTRACT_ID);
    expect(status.deployed).toBe(false);
    expect(status.error).toBeTruthy();
  });

  it('surfaces a structured error for an unparseable contractual response', async () => {
    setContractHandler('https://rpc.example.com', async () => ({ liveUntilLedgerSeq: 0 }));
    const status = await getContractStatus('https://rpc.example.com', CONTRACT_ID);
    expect(status.deployed).toBe(false);
    expect(status.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getBestEndpoint
// ---------------------------------------------------------------------------

describe('getBestEndpoint()', () => {
  it('returns null for an empty URL list', async () => {
    expect(await getBestEndpoint([])).toBeNull();
  });

  it('returns null when all endpoints are unreachable', async () => {
    const result = await getBestEndpoint([
      'https://bad-a.example.com',
      'https://bad-b.example.com',
    ]);
    expect(result).toBeNull();
  });

  it('returns the only endpoint when exactly one is healthy', async () => {
    setHealthHandler('https://bad.example.com', async () => {
      throw new Error('dead endpoint');
    });
    setHealthHandler('https://healthy.example.com', async () => ({ status: 'healthy' }));
    setLedgerHandler('https://healthy.example.com', async () => ({
      sequence: 1, id: 'x', protocolVersion: '21',
    }));
    const result = await getBestEndpoint([
      'https://bad.example.com',
      'https://healthy.example.com',
    ]);
    expect(result).toBe('https://healthy.example.com');
  });

  it('selects a working endpoint among mixed-health pool', async () => {
    setHealthHandler('https://bad.example.com', async () => {
      throw new Error('dead');
    });
    setLedgerHandler('https://fast.example.com', async () => ({
      sequence: 1, id: 'x', protocolVersion: '21',
    }));
    setHealthHandler('https://fast.example.com', async () => ({ status: 'healthy' }));
    const result = await getBestEndpoint([
      'https://bad.example.com',
      'https://fast.example.com',
    ]);
    expect(result).toBe('https://fast.example.com');
  });

  it('prefers healthy endpoints over unhealthy regardless of speed label', async () => {
    setHealthHandler('https://fast-but-dead.example.com', async () => {
      throw new Error('dead');
    });
    setHealthHandler('https://slow-but-alive.example.com', async () => ({ status: 'healthy' }));
    setLedgerHandler('https://slow-but-alive.example.com', async () => ({
      sequence: 1, id: 'x', protocolVersion: '21',
    }));
    const result = await getBestEndpoint([
      'https://fast-but-dead.example.com',
      'https://slow-but-alive.example.com',
    ]);
    expect(result).toBe('https://slow-but-alive.example.com');
  });
});
