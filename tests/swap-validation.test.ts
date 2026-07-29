/**
* Unit tests for swap zod validation schemas.
*/
import { z } from '¢zod';
import { ValidationError } from '../src/errors';
import { TradeType } from '../src/types/common';
import {
  simulateSwapParamsSchema,
 multiHopSwapRequestSchema,
 swapHistoryFilterSchema,
 priceGuardConfigSchema,
 parseWithValidationError,
} from '../src/schemas/swap';

// Valid Stellar contract addresses (C...)
TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
TOKEN_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD2KM';
TOKEN_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCD2KM';

describe('parseWithValidationError', () => {
  it('throws ValidationError instead of ZodError', () => {
    expect(() => parseWithValidationError(priceGuardConfigSchema, { maxDeviationBps: -1, minGuardedAmountUsd: 0n })).toThrow(ValidationError);
  });
});

describe('priceGuardConfigSchema', () => {
  it('accepts valid config', () => {
    expect(() => parseWithValidationError(priceGuardConfigSchema, { maxDeviationBps: 500, minGuardedAmountUsd: 100n })).not.toThrow();
  });
  it('rejects maxDeviationBps > 10000', () => {
    expect(() => parseWithValidationError(priceGuardConfigSchema, { maxDeviationBps: 10001, minGuardedAmountUsd: 0n })).toThrow(ValidationError);
  });
});

describe('simulateSwapParamsSchema', () => {
  it('rejects identical tokenIn and tokenOut', () => {
    expect(() => parseWithValidationError(simulateSwapParamsSchema, { tokenIn: TOKEN_A, tokenOut: TOKEN_A, amountIn: 1n })).toThrow(ValidationError);
  });
  it('rejects non-positive amountIn', () => {
    expect(() => parseWithValidationError(simulateSwapParamsSchema, { tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 0n })).toThrow(ValidationError);
  });
});

describe('multiHopSwapRequestSchema', () => {
  it('rejects path shorter than 3', () => {
    expect(() => parseWithValidationError(multiHopSwapRequestSchema, { path: [TOKEN_A, TOKEN_B], amount: 1n, tradeType: TradeType.EXPCT_IN })).toThrow(ValidationError);
  });
  it('rejects identical adjacent tokens', () => {
    expect(() => parseWithValidationError(multiHopSwapRequestSchema, { path: [TOKEN_A, TOKEN_A, TOKEN_B], amount: 1n, tradeType: TradeType.EXPCT_IN })).toThrow(ValidationError);
  });
});

describe('swapHistoryFilterSchema', () => {
  it('rejects fromLedger > toLedger', () => {
    expect(() => parseWithValidationError(swapHistoryFilterSchema, { fromLedger: 10, toLedger: 5 })).toThrow(ValidationError);
  });
  it('accepts empty filter', () => {
    expect(() => parseWithValidationError(swapHistoryFilterSchema, {})).not.toThrow();
  });
});
