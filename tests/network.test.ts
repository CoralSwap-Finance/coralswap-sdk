import { Keypair, SorobanRpc } from "@stellar/stellar-sdk";
import { CoralSwapClient } from "../src/client";
import { NetworkSwitcher } from "../src/contracts/switcher";
import { Network } from "../src/types/common";
import { NETWORK_CONFIGS } from "../src/config";
import { NotConfiguredError } from "../src/errors";
import {
  clearTokenDecimalsCache,
  getTokenDecimals,
} from "../src/utils/token-decimals";

// Mock SorobanRpc.Server
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation((rpcUrl) => ({
        rpcUrl,
        getAccount: jest.fn(),
        simulateTransaction: jest.fn(),
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      })),
    },
    Contract: jest.fn().mockImplementation((address) => ({
      address,
      call: jest.fn(),
    })),
  };
});

describe("Network Switching", () => {
  const TEST_SECRET =
    "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

  it("throws a typed error for undeployed mainnet contracts", () => {
    const client = new CoralSwapClient({ network: Network.MAINNET });
    expect(() => client.factory).toThrow(NotConfiguredError);
    expect(() => client.router).toThrow(NotConfiguredError);
  });

  it("names the missing config key and how to set it on every undeployed network", () => {
    const capture = (access: () => unknown): NotConfiguredError => {
      try {
        access();
      } catch (err) {
        expect(err).toBeInstanceOf(NotConfiguredError);
        return err as NotConfiguredError;
      }
      throw new Error("expected access to throw NotConfiguredError");
    };

    const cases = [
      {
        network: Network.MAINNET,
        accessor: "factory" as const,
        configKey: "factoryAddress",
      },
      {
        network: Network.MAINNET,
        accessor: "router" as const,
        configKey: "routerAddress",
      },
      {
        network: Network.STAGING,
        accessor: "factory" as const,
        configKey: "factoryAddress",
      },
      {
        network: Network.STAGING,
        accessor: "router" as const,
        configKey: "routerAddress",
      },
    ];

    for (const { network, accessor, configKey } of cases) {
      const client = new CoralSwapClient({ network });
      const err = capture(() => client[accessor]);

      expect(err.code).toBe("NOT_CONFIGURED");
      expect(err.configKey).toBe(configKey);
      expect(err.details?.configKey).toBe(configKey);
      expect(err.details?.network).toBe(network);

      // Actionable: names the config key, the network and the accessor.
      expect(err.message).toContain(configKey);
      expect(err.message).toContain(network);
      expect(err.message).toContain(`client.${accessor}`);
    }
  });

  it("CoralSwapClient.setNetwork updates configuration correctly", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    expect(client.network).toBe(Network.TESTNET);
    expect(client.networkConfig.networkPassphrase).toBe(
      NETWORK_CONFIGS[Network.TESTNET].networkPassphrase,
    );
    const initialServer = client.server;

    // Switch to Mainnet
    client.setNetwork(Network.MAINNET);

    expect(client.network).toBe(Network.MAINNET);
    expect(client.networkConfig.networkPassphrase).toBe(
      NETWORK_CONFIGS[Network.MAINNET].networkPassphrase,
    );
    expect(client.server).not.toBe(initialServer);
    expect(String((client.server as any).serverURL)).toBe(
      NETWORK_CONFIGS[Network.MAINNET].rpcUrl + "/",
    );
  });

  it("CoralSwapClient.setNetwork resets contract singletons", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      // Need factoryAddress in config for TESTNET if it's empty in config.ts,
      // but let's assume it's empty and we check if the cache is cleared.
    });

    // Mock factoryAddress with valid contract addresses
    (client as any).networkConfig.factoryAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    const factory1 = client.factory;
    expect(factory1).toBeDefined();

    client.setNetwork(Network.MAINNET);

    // After reset, checking if the private field is null would be best,
    // but we can check if a new access creates a new instance.
    // However, since we can't easily check private fields in TS tests without casting,
    // let's just verify properties of the new client are updated if we had different addresses.

    (client as any).networkConfig.factoryAddress =
      "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
    const factory2 = client.factory;
    expect(factory2).not.toBe(factory1);
  });

  it("NetworkSwitcher wraps client.setNetwork correctly", async () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    const switcher = new NetworkSwitcher(client);

    // Mock resolvePublicKey to avoid errors
    client.resolvePublicKey = jest.fn().mockResolvedValue("test-pubkey");

    await switcher.switchNetwork(Network.MAINNET);

    expect(client.network).toBe(Network.MAINNET);
    expect(client.resolvePublicKey).toHaveBeenCalled();
  });

  it("supports custom RPC URL during network switch", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    const customRpc = "https://my-custom-rpc.com";
    client.setNetwork(Network.MAINNET, customRpc);

    expect(client.network).toBe(Network.MAINNET);
    expect(client.networkConfig.rpcUrl).toBe(customRpc);
    expect(String((client.server as any).serverURL)).toBe(customRpc + "/");
  });

  it("resets network-scoped caches and singletons when switching networks", async () => {
    clearTokenDecimalsCache();
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    const factoryAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const routerAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
    (client as any).networkConfig.factoryAddress = factoryAddress;
    (client as any).networkConfig.routerAddress = routerAddress;

    const initialPoller = client.poller();
    const initialFactory = client.factory;
    const initialRouter = client.router;
    const factoryModule = client.factoryModule();
    (factoryModule as any).cache.set("A:B", {
      address: factoryAddress,
      expiresAt: Date.now() + 60_000,
    });

    const tokenAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const lpToken = {
      metadata: jest.fn().mockResolvedValue({ decimals: 9 }),
    };
    (client as any).lpToken = jest.fn().mockReturnValue(lpToken);
    await getTokenDecimals(client, tokenAddress);
    expect((client as any).lpToken).toHaveBeenCalledTimes(1);

    client.setNetwork(Network.MAINNET);

    (client as any).networkConfig.factoryAddress = factoryAddress;
    (client as any).networkConfig.routerAddress = routerAddress;

    expect(client.poller()).not.toBe(initialPoller);
    expect(client.factory).not.toBe(initialFactory);
    expect(client.router).not.toBe(initialRouter);
    expect((client.factoryModule() as any).cache.size).toBe(0);
    expect(client.network).toBe(Network.MAINNET);
    expect(client.networkConfig.networkPassphrase).toBe(
      NETWORK_CONFIGS[Network.MAINNET].networkPassphrase,
    );

    await getTokenDecimals(client, tokenAddress);
    expect((client as any).lpToken).toHaveBeenCalledTimes(2);
  });

  it("leaves the client usable when an invalid network switch fails mid-reset", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    const factoryAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    (client as any).networkConfig.factoryAddress = factoryAddress;
    (client as any).networkConfig.routerAddress = factoryAddress;

    const beforeServer = client.server;
    const beforePoller = client.poller();
    const beforeFactory = client.factory;
    const beforeRouter = client.router;

    expect(() =>
      client.setNetwork(Network.MAINNET, "http://localhost:8000"),
    ).toThrow();

    expect(client.network).toBe(Network.TESTNET);
    expect(client.server).toBe(beforeServer);
    expect(client.poller()).toBe(beforePoller);
    expect(client.factory).toBe(beforeFactory);
    expect(client.router).toBe(beforeRouter);
  });

  it("supports reselecting the same network without breaking the client", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    const factoryAddress =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    (client as any).networkConfig.factoryAddress = factoryAddress;
    (client as any).networkConfig.routerAddress = factoryAddress;

    const beforeServer = client.server;
    const beforePoller = client.poller();
    const beforeFactory = client.factory;
    const beforeRouter = client.router;

    expect(() => client.setNetwork(Network.TESTNET)).not.toThrow();
    expect(client.network).toBe(Network.TESTNET);
    expect(client.networkConfig.networkPassphrase).toBe(
      NETWORK_CONFIGS[Network.TESTNET].networkPassphrase,
    );
    expect(client.server).not.toBe(beforeServer);
    expect(client.poller()).not.toBe(beforePoller);
    expect(client.factory).not.toBe(beforeFactory);
    expect(client.router).not.toBe(beforeRouter);
  });
});

describe("Staging Network Configuration", () => {
  const TEST_SECRET =
    "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

  it("STAGING is a valid Network enum value", () => {
    expect(Network.STAGING).toBe("staging");
  });

  it("NETWORK_CONFIGS contains a STAGING entry", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(staging).toBeDefined();
  });

  it("STAGING config has the same shape as TESTNET and MAINNET", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    const testnet = NETWORK_CONFIGS[Network.TESTNET];

    // Verify all required keys exist
    const requiredKeys: (keyof typeof testnet)[] = [
      "rpcUrl",
      "networkPassphrase",
      "factoryAddress",
      "routerAddress",
      "sorobanTimeout",
    ];

    for (const key of requiredKeys) {
      expect(staging).toHaveProperty(key);
    }
  });

  it("STAGING config has valid rpcUrl", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(typeof staging.rpcUrl).toBe("string");
    expect(staging.rpcUrl.length).toBeGreaterThan(0);
    expect(staging.rpcUrl).toMatch(/^https?:\/\//);
  });

  it("STAGING config has valid networkPassphrase", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(typeof staging.networkPassphrase).toBe("string");
    expect(staging.networkPassphrase.length).toBeGreaterThan(0);
  });

  it("STAGING config has a positive sorobanTimeout", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(staging.sorobanTimeout).toBeGreaterThan(0);
  });

  it("CoralSwapClient can be initialized with STAGING network", () => {
    const client = new CoralSwapClient({
      network: Network.STAGING,
      secretKey: TEST_SECRET,
    });

    expect(client.network).toBe(Network.STAGING);
    expect(client.networkConfig).toEqual(NETWORK_CONFIGS[Network.STAGING]);
  });

  it("can switch from TESTNET to STAGING", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    client.setNetwork(Network.STAGING);

    expect(client.network).toBe(Network.STAGING);
    expect(client.networkConfig.rpcUrl).toBe(
      NETWORK_CONFIGS[Network.STAGING].rpcUrl,
    );
  });

  it("can switch from STAGING to MAINNET", () => {
    const client = new CoralSwapClient({
      network: Network.STAGING,
      secretKey: TEST_SECRET,
    });

    client.setNetwork(Network.MAINNET);

    expect(client.network).toBe(Network.MAINNET);
    expect(client.networkConfig.rpcUrl).toBe(
      NETWORK_CONFIGS[Network.MAINNET].rpcUrl,
    );
  });
});

describe("RPC URL scheme validation on setNetwork", () => {
  const TEST_SECRET =
    "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";

  it("rejects cleartext http when switching to mainnet", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    expect(() =>
      client.setNetwork(Network.MAINNET, "http://localhost:8000"),
    ).toThrow(/cleartext/i);
  });

  it("allows cleartext http when switching to testnet", () => {
    const client = new CoralSwapClient({
      network: Network.MAINNET,
      secretKey: TEST_SECRET,
    });

    client.setNetwork(Network.TESTNET, "http://localhost:8000");

    expect(client.networkConfig.rpcUrl).toBe("http://localhost:8000");
  });

  it("allows https when switching to mainnet", () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    client.setNetwork(Network.MAINNET, "https://soroban.stellar.org");

    expect(client.networkConfig.rpcUrl).toBe("https://soroban.stellar.org");
  });
});
