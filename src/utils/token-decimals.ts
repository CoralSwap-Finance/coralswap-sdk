import type { CoralSwapClient } from "@/client";

/**
 * Decimals assumed when a token's on-chain metadata cannot be read.
 *
 * Matches the Soroban / XLM default so an unreadable token degrades to the
 * historical 7-decimal behaviour instead of failing a whole aggregation.
 */
export const FALLBACK_TOKEN_DECIMALS = 7;

/**
 * Decimals cache, keyed by token address.
 *
 * `decimals` is immutable for a given token contract, so an aggregation over
 * N events pays for exactly one metadata read per distinct token.
 */
const decimalsCache = new Map<string, number>();

/**
 * Read a SEP-41 token's `decimals` from on-chain metadata.
 *
 * Used wherever a raw stroop amount has to be rendered in human units:
 * fees/revenue and LP-yield math must divide by `10 ** decimals` of the token
 * the amount is denominated in, not by a hardcoded `1e7`.
 *
 * @param client - SDK client used to reach the token contract.
 * @param address - Token (or LP token) contract address.
 * @returns The token's decimals, or {@link FALLBACK_TOKEN_DECIMALS} when the
 *   metadata read fails.
 *
 * @example
 * ```ts
 * const decimals = await getTokenDecimals(client, tokenAddress);
 * const human = Number(feeStroops) / 10 ** decimals;
 * ```
 */
export async function getTokenDecimals(
  client: CoralSwapClient,
  address: string,
): Promise<number> {
  const cached = decimalsCache.get(address);
  if (cached !== undefined) return cached;

  try {
    const meta = await client.lpToken(address).metadata();
    decimalsCache.set(address, meta.decimals);
    return meta.decimals;
  } catch {
    return FALLBACK_TOKEN_DECIMALS;
  }
}

/** Drop cached metadata. Intended for tests that re-point a token address. */
export function clearTokenDecimalsCache(): void {
  decimalsCache.clear();
}
