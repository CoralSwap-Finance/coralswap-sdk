import { CoralSwapClient, Network } from "../../src";
import { RWAModule } from "../../src/rwa";

const RUN_INTEGRATION =
  process.env.STELLAR_TESTNET === "true" &&
  Boolean(process.env.TEST_KEYPAIR && process.env.TEST_RWA_POOL);
const describeIf = RUN_INTEGRATION ? describe : describe.skip;

describeIf("RWAModule (Stellar Testnet integration)", () => {
  let client: CoralSwapClient;
  let rwa: RWAModule;

  const KEYPAIR = process.env.TEST_KEYPAIR as string;
  const RPC_URL =
    process.env.TEST_RPC_URL || "https://soroban-testnet.stellar.org";

  beforeAll(() => {
    if (!RUN_INTEGRATION) return;
    client = new CoralSwapClient({
      network: Network.TESTNET,
      rpcUrl: RPC_URL,
      secretKey: KEYPAIR,
    });
    rwa = new RWAModule(client);
  });

  it("initializes RWAModule successfully", () => {
    expect(rwa).toBeDefined();
  });

  it("connects to the real RPC and reports healthy", async () => {
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });
});