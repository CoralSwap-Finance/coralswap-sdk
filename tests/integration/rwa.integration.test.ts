import { CoralSwapClient, Network } from "../../src";
import { RwaModule } from "../../src/rwa"; // CHECK: real export name/path

const RUN_INTEGRATION = process.env.STELLAR_TESTNET === "true" && Boolean(process.env.TEST_KEYPAIR && process.env.TEST_RWA_POOL && process.env.TEST_NAV_FEED_ID);
const describeIf = RUN_INTEGRATION ? describe : describe.skip;

describeIf("RwaModule (Stellar Testnet integration)", () => {
  let client: CoralSwapClient;
  let rwa: RwaModule; // CHECK: real class name

  const RWA_POOL = process.env.TEST_RWA_POOL as string;      // new env var — RWA pool contract address
  const NAV_FEED_ID = process.env.TEST_NAV_FEED_ID as string; // new env var — RedStone feed id for this pool
  const KEYPAIR = process.env.TEST_KEYPAIR as string;
  const RPC_URL = process.env.TEST_RPC_URL || "https://soroban-testnet.stellar.org";

  beforeAll(() => {
    if (!RUN_INTEGRATION) return;
    if (!RWA_POOL || !NAV_FEED_ID || !KEYPAIR) {
      throw new Error(
        "Missing required env vars for RWA integration test: TEST_RWA_POOL, TEST_NAV_FEED_ID, TEST_KEYPAIR"
      );
    }
    client = new CoralSwapClient({
      network: Network.TESTNET,
      rpcUrl: RPC_URL,
      secretKey: KEYPAIR,
    });
    rwa = new RwaModule(client); // CHECK: constructor signature
  });

  it("connects to the real RPC and reports healthy", async () => {
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  it("fetches real pool state from a deployed RWA pool on testnet", async () => {
    const poolState = await rwa.getPoolState(RWA_POOL); // CHECK: real method name
    expect(poolState).toBeDefined();
    expect(typeof poolState.totalAssets).toBe("bigint"); // CHECK: real field names
  });

  it("fetches real NAV feed data for the pool's underlying asset", async () => {
    const nav = await rwa.getNAV(NAV_FEED_ID); // CHECK: real method name/signature
    expect(nav).toBeDefined();
    expect(typeof nav.value).toBe("bigint"); // CHECK: real field name — may be number/string
    expect(nav.timestamp).toBeGreaterThan(0);
  });

  it("verifies pool state is consistent with the real NAV feed", async () => {
    const [poolState, nav] = await Promise.all([
      rwa.getPoolState(RWA_POOL),
      rwa.getNAV(NAV_FEED_ID),
    ]);
    // CHECK: replace with the actual relationship the module enforces —
    // e.g. pool's cached NAV should match (or be within tolerance of) the live feed
    expect(poolState.navFeedId).toBe(NAV_FEED_ID);
  });

  it("handles NAV feed staleness gracefully under real network conditions", async () => {
    const nav = await rwa.getNAV(NAV_FEED_ID);
    const ageSeconds = Math.floor(Date.now() / 1000) - nav.timestamp;

    // Don't assert a specific staleness outcome — testnet feed freshness
    // varies. Assert the SDK reports staleness correctly either way:
    if (ageSeconds > nav.maxStalenessSeconds) { // CHECK: real staleness threshold field
      expect(nav.isStale).toBe(true); // CHECK: real flag name, mirrors FeeModule's `isStale`
    } else {
      expect(nav.isStale).toBe(false);
    }
    // The SDK must not throw an uncaught error on a stale feed —
    // it should surface staleness as data, not an exception.
  });
});