import { z } from 'zod';

/**
 * Zod schemas for the LP position entries produced by {@link PositionsModule}.
 *
 * Position entries are assembled from several independent RPC reads
 * (reserves, tokens, fee state, LP balance/supply). A decode that silently
 * yields `undefined`, a `NaN` share or an out-of-range fee used to surface
 * later as an untyped `TypeError` — or as a plausible-looking but wrong
 * object. These schemas run at the module boundary so a malformed read
 * fails fast as a {@link ValidationError} instead.
 *
 * ## What is and is not checked
 *
 * - **Shape and numeric ranges**: required keys, `bigint` vs `number`,
 *   `share ∈ [0, 1]`, `feeBps ∈ [0, 10000]`, non-negative amounts.
 * - **Address checksums**: intentionally *not* re-checked here. Inputs are
 *   already guarded by `validateAddress()` (StrKey checksum), and entry
 *   addresses come back from the chain as decoded strkeys. This schema
 *   only requires them to be non-empty strings.
 *
 * @example
 * ```ts
 * import { validateWithSchema } from '@/schemas';
 * import { EnrichedLPPositionSchema } from '@/schemas/positions';
 *
 * const entry = validateWithSchema(EnrichedLPPositionSchema, raw, 'position');
 * ```
 */

/** Any address-bearing field: a non-empty string (checksums handled by `validateAddress`). */
const addressField = (label: string) =>
  z.string().min(1, `${label} must not be empty`);

/** Whole, non-negative stroop amount. */
const stroopsField = (label: string) =>
  z.bigint().nonnegative(`${label} must be >= 0`);

/**
 * Operands of the BigInt position math (`share`, `token0Amount`,
 * `token1Amount`).
 *
 * Validated *before* the arithmetic: mixing a non-`bigint` read into
 * `reserve0 * balance` throws a raw `TypeError`, which is exactly the
 * untyped shape error these schemas exist to prevent.
 */
export const PositionMathSchema = z.object({
  balance: stroopsField('balance'),
  totalSupply: stroopsField('totalSupply'),
  reserve0: stroopsField('reserve0'),
  reserve1: stroopsField('reserve1'),
});

/**
 * One enriched LP position: the raw LP holding plus the pool state it was
 * measured against.
 */
export const EnrichedLPPositionSchema = z.object({
  pairAddress: addressField('pairAddress'),
  lpTokenAddress: addressField('lpTokenAddress'),
  token0: addressField('token0'),
  token1: addressField('token1'),
  balance: stroopsField('balance'),
  totalSupply: stroopsField('totalSupply'),
  share: z
    .number()
    .min(0, 'share must be >= 0')
    .max(1, 'share must be <= 1'),
  token0Amount: stroopsField('token0Amount'),
  token1Amount: stroopsField('token1Amount'),
  reserve0: stroopsField('reserve0'),
  reserve1: stroopsField('reserve1'),
  feeBps: z
    .number()
    .int('feeBps must be an integer')
    .min(0, 'feeBps must be >= 0')
    .max(10000, 'feeBps must be <= 10000'),
  token0Symbol: z.string().optional(),
  token1Symbol: z.string().optional(),
});

/** Cursor metadata attached to a position page. */
const PositionPageInfoSchema = z.object({
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
  nextCursor: z.string().nullable().optional(),
  hasNextPage: z.boolean().optional(),
  hasMore: z.boolean().optional(),
});

/**
 * The paged summary returned by `getPositions()`: owner, the validated
 * entries, and pagination state.
 */
export const PositionSummarySchema = z.object({
  owner: addressField('owner'),
  totalPools: z.number().int().min(0, 'totalPools must be >= 0'),
  positions: z.array(EnrichedLPPositionSchema),
  truncated: z.boolean().optional(),
  pageInfo: PositionPageInfoSchema.optional(),
});
