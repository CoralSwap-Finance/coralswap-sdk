import {
  getRpcUrlScheme,
  isSecureRpcUrl,
  isCleartextRpcAllowed,
  validateRpcUrls,
  SECURE_RPC_SCHEMES,
  ALLOWED_RPC_SCHEMES,
} from '../src/utils/rpc-url';
import { ValidationError } from '../src/errors';
import { Network } from '../src/types/common';

describe('RPC URL validation', () => {
  describe('getRpcUrlScheme', () => {
    it('extracts the scheme from a URL', () => {
      expect(getRpcUrlScheme('https://soroban.stellar.org')).toBe('https');
      expect(getRpcUrlScheme('http://localhost:8000')).toBe('http');
      expect(getRpcUrlScheme('wss://rpc.example.com')).toBe('wss');
      expect(getRpcUrlScheme('ws://rpc.example.com')).toBe('ws');
    });

    it('returns null for malformed URLs', () => {
      expect(getRpcUrlScheme('not-a-url')).toBeNull();
      expect(getRpcUrlScheme('')).toBeNull();
    });
  });

  describe('isSecureRpcUrl', () => {
    it('accepts https and wss', () => {
      expect(isSecureRpcUrl('https://soroban.stellar.org')).toBe(true);
      expect(isSecureRpcUrl('wss://rpc.example.com')).toBe(true);
    });

    it('rejects http and ws', () => {
      expect(isSecureRpcUrl('http://localhost:8000')).toBe(false);
      expect(isSecureRpcUrl('ws://localhost:8000')).toBe(false);
    });
  });

  describe('isCleartextRpcAllowed', () => {
    it('only permits cleartext on dev/test networks', () => {
      expect(isCleartextRpcAllowed(Network.TESTNET)).toBe(true);
      expect(isCleartextRpcAllowed(Network.STAGING)).toBe(true);
      expect(isCleartextRpcAllowed(Network.MAINNET)).toBe(false);
    });
  });

  describe('validateRpcUrls', () => {
    it('accepts secure URLs on any network', () => {
      expect(() =>
        validateRpcUrls('https://soroban.stellar.org', Network.MAINNET),
      ).not.toThrow();
      expect(() =>
        validateRpcUrls('wss://rpc.example.com', Network.MAINNET),
      ).not.toThrow();
      expect(() =>
        validateRpcUrls(['https://a.example.com', 'https://b.example.com'], Network.TESTNET),
      ).not.toThrow();
    });

    it('rejects cleartext http on mainnet', () => {
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.MAINNET),
      ).toThrow(ValidationError);
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.MAINNET),
      ).toThrow(/cleartext/i);
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.MAINNET),
      ).toThrow(/mainnet/i);
    });

    it('rejects cleartext ws on mainnet', () => {
      expect(() =>
        validateRpcUrls('ws://rpc.example.com', Network.MAINNET),
      ).toThrow(ValidationError);
    });

    it('allows cleartext http on dev/test networks', () => {
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.TESTNET),
      ).not.toThrow();
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.STAGING),
      ).not.toThrow();
    });

    it('rejects a mix containing a cleartext URL on mainnet', () => {
      expect(() =>
        validateRpcUrls(
          ['https://a.example.com', 'http://b.example.com'],
          Network.MAINNET,
        ),
      ).toThrow(ValidationError);
      expect(() =>
        validateRpcUrls(
          ['https://a.example.com', 'http://b.example.com'],
          Network.MAINNET,
        ),
      ).toThrow(/http:\/\/b\.example\.com/);
    });

    it('rejects malformed URLs', () => {
      expect(() =>
        validateRpcUrls('not-a-url', Network.TESTNET),
      ).toThrow(ValidationError);
      expect(() =>
        validateRpcUrls('not-a-url', Network.TESTNET),
      ).toThrow(/not a valid URL/);
    });

    it('rejects unsupported schemes', () => {
      expect(() =>
        validateRpcUrls('ftp://rpc.example.com', Network.TESTNET),
      ).toThrow(ValidationError);
      expect(() =>
        validateRpcUrls('ftp://rpc.example.com', Network.TESTNET),
      ).toThrow(/unsupported scheme/i);
    });

    it('includes the URL in the error details', () => {
      try {
        validateRpcUrls('http://localhost:8000', Network.MAINNET);
        throw new Error('expected to throw');
      } catch (err) {
        const ve = err as ValidationError;
        expect(ve.code).toBe('VALIDATION_ERROR');
        expect(ve.details?.url).toBe('http://localhost:8000');
        expect(ve.details?.scheme).toBe('http');
        expect(ve.details?.network).toBe(Network.MAINNET);
      }
    });

    it('uses a custom label in error messages', () => {
      expect(() =>
        validateRpcUrls('http://localhost:8000', Network.MAINNET, 'RPC endpoint'),
      ).toThrow(/RPC endpoint/);
    });
  });

  describe('scheme constants', () => {
    it('lists https and wss as secure', () => {
      expect(SECURE_RPC_SCHEMES).toEqual(['https', 'wss']);
    });

    it('lists every allowed scheme', () => {
      expect(ALLOWED_RPC_SCHEMES).toEqual(['http', 'https', 'ws', 'wss']);
    });
  });
});