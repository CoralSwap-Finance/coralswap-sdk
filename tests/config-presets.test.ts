/**
 * Unit tests for CoralSwap SDK network config presets and address validation.
 *
 * Covers:
 *  - Table-driven structural validation of every NetworkConfig preset
 *    (TESTNET, MAINNET, STAGING): required fields present, correct types,
 *    non-empty strings, positive sorobanTimeout, distinct passphrase/rpcUrl
 *    across presets.
 *  - RPC URL scheme checks: presets must use https (no cleartext production URL).
 *  - Address field checks: non-empty addresses must be valid Soroban C-addresses;
 *    undeployed presets (MAINNET, STAGING) must have empty strings (not garbage).
 *  - Passphrase correctness: each preset must carry the canonical Stellar
 *    passphrase for its network.
 *  - NETWORK_CONFIGS map completeness: every Network enum value is present.
 *  - DEFAULTS object: all numeric defaults are positive / within expected ranges.
 *  - Schema validation of CoralSwapConfig objects via the client constructor:
 *    invalid configs are rejected with typed errors.
 */

import {
  NETWORK_CONFIGS,
  TESTNET_NETWORK,
  MAINNET_NETWORK,
  STAGING_NETWORK,
  NetworkConfig,
  DEFAULTS,
} from '../src/config';
import { Network } from '../src/types/common';
import { isValidContractId, isValidPublicKey } from '../src/utils/addresses';
import { isSecureRpcUrl, getRpcUrlScheme } from '../src/utils/rpc-url';
import { ValidationError, NotConfiguredError } from '../src/errors';
import { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts that `addr` is either an empty string or a valid Soroban C-address. */
function expectEmptyOrValidContract(addr: string, label: string): void {
  if (addr === '') return;
  expect(isValidContractId(addr)).toBe(true); // <-- fails if garbage value
  expect(addr).toMatch(/^C[A-Z2-7]{55}$/); // Soroban contracts: C + 55 base-32 chars
}

/** All three presets as a table for `test.each`. */
const ALL_PRESETS: Array<[Network, NetworkConfig, string]> = [
  [Network.TESTNET, TESTNET_NETWORK, 'TESTNET'],
  [Network.MAINNET, MAINNET_NETWORK, 'MAINNET'],
  [Network.STAGING, STAGING_NETWORK, 'STAGING'],
];

// ---------------------------------------------------------------------------
// 1. NETWORK_CONFIGS map completeness
// ---------------------------------------------------------------------------

describe('NETWORK_CONFIGS map', () => {
  it('contains an entry for every Network enum value', () => {
    const enumValues = Object.values(Network);
    for (const v of enumValues) {
      expect(NETWORK_CONFIGS).toHaveProperty(v);
    }
  });

  it('has exactly one entry per Network enum value (no extras)', () => {
    expect(Object.keys(NETWORK_CONFIGS)).toHaveLength(Object.values(Network).length);
  });

  it('named exports match NETWORK_CONFIGS entries', () => {
    expect(NETWORK_CONFIGS[Network.TESTNET]).toBe(TESTNET_NETWORK);
    expect(NETWORK_CONFIGS[Network.MAINNET]).toBe(MAINNET_NETWORK);
    expect(NETWORK_CONFIGS[Network.STAGING]).toBe(STAGING_NETWORK);
  });
});

// ---------------------------------------------------------------------------
// 2. Structural / shape validation — table test over all presets
// ---------------------------------------------------------------------------

describe.each(ALL_PRESETS)('%s preset — structural shape', (_network, preset, label) => {
  const REQUIRED_KEYS: (keyof NetworkConfig)[] = [
    'rpcUrl',
    'networkPassphrase',
    'factoryAddress',
    'routerAddress',
    'sorobanTimeout',
  ];

  it(`${label}: has all required NetworkConfig keys`, () => {
    for (const key of REQUIRED_KEYS) {
      expect(preset).toHaveProperty(key);
    }
  });

  it(`${label}: rpcUrl is a non-empty string`, () => {
    expect(typeof preset.rpcUrl).toBe('string');
    expect(preset.rpcUrl.length).toBeGreaterThan(0);
  });

  it(`${label}: networkPassphrase is a non-empty string`, () => {
    expect(typeof preset.networkPassphrase).toBe('string');
    expect(preset.networkPassphrase.length).toBeGreaterThan(0);
  });

  it(`${label}: factoryAddress is a string`, () => {
    expect(typeof preset.factoryAddress).toBe('string');
  });

  it(`${label}: routerAddress is a string`, () => {
    expect(typeof preset.routerAddress).toBe('string');
  });

  it(`${label}: sorobanTimeout is a positive integer`, () => {
    expect(typeof preset.sorobanTimeout).toBe('number');
    expect(preset.sorobanTimeout).toBeGreaterThan(0);
    expect(Number.isInteger(preset.sorobanTimeout)).toBe(true);
  });

  it(`${label}: sorobanTimeout is a reasonable upper-bound (≤ 3600 s)`, () => {
    // Prevent accidental millisecond values (e.g. 30_000 instead of 30).
    expect(preset.sorobanTimeout).toBeLessThanOrEqual(3600);
  });
});

// ---------------------------------------------------------------------------
// 3. RPC URL scheme validation — table test over all presets
// ---------------------------------------------------------------------------

describe.each(ALL_PRESETS)('%s preset — rpcUrl scheme', (_network, preset, label) => {
  it(`${label}: rpcUrl parses as a valid URL`, () => {
    expect(() => new URL(preset.rpcUrl)).not.toThrow();
  });

  it(`${label}: rpcUrl uses an https or http scheme (no typos or unsupported protocols)`, () => {
    const scheme = getRpcUrlScheme(preset.rpcUrl);
    expect(['http', 'https', 'wss', 'ws']).toContain(scheme);
  });

  it(`${label}: rpcUrl uses a secure (https / wss) scheme`, () => {
    // All production-shipped preset URLs must be secure. Local overrides
    // (http://localhost) are only allowed at runtime by the caller.
    expect(isSecureRpcUrl(preset.rpcUrl)).toBe(true);
  });

  it(`${label}: rpcUrl does not contain placeholder text`, () => {
    const lower = preset.rpcUrl.toLowerCase();
    expect(lower).not.toContain('todo');
    expect(lower).not.toContain('fixme');
    expect(lower).not.toContain('example.com');
    expect(lower).not.toContain('localhost');
  });
});

// ---------------------------------------------------------------------------
// 4. Address field validation — C-address or empty string
// ---------------------------------------------------------------------------

describe.each(ALL_PRESETS)('%s preset — address fields', (_network, preset, label) => {
  it(`${label}: factoryAddress is empty or a valid Soroban C-address`, () => {
    expectEmptyOrValidContract(preset.factoryAddress, `${label}.factoryAddress`);
  });

  it(`${label}: routerAddress is empty or a valid Soroban C-address`, () => {
    expectEmptyOrValidContract(preset.routerAddress, `${label}.routerAddress`);
  });

  it(`${label}: factoryAddress is not a G-address (public key)`, () => {
    // Contract addresses must start with C, not G.
    if (preset.factoryAddress !== '') {
      expect(isValidPublicKey(preset.factoryAddress)).toBe(false);
      expect(preset.factoryAddress.startsWith('C')).toBe(true);
    }
  });

  it(`${label}: routerAddress is not a G-address (public key)`, () => {
    if (preset.routerAddress !== '') {
      expect(isValidPublicKey(preset.routerAddress)).toBe(false);
      expect(preset.routerAddress.startsWith('C')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Per-preset canonical values
// ---------------------------------------------------------------------------

describe('TESTNET preset — canonical values', () => {
  it('uses the Stellar testnet passphrase', () => {
    expect(TESTNET_NETWORK.networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('uses the official Stellar testnet RPC endpoint', () => {
    expect(TESTNET_NETWORK.rpcUrl).toBe('https://soroban-testnet.stellar.org');
  });

  it('has non-empty factoryAddress (testnet is deployed)', () => {
    expect(TESTNET_NETWORK.factoryAddress).not.toBe('');
    expect(isValidContractId(TESTNET_NETWORK.factoryAddress)).toBe(true);
  });

  it('has non-empty routerAddress (testnet is deployed)', () => {
    expect(TESTNET_NETWORK.routerAddress).not.toBe('');
    expect(isValidContractId(TESTNET_NETWORK.routerAddress)).toBe(true);
  });
});

describe('MAINNET preset — canonical values', () => {
  it('uses the Stellar mainnet passphrase', () => {
    expect(MAINNET_NETWORK.networkPassphrase).toBe(
      'Public Global Stellar Network ; September 2015',
    );
  });

  it('uses the official Stellar mainnet RPC endpoint', () => {
    expect(MAINNET_NETWORK.rpcUrl).toBe('https://soroban.stellar.org');
  });

  it('has empty factoryAddress (not yet deployed on mainnet)', () => {
    expect(MAINNET_NETWORK.factoryAddress).toBe('');
  });

  it('has empty routerAddress (not yet deployed on mainnet)', () => {
    expect(MAINNET_NETWORK.routerAddress).toBe('');
  });
});

describe('STAGING preset — canonical values', () => {
  it('uses the Stellar Futurenet passphrase (not Testnet)', () => {
    expect(STAGING_NETWORK.networkPassphrase).toBe(
      'Test SDF Future Network ; October 2022',
    );
    // Must be distinct from Testnet passphrase
    expect(STAGING_NETWORK.networkPassphrase).not.toBe(TESTNET_NETWORK.networkPassphrase);
  });

  it('uses the Stellar Futurenet RPC endpoint (not Testnet)', () => {
    expect(STAGING_NETWORK.rpcUrl).toBe('https://rpc-futurenet.stellar.org');
    expect(STAGING_NETWORK.rpcUrl).not.toBe(TESTNET_NETWORK.rpcUrl);
  });

  it('has empty factoryAddress (no CoralSwap deployment on Futurenet)', () => {
    expect(STAGING_NETWORK.factoryAddress).toBe('');
  });

  it('has empty routerAddress (no CoralSwap deployment on Futurenet)', () => {
    expect(STAGING_NETWORK.routerAddress).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Cross-preset uniqueness — no accidental copy-paste between presets
// ---------------------------------------------------------------------------

describe('cross-preset uniqueness', () => {
  it('all three rpcUrls are distinct', () => {
    const urls = [
      TESTNET_NETWORK.rpcUrl,
      MAINNET_NETWORK.rpcUrl,
      STAGING_NETWORK.rpcUrl,
    ];
    const unique = new Set(urls);
    expect(unique.size).toBe(3);
  });

  it('all three networkPassphrases are distinct', () => {
    const passphrases = [
      TESTNET_NETWORK.networkPassphrase,
      MAINNET_NETWORK.networkPassphrase,
      STAGING_NETWORK.networkPassphrase,
    ];
    const unique = new Set(passphrases);
    expect(unique.size).toBe(3);
  });

  it('STAGING rpcUrl is not the same as TESTNET rpcUrl', () => {
    expect(STAGING_NETWORK.rpcUrl).not.toBe(TESTNET_NETWORK.rpcUrl);
  });

  it('MAINNET rpcUrl is not the same as TESTNET rpcUrl', () => {
    expect(MAINNET_NETWORK.rpcUrl).not.toBe(TESTNET_NETWORK.rpcUrl);
  });

  it('STAGING passphrase differs from MAINNET passphrase', () => {
    expect(STAGING_NETWORK.networkPassphrase).not.toBe(MAINNET_NETWORK.networkPassphrase);
  });
});

// ---------------------------------------------------------------------------
// 7. DEFAULTS object — numeric sanity
// ---------------------------------------------------------------------------

describe('DEFAULTS object', () => {
  it('slippageBps is within 0–10000', () => {
    expect(DEFAULTS.slippageBps).toBeGreaterThanOrEqual(0);
    expect(DEFAULTS.slippageBps).toBeLessThanOrEqual(10_000);
  });

  it('deadlineSec is positive', () => {
    expect(DEFAULTS.deadlineSec).toBeGreaterThan(0);
  });

  it('maxRetries is a non-negative integer', () => {
    expect(DEFAULTS.maxRetries).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(DEFAULTS.maxRetries)).toBe(true);
  });

  it('retryDelayMs is positive', () => {
    expect(DEFAULTS.retryDelayMs).toBeGreaterThan(0);
  });

  it('maxRetryDelayMs >= retryDelayMs', () => {
    expect(DEFAULTS.maxRetryDelayMs).toBeGreaterThanOrEqual(DEFAULTS.retryDelayMs);
  });

  it('pollingIntervalMs is positive', () => {
    expect(DEFAULTS.pollingIntervalMs).toBeGreaterThan(0);
  });

  it('maxPollingAttempts is a positive integer', () => {
    expect(DEFAULTS.maxPollingAttempts).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULTS.maxPollingAttempts)).toBe(true);
  });

  it('pollingBackoffFactor is > 1 (meaningful exponential growth)', () => {
    expect(DEFAULTS.pollingBackoffFactor).toBeGreaterThan(1);
  });

  it('feeMinBps < feeMaxBps', () => {
    expect(DEFAULTS.feeMinBps).toBeLessThan(DEFAULTS.feeMaxBps);
  });

  it('baselineFeeBps is within feeMinBps–feeMaxBps', () => {
    expect(DEFAULTS.baselineFeeBps).toBeGreaterThanOrEqual(DEFAULTS.feeMinBps);
    expect(DEFAULTS.baselineFeeBps).toBeLessThanOrEqual(DEFAULTS.feeMaxBps);
  });

  it('flashFeeFloorBps is positive', () => {
    expect(DEFAULTS.flashFeeFloorBps).toBeGreaterThan(0);
  });

  it('multiSigThreshold < multiSigSigners (valid quorum)', () => {
    expect(DEFAULTS.multiSigThreshold).toBeLessThan(DEFAULTS.multiSigSigners);
    expect(DEFAULTS.multiSigThreshold).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 8. CoralSwapConfig schema validation via CoralSwapClient constructor
// ---------------------------------------------------------------------------

/**
 * The constructor validates the rpcUrl before any network call, so it's
 * the right place to assert that invalid configs are rejected early.
 *
 * We do not mock the RPC server here — we only check that the constructor
 * either succeeds silently or throws a typed ValidationError / NotConfiguredError.
 */
describe('CoralSwapConfig — invalid configs are rejected', () => {
  it('rejects a cleartext http rpcUrl on mainnet', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.MAINNET,
        rpcUrl: 'http://localhost:8000',
      }),
    ).toThrow(ValidationError);
  });

  it('includes "cleartext" in the error message for http on mainnet', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.MAINNET,
        rpcUrl: 'http://localhost:8000',
      }),
    ).toThrow(/cleartext/i);
  });

  it('rejects a cleartext ws rpcUrl on mainnet', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.MAINNET,
        rpcUrl: 'ws://insecure.example.com',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a malformed rpcUrl (not a URL at all)', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: 'not-a-url',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an unsupported URL scheme (ftp://)', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: 'ftp://files.example.com',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an unsupported URL scheme even on testnet', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: 'smtp://mail.example.com',
      }),
    ).toThrow(/unsupported scheme/i);
  });

  it('rejects a mixed array where one URL is cleartext on mainnet', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.MAINNET,
        rpcUrl: ['https://soroban.stellar.org', 'http://fallback.example.com'],
      }),
    ).toThrow(ValidationError);
  });

  it('accepts a valid https rpcUrl on mainnet without throwing', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.MAINNET,
        rpcUrl: 'https://soroban.stellar.org',
      }),
    ).not.toThrow();
  });

  it('accepts a valid https rpcUrl array on testnet without throwing', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: [
          'https://soroban-testnet.stellar.org',
          'https://backup-rpc.example.com',
        ],
      }),
    ).not.toThrow();
  });

  it('accepts cleartext http rpcUrl on testnet (dev/test allowed)', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.TESTNET,
        rpcUrl: 'http://localhost:8000',
      }),
    ).not.toThrow();
  });

  it('accepts cleartext http rpcUrl on staging (dev/test allowed)', () => {
    expect(() =>
      new CoralSwapClient({
        network: Network.STAGING,
        rpcUrl: 'http://localhost:8000',
      }),
    ).not.toThrow();
  });

  it('accessing factory on mainnet throws NotConfiguredError', () => {
    const client = new CoralSwapClient({ network: Network.MAINNET });
    expect(() => client.factory).toThrow(NotConfiguredError);
    expect(() => client.factory).toThrow(/not configured/i);
  });

  it('accessing router on mainnet throws NotConfiguredError', () => {
    const client = new CoralSwapClient({ network: Network.MAINNET });
    expect(() => client.router).toThrow(NotConfiguredError);
  });

  it('accessing factory on staging throws NotConfiguredError', () => {
    const client = new CoralSwapClient({ network: Network.STAGING });
    expect(() => client.factory).toThrow(NotConfiguredError);
  });

  it('accessing router on staging throws NotConfiguredError', () => {
    const client = new CoralSwapClient({ network: Network.STAGING });
    expect(() => client.router).toThrow(NotConfiguredError);
  });

  it('does not throw NotConfiguredError for factory on testnet (addresses are set)', () => {
    // testnet has deployed addresses — accessing .factory should not throw
    // NotConfiguredError. It will attempt to build the client; no RPC is called here.
    const client = new CoralSwapClient({ network: Network.TESTNET });
    expect(() => client.factory).not.toThrow(NotConfiguredError);
  });

  it('does not throw NotConfiguredError for router on testnet', () => {
    const client = new CoralSwapClient({ network: Network.TESTNET });
    expect(() => client.router).not.toThrow(NotConfiguredError);
  });
});

// ---------------------------------------------------------------------------
// 9. Preset correctness after setNetwork() round-trips
// ---------------------------------------------------------------------------

describe('config correctness after setNetwork round-trips', () => {
  it('networkConfig.rpcUrl matches the preset after switching to TESTNET', () => {
    const client = new CoralSwapClient({ network: Network.MAINNET });
    client.setNetwork(Network.TESTNET);
    expect(client.networkConfig.rpcUrl).toBe(TESTNET_NETWORK.rpcUrl);
    expect(client.networkConfig.networkPassphrase).toBe(TESTNET_NETWORK.networkPassphrase);
  });

  it('networkConfig.rpcUrl matches the preset after switching to MAINNET', () => {
    const client = new CoralSwapClient({ network: Network.TESTNET });
    client.setNetwork(Network.MAINNET);
    expect(client.networkConfig.rpcUrl).toBe(MAINNET_NETWORK.rpcUrl);
    expect(client.networkConfig.networkPassphrase).toBe(MAINNET_NETWORK.networkPassphrase);
  });

  it('networkConfig.rpcUrl matches the preset after switching to STAGING', () => {
    const client = new CoralSwapClient({ network: Network.TESTNET });
    client.setNetwork(Network.STAGING);
    expect(client.networkConfig.rpcUrl).toBe(STAGING_NETWORK.rpcUrl);
    expect(client.networkConfig.networkPassphrase).toBe(STAGING_NETWORK.networkPassphrase);
  });

  it('factory and router contract addresses reset when switching away from TESTNET', () => {
    const client = new CoralSwapClient({ network: Network.TESTNET });
    // Access factory to warm the singleton
    const _f = client.factory;
    // Switch to a network with no deployed addresses
    client.setNetwork(Network.MAINNET);
    // Singleton must have been cleared — accessing factory now throws
    expect(() => client.factory).toThrow(NotConfiguredError);
  });

  it('a custom rpcUrl survives a switch and overrides the preset', () => {
    const customUrl = 'https://my-custom-rpc.example.com';
    const client = new CoralSwapClient({ network: Network.TESTNET });
    client.setNetwork(Network.TESTNET, customUrl);
    expect(client.networkConfig.rpcUrl).toBe(customUrl);
  });

  it('rejects a cleartext http override on mainnet via setNetwork', () => {
    const client = new CoralSwapClient({ network: Network.TESTNET });
    expect(() =>
      client.setNetwork(Network.MAINNET, 'http://localhost:8000'),
    ).toThrow(ValidationError);
  });
});
