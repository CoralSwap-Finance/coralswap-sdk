import {
  CoralSwapSDKError,
  NetworkError,
  SlippageError,
  DeadlineError,
  PairNotFoundError,
  mapError,
} from '../src/errors';

describe('Error Hierarchy', () => {
  it('CoralSwapSDKError is instanceof Error', () => {
    const err = new CoralSwapSDKError('TEST', 'test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CoralSwapSDKError);
    expect(err.code).toBe('TEST');
  });

  it('NetworkError carries code', () => {
    const err = new NetworkError('connection lost');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.name).toBe('NetworkError');
  });

  it('SlippageError includes amounts', () => {
    const err = new SlippageError(100n, 90n, 50);
    expect(err.code).toBe('SLIPPAGE_EXCEEDED');
    expect(err.details?.toleranceBps).toBe(50);
  });

  it('DeadlineError includes timestamp', () => {
    const err = new DeadlineError(1234567890);
    expect(err.code).toBe('DEADLINE_EXCEEDED');
    expect(err.details?.deadline).toBe(1234567890);
  });

  it('PairNotFoundError includes tokens', () => {
    const err = new PairNotFoundError('TOKEN_A', 'TOKEN_B');
    expect(err.code).toBe('PAIR_NOT_FOUND');
    expect(err.details?.tokenA).toBe('TOKEN_A');
  });

  describe('mapError', () => {
    it('passes through SDK errors', () => {
      const original = new NetworkError('test');
      expect(mapError(original)).toBe(original);
    });

    it('maps deadline strings', () => {
      const err = mapError(new Error('Transaction EXPIRED'));
      expect(err.code).toBe('DEADLINE_EXCEEDED');
    });

    it('maps network errors', () => {
      const err = mapError(new Error('ECONNRESET'));
      expect(err.code).toBe('NETWORK_ERROR');
    });

    it('maps unknown errors', () => {
      const err = mapError('some string error');
      expect(err.code).toBe('UNKNOWN_ERROR');
    });
  });
});
