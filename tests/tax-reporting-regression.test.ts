import { TaxReportingModule } from "../src/modules/tax-reporting";
import { CoralSwapClient } from "../src/client";
import { Network } from "../src/types/common";
import { xdr } from "@stellar/stellar-sdk";

const MOCK_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

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

function buildMockSwapEvent(opts: {
  sender?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  feeBps?: number;
  txHash?: string;
  ledgerClosedAt?: string;
}) {
  return {
    topic: [xdr.ScVal.scvSymbol("swap")],
    value: {
      map: () => [
        { key: makeSym("sender"), val: makeAddr(opts.sender ?? MOCK_ADDRESS) },
        { key: makeSym("token_in"), val: makeAddr(opts.tokenIn ?? TOKEN_A) },
        { key: makeSym("token_out"), val: makeAddr(opts.tokenOut ?? TOKEN_B) },
        { key: makeSym("amount_in"), val: makeI128(opts.amountIn ?? 10_000_000n) },
        { key: makeSym("amount_out"), val: makeI128(opts.amountOut ?? 20_000_000n) },
        { key: makeSym("fee_bps"), val: makeU32(opts.feeBps ?? 30) },
      ],
    },
    txHash: opts.txHash ?? "tx_hash_123",
    ledgerClosedAt: opts.ledgerClosedAt ?? new Date(1_700_000_000_000).toISOString(),
  };
}

describe("TaxReportingModule - Regression Suite (#659)", () => {
  let client: CoralSwapClient;
  let taxModule: TaxReportingModule;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU",
    });
    jest.spyOn(client, "getCurrentLedger").mockResolvedValue(5000);
    jest.spyOn(client.server, "getLatestLedger").mockResolvedValue({ sequence: 5000 } as any);
    taxModule = new TaxReportingModule(client);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("asserts real non-zero gain/loss on token disposal with exact stroop precision", async () => {
    // 1. Buy 2.0 TOKEN_B using 1.0 TOKEN_A (cost = 1.003 TOKEN_A including fee)
    // 2. Dispose (sell) 2.0 TOKEN_B for 1.5 TOKEN_A (sale proceeds = 1.5 TOKEN_A)
    // Real gain = 1.5 - 1.003 = 0.497 TOKEN_A
    const buySwap = buildMockSwapEvent({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n, // 1.0 TOKEN_A
      amountOut: 20_000_000n, // 2.0 TOKEN_B
      feeBps: 30, // 0.003 fee
      txHash: "tx_buy",
      ledgerClosedAt: new Date(1_700_000_000_000).toISOString(),
    });

    const sellSwap = buildMockSwapEvent({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: 20_000_000n, // 2.0 TOKEN_B disposed
      amountOut: 15_000_000n, // 1.5 TOKEN_A received
      feeBps: 0,
      txHash: "tx_sell",
      ledgerClosedAt: new Date(1_700_000_000_000 + 86400_000).toISOString(),
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req: any) => {
      const topicSeg = req.filters?.[0]?.topics?.[0]?.[0];
      if (topicSeg) {
        const decoded = xdr.ScVal.fromXdr(topicSeg, "base64").sym.toString();
        if (decoded === "swap") {
          return { events: [buySwap, sellSwap], latestLedger: 5000 } as any;
        }
      }
      return { events: [], latestLedger: 5000 } as any;
    });

    const costBasis = await taxModule.getCostBasis(MOCK_ADDRESS, TOKEN_B);

    expect(costBasis.disposals).toHaveLength(1);
    const disposal = costBasis.disposals[0];

    // Check non-zero gain is correctly calculated
    expect(disposal.gain).not.toBe("0.0000000");
    expect(disposal.gain).toBe("0.4970000"); // 1.5 - 1.003 = 0.4970000
    expect(disposal.costBasis).toBe("1.0030000");
    expect(disposal.salePrice).toBe("1.5000000");
  });

  it("calculates non-zero capital gains correctly in getCapitalGains", async () => {
    const buySwap = buildMockSwapEvent({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 10_000_000n,
      amountOut: 10_000_000n,
      feeBps: 0,
      txHash: "tx_buy",
      ledgerClosedAt: new Date("2024-03-01T00:00:00Z").toISOString(),
    });

    const sellSwap = buildMockSwapEvent({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: 10_000_000n,
      amountOut: 18_000_000n, // Sold for 1.8 -> gain of 0.8
      feeBps: 0,
      txHash: "tx_sell",
      ledgerClosedAt: new Date("2024-04-01T00:00:00Z").toISOString(),
    });

    jest.spyOn(client.server, "getEvents").mockImplementation(async (req: any) => {
      const topicSeg = req.filters?.[0]?.topics?.[0]?.[0];
      if (topicSeg) {
        const decoded = xdr.ScVal.fromXdr(topicSeg, "base64").sym.toString();
        if (decoded === "swap") {
          return { events: [buySwap, sellSwap], latestLedger: 5000 } as any;
        }
      }
      return { events: [], latestLedger: 5000 } as any;
    });

    const capGains = await taxModule.getCapitalGains(MOCK_ADDRESS, 2024);

    expect(capGains.shortTermGains).toBe("0.8000000");
    expect(capGains.totalGain).toBe("0.8000000");
    expect(capGains.netGain).toBe("0.8000000");
  });

  it("exports past 200 events over multi-page ledgers", async () => {
    // Generate 250 swap events (> 200)
    const mockEvents = Array.from({ length: 250 }, (_, i) =>
      buildMockSwapEvent({
        txHash: `tx_${i}`,
        ledgerClosedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      }),
    );

    let pageCall = 0;
    jest.spyOn(client.server, "getEvents").mockImplementation(async (req: any) => {
      const topicSeg = req.filters?.[0]?.topics?.[0]?.[0];
      if (topicSeg) {
        const decoded = xdr.ScVal.fromXdr(topicSeg, "base64").sym.toString();
        if (decoded === "swap") {
          pageCall++;
          if (pageCall === 1) {
            return {
              events: mockEvents.slice(0, 200),
              latestLedger: 5000,
              cursor: "cursor_page1",
            } as any;
          }
          return {
            events: mockEvents.slice(200),
            latestLedger: 5000,
            cursor: null,
          } as any;
        }
      }
      return { events: [], latestLedger: 5000 } as any;
    });

    const jsonResult = await taxModule.exportTradeHistory(MOCK_ADDRESS, { format: "json" });
    const rows = JSON.parse(jsonResult);

    expect(rows.length).toBe(250);
  });
});
