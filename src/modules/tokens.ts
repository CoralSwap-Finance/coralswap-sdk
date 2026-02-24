import { z } from 'zod';
import { CoralSwapClient } from '../client';
import { Network } from '../types/common';
import { Token, TokenList } from '../types/tokens';
import { NetworkError, ValidationError } from '../errors';

// ---------------------------------------------------------------------------
// Zod schemas — validates token list JSON against Stellar token list standard
// ---------------------------------------------------------------------------

const NetworkSchema = z.nativeEnum(Network);

const TokenSchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().nonnegative().max(18),
  network: NetworkSchema,
  logoURI: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
});

const TokenListVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
});

const TokenListSchema = z.object({
  name: z.string().min(1),
  version: TokenListVersionSchema,
  timestamp: z.string().optional(),
  tokens: z.array(TokenSchema),
});

// ---------------------------------------------------------------------------
// TokenListModule
// ---------------------------------------------------------------------------

/**
 * Helper module for fetching, validating and filtering Stellar token lists.
 *
 * Token lists follow a JSON schema similar to the Uniswap Token List standard
 * adapted for Stellar/Soroban, with network-aware filtering (Mainnet/Testnet).
 *
 * @example
 * ```ts
 * const tokens = client.tokens();
 * const list = await tokens.fetch('https://example.com/tokenlist.json');
 * console.log(list.tokens); // Token[] filtered to current network
 * ```
 */
export class TokenListModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Fetch a token list from a URL, validate the schema, and return only
   * the tokens matching the client's current network.
   *
   * @param url - URL pointing to a token list JSON.
   * @returns A validated TokenList with tokens filtered by network.
   * @throws {NetworkError} If the fetch request fails.
   * @throws {ValidationError} If the JSON does not match the expected schema.
   */
  async fetch(url: string): Promise<TokenList> {
    const raw = await this.fetchJson(url);
    const list = this.validate(raw);
    return {
      ...list,
      tokens: this.filterByNetwork(list.tokens, this.client.network),
    };
  }

  /**
   * Fetch a token list and return all tokens without network filtering.
   *
   * @param url - URL pointing to a token list JSON.
   * @returns A validated TokenList containing tokens for all networks.
   */
  async fetchAll(url: string): Promise<TokenList> {
    const raw = await this.fetchJson(url);
    return this.validate(raw);
  }

  /**
   * Validate raw JSON data against the token list Zod schema.
   *
   * @param data - Parsed JSON object to validate.
   * @returns A typed TokenList.
   * @throws {ValidationError} If the schema check fails.
   */
  validate(data: unknown): TokenList {
    const result = TokenListSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ValidationError(`Invalid token list schema: ${issues}`, {
        zodErrors: result.error.issues,
      });
    }
    return result.data;
  }

  /**
   * Filter a token array to only include entries matching a given network.
   *
   * @param tokens - Full token array.
   * @param network - Target network to filter by.
   * @returns Tokens belonging to the specified network.
   */
  filterByNetwork(tokens: Token[], network: Network): Token[] {
    return tokens.filter((t) => t.network === network);
  }

  /**
   * Search tokens by symbol or name (case-insensitive).
   *
   * @param tokens - Token array to search.
   * @param query - Search string to match against symbol or name.
   * @returns Matching tokens.
   */
  search(tokens: Token[], query: string): Token[] {
    const q = query.toLowerCase();
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q),
    );
  }

  /**
   * Find a single token by its contract address.
   *
   * @param tokens - Token array to search.
   * @param address - Contract address or asset identifier.
   * @returns The matching token, or undefined.
   */
  findByAddress(tokens: Token[], address: string): Token | undefined {
    return tokens.find((t) => t.address === address);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Perform a GET request and parse the response as JSON.
   */
  private async fetchJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new NetworkError(
        `Failed to fetch token list from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { url },
      );
    }

    if (!response.ok) {
      throw new NetworkError(
        `Token list request failed with HTTP ${response.status}`,
        { url, status: response.status },
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ValidationError('Token list response is not valid JSON', {
        url,
      });
    }
  }
}
