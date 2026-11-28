import {
  isValidPublicKey,
  isValidContractId,
  isValidAddress,
  isNativeToken,
  getNativeAssetContractAddress,
  resolveTokenIdentifier,
  sortTokens,
  toScAddress,
  truncateAddress,
  getPairAddress,
} from '../src/utils/addresses';
import { ValidationError } from '../src/errors';

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

  describe('getNativeAssetContractAddress', () => {
    const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
    const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

    it('returns a valid contract ID for testnet', () => {
      const addr = getNativeAssetContractAddress(TESTNET_PASSPHRASE);
      expect(addr).toMatch(/^C[A-Z0-9]{55}$/);
      expect(isValidContractId(addr)).toBe(true);
    });

    it('returns a valid contract ID for mainnet', () => {
      const addr = getNativeAssetContractAddress(MAINNET_PASSPHRASE);
      expect(isValidContractId(addr)).toBe(true);
    });

    it('returns different addresses for different networks', () => {
      const testnet = getNativeAssetContractAddress(TESTNET_PASSPHRASE);
      const mainnet = getNativeAssetContractAddress(MAINNET_PASSPHRASE);
      expect(testnet).not.toBe(mainnet);
    });

    it('throws ValidationError for an empty network passphrase', () => {
      expect(() => getNativeAssetContractAddress('')).toThrow(ValidationError);
    });
  });

  describe('resolveTokenIdentifier', () => {
    const PASSPHRASE = 'Test SDF Network ; September 2015';

    it('resolves XLM to native SAC address', () => {
      const resolved = resolveTokenIdentifier('XLM', PASSPHRASE);
      expect(resolved).toMatch(/^C[A-Z0-9]{55}$/);
      expect(resolved).toBe(getNativeAssetContractAddress(PASSPHRASE));
    });

    it('returns contract address unchanged', () => {
      const addr = VALID_CONTRACT;
      expect(resolveTokenIdentifier(addr, PASSPHRASE)).toBe(addr);
    });
  });

  describe('sortTokens', () => {
    it('sorts tokens deterministically', () => {
      const [a, b] = sortTokens('B_TOKEN', 'A_TOKEN');
      expect(a).toBe('A_TOKEN');
      expect(b).toBe('B_TOKEN');
    });

    it('throws ValidationError for identical tokens', () => {
      expect(() => sortTokens('A_TOKEN', 'A_TOKEN')).toThrow(ValidationError);
      try {
        sortTokens('A_TOKEN', 'A_TOKEN');
      } catch (error) {
        expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('toScAddress', () => {
    it('converts a valid Stellar address', () => {
      expect(toScAddress(VALID_PUBLIC_KEY)).toBeDefined();
    });

    it('throws ValidationError for an invalid address', () => {
      expect(() => toScAddress('invalid-address')).toThrow(ValidationError);
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

    it('throws ValidationError for identical tokens', () => {
      expect(() =>
        getPairAddress(FACTORY, TOKEN_A, TOKEN_A, TESTNET_PASSPHRASE),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for an invalid factory address', () => {
      expect(() =>
        getPairAddress('invalid-factory', TOKEN_A, TOKEN_B, TESTNET_PASSPHRASE),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for an invalid token address', () => {
      expect(() =>
        getPairAddress(FACTORY, 'invalid-token', TOKEN_B, TESTNET_PASSPHRASE),
      ).toThrow(ValidationError);
    });

    it('throws ValidationError for an empty network passphrase', () => {
      expect(() => getPairAddress(FACTORY, TOKEN_A, TOKEN_B, '')).toThrow(
        ValidationError,
      );
    });
  });
});
