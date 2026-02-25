import {
  isValidPublicKey,
  isValidContractId,
  isValidAddress,
  isNativeToken,
  sortTokens,
  truncateAddress,
  getPairAddress,
} from '../src/utils/addresses';

describe('Address Utilities', () => {
  const VALID_PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const VALID_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  describe('isValidPublicKey', () => {
    it('validates correct public keys', () => {
      expect(isValidPublicKey(VALID_PUBLIC_KEY)).toBe(true);
    });

    it('rejects invalid keys', () => {
      expect(isValidPublicKey('invalid')).toBe(false);
    });

    it('rejects contract addresses', () => {
      expect(isValidPublicKey(VALID_CONTRACT)).toBe(false);
    });
  });

  describe('isValidContractId', () => {
    it('validates correct contract IDs', () => {
      expect(isValidContractId(VALID_CONTRACT)).toBe(true);
    });

    it('rejects invalid IDs', () => {
      expect(isValidContractId('invalid')).toBe(false);
    });
  });

  describe('isValidAddress', () => {
    it('validates public keys', () => {
      expect(isValidAddress(VALID_PUBLIC_KEY)).toBe(true);
    });

    it('validates contract IDs', () => {
      expect(isValidAddress(VALID_CONTRACT)).toBe(true);
    });

    it('rejects invalid addresses', () => {
      expect(isValidAddress('xyz')).toBe(false);
    });
  });

  describe('isNativeToken', () => {
    it('returns true for XLM symbol (case-insensitive)', () => {
      expect(isNativeToken('XLM')).toBe(true);
      expect(isNativeToken('xlm')).toBe(true);
    });

    it('returns true for generic native identifier', () => {
      expect(isNativeToken('native')).toBe(true);
      expect(isNativeToken(' NATIVE ')).toBe(true);
    });

    it('returns false for empty or whitespace-only input', () => {
      expect(isNativeToken('')).toBe(false);
      expect(isNativeToken('   ')).toBe(false);
    });

    it('returns false for real Stellar addresses', () => {
      expect(isNativeToken(VALID_PUBLIC_KEY)).toBe(false);
      expect(isNativeToken(VALID_CONTRACT)).toBe(false);
    });

    it('returns false for arbitrary asset identifiers', () => {
      expect(isNativeToken('USDC')).toBe(false);
      expect(isNativeToken('TOKEN:ISSUER')).toBe(false);
    });
  });

  describe('sortTokens', () => {
    it('sorts tokens deterministically', () => {
      const [a, b] = sortTokens('B_TOKEN', 'A_TOKEN');
      expect(a).toBe('A_TOKEN');
      expect(b).toBe('B_TOKEN');
    });

    it('throws on identical tokens', () => {
      expect(() => sortTokens('A_TOKEN', 'A_TOKEN')).toThrow('Identical');
    });
  });

  describe('truncateAddress', () => {
    it('truncates long addresses', () => {
      const truncated = truncateAddress(VALID_PUBLIC_KEY, 4);
      expect(truncated).toBe('GAAA...AWHF');
    });

    it('preserves short strings', () => {
      expect(truncateAddress('short')).toBe('short');
    });
  });

  describe('getPairAddress', () => {
    const FACTORY = 'CCVAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA463';
    const TOKEN_A = 'CC5QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4CG';
    const TOKEN_B = 'CDGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGVG';
    const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
    const EXPECTED_PAIR = 'CC4YVLFRDJB3I32FKEHLSP7ZUE5DP73QHB54SQIBO6MXBFP7FIMVTG2I';

    it('derives the correct pair address', () => {
      const pair = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      expect(pair).toBe(EXPECTED_PAIR);
    });

    it('returns the same address regardless of token order', () => {
      const forward = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      const reversed = getPairAddress(FACTORY, TOKEN_B, TOKEN_A, TESTNET_PASSPHRASE);
      expect(forward).toBe(reversed);
    });

    it('returns a valid contract address', () => {
      const pair = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      expect(isValidContractId(pair)).toBe(true);
    });

    it('produces different addresses for different factory addresses', () => {
      const otherFactory = 'CAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDQF';
      const pair1 = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      const pair2 = getPairAddress(otherFactory, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      expect(pair1).not.toBe(pair2);
    });

    it('produces different addresses for different network passphrases', () => {
      const mainnetPassphrase = 'Public Global Stellar Network ; September 2015';
      const testnet = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE);
      const mainnet = getPairAddress(FACTORY, TOKEN_A, TOKEN_B, mainnetPassphrase);
      expect(testnet).not.toBe(mainnet);
    });

    it('throws on identical tokens', () => {
      expect(() =>
        getPairAddress(FACTORY, TOKEN_A, TOKEN_A, TESTNET_PASSPHRASE),
      ).toThrow('Identical');
    });
  });
});
