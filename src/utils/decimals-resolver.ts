/**
 * LRU-bounded token-decimals resolver with optional TTL.
 *
 * ## Problem
 * A plain `Map<string, number>` used as a decimals cache grows without bound
 * when the SDK is used for multi-pair scans (leaderboard queries, portfolio
 * sweeps, etc.). On a chain with thousands of registered tokens the cache can
 * hold millions of entries for the lifetime of a Node process, leaking memory
 * indefinitely.
 *
 * ## Solution
 * `DecimalsResolver` implements an LRU (Least-Recently-Used) eviction policy
 * with a configurable capacity cap.  An optional per-entry TTL lets callers
 * opt in to time-bounded staleness so a token that changed its decimal
 * precision on-chain is eventually re-fetched.
 *
 * ### Complexity
 * | Operation | Time |
 * |-----------|------|
 * | get       | O(1) |
 * | set       | O(1) |
 * | eviction  | O(1) |
 *
 * The implementation uses a doubly-linked list + `Map` — the canonical O(1)
 * LRU design — avoiding any external runtime dependency.
 *
 * @module utils/decimals-resolver
 */

import type { CoralSwapClient } from "@/client";

/** Default maximum number of token addresses to keep in the cache. */
export const DEFAULT_DECIMALS_CACHE_CAPACITY = 512;

/** Sentinel value: TTL disabled (entries never expire by time). */
export const TTL_DISABLED = 0;

/** A single node in the doubly-linked list that backs the LRU eviction order. */
interface LruNode {
  key: string;
  value: number;
  /** Absolute timestamp (ms) after which this entry is stale, or 0 = no expiry. */
  expiresAt: number;
  prev: LruNode | null;
  next: LruNode | null;
}

/**
 * Options accepted by the {@link DecimalsResolver} constructor.
 */
export interface DecimalsResolverOptions {
  /**
   * Maximum number of token addresses whose decimal counts are kept in memory.
   * When the limit is exceeded the least-recently-used entry is evicted.
   * Defaults to {@link DEFAULT_DECIMALS_CACHE_CAPACITY} (512).
   */
  capacity?: number;

  /**
   * Per-entry time-to-live in milliseconds.  After this duration a cached
   * entry is considered stale and the next lookup triggers a fresh on-chain
   * fetch.  Set to `0` (the default) to disable TTL: entries live until
   * they are evicted by the LRU policy.
   */
  ttlMs?: number;
}

/**
 * LRU-bounded cache for token decimal counts.
 *
 * Entries are evicted in least-recently-used order once the cache reaches
 * its capacity.  An optional TTL evicts stale entries on read.
 *
 * @example
 * ```ts
 * const resolver = new DecimalsResolver({ capacity: 256, ttlMs: 60_000 });
 *
 * // Inside an async function that has access to a CoralSwapClient:
 * const decimals = await resolver.resolve(client, tokenAddress);
 * ```
 */
export class DecimalsResolver {
  private readonly capacity: number;
  private readonly ttlMs: number;

  /** Fast O(1) address → node lookup. */
  private readonly map: Map<string, LruNode> = new Map();

  /**
   * Sentinel head of the doubly-linked list.
   * The node just after `head` is the most-recently used entry.
   */
  private readonly head: LruNode;

  /**
   * Sentinel tail of the doubly-linked list.
   * The node just before `tail` is the least-recently used entry.
   */
  private readonly tail: LruNode;

  constructor(options: DecimalsResolverOptions = {}) {
    const cap = options.capacity ?? DEFAULT_DECIMALS_CACHE_CAPACITY;
    if (!Number.isInteger(cap) || cap < 1) {
      throw new RangeError(
        `DecimalsResolver: capacity must be a positive integer, got ${cap}`,
      );
    }
    const ttl = options.ttlMs ?? TTL_DISABLED;
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new RangeError(
        `DecimalsResolver: ttlMs must be a non-negative integer, got ${ttl}`,
      );
    }

    this.capacity = cap;
    this.ttlMs = ttl;

    // Build the sentinel nodes; they never hold real data.
    this.head = { key: "", value: 0, expiresAt: 0, prev: null, next: null };
    this.tail = { key: "", value: 0, expiresAt: 0, prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Resolve the decimal count for `address`.
   *
   * Returns the cached value when it is still valid.  On a cache miss (or
   * TTL expiry) the method fetches fresh metadata from the chain via
   * `client.lpToken(address).metadata()` and stores the result.
   *
   * Falls back to `7` (Stellar-standard precision) when the on-chain call
   * fails, mirroring the original leaderboard behaviour.
   *
   * @param client  - A live {@link CoralSwapClient} instance used for on-chain
   *                  metadata fetches.
   * @param address - The Stellar/Soroban contract address of the token.
   * @returns The token's decimal precision (e.g. `7`).
   */
  async resolve(client: CoralSwapClient, address: string): Promise<number> {
    const cached = this.get(address);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const meta = await client.lpToken(address).metadata();
      this.set(address, meta.decimals);
      return meta.decimals;
    } catch {
      // Standard Soroban fallback — do NOT cache the fallback so that a
      // transient RPC error does not permanently poison the entry.
      return 7;
    }
  }

  /**
   * Current number of entries stored in the cache (excluding expired entries
   * that have not yet been evicted by a read).
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Maximum number of entries the cache can hold before eviction occurs.
   */
  get maxCapacity(): number {
    return this.capacity;
  }

  /**
   * Remove all entries from the cache, resetting it to the empty state.
   * Useful for testing or after a network switch.
   */
  clear(): void {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  // ---------------------------------------------------------------------------
  // Internal LRU mechanics
  // ---------------------------------------------------------------------------

  /**
   * Look up `key`.  Returns the stored decimal count when the entry exists
   * and has not expired, or `undefined` otherwise.
   *
   * On a hit the accessed node is moved to the most-recently-used position.
   * On an expired hit the stale node is removed.
   */
  private get(key: string): number | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;

    // TTL check: treat expired entries as a miss.
    if (node.expiresAt !== 0 && Date.now() >= node.expiresAt) {
      this.removeNode(node);
      this.map.delete(key);
      return undefined;
    }

    // Promote to MRU position.
    this.removeNode(node);
    this.insertAfterHead(node);
    return node.value;
  }

  /**
   * Store `key → value`.
   *
   * If the key already exists its value is updated and it is promoted to MRU.
   * If adding the entry would exceed capacity the LRU entry (the node just
   * before the tail sentinel) is evicted first.
   */
  private set(key: string, value: number): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = this.ttlMs > 0 ? Date.now() + this.ttlMs : 0;
      this.removeNode(existing);
      this.insertAfterHead(existing);
      return;
    }

    // Evict LRU entry when at capacity.
    if (this.map.size >= this.capacity) {
      const lru = this.tail.prev!;
      // Guard against the pathological case where capacity=1 and the list only
      // contains the two sentinel nodes (should never happen in practice).
      if (lru !== this.head) {
        this.removeNode(lru);
        this.map.delete(lru.key);
      }
    }

    const node: LruNode = {
      key,
      value,
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0,
      prev: null,
      next: null,
    };
    this.map.set(key, node);
    this.insertAfterHead(node);
  }

  /** Splice `node` out of the list without touching `this.map`. */
  private removeNode(node: LruNode): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  /** Insert `node` immediately after the head sentinel (= MRU position). */
  private insertAfterHead(node: LruNode): void {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next!.prev = node;
    this.head.next = node;
  }
}
