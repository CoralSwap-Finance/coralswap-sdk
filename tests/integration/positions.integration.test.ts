import { CoralSwapClient } from "@/client";
import { Network } from "@/types/common";
import { PositionsModule } from "@/modules/positions";

// ---------------------------------------------------------------------------
// Integration tests for PositionsModule against Stellar Testnet
// ---------------------------------------------------------------------------
// Prerequisites:
//   1. STELLAR_TESTNET=1 env var (skip gate)
//   2. TESTNET_PAIR_ADDRESS  — a known CoralSwap pair on Testnet
//   3. TESTNET_OWNER_ADDRESS — a wallet with LP tokens in that pair
//   4. TESTNET_RPC_URL (optional, defaults to Soroban Testnet)
// ---------------------------------------------------------------------------

const INTEGRATION_SKIP_REASON =
  "Skipping integration test — set STELLAR_TESTNET=1 and provide TESTNET_PAIR_ADDRESS / TESTNET_OWNER_ADDRESS in your .env";

function ensureIntegrationEnv(): boolean {
  return (
    process.env.STELLAR_TESTNET === "1" &&
    !!process.env.TESTNET_PAIR_ADDRESS &&
    !!process.env.TESTNET_OWNER_ADDRESS
  );
}

function createClient(): CoralSwapClient {
  const rpcUrl =
    process.env.TESTNET_RPC_URL ?? "https://soroban-testnet.stellar.org";
  return new CoralSwapClient({
    network: Network.TESTNET,
    rpcUrl,
  });
}

const pairAddress = process.env.TESTNET_PAIR_ADDRESS ?? "";
const ownerAddress = process.env.TESTNET_OWNER_ADDRESS ?? "";

describe("PositionsModule (Testnet Integration)", () => {
  let client: CoralSwapClient;
  let positions: PositionsModule;

  beforeAll(() => {
    if (!ensureIntegrationEnv()) {
      return;
    }
    client = createClient();
    positions = new PositionsModule(client);
  });

  // -----------------------------------------------------------------------
  // getPosition
  // -----------------------------------------------------------------------
  describe("getPosition", () => {
    (ensureIntegrationEnv() ? it : it.skip)(
      "returns an enriched LP position for a known pair + owner",
      async () => {
        const pos = await positions.getPosition(pairAddress, ownerAddress);

        expect(pos).toBeDefined();
        expect(pos.pairAddress).toBe(pairAddress);
        expect(typeof pos.lpTokenAddress).toBe("string");
        expect(pos.lpTokenAddress.length).toBeGreaterThan(0);

        // LP balances should be known-positive for the test wallet
        expect(typeof pos.balance).toBe("bigint");
        expect(pos.balance).toBeGreaterThan(0n);

        // Derived amounts
        expect(typeof pos.totalSupply).toBe("bigint");
        expect(pos.totalSupply).toBeGreaterThan(0n);
        expect(typeof pos.share).toBe("number");
        expect(pos.share).toBeGreaterThan(0);

        // Token and reserve data
        expect(typeof pos.token0).toBe("string");
        expect(pos.token0.length).toBeGreaterThan(0);
        expect(typeof pos.token1).toBe("string");
        expect(pos.token1.length).toBeGreaterThan(0);
        expect(pos.reserve0).toBeGreaterThan(0n);
        expect(pos.reserve1).toBeGreaterThan(0n);

        // Proportional token amounts should be > 0
        expect(pos.token0Amount).toBeGreaterThan(0n);
        expect(pos.token1Amount).toBeGreaterThan(0n);

        // Fee state
        expect(typeof pos.feeBps).toBe("number");
        expect(pos.feeBps).toBeGreaterThanOrEqual(0);
      },
      INTEGRATION_SKIP_REASON,
    );

    (ensureIntegrationEnv() ? it : it.skip)(
      "throws for an invalid pair address",
      async () => {
        await expect(
          positions.getPosition(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQ",
            ownerAddress,
          ),
        ).rejects.toThrow();
      },
      INTEGRATION_SKIP_REASON,
    );
  });

  // -----------------------------------------------------------------------
  // getPositions
  // -----------------------------------------------------------------------
  describe("getPositions", () => {
    (ensureIntegrationEnv() ? it : it.skip)(
      "returns a non-empty PositionSummary for a known owner",
      async () => {
        const summary = await positions.getPositions(ownerAddress);

        expect(summary).toBeDefined();
        expect(summary.owner).toBe(ownerAddress);
        expect(summary.totalPools).toBeGreaterThan(0);
        expect(summary.positions.length).toBe(summary.totalPools);

        for (const pos of summary.positions) {
          expect(pos.balance).toBeGreaterThan(0n);
          expect(typeof pos.pairAddress).toBe("string");
          expect(typeof pos.token0).toBe("string");
          expect(typeof pos.token1).toBe("string");
        }
      },
      INTEGRATION_SKIP_REASON,
    );

    (ensureIntegrationEnv() ? it : it.skip)(
      "filters by pairAddresses option",
      async () => {
        const summary = await positions.getPositions(ownerAddress, {
          pairAddresses: [pairAddress],
        });

        expect(summary.totalPools).toBeGreaterThanOrEqual(1);
        for (const pos of summary.positions) {
          expect(pos.pairAddress).toBe(pairAddress);
        }
      },
      INTEGRATION_SKIP_REASON,
    );

    (ensureIntegrationEnv() ? it : it.skip)(
      "returns empty summary when filtering with a non-existent pair",
      async () => {
        // Use a valid Soroban contract ID that isn't a CoralSwap pair
        const fakePair =
          "CA3D5K7U5H3E4F5G6H7I8J9K0L1M2N3O4P5Q6R7S8T9U0V1W2X3Y4Z5A6B7C";

        const summary = await positions.getPositions(ownerAddress, {
          pairAddresses: [fakePair],
        });

        expect(summary.totalPools).toBe(0);
        expect(summary.positions).toHaveLength(0);
      },
      INTEGRATION_SKIP_REASON,
    );

    (ensureIntegrationEnv() ? it : it.skip)(
      "handles an address with no LP positions gracefully",
      async () => {
        // An empty wallet (no LP tokens)
        const emptyWallet =
          "GDQIWX23W4O6U5JQ4T6V7X8Y9Z0A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P";

        const summary = await positions.getPositions(emptyWallet);
        expect(summary.owner).toBe(emptyWallet);
        expect(summary.totalPools).toBe(0);
        expect(summary.positions).toHaveLength(0);
      },
      INTEGRATION_SKIP_REASON,
    );
  });

  // -----------------------------------------------------------------------
  // hasPosition
  // -----------------------------------------------------------------------
  describe("hasPosition", () => {
    (ensureIntegrationEnv() ? it : it.skip)(
      "returns true for an owner with LP tokens in a pair",
      async () => {
        const result = await positions.hasPosition(pairAddress, ownerAddress);
        expect(result).toBe(true);
      },
      INTEGRATION_SKIP_REASON,
    );

    (ensureIntegrationEnv() ? it : it.skip)(
      "returns false for an address without LP tokens",
      async () => {
        const emptyWallet =
          "GDQIWX23W4O6U5JQ4T6V7X8Y9Z0A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P";
        const result = await positions.hasPosition(pairAddress, emptyWallet);
        expect(result).toBe(false);
      },
      INTEGRATION_SKIP_REASON,
    );
  });
});
