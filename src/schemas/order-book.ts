/**
 * Worked example: Zod schemas for the order-book module.
 *
 * This file demonstrates the shared convention documented in `src/schemas/index.ts`.
 * It replaces the ad-hoc validation patterns found elsewhere in the codebase
 * with declarative Zod schemas that produce consistent {@link ValidationError}s.
 *
 * ## Pattern
 *
 * 1. Define a Zod schema for each public method's parameter object.
 * 2. Export schemas from this file.
 * 3. Use {@link validateWithSchema} inside the module method.
 *
 * @see src/schemas/index.ts for the full convention guide.
 */

import { z } from 'zod';

/**
 * Zod schema for the `address` parameter accepted by all order-book
 * query methods (e.g. `getOpenOrders`, `getOrderSummary`).
 *
 * Replaces the hand-rolled {@link validateAddress} guard.
 */
export const OrderBookAddressSchema = z
  .string()
  .min(1, 'Address must not be empty')
  .refine(
    (addr) => /^[GC][A-Z0-9]{55}$/.test(addr),
    (addr) => ({ message: `Address is not a valid Stellar address: ${addr}` }),
  );

/**
 * Zod schema for the optional `TradeFilter` parameter of `getTradeHistory`.
 */
export const TradeFilterSchema = z.object({
  types: z
    .array(
      z.enum([
        'swap',
        'limit-fill',
        'dca-execution',
        'stop-loss-trigger',
      ]),
    )
    .optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * Zod schema for the `address` parameter of `getOpenOrders`.
 */
export const GetOpenOrdersSchema = z.object({
  address: OrderBookAddressSchema,
});

/**
 * Zod schema for the parameters of `getOrderSummary`.
 */
export const GetOrderSummarySchema = z.object({
  address: OrderBookAddressSchema,
});
