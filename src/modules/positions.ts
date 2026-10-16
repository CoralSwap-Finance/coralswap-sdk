import { CoralSwapClient } from "@/client";
import { ValidationError } from "@/errors";
import {
  EnrichedLPPositionSchema,
  PositionMathSchema,
  PositionSummarySchema,
  validateWithSchema,
} from "@/schemas";
import {
  EnrichedLPPosition,
  GetPositionsOptions,
  PositionSummary,
} from "@/types/positions";
import { validateAddress } from "@/utils/validation";

/**
 * Positions module — tracks LP positions per address across CoralSwap pools.
 *
 * Builds on top of the raw LPPosition data from the LiquidityModule and
 * enriches each position with pool token addresses, reserves, and fee state.
 */
export class PositionsModule {
  private client: CoralSwapClient;
  private lpTokenCache: Map<string, string> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Get a single enriched LP position for an owner in a specific pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param owner - The wallet address to query
   * @returns Enriched LP position with token metadata and reserves
   * @throws {ValidationError} If the position read back from the chain is
   *   malformed (missing token addresses, a share outside 0..1, an
   *   out-of-range or non-integer fee, negative stroops, …) — the entry is
   *   validated against {@link EnrichedLPPositionSchema} before it is
   *   returned, so a bad read fails here instead of as a runtime shape error.
   * @example
   * const pos = await sdk.positions.getPosition('C...pair', 'G...wallet');
   */
  async getPosition(
    pairAddress: string,
    owner: string,
  ): Promise<EnrichedLPPosition> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");

    const pair = this.client.pair(pairAddress);

    const [reserves, tokens, feeState] = await Promise.all([
      pair.getReserves(),
      pair.getTokens(),
      pair.getFeeState().catch(() => null),
    ]);

    let lpTokenAddress = this.lpTokenCache.get(pairAddress);
    if (!lpTokenAddress) {
      lpTokenAddress = await pair.getLPTokenAddress();
      this.lpTokenCache.set(pairAddress, lpTokenAddress);
    }

    const lpClient = this.client.lpToken(lpTokenAddress);

    const [balance, totalSupply] = await Promise.all([
      lpClient.balance(owner),
      lpClient.totalSupply(),
    ]);

    // The BigInt math below throws a raw TypeError if any read came back as
    // a number/string, so the operands are validated first — a malformed
    // read is a ValidationError, not an untyped runtime shape error.
    const math = validateWithSchema(
      PositionMathSchema,
      { balance, totalSupply, reserve0: reserves.reserve0, reserve1: reserves.reserve1 },
      "position math",
    );

    const share =
      math.totalSupply > 0n
        ? Number((math.balance * 10000n) / math.totalSupply) / 10000
        : 0;

    const token0Amount =
      math.totalSupply > 0n ? (math.reserve0 * math.balance) / math.totalSupply : 0n;
    const token1Amount =
      math.totalSupply > 0n ? (math.reserve1 * math.balance) / math.totalSupply : 0n;

    return validateWithSchema(
      EnrichedLPPositionSchema,
      {
        pairAddress,
        lpTokenAddress,
        balance: math.balance,
        totalSupply: math.totalSupply,
        share,
        token0Amount,
        token1Amount,
        token0: tokens.token0,
        token1: tokens.token1,
        reserve0: math.reserve0,
        reserve1: math.reserve1,
        feeBps: feeState?.feeCurrent ?? 0,
      },
      "position",
    );
  }

  /**
   * Get all LP positions for an owner across multiple pairs.
   *
   * @param owner - The wallet address to query
   * @param options - Optional filters: includeEmpty, pairAddresses
   * @returns A PositionSummary with all matching positions
   * @throws {ValidationError} If any collected position or the summary
   *   itself fails schema validation (malformed chain data). Transient
   *   per-pair RPC failures are still skipped, so one unreachable pool
   *   does not fail the whole page.
   * @example
   * const summary = await sdk.positions.getPositions('G...wallet');
   * const summary = await sdk.positions.getPositions('G...wallet', { includeEmpty: true });
   * const summary = await sdk.positions.getPositions('G...wallet', { pairAddresses: ['C...'] });
   */
  async getPositions(
    owner: string,
    options: GetPositionsOptions = {},
  ): Promise<PositionSummary> {
    validateAddress(owner, "owner");

    const { includeEmpty = false, pairAddresses, limit, cursor } = options;
    const safeLimit = limit !== undefined ? Math.max(1, Math.floor(limit)) : undefined;

    const pairs =
      pairAddresses && pairAddresses.length > 0
        ? pairAddresses
        : await this.client.factory.getAllPairs();

    if (pairs.length === 0) {
      return validateWithSchema(
        PositionSummarySchema,
        {
          owner,
          totalPools: 0,
          positions: [],
          truncated: false,
          pageInfo: { limit: safeLimit, cursor, nextCursor: null, hasNextPage: false },
        },
        "position summary",
      );
    }

    const results = await Promise.allSettled(
      pairs.map((addr) => this.getPosition(addr, owner)),
    );

    const positions: EnrichedLPPosition[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        const pos = result.value;
        if (includeEmpty || pos.balance > 0n) {
          positions.push(pos);
        }
      } else if (result.reason instanceof ValidationError) {
        // A malformed position is a shape bug, not a transient per-pair
        // failure: surface it instead of silently dropping the pool.
        throw result.reason;
      }
    }

    const startIndex = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const pageStart = safeLimit === undefined ? 0 : startIndex;
    const pageEnd = safeLimit === undefined ? positions.length : pageStart + safeLimit;
    const page = safeLimit === undefined ? positions : positions.slice(pageStart, pageEnd);
    const truncated =
      safeLimit !== undefined &&
      positions.length > safeLimit &&
      pageStart < positions.length &&
      pageEnd < positions.length;
    const nextCursor = truncated ? String(pageEnd) : null;

    return validateWithSchema(
      PositionSummarySchema,
      {
        owner,
        totalPools: positions.length,
        positions: page,
        truncated,
        pageInfo: {
          limit: safeLimit,
          cursor: cursor ?? undefined,
          nextCursor,
          hasNextPage: truncated,
          hasMore: truncated,
        },
      },
      "position summary",
    );
  }

  /**
   * Check whether an address holds any LP tokens in a given pair.
   *
   * @param pairAddress - The pair contract address
   * @param owner - The wallet address to check
   * @returns true if the owner has a non-zero LP balance
   */
  async hasPosition(pairAddress: string, owner: string): Promise<boolean> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(owner, "owner");

    let lpTokenAddress = this.lpTokenCache.get(pairAddress);
    if (!lpTokenAddress) {
      const pair = this.client.pair(pairAddress);
      lpTokenAddress = await pair.getLPTokenAddress();
      this.lpTokenCache.set(pairAddress, lpTokenAddress);
    }

    const lpClient = this.client.lpToken(lpTokenAddress);
    const balance = await lpClient.balance(owner);
    return balance > 0n;
  }
}