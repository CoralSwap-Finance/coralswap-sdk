import { Address, rpc as SorobanRpc, xdr } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "../src/client";
import { LeaderboardModule } from "../src/modules/leaderboard";
import { SwapModule } from "../src/modules/swap";
import { TaxReportingModule } from "../src/modules/tax-reporting";
import { Network } from "../src/types/common";
import {
  NEW_PAIR_TOPICS,
  RegisteredPairRegistry,
} from "../src/utils/registered-pairs";

/**
 * Issue #883: event-derived history, leaderboards and tax rows must only trust
 * swap events emitted by pairs registered in the on-chain factory.
 */

const TEST_SECRET =
  "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

const REGISTERED_PAIR =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const FORGED_PAIR =
  "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const USER =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_USER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

const makeAddr = (addr: string) => ({
  address: () => ({ toString: () => addr }),
});
const makeI128 = (n: bigint) => ({
  i128: () => ({
    hi: () => ({ toString: () => String(n >> 64n) }),
    lo: () => ({ toString: () => String(n & 0xffffffffffffffffn) }),
  }),
});
const makeU32 = (n: number) => ({ u32: () => n });
const makeSym = (s: string) => ({ sym: () => ({ toString: () => s }) });

function makeSwapEvent(opts: {
  contractId: string;
  sender: string;
  ledger: number;
  txHash: string;
  amountIn?: bigint;
}): Record<string, unknown> {
  return {
    contractId: opts.contractId,
    topic: [xdr.ScVal.scvSymbol("swap")],
    value: {
      map: () => [
        { key: makeSym("sender"), val: makeAddr(opts.sender) },
        { key: makeSym("token_in"), val: makeAddr(TOKEN_A) },
        { key: makeSym("token_out"), val: makeAddr(TOKEN_B) },
        { key: makeSym("amount_in"), val: makeI128(opts.amountIn ?? 1_000n) },
        { key: makeSym("amount_out"), val: makeI128(900n) },
        { key: makeSym("fee_bps"), val: makeU32(30) },
      ],
    },
    ledger: opts.ledger,
    pagingToken: `${opts.ledger}-1`,
    txHash: opts.txHash,
    ledgerClosedAt: new Date(1_700_000_000_000 + opts.ledger * 1000).toISOString(),
  };
}

function decodeTopic(req: SorobanRpc.Server.GetEventsRequest): string {
  const segment = req.filters?.[0]?.topics?.[0]?.[0];
  if (!segment) return "";
  return xdr.ScVal.fromXdr(segment, "base64").sym.toString();
}

function response(
  events: Record<string, unknown>[],
  latestLedger: number,
  cursor?: string | null,
): SorobanRpc.Api.GetEventsResponse {
  return {
    events: events as unknown as SorobanRpc.Api.EventResponse[],
    latestLedger,
    ...(cursor !== undefined ? { cursor } : {}),
  } as SorobanRpc.Api.GetEventsResponse;
}

/** Route mock responses by topic, keeping the factory refresh scan empty. */
function mockTopicEvents(
  client: CoralSwapClient,
  eventsByTopic: Record<string, Record<string, unknown>[]>,
): jest.SpyInstance {
  return jest
    .spyOn(client.server, "getEvents")
    .mockImplementation((req: SorobanRpc.Server.GetEventsRequest) => {
      const topic = decodeTopic(req);
      if (NEW_PAIR_TOPICS.includes(topic as (typeof NEW_PAIR_TOPICS)[number])) {
        return Promise.resolve(response([], req.startLedger ?? 0));
      }
      return Promise.resolve(
        response(eventsByTopic[topic] ?? [], req.startLedger ?? 0),
      );
    });
}

function makeClient(): CoralSwapClient {
  const client = new CoralSwapClient({
    network: Network.TESTNET,
    secretKey: TEST_SECRET,
  });
  jest.spyOn(client.factory, "getAllPairs").mockResolvedValue([REGISTERED_PAIR]);
  jest.spyOn(client, "getCurrentLedger").mockResolvedValue(50_000);
  jest
    .spyOn(client.server, "getLatestLedger")
    .mockResolvedValue({ sequence: 50_000 } as unknown as Awaited<
      ReturnType<typeof client.server.getLatestLedger>
    >);
  return client;
}

describe("Event provenance (#883)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shares one registry instance across report modules", async () => {
    const client = makeClient();
    const first = RegisteredPairRegistry.forClient(client);
    const second = RegisteredPairRegistry.forClient(client);

    expect(first).toBe(second);
  });

  it("refreshes the trusted pair set from factory new-pair events", async () => {
    const client = makeClient();
    const announced = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
    jest
      .spyOn(client.factory, "getAllPairs")
      .mockResolvedValue([REGISTERED_PAIR]);
    jest
      .spyOn(client.server, "getEvents")
      .mockResolvedValue(
        response(
          [
            {
              contractId: client.networkConfig.factoryAddress,
              topic: [xdr.ScVal.scvSymbol(NEW_PAIR_TOPICS[0])],
              value: xdr.ScVal.scvAddress(
                xdr.ScAddress.scAddressTypeContract(
                  Address.fromString(announced).toBuffer(),
                ),
              ),
              ledger: 49_000,
              pagingToken: "49000-1",
            },
          ],
          50_000,
        ),
      );

    const registry = new RegisteredPairRegistry(client);
    const pairs = await registry.getPairsForWindow(48_000, 50_000);

    expect(pairs.has(REGISTERED_PAIR)).toBe(true);
    expect(pairs.has(announced)).toBe(true);
  });

  it("fails closed when no factory registry is available", async () => {
    const client = makeClient();
    jest
      .spyOn(client.factory, "getAllPairs")
      .mockRejectedValue(new Error("factory unavailable"));
    jest.spyOn(client.server, "getEvents").mockResolvedValue(response([], 50_000));

    const history = await new SwapModule(client).getSwapHistory({});

    expect(history).toEqual([]);
  });

  it("excludes a forged swap from swap history", async () => {
    const client = makeClient();
    const trusted = makeSwapEvent({
      contractId: REGISTERED_PAIR,
      sender: USER,
      ledger: 40_000,
      txHash: "tx_trusted",
    });
    const forged = makeSwapEvent({
      contractId: FORGED_PAIR,
      sender: USER,
      ledger: 40_001,
      txHash: "tx_forged",
    });
    mockTopicEvents(client, { swap: [trusted, forged] });

    const history = await new SwapModule(client).getSwapHistory({
      userAddress: USER,
    });

    expect(history.map((event) => event.txHash)).toEqual(["tx_trusted"]);
    expect(history[0].pairAddress).toBe(REGISTERED_PAIR);
  });

  it("excludes a forged swap from the leaderboard", async () => {
    const client = makeClient();
    const trusted = makeSwapEvent({
      contractId: REGISTERED_PAIR,
      sender: USER,
      ledger: 40_000,
      txHash: "tx_trusted",
      amountIn: 1_000n,
    });
    const forged = makeSwapEvent({
      contractId: FORGED_PAIR,
      sender: USER,
      ledger: 40_001,
      txHash: "tx_forged",
      amountIn: 999_999n,
    });
    mockTopicEvents(client, { swap: [trusted, forged] });

    const entries = await new LeaderboardModule(client).getLeaderboard(
      "trader",
      { period: "24h" },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].address).toBe(USER);
    expect(entries[0].metricValue).toBe(1_000n);
  });

  it("excludes a forged swap from tax exports", async () => {
    const client = makeClient();
    const trusted = makeSwapEvent({
      contractId: REGISTERED_PAIR,
      sender: USER,
      ledger: 40_000,
      txHash: "tx_trusted",
    });
    const forged = makeSwapEvent({
      contractId: FORGED_PAIR,
      sender: USER,
      ledger: 40_001,
      txHash: "tx_forged",
    });
    mockTopicEvents(client, { swap: [trusted, forged] });

    const json = await new TaxReportingModule(client).exportTradeHistory(USER, {
      format: "json",
    });
    const rows = JSON.parse(json) as Array<{ txHash: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("tx_trusted");
  });

  it("pages past the limit when filtering by user", async () => {
    const client = makeClient();
    const events = Array.from({ length: 300 }, (_, index) =>
      makeSwapEvent({
        contractId: REGISTERED_PAIR,
        sender: index < 295 ? OTHER_USER : USER,
        ledger: 1_000 + index,
        txHash: `tx_${index}`,
      }),
    );

    let swapPage = 0;
    jest
      .spyOn(client.server, "getEvents")
      .mockImplementation((req: SorobanRpc.Server.GetEventsRequest) => {
        const topic = decodeTopic(req);
        if (
          topic !== "swap" ||
          NEW_PAIR_TOPICS.includes(topic as (typeof NEW_PAIR_TOPICS)[number])
        ) {
          return Promise.resolve(response([], req.startLedger ?? 0));
        }
        swapPage += 1;
        if (swapPage === 1) {
          return Promise.resolve(response(events.slice(0, 200), 2_000, "page-1"));
        }
        return Promise.resolve(response(events.slice(200), 2_000));
      });

    const history = await new SwapModule(client).getSwapHistory({
      userAddress: USER,
      limit: 200,
    });

    expect(swapPage).toBe(2);
    expect(history).toHaveLength(5);
    expect(history.map((event) => event.txHash)).toEqual([
      "tx_295",
      "tx_296",
      "tx_297",
      "tx_298",
      "tx_299",
    ]);
  });
});
