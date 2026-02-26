import {
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateSlippage,
  validateDistinctTokens,
  isValidPath,
} from '../src/utils/validation';
import { ValidationError } from '../src/errors';

describe('Validation Guards', () => {
  const VALID_PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const VALID_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  describe('validateAddress', () => {
    it('accepts a valid public key', () => {
      expect(() => validateAddress(VALID_PUBLIC_KEY, 'token')).not.toThrow();
    });

    it('accepts a valid contract address', () => {
      expect(() => validateAddress(VALID_CONTRACT, 'pair')).not.toThrow();
    });

    it('throws on empty string', () => {
      expect(() => validateAddress('', 'tokenA')).toThrow(ValidationError);
      expect(() => validateAddress('', 'tokenA')).toThrow('must not be empty');
    });

    it('throws on whitespace-only string', () => {
      expect(() => validateAddress('   ', 'tokenA')).toThrow(ValidationError);
    });

    it('throws on invalid address', () => {
      expect(() => validateAddress('not-a-stellar-address', 'pair')).toThrow(ValidationError);
      expect(() => validateAddress('not-a-stellar-address', 'pair')).toThrow('not a valid Stellar address');
    });

    it('includes parameter name in error message', () => {
      expect(() => validateAddress('bad', 'myParam')).toThrow('myParam');
    });
  });

  describe('validatePositiveAmount', () => {
    it('accepts positive amounts', () => {
      expect(() => validatePositiveAmount(1n, 'amount')).not.toThrow();
      expect(() => validatePositiveAmount(1000000n, 'amount')).not.toThrow();
    });

    it('throws on zero', () => {
      expect(() => validatePositiveAmount(0n, 'amount')).toThrow(ValidationError);
      expect(() => validatePositiveAmount(0n, 'amount')).toThrow('must be greater than 0');
    });

    it('throws on negative', () => {
      expect(() => validatePositiveAmount(-1n, 'amount')).toThrow(ValidationError);
    });

    it('includes parameter name in error message', () => {
      expect(() => validatePositiveAmount(0n, 'amountIn')).toThrow('amountIn');
    });
  });

  describe('validateNonNegativeAmount', () => {
    it('accepts zero', () => {
      expect(() => validateNonNegativeAmount(0n, 'min')).not.toThrow();
    });

    it('accepts positive amounts', () => {
      expect(() => validateNonNegativeAmount(100n, 'min')).not.toThrow();
    });

    it('throws on negative', () => {
      expect(() => validateNonNegativeAmount(-1n, 'amountMin')).toThrow(ValidationError);
      expect(() => validateNonNegativeAmount(-1n, 'amountMin')).toThrow('must be non-negative');
    });

    it('includes parameter name in error message', () => {
      expect(() => validateNonNegativeAmount(-5n, 'amountBMin')).toThrow('amountBMin');
    });
  });

  describe('validateSlippage', () => {
    it('accepts 0 bps', () => {
      expect(() => validateSlippage(0)).not.toThrow();
    });

    it('accepts 5000 bps (50%)', () => {
      expect(() => validateSlippage(5000)).not.toThrow();
    });

    it('accepts typical slippage values', () => {
      expect(() => validateSlippage(50)).not.toThrow();
      expect(() => validateSlippage(100)).not.toThrow();
      expect(() => validateSlippage(300)).not.toThrow();
    });

    it('throws on negative bps', () => {
      expect(() => validateSlippage(-1)).toThrow(ValidationError);
      expect(() => validateSlippage(-1)).toThrow('between 0 and 5000');
    });

    it('throws on bps exceeding 5000', () => {
      expect(() => validateSlippage(5001)).toThrow(ValidationError);
      expect(() => validateSlippage(10000)).toThrow(ValidationError);
    });
  });

  describe('validateDistinctTokens', () => {
    it('accepts different addresses', () => {
      expect(() => validateDistinctTokens(VALID_PUBLIC_KEY, VALID_CONTRACT)).not.toThrow();
    });

    it('throws on identical addresses', () => {
      expect(() => validateDistinctTokens(VALID_CONTRACT, VALID_CONTRACT)).toThrow(ValidationError);
      expect(() => validateDistinctTokens(VALID_CONTRACT, VALID_CONTRACT)).toThrow('must be different');
    });
  });

  describe('isValidPath', () => {
    it('returns false for paths with fewer than 2 tokens', () => {
      expect(isValidPath([])).toBe(false);
      expect(isValidPath(['A'])).toBe(false);
    });

    it('returns false when any adjacent tokens are identical', () => {
      expect(isValidPath(['A', 'A'])).toBe(false);
      expect(isValidPath(['A', 'B', 'B', 'C'])).toBe(false);
    });

    it('returns true for structurally valid paths', () => {
      expect(isValidPath(['A', 'B'])).toBe(true);
      expect(isValidPath(['A', 'B', 'C'])).toBe(true);
    });
  });
});
