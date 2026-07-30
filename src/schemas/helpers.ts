import { z } from 'zod';
import { ValidationError } from '@/errors';

/**
 * Validate a value against a Zod schema and surface failures as the SDK's
 * own {@link ValidationError} (not Zod's native `ZodError`), so caller-side
 * error handling stays consistent.
 *
 * @param schema - A Zod schema to validate against.
 * @param value - The value (typically user-supplied input) to check.
 * @param label - Human-readable parameter or object name used in error messages.
 * @returns The typed and (if applicable) transformed output from the schema.
 * @throws {ValidationError} With a message at least as clear as the SDK's
 *   hand-rolled validation guards.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { validateWithSchema } from '@/schemas/helpers';
 *
 * const AddressSchema = z.string().min(1, 'Address must not be empty');
 * const addr = validateWithSchema(AddressSchema, someInput, 'tokenIn');
 * ```
 */
export function validateWithSchema<T>(
  schema: z.ZodSchema<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: z.ZodIssue) => {
        const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
        return `${path}${i.message}`;
      })
      .join('; ');

    throw new ValidationError(`Invalid ${label}: ${issues}`, {
      zodErrors: result.error.issues,
    });
  }
  return result.data;
}
