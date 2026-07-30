/**
 * Shared Zod schema patterns for SDK module input validation.
 *
 * # Convention
 *
 * Each module that accepts user-supplied parameters SHOULD define a
 * `schemas.ts` file alongside the module source (e.g.
 * `src/modules/stop-loss/schemas.ts`) OR add its schemas to this
 * directory as `src/schemas/<module-name>.ts`.
 *
 * # Helper
 *
 * {@link validateWithSchema} is the single entry point for running input
 * through a Zod schema.  It always surfaces failures as the SDK's own
 * {@link ValidationError}, keeping error handling consistent for callers.
 *
 * @example
 * ```ts
 * // Inside a module method:
 * import { validateWithSchema } from '@/schemas/helpers';
 * import { z } from 'zod';
 *
 * const MySchema = z.object({
 *   address: z.string().min(1, 'Address must not be empty'),
 *   amount: z.bigint().positive('Amount must be > 0'),
 * });
 *
 * function myMethod(params: unknown) {
 *   const validated = validateWithSchema(MySchema, params, 'myMethod.params');
 *   // validated is now strongly typed as { address: string; amount: bigint }
 * }
 * ```
 */

export { validateWithSchema } from './helpers';
export * from './order-book';
