import { z } from 'zod';
import { xdr, nativeToScVal, Address } from '@stellar/stellar-sdk';
import { Contract } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import { Network } from '@/types/common';
import { Token, TokenList } from '@/types/tokens';
import { NetworkError, ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';

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

/**
 * Result of building a token approve operation.
 */
export interface ApproveOperation {
  /** The XDR operation to include in a transaction. */
  op: xdr.Operation;
  /** The token contract address that was approved. */
  tokenAddress: string;
  /** The spender address that received approval. */
  spender: string;
  /** The approved amount (in token's smallest unit). */
  amount: bigint;
  /** The ledger number at which this approval expires. */
  expirationLedger: number;
}

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
        .map((i: z.ZodIssue) => `${i.path.join('.')}: ${i.message}`)
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

  /**
   * Filter tokens by a specific tag.
   *
   * @param tokens - Token array to filter.
   * @param tag - The tag to look for (e.g. "stablecoin").
   * @returns Tokens containing the specified tag.
   */
  filterByTag(tokens: Token[], tag: string): Token[] {
    return tokens.filter((t) => t.tags?.includes(tag));
  }

  /**
   * Filter tokens that match ALL specified tags.
   *
   * @param tokens - Token array to filter.
   * @param tags - List of tags that must all be present.
   * @returns Tokens containing all the specified tags.
   */
  filterByTags(tokens: Token[], tags: string[]): Token[] {
    return tokens.filter((t) => tags.every((tag) => t.tags?.includes(tag)));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a scoped token approve (allowance) operation per SEP-41.
   *
   * Constructs a Soroban contract invocation that calls the `approve` function
   * on the specified token contract, granting `spender` permission to transfer
   * up to `amount` tokens on the caller's behalf until `expirationLedger`.
   *
   * **Security note:** The allowance is scoped to the exact `amount` provided,
   * NOT an unlimited/max value. This prevents the well-known "unlimited
   * approval" wallet-drain pattern. If you intentionally need a larger or
   * unlimited allowance, pass the desired amount explicitly.
   *
   * @param tokenAddress - The Soroban contract address of the token.
   * @param spender - The address that will be allowed to spend the tokens.
   * @param amount - The exact amount to approve (in the token's smallest unit).
   *   Defaults to an operation-scoped amount — never an unlimited value.
   * @param expirationLedger - The ledger sequence number after which this
   *   approval expires. Defaults to 0 (no expiration). For SEP-41 tokens,
   *   the contract enforces this expiry.
   * @returns An {@link ApproveOperation} containing the XDR operation and metadata.
   * @throws {ValidationError} If any address is invalid, amount is negative, or
   *   `expirationLedger` is negative.
   *
   * @example
   * ```ts
   * const tokens = client.tokens();
   * const { op } = tokens.buildApprove(
   *   'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', // token
   *   'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',   // spender (router)
   *   1000_000_000n,                                                   // 1000 USDC (7 decimals)
   *   123456,                                                          // expiration ledger
   * );
   * // Include `op` in a TransactionBuilder with other operations
   * ```
   *
   * @example
   * ```ts
   * // Approve before a swap
   * const approve = tokens.buildApprove(tokenIn, routerAddress, amountIn, expiryLedger);
   * const swap = client.swap.execute({ ... });
   * ```
   */
  buildApprove(
    tokenAddress: string,
    spender: string,
    amount: bigint,
    expirationLedger: number = 0,
  ): ApproveOperation {
    validateAddress(tokenAddress, 'tokenAddress');
    validateAddress(spender, 'spender');
    if (amount < 0n) {
      throw new ValidationError('amount must be non-negative', { amount: amount.toString() });
    }
    if (expirationLedger < 0) {
      throw new ValidationError('expirationLedger must be non-negative', { expirationLedger });
    }

    const contract = new Contract(tokenAddress);
    const op = contract.call(
      'approve',
      nativeToScVal(Address.fromString(spender), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
      nativeToScVal(expirationLedger, { type: 'u32' }),
    );

    return {
      op,
      tokenAddress,
      spender,
      amount,
      expirationLedger,
    };
  }

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
