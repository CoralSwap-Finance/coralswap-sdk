import { z } from 'zod';
import { isValidAddress } from '../utils/addresses';
import { TradeType } from '../types/common';
import { ValidationError } from '../errors';

const stellarAddress = z.string().min(1, { message: 'must not be empty' }).superRefine(
  (val, ctx) => {
    if (!isValidAddress(val)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `is not a valid Stellar address: ${val}` });
    }
  },
);

const positiveAmount = z.bigint().refine((val) => val > 0n, {
  message: 'must be greater than 0',
});

export const simulateSwapParamsSchema = z
  .object({
    tokenIn: stellarAddress,
    tokenOut: stellarAddress,
    amountIn: positiveAmount,
    pairAddress: stellarAddress.optional(),
  })
  .refine((d) => d.tokenIn !== d.tokenOut, {
    message: 'tokenIn and tokenOut must be different addresses',
  });

export const multiHopSwapRequestSchema = z.object({
  path: z.array(stellarAddress).min(3, { message: 'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens' }).refine((path) => { for (let i = 0; i < path.length - 1; i++) { if (path[i] === path[i + 1]) return false; } return true; }, { message: 'Multi-hop path must contain at least 3 tokens with no identical adjacent tokens' }),
  amount: positiveAmount,
  tradeType: z.nativeEnum(TradeType),
  slippageBps: z.number().int().min(0).max(5000).optional(),
  deadline: z.number().int().positive().optional(),
  to: stellarAddress.optional(),
});

export const swapHistoryFilterSchema = z
  .object({
    pairAddress: stellarAddress.optional(),
    userAddress: stellarAddress.optional(),
    fromLedger: z.number().int().nonnegative().optional(),
    toLedger: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.fromLedger !== undefined && d.toLedger !== undefined && d.fromLedger > d.toLedger) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fromLedger (${d.fromLedger}) must not be greater than toLedger (${d.toLedger})` });
    }
  });

export const priceGuardConfigSchema = z.object({
  maxDeviationBps: z.number().int().min(0).max(10000, { message: 'maxDeviationBps must be between 0 and 10000' }),
  minGuardedAmountUsd: z.bigint(),
});

export function parseWithValidationError<T>(
  schema: z.ZodType<T>,
  data: unknown,
  paramNames?: Record<string, string>,
): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.issues.map((issue) => {
        const pathStr = issue.path.join('.');
        const name = (paramNames && pathStr && paramNames[pathStr]) || pathStr;
        if (name) { return `${name} ${issue.message}`; }
        return issue.message;
      });
      throw new ValidationError(messages.join('; '), {
        zodIssues: err.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    throw err;
  }
}
