import { TokenListModule } from '../src/modules/tokens';
import { Network } from '../src/types/common';
import { ValidationError, NetworkError } from '../src/errors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN_LIST = {
  name: 'CoralSwap Default',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    {
      address: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 7,
      network: 'testnet',
      logoURI: 'https://example.com/usdc.png',
      tags: ['stablecoin', 'fiat-backed'],
    },
    {
      address: 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K',
      name: 'Wrapped XLM',
      symbol: 'wXLM',
      decimals: 7,
      network: 'testnet',
      tags: ['native', 'wrapped'],
    },
    {
      address: 'CA1MAINNETADDRESS000000000000000000000000000000000000000',
      name: 'Mainnet USDC',
      symbol: 'USDC',
      decimals: 7,
      network: 'mainnet',
      tags: ['stablecoin'],
    },
  ],
};

const INVALID_TOKEN_LIST_MISSING_NAME = {
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [],
};

const INVALID_TOKEN_LIST_BAD_TOKEN = {
  name: 'Bad List',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    {
      address: '',
      name: 'Missing Fields',
      symbol: 'BAD',
      decimals: -1,
      network: 'testnet',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenListModule', () => {
  let mod: TokenListModule;

  beforeEach(() => {
    // Construct with a mock client that has network = TESTNET
    const fakeClient = { network: Network.TESTNET } as any;
    mod = new TokenListModule(fakeClient);
  });

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  describe('validate', () => {
    it('parses a valid token list', () => {
      const result = mod.validate(VALID_TOKEN_LIST);
      expect(result.name).toBe('CoralSwap Default');
      expect(result.tokens).toHaveLength(3);
      expect(result.version).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    it('throws ValidationError when name is missing', () => {
      expect(() => mod.validate(INVALID_TOKEN_LIST_MISSING_NAME)).toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError for invalid token fields', () => {
      expect(() => mod.validate(INVALID_TOKEN_LIST_BAD_TOKEN)).toThrow(
        ValidationError,
      );
    });

    it('throws ValidationError for non-object input', () => {
      expect(() => mod.validate('not an object')).toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // filterByNetwork()
  // -------------------------------------------------------------------------

  describe('filterByNetwork', () => {
    it('filters tokens to testnet only', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const testnet = mod.filterByNetwork(all.tokens, Network.TESTNET);
      expect(testnet).toHaveLength(2);
      expect(testnet.every((t) => t.network === Network.TESTNET)).toBe(true);
    });

    it('filters tokens to mainnet only', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const mainnet = mod.filterByNetwork(all.tokens, Network.MAINNET);
      expect(mainnet).toHaveLength(1);
      expect(mainnet[0].symbol).toBe('USDC');
    });

    it('returns empty array when no tokens match', () => {
      const empty = mod.filterByNetwork([], Network.TESTNET);
      expect(empty).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe('search', () => {
    it('searches by symbol (case-insensitive)', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.search(all.tokens, 'usdc');
      expect(results).toHaveLength(2);
    });

    it('searches by name', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.search(all.tokens, 'Wrapped');
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('wXLM');
    });

    it('returns empty for no match', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.search(all.tokens, 'NONEXIST')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // findByAddress()
  // -------------------------------------------------------------------------

  describe('findByAddress', () => {
    it('finds a token by exact address', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const token = mod.findByAddress(
        all.tokens,
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      );
      expect(token).toBeDefined();
      expect(token!.symbol).toBe('USDC');
    });

    it('returns undefined for unknown address', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.findByAddress(all.tokens, 'UNKNOWN')).toBeUndefined();
    });
  });

  describe('filterByTag', () => {
    it('filters tokens by a single tag', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.filterByTag(all.tokens, 'stablecoin');
      expect(results).toHaveLength(2);
      expect(results.map((t) => t.symbol)).toContain('USDC');
    });

    it('returns empty array if tag not found', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.filterByTag(all.tokens, 'non-existent')).toHaveLength(0);
    });
  });

  describe('filterByTags', () => {
    it('filters tokens by multiple tags', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      const results = mod.filterByTags(all.tokens, ['stablecoin', 'fiat-backed']);
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('USDC');
    });

    it('returns empty array if any tag is missing', () => {
      const all = mod.validate(VALID_TOKEN_LIST);
      expect(mod.filterByTags(all.tokens, ['stablecoin', 'non-existent'])).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // fetch() — uses mocked global fetch
  // -------------------------------------------------------------------------

  describe('fetch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('fetches, validates, and filters by client network', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => VALID_TOKEN_LIST,
      }) as any;

      const list = await mod.fetch('https://example.com/tokens.json');
      expect(list.name).toBe('CoralSwap Default');
      // Client network is TESTNET, so only testnet tokens are returned
      expect(list.tokens).toHaveLength(2);
      expect(list.tokens.every((t) => t.network === Network.TESTNET)).toBe(
        true,
      );
    });

    it('throws NetworkError on fetch failure', async () => {
      globalThis.fetch = jest.fn().mockRejectedValue(
        new Error('Network unreachable'),
      ) as any;

      await expect(
        mod.fetch('https://bad-url.example.com/tokens.json'),
      ).rejects.toThrow(NetworkError);
    });

    it('throws NetworkError on non-OK response', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      await expect(
        mod.fetch('https://example.com/missing.json'),
      ).rejects.toThrow(NetworkError);
    });

    it('throws ValidationError on invalid JSON body', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }) as any;

      await expect(
        mod.fetch('https://example.com/bad.json'),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError on invalid schema', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ bad: 'data' }),
      }) as any;

      await expect(
        mod.fetch('https://example.com/invalid.json'),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // fetchAll()
  // -------------------------------------------------------------------------

  describe('fetchAll', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns all tokens without network filter', async () => {
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => VALID_TOKEN_LIST,
      }) as any;

      const list = await mod.fetchAll('https://example.com/tokens.json');
      expect(list.tokens).toHaveLength(3);
    });
  });
});
