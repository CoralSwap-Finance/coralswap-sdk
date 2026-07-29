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

export const multiHopSwapRequestSchema = z.object({
  path: z.array(stellarAddress).min(3, { message: 'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens' }).refine((path) => { for (let i = 0; i < path.length - 1; i++) { if (path[i] === path[i + 1]) return false; } return true; }, { message: 'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens' }),
  amount: positiveAmount,
  tradeType: z.nativeEnum(TradeType),
  slippageBps: z.number().int().min(0).max(5000).optional(),
  deadline: z.number().int().positive().optional(),
  to: stellarAddress.optional(),
});
