import { Address, type rpc } from "@stellar/stellar-sdk";
import type { CoralSwapClient } from "@/client";
import { EventCursor, decodeEventTopic } from "./event-cursor";
import { MAX_FILTERED_CONTRACT_IDS } from "./event-filters";

/** Symbol names used by factory deployments for new-pair notifications. */
export const NEW_PAIR_TOPICS = [
  "pair_created",
  "new_pair",
  "pair_added",
  "create_pair",
] as const;

/** Deliberately loose: fixtures and RPC adapters may use non-StrKey IDs. */
const CONTRACT_ID_PATTERN = /^C[A-Za-z0-9]{10,}$/;
const DEFAULT_REGISTRY_TTL_MS = 60_000;
const MAX_CACHED_WINDOW_LOOKUPS = 16;

/** One registry per client so history, leaderboard and tax reports share it. */
const registriesByClient = new WeakMap<CoralSwapClient, RegisteredPairRegistry>();

export interface RegisteredPairRegistryOptions {
  /** How long a factory pair list is trusted before re-reading it. */
  ttlMs?: number;
  /** Maximum number of raw events pulled per new-pair event scan page. */
  pageLimit?: number;
}

/**
 * Shared trust boundary for event-derived reports.
 *
 * The authoritative pair list comes from {@link CoralSwapClient.factoryModule}
 * (which caches `factory.getAllPairs()`); addresses are additionally refreshed
 * from factory new-pair events in the report's ledger window, so a pair whose
 * event predates a stale cache is still recognised. Every report must pass its
 * events through {@link isTrustedContractEvent} (or filter with
 * {@link filterTrustedEvents}) before producing output.
 */
export class RegisteredPairRegistry {
  private readonly client: CoralSwapClient;
  private readonly ttlMs: number;
  private readonly pageLimit: number;
  private cache: { pairs: Set<string>; expiresAt: number } | null = null;
  private pending: Promise<Set<string>> | null = null;
  private readonly windowLookups = new Map<string, Promise<Set<string>>>();

  constructor(client: CoralSwapClient, options: RegisteredPairRegistryOptions = {}) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_TTL_MS;
    this.pageLimit = options.pageLimit ?? 200;
  }

  /** Shared registry for a client; reports must use this instead of `new`. */
  static forClient(client: CoralSwapClient): RegisteredPairRegistry {
    let registry = registriesByClient.get(client);
    if (!registry) {
      registry = new RegisteredPairRegistry(client);
      registriesByClient.set(client, registry);
    }
    return registry;
  }

  /** Drop the cached registry (e.g. after the client switches networks). */
  invalidate(): void {
    this.cache = null;
    this.pending = null;
    this.windowLookups.clear();
  }

  /** Cached set of pairs currently registered with the on-chain factory. */
  async getRegisteredPairs(): Promise<Set<string>> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return new Set(this.cache.pairs);
    }
    if (this.pending) return this.pending;

    const readPairs = async (): Promise<Set<string>> => {
      // Real clients expose the cached FactoryModule; lightweight test clients
      // may only provide the factory contract accessor.
      const module =
        typeof this.client.factoryModule === "function"
          ? this.client.factoryModule()
          : undefined;
      return module
        ? module.getRegisteredPairs()
        : new Set(await this.client.factory.getAllPairs());
    };

    this.pending = readPairs()
      .then((pairs) => {
        this.cache = { pairs: new Set(pairs), expiresAt: Date.now() + this.ttlMs };
        return new Set(pairs);
      })
      .catch(() => {
        // No configured/available factory means no trusted event sources.
        // Fail closed instead of treating the whole chain as a CoralSwap pair.
        const pairs = new Set<string>();
        this.cache = { pairs, expiresAt: Date.now() + this.ttlMs };
        return pairs;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /**
   * Registry to use for a ledger window: the cached factory list plus any
   * pairs announced by factory events inside the range.
   */
  async getPairsForWindow(fromLedger: number, toLedger: number): Promise<Set<string>> {
    const [registered, announced] = await Promise.all([
      this.getRegisteredPairs(),
      this.scanNewPairEvents(fromLedger, toLedger),
    ]);
    for (const address of announced) registered.add(address);
    return registered;
  }

  /**
   * Scan factory events for newly registered pairs. Failures are non-fatal:
   * the authoritative `getAllPairs()` list remains the trust boundary, and an
   * unavailable event stream must not turn into an unfiltered report.
   */
  private async scanNewPairEvents(
    fromLedger: number,
    toLedger: number,
  ): Promise<Set<string>> {
    const factoryAddress = this.client.networkConfig?.factoryAddress;
    if (!factoryAddress || !this.client.server) return new Set();

    const key = `${fromLedger}:${toLedger}`;
    const cached = this.windowLookups.get(key);
    if (cached) return cached;

    const lookup = (async () => {
      const found = new Set<string>();
      try {
        const cursor = new EventCursor(this.client.server);
        const events = await cursor.scan({
          contractIds: [factoryAddress],
          topics: [...NEW_PAIR_TOPICS],
          fromLedger,
          toLedger,
          limit: this.pageLimit,
        });
        for (const ev of events) {
          const topic = ev.topic?.[0] ? decodeEventTopic(ev.topic[0]) : "";
          if (!(NEW_PAIR_TOPICS as readonly string[]).includes(topic)) continue;
          for (const address of extractNewPairAddresses(ev)) found.add(address);
        }
      } catch {
        // Event history is best-effort; `getAllPairs()` is authoritative.
      }
      return found;
    })();

    this.windowLookups.set(key, lookup);
    if (this.windowLookups.size > MAX_CACHED_WINDOW_LOOKUPS) {
      const oldest = this.windowLookups.keys().next().value;
      if (oldest !== undefined) this.windowLookups.delete(oldest);
    }
    return lookup;
  }
}

/**
 * Contract IDs to send as RPC filters for a trusted set. `null` means the
 * requested pair is not registered, i.e. the report must be empty. When the
 * registry exceeds the RPC's 5 filters × 5 IDs budget, no contract filter is
 * sent and {@link filterTrustedEvents} must be applied to every event.
 */
export function selectScanContractIds(
  trusted: Set<string>,
  pairAddress?: string,
): string[] | null {
  if (pairAddress) {
    return trusted.has(pairAddress) ? [pairAddress] : null;
  }
  if (trusted.size === 0 || trusted.size > MAX_FILTERED_CONTRACT_IDS) {
    return [];
  }
  return Array.from(trusted);
}

/** Keep only events emitted by a registered CoralSwap pair. */
export function filterTrustedEvents<T extends { contractId?: unknown }>(
  events: readonly T[],
  trusted: Set<string>,
  pairAddress?: string,
): T[] {
  return events.filter((event) => isTrustedContractEvent(event, trusted, pairAddress));
}

/** Whether a raw event came from a trusted pair (and optional requested pair). */
export function isTrustedContractEvent(
  event: { contractId?: unknown },
  trusted: Set<string>,
  pairAddress?: string,
): boolean {
  const id = eventIdToString(event.contractId);
  if (!id || !trusted.has(id)) return false;
  return pairAddress ? id === pairAddress : true;
}

/**
 * Normalise the `contractId` field of an `EventResponse` to a StrKey. Both the
 * SDK's `Contract` objects and plain strings appear in tests and RPC adapters.
 */
function eventIdToString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id.length > 0 ? id : undefined;
  }
  if (value && typeof value === "object" && "toString" in value) {
    try {
      const id = String(value.toString()).trim();
      return id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Convert raw 32-byte contract ID bytes into a StrKey. */
function contractBytesToId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bytes = (value as Record<string, unknown>).contractId;
  if (!bytes) return undefined;
  try {
    if (typeof bytes === "string") {
      return Address.contract(Uint8Array.from(Buffer.from(bytes, "base64"))).toString();
    }
    if (bytes instanceof Uint8Array || Array.isArray(bytes)) {
      return Address.contract(Uint8Array.from(bytes as Uint8Array)).toString();
    }
  } catch {
    // Not a contract address value.
  }
  return undefined;
}

/** Extract a contract address from an ScVal-shaped topic or data field. */
function addressCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return CONTRACT_ID_PATTERN.test(value) ? value : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.address === "function") {
    try {
      const address = (obj.address as () => unknown)();
      return addressCandidate(address) ?? contractBytesToId(address);
    } catch {
      return undefined;
    }
  }
  if ("address" in obj) {
    const direct = addressCandidate(obj.address) ?? contractBytesToId(obj.address);
    if (direct) return direct;
  }
  const fromBytes = contractBytesToId(obj);
  if (fromBytes) return fromBytes;
  return eventIdToString(obj._value);
}

/** Data fields a factory might use to name the newly created pair. */
const PAIR_DATA_KEYS = [
  "pair",
  "pair_address",
  "pairAddress",
  "contract",
  "address",
];

/** Pull the announced pair address out of a factory event. */
function symbolText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  for (const name of ["sym", "str"] as const) {
    const candidate = obj[name];
    try {
      const text =
        typeof candidate === "function"
          ? String((candidate as () => unknown)())
          : candidate
            ? String(candidate)
            : "";
      if (text) return text;
    } catch {
      // Try the other symbol shape.
    }
  }
  return "";
}

function extractNewPairAddresses(event: rpc.Api.EventResponse): string[] {
  const found = new Set<string>();
  for (const topic of (event.topic ?? []).slice(1)) {
    const address = addressCandidate(topic);
    if (address) found.add(address);
  }

  const value = event.value as
    | { map?: () => unknown[]; _value?: unknown }
    | undefined;
  if (!value) return Array.from(found);
  const direct = addressCandidate(value);
  if (direct) found.add(direct);

  const entries =
    typeof value.map === "function" ? value.map() : (value._value as unknown);
  if (!Array.isArray(entries)) return Array.from(found);

  for (const entry of entries as Array<{ key?: unknown; val?: unknown }>) {
    const key = symbolText(entry?.key);
    if (!PAIR_DATA_KEYS.includes(key)) continue;
    const address = addressCandidate(entry.val);
    if (address) found.add(address);
  }
  return Array.from(found);
}

