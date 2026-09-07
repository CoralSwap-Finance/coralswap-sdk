/**
 * Unit tests for SquidModule — quote correctness and resubmission safety.
 *
 * Pins three invariants from the issue:
 *   1. Native path never returns 1:1 (estimatedAmountOut < amountIn).
 *   2. Fees are applied when known (from the Squid API feeCosts).
 *   3. `unknown` route status blocks resubmit (CrossChainError thrown).
 *
 * Each Squid mode has its own fixture payload so the test data is reusable
 * and clearly separated.
 */

import { SquidModule } from "../src/modules/squid";
import { CrossChainError, ValidationError } from "../src/errors";
import { CrossChainQuote } from "../src/types/squid";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const BRIDGED_TOKEN =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TO_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const FROM_ASSET_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC on Ethereum

// ---------------------------------------------------------------------------
// Fixture payloads — one per Squid mode
// ---------------------------------------------------------------------------

/**
 * Fixture: Squid API `/route` response for a cross-chain (Ethereum → Stellar)
 * bridge + swap route, with known fee costs.
 */
const FIXTURE_CROSS_CHAIN_ROUTE = {
  routeId: "squid-route-abc123",
  toToken: BRIDGED_TOKEN,
  toAmount: "990000", // 0.99 USDC arrives on Stellar after bridge fees
  toAmountMin: "980100",
  feeCosts: [
    { amount: "5000", name: "bridgeFee" }, // bridge fee: 5000 units
    { amount: "1000", name: "gasFee" }, // gas fee: 1000 units
    { amount: "2000", name: "swapFee" }, // CoralSwap swap fee: 2000 units
  ],
  estimatedRouteDuration: 120,
  calldata: {
    target: "0xSquidRouter",
    data: "0xcalldata",
    value: "0",
  },
};

/**
 * Fixture: Squid API `/route` response with no feeCosts (unknown fees).
 */
const FIXTURE_CROSS_CHAIN_ROUTE_NO_FEES = {
  routeId: "squid-route-nofees",
  toToken: BRIDGED_TOKEN,
  toAmount: "1000000",
  toAmountMin: "990000",
  feeCosts: [],
  estimatedRouteDuration: 90,
  calldata: {
    target: "0xSquidRouter",
    data: "0xcalldata",
    value: "0",
  },
};

/**
 * Fixture: Squid `/status` response payloads for each tracked status.
 */
const FIXTURE_STATUS = {
  success: {
    status: "success",
    toChain: { transactionHash: "BRIDGE_TX_SUCCESS" },
  },
  ongoing: {
    status: "ongoing",
    toChain: { transactionHash: "BRIDGE_TX_ONGOING" },
  },
  failed: { status: "failed" },
  not_found: { status: "not_found" },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildQuote(overrides: Partial<CrossChainQuote> = {}): CrossChainQuote {
  return {
    routeId: "route-1",
    isStellarNative: false,
    fromChain: "ethereum",
    fromAsset: FROM_ASSET_ETH,
    bridgedAsset: BRIDGED_TOKEN,
    toAsset: TO_TOKEN,
    amountIn: 1_000_000n,
    bridgedAmount: 990_000n,
    estimatedAmountOut: 988_000n,
    amountOutMin: 983_060n,
    bridgeFee: 6_000n,
    swapFee: 2_000n,
    totalSlippageBps: 50,
    estimatedTimeSeconds: 60,
    deadline: 9_999_999_999,
    steps: [],
    bridgeCalldata: { target: "0xSquidRouter", data: "0xcalldata" },
    ...overrides,
  };
}

function buildMockClient(
  options: { submitResults?: object[]; txResult?: object } = {},
) {
  const {
    submitResults = [
      { success: true, txHash: "SWAP_TX", data: { ledger: 100 } },
    ],
    txResult = { status: "NOT_FOUND" },
  } = options;

  const submitTransaction = jest.fn();
  submitResults.forEach((r) => submitTransaction.mockResolvedValueOnce(r));

  return {
    publicKey: "GTEST_SENDER",
    getDeadline: jest.fn().mockReturnValue(9_999_999_999),
    router: {
      buildSwapExactIn: jest.fn().mockReturnValue("mock_swap_op"),
    },
    submitTransaction,
    server: {
      getTransaction: jest.fn().mockResolvedValue(txResult),
    },
  };
}

/**
 * Build a mock fetch that dispatches based on URL path:
 *   /route  → POST quote request
 *   /execute → POST bridge execution
 *   /status  → GET status check
 */
function buildMockFetch(handlers: {
  route?: () => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
  }>;
  execute?: () => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
  }>;
  status?: () => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
  }>;
}) {
  return jest.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/route") && method === "POST") {
      if (!handlers.route) throw new Error("unexpected /route POST");
      return handlers.route();
    }
    if (url.includes("/execute")) {
      if (!handlers.execute) throw new Error("unexpected /execute call");
      return handlers.execute();
    }
    if (url.includes("/status")) {
      if (!handlers.status) throw new Error("unexpected /status call");
      return handlers.status();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SquidModule.getCrossChainQuote — quote correctness", () => {
  describe("Native (Stellar) path — no 1:1 quotes", () => {
    it("estimatedAmountOut is strictly less than amountIn (fees applied)", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "stellar",
        fromAsset: BRIDGED_TOKEN,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      // Core invariant: native path must NEVER return 1:1
      expect(quote.estimatedAmountOut).toBeLessThan(quote.amountIn);
      expect(quote.isStellarNative).toBe(true);
    });

    it("swapFee is non-zero for native quotes", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "stellar",
        fromAsset: BRIDGED_TOKEN,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      expect(quote.swapFee).toBeGreaterThan(0n);
      expect(quote.bridgeFee).toBe(0n); // no bridge for native
    });

    it("fee math: estimatedAmountOut = amountIn - swapFee", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const amount = 10_000_000n;
      const quote = await module.getCrossChainQuote({
        fromChain: "stellar",
        fromAsset: BRIDGED_TOKEN,
        toAsset: TO_TOKEN,
        amount,
      });

      // 30 bps fee on 10M = 30_000
      expect(quote.swapFee).toBe(30_000n);
      expect(quote.estimatedAmountOut).toBe(amount - 30_000n);
    });

    it("amountOutMin is derived from estimatedAmountOut (not amountIn)", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "stellar",
        fromAsset: BRIDGED_TOKEN,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
        slippageBps: 100, // 1%
      });

      // amountOutMin = estimatedAmountOut - (estimatedAmountOut * 100 / 10000)
      const expectedMin =
        quote.estimatedAmountOut - (quote.estimatedAmountOut * 100n) / 10_000n;
      expect(quote.amountOutMin).toBe(expectedMin);
    });

    it("native quote does not call the Squid API", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      await module.getCrossChainQuote({
        fromChain: "stellar",
        fromAsset: BRIDGED_TOKEN,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe("Cross-chain (bridge) path — fees applied when known", () => {
    it("swapFee from feeCosts is deducted from estimatedAmountOut", async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        route: () => okJson(FIXTURE_CROSS_CHAIN_ROUTE) as any,
      });
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "ethereum",
        fromAsset: FROM_ASSET_ETH,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      // bridgedAmount = toAmount = 990_000
      expect(quote.bridgedAmount).toBe(990_000n);
      // swapFee = 2000 from feeCosts
      expect(quote.swapFee).toBe(2_000n);
      // estimatedAmountOut = bridgedAmount - swapFee = 990_000 - 2_000 = 988_000
      expect(quote.estimatedAmountOut).toBe(988_000n);
    });

    it("bridgeFee from feeCosts is correctly summed", async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        route: () => okJson(FIXTURE_CROSS_CHAIN_ROUTE) as any,
      });
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "ethereum",
        fromAsset: FROM_ASSET_ETH,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      // bridgeFee = bridgeFee (5000) + gasFee (1000) = 6000
      expect(quote.bridgeFee).toBe(6_000n);
    });

    it("when feeCosts is empty, swapFee is 0 and estimatedAmountOut equals bridgedAmount", async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        route: () => okJson(FIXTURE_CROSS_CHAIN_ROUTE_NO_FEES) as any,
      });
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "ethereum",
        fromAsset: FROM_ASSET_ETH,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      expect(quote.swapFee).toBe(0n);
      expect(quote.bridgeFee).toBe(0n);
      expect(quote.estimatedAmountOut).toBe(quote.bridgedAmount);
    });

    it("cross-chain quote is never 1:1 when fees are present", async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        route: () => okJson(FIXTURE_CROSS_CHAIN_ROUTE) as any,
      });
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "ethereum",
        fromAsset: FROM_ASSET_ETH,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      // estimatedAmountOut (988_000) < amountIn (1_000_000)
      expect(quote.estimatedAmountOut).toBeLessThan(quote.amountIn);
    });

    it("steps include both bridge and swap for cross-chain routes", async () => {
      const client = buildMockClient();
      const fetchFn = buildMockFetch({
        route: () => okJson(FIXTURE_CROSS_CHAIN_ROUTE) as any,
      });
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      const quote = await module.getCrossChainQuote({
        fromChain: "ethereum",
        fromAsset: FROM_ASSET_ETH,
        toAsset: TO_TOKEN,
        amount: 1_000_000n,
      });

      expect(quote.steps).toHaveLength(2);
      expect(quote.steps[0].type).toBe("bridge");
      expect(quote.steps[1].type).toBe("swap");
    });
  });

  describe("Validation", () => {
    it("rejects empty fromAsset", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      await expect(
        module.getCrossChainQuote({
          fromChain: "stellar",
          fromAsset: "",
          toAsset: TO_TOKEN,
          amount: 1_000_000n,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects empty fromChain", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      await expect(
        module.getCrossChainQuote({
          fromChain: "",
          fromAsset: BRIDGED_TOKEN,
          toAsset: TO_TOKEN,
          amount: 1_000_000n,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects zero amount", async () => {
      const client = buildMockClient();
      const fetchFn = jest.fn();
      const module = new SquidModule(client as any, {
        fetchFn: fetchFn as any,
      });

      await expect(
        module.getCrossChainQuote({
          fromChain: "stellar",
          fromAsset: BRIDGED_TOKEN,
          toAsset: TO_TOKEN,
          amount: 0n,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});

describe("SquidModule — unknown route status blocks resubmit", () => {
  it("throws CrossChainError when status API returns non-ok (unknown)", async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("Request timeout")),
      status: () =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        }) as any,
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(
      CrossChainError,
    );
    // Only one execute call + one status check, no resubmission
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(client.submitTransaction).not.toHaveBeenCalled();
  });

  it("throws CrossChainError when status API throws (unknown)", async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("connection timeout")),
      status: () => Promise.reject(new Error("status API unreachable")),
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(
      CrossChainError,
    );
    // Only one execute call + one status check, no resubmission
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('error message mentions "unknown" and "cannot be safely resubmitted"', async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("socket hang up")),
      status: () => Promise.reject(new Error("network error")),
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    try {
      await module.executeCrossChainSwap(buildQuote());
      fail("Expected CrossChainError");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossChainError);
      expect((err as Error).message).toMatch(/unknown/i);
      expect((err as Error).message).toMatch(/cannot be safely resubmitted/i);
    }
  });

  it('still allows resubmit when status is explicitly "not_found"', async () => {
    const client = buildMockClient();
    let executeCalls = 0;
    const fetchFn = buildMockFetch({
      execute: () => {
        executeCalls += 1;
        if (executeCalls === 1) return Promise.reject(new Error("timeout"));
        return okJson({ transactionHash: "BRIDGE_TX_RETRIED" }) as any;
      },
      status: () => okJson(FIXTURE_STATUS.not_found) as any,
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    const result = await module.executeCrossChainSwap(buildQuote());

    expect(result.bridgeTxHash).toBe("BRIDGE_TX_RETRIED");
    expect(executeCalls).toBe(2);
  });

  it('does not resubmit when status is "success" — returns landed hash', async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("Request timeout")),
      status: () => okJson(FIXTURE_STATUS.success) as any,
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    const result = await module.executeCrossChainSwap(buildQuote());

    expect(result.bridgeTxHash).toBe("BRIDGE_TX_SUCCESS");
    expect(fetchFn).toHaveBeenCalledTimes(2); // 1 execute + 1 status
  });

  it('does not resubmit when status is "ongoing" — returns inflight hash', async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("socket hang up")),
      status: () => okJson(FIXTURE_STATUS.ongoing) as any,
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    const result = await module.executeCrossChainSwap(buildQuote());

    expect(result.bridgeTxHash).toBe("BRIDGE_TX_ONGOING");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not resubmit when status is "failed" — throws immediately', async () => {
    const client = buildMockClient();
    const fetchFn = buildMockFetch({
      execute: () => Promise.reject(new Error("connection timeout")),
      status: () => okJson(FIXTURE_STATUS.failed) as any,
    });
    const module = new SquidModule(client as any, { fetchFn: fetchFn as any });

    await expect(module.executeCrossChainSwap(buildQuote())).rejects.toThrow(
      CrossChainError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(client.submitTransaction).not.toHaveBeenCalled();
  });
});
