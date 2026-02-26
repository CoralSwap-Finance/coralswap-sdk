/**
 * Test helper utilities for the CoralSwap SDK test suite.
 */

/**
 * Return a shuffled copy of a valid token path.
 *
 * Uses Fisher-Yates shuffle and does not mutate the original array.
 * If a `random` function is provided, it is used instead of `Math.random`
 * to enable deterministic shuffles in tests.
 */
export function shufflePath<T>(path: readonly T[], random: () => number = Math.random): T[] {
  const result = [...path];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }

  return result;
}


