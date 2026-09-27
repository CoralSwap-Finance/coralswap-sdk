/**
 * Fixture event streams for monitoring aggregation tests.
 *
 * Builders emit `getEvents` response entries shaped exactly like real Soroban
 * RPC output — real XDR `ScVal` topics and values — so the monitoring module's
 * reserve (`sync`) and transfer (`swap`) decoding runs unchanged instead of
 * being stubbed out. {@link createFixtureClient} serves those events through a
 * `getEvents` mock that mirrors real RPC filter semantics: topics only match
 * base64-encoded XDR symbols, and `contractIds`, `startLedger`, `limit`, and
 * cursor continuation are honoured.
 *
 * A fixture is just three things: the factory's pair list, each pair's current
 * on-chain state (reserves/tokens/fee), and the historical event stream. Swap
 * the fixture and every aggregate derived from it must move.
 */

import { xdr, Address, Contract, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import type { CoralSwapClient } from '../../src/client';

export const STABLE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
export const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
export const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

export const PAIR_1 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
export const PAIR_2 = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

export const USER_1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
export const USER_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const USER_3 = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';
export const USER_4 = 'GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP';

/** Ledgers closed per day at a 5s close time — the window every 24h figure uses. */
export const LEDGERS_PER_DAY = 17_280;
export const CURRENT_LEDGER = 100_000;
/** First ledger of the trailing-24h window. Swaps before it are "previous window". */
export const CURRENT_START = CURRENT_LEDGER - LEDGERS_PER_DAY;

const addr = (a: string) => nativeToScVal(Address.fromString(a), { type: 'address' });
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

let eventSeq = 0;

/** A `getEvents` response entry shaped exactly like real Soroban RPC output. */
function makeEvent(contract: string, topic: string, ledger: number, value: xdr.ScVal): rpc.Api.EventResponse {
  eventSeq++;
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date(ledger * 5000).toISOString(),
    contractId: new Contract(contract),
    id: String(eventSeq).padStart(8, '0'),
    pagingToken: String(eventSeq),
    inSuccessfulContractCall: true,
    txHash: `tx_${eventSeq}`,
    topic: [xdr.ScVal.scvSymbol(topic)],
    value,
  } as unknown as rpc.Api.EventResponse;
}

/** Reserve snapshot — the stream that drives historical TVL. */
export function syncEvent(contract: string, ledger: number, reserve0: bigint, reserve1: bigint): rpc.Api.EventResponse {
  return makeEvent(contract, 'sync', ledger, scMap([
    ['reserve0', i128(reserve0)],
    ['reserve1', i128(reserve1)],
  ]));
}

export interface SwapFixture {
  /** Input amount in the input token's smallest unit (7 decimals). */
  amountIn: bigint;
  sender: string;
  /** Fee in basis points; defaults to 30. */
  feeBps?: number;
  /** Input token; defaults to the stablecoin (so volume prices at $1/unit). */
  tokenIn?: string;
  /** Output token; defaults to TOKEN_A. */
  tokenOut?: string;
}

/** Transfer — the stream that drives volume, fees, and unique swappers. */
export function swapEvent(
  contract: string,
  ledger: number,
  swap: SwapFixture,
): rpc.Api.EventResponse {
  return makeEvent(contract, 'swap', ledger, scMap([
    ['sender', addr(swap.sender)],
    ['token_in', addr(swap.tokenIn ?? STABLE_ADDR)],
    ['token_out', addr(swap.tokenOut ?? TOKEN_A)],
    ['amount_in', i128(swap.amountIn)],
    ['amount_out', i128(swap.amountIn)],
    ['fee_bps', xdr.ScVal.scvU32(swap.feeBps ?? 30)],
  ]));
}

/** Current on-chain state of one pair, as returned by the pair contract reads. */
export interface PairSpec {
  reserve0: bigint;
  reserve1: bigint;
  token0?: string;
  token1?: string;
  feeBps?: number;
}

export interface MonitoringFixture {
  /** Pair addresses returned by `factory.getAllPairs()`. */
  pairs: string[];
  /** Live pair state behind `getReserves()` / `getTokens()` / `getDynamicFee()`. */
  pairSpecs: Record<string, PairSpec>;
  /** Historical `sync` / `swap` event stream served by `getEvents`. */
  events: rpc.Api.EventResponse[];
}

interface GetEventsRequest {
  startLedger: number;
  limit: number;
  filters: Array<{ contractIds?: string[]; topics?: string[][] }>;
  cursor?: string;
}

export interface FixtureClient {
  client: CoralSwapClient;
  getEvents: jest.Mock;
}

/**
 * Build a client whose reads and `getEvents` serve the fixture.
 *
 * Events are matched the way Soroban RPC does: encoded-topic equality,
 * contract-id membership, `startLedger` as an inclusive lower bound, `limit`
 * as a page cap, and cursor requests resuming right after the matching token
 * with no ledger range.
 */
export function createFixtureClient(fixture: MonitoringFixture): FixtureClient {
  const sorted = [...fixture.events].sort((a, b) => a.ledger - b.ledger);

  const getEvents = jest.fn(async (req: GetEventsRequest) => {
    const filter = req.filters[0] ?? {};
    const wantedTopics = new Set(filter.topics?.[0] ?? []);
    const wantedContracts = new Set(filter.contractIds ?? []);
    const matchesFilter = (e: (typeof sorted)[number]) =>
      (wantedContracts.size === 0 || wantedContracts.has(e.contractId!.toString())) &&
      wantedTopics.has(e.topic[0].toXDR('base64'));

    let matches: typeof sorted;
    if (req.cursor !== undefined) {
      const all = sorted.filter(matchesFilter);
      const idx = all.findIndex((e) => e.pagingToken === req.cursor);
      matches = idx >= 0 ? all.slice(idx + 1) : [];
    } else {
      matches = sorted.filter((e) => e.ledger >= req.startLedger && matchesFilter(e));
    }
    return { events: matches.slice(0, req.limit), latestLedger: CURRENT_LEDGER };
  });

  const client = {
    factory: { getAllPairs: jest.fn().mockResolvedValue(fixture.pairs) },
    pair: jest.fn((address: string) => {
      const spec = fixture.pairSpecs[address] ?? { reserve0: 0n, reserve1: 0n };
      return {
        getReserves: jest.fn().mockResolvedValue({ reserve0: spec.reserve0, reserve1: spec.reserve1 }),
        getTokens: jest.fn().mockResolvedValue({
          token0: spec.token0 ?? STABLE_ADDR,
          token1: spec.token1 ?? TOKEN_A,
        }),
        getDynamicFee: jest.fn().mockResolvedValue(spec.feeBps ?? 30),
      };
    }),
    server: {
      getEvents,
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: CURRENT_LEDGER }),
    },
    getCurrentLedger: jest.fn().mockResolvedValue(CURRENT_LEDGER),
  } as unknown as CoralSwapClient;

  return { client, getEvents };
}
