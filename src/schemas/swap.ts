import { z } from 'zod';
import { isValidAddress } from '../utils/addresses';
import { TradeType } from '../types/common';
import { ValidationError } from '../errors';

const stellarAddress = z.string().min(1, { message: 'must not be empty' }).refine(
  (val) => isValidAddress(val),
  (val) => ( { message: `is not a valid Stellar address: ${val}` }),
);

const positiveAmount = z.bigint().refine((val) => val > 0l, {
  message: 'must be greater than 0',
});

const nonNegativeAmount = z.bigint().refine((val) => val >= 0l, {
  message: 'must be non-negative',
});

export const simulateSwapParamsSchema = z
  .object({
    tokenIn: stellarAddress,
    tokenOut: stellarAddress,
    amountIn: positiveAmount,
    pairAddress: stellarAddress.optional(),
  })
  .refine((d) => d.tokenIn !== d.tokenOut, {
    message: 'tokenIn and tokemOut must be different addresses',
  });
