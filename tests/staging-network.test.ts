import { Network } from "../src/types/common";
import { NETWORK_CONFIGS, NetworkConfig } from "../src/config";

describe("Staging Network Configuration", () => {
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

    const requiredKeys: (keyof NetworkConfig)[] = [
      "rpcUrl",
      "networkPassphrase",
      "factoryAddress",
      "routerAddress",
      "sorobanTimeout",
    ];

    for (const key of requiredKeys) {
      expect(staging).toHaveProperty(key);
      expect(typeof staging[key]).toBe(typeof testnet[key]);
    }
  });

  it("STAGING config has a valid rpcUrl", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(typeof staging.rpcUrl).toBe("string");
    expect(staging.rpcUrl.length).toBeGreaterThan(0);
    expect(staging.rpcUrl).toMatch(/^https?:\/\//);
  });

  it("STAGING config has a valid networkPassphrase", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(typeof staging.networkPassphrase).toBe("string");
    expect(staging.networkPassphrase.length).toBeGreaterThan(0);
  });

  it("STAGING config has a positive sorobanTimeout", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(staging.sorobanTimeout).toBeGreaterThan(0);
  });

  it("STAGING config has string factoryAddress and routerAddress", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    expect(typeof staging.factoryAddress).toBe("string");
    expect(typeof staging.routerAddress).toBe("string");
  });

  it("all three networks are present in NETWORK_CONFIGS", () => {
    expect(Object.keys(NETWORK_CONFIGS)).toHaveLength(3);
    expect(NETWORK_CONFIGS).toHaveProperty(Network.TESTNET);
    expect(NETWORK_CONFIGS).toHaveProperty(Network.MAINNET);
    expect(NETWORK_CONFIGS).toHaveProperty(Network.STAGING);
  });

  it("STAGING uses the testnet passphrase (staging runs on testnet)", () => {
    const staging = NETWORK_CONFIGS[Network.STAGING];
    const testnet = NETWORK_CONFIGS[Network.TESTNET];
    expect(staging.networkPassphrase).toBe(testnet.networkPassphrase);
  });
});
