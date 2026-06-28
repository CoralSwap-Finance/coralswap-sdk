import { StakingModule } from "../src/modules/staking";
import { CoralSwapClient } from "../src/client";
import {
  ValidationError,
  TransactionError,
  CooldownError,
  StakingError,
} from "../src/errors";
import type { Signer } from "../src/types/common";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOCK_LP_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const MOCK_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_REWARD_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const MOCK_TX_HASH = "abc123def456";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Signer for testing.
 */
function createMockSigner(publicKey: string = MOCK_ADDRESS): Signer {
  return {
    publicKey: jest.fn().mockResolvedValue(publicKey),
    signTransaction: jest.fn().mockResolvedValue("signed_xdr"),
  };
}

/**
 * Build a mock account object matching what SorobanRpc.Server.getAccount returns.
 */
function createMockAccount() {
  return {
    accountId: jest.fn().mockReturnValue(MOCK_ADDRESS),
    sequenceNumber: jest.fn().mockReturnValue("1"),
    sequence: jest.fn().mockReturnValue("1"),
    incrementSequenceNumber: jest.fn(),
  };
}

/**
 * Create a successful simulation response.
 * `isSimulationSuccess` checks for `'transactionData' in sim`.
 */
function createSuccessSimResponse(retval: unknown) {
  return {
    transactionData: "mock_transaction_data",
    result: { retval },
    latestLedger: 100,
  };
}

/**
 * Create a failed simulation response (no transactionData).
 */
function createFailedSimResponse() {
  return {
    error: "simulation failed",
    latestLedger: 100,
  };
}

/**
 * Build a mock CoralSwapClient with overridable simulation results.
 */
function createMockClient(
  overrides: {
    simulationResult?: unknown;
    simulationFail?: boolean;
    submitSuccess?: boolean;
    submitTxHash?: string;
    submitErrorMessage?: string;
    simulateTransactionFn?: jest.Mock;
  } = {},
): CoralSwapClient {
  const {
    simulationResult = null,
    simulationFail = false,
    submitSuccess = true,
    submitTxHash = MOCK_TX_HASH,
    submitErrorMessage = "Unknown error",
    simulateTransactionFn,
  } = overrides;

  const simResponse = simulationFail || !simulationResult
    ? createFailedSimResponse()
    : createSuccessSimResponse(simulationResult);

  const mockServer = {
    getAccount: jest.fn().mockResolvedValue(createMockAccount()),
    simulateTransaction: simulateTransactionFn ?? jest.fn().mockResolvedValue(simResponse),
  };

  return {
    server: mockServer,
    networkConfig: {
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      factoryAddress: "CAAAA...",
      routerAddress: "CAAAA...",
      sorobanTimeout: 30,
    },
    submitTransaction: jest.fn().mockResolvedValue(
      submitSuccess
        ? { success: true, txHash: submitTxHash, data: { ledger: 100 } }
        : { success: false, txHash: submitTxHash, error: { message: submitErrorMessage } },
    ),
  } as unknown as CoralSwapClient;
}

/**
 * Create a mock ScVal map representing a StakedPosition.
 */
function createMockStakeResult(
  amount: bigint,
  stakedAt: number,
  cooldownEnd: number,
) {
  return {
    map: () => [
      {
        key: () => ({ sym: () => ({ toString: () => "amount" }) }),
        val: () => ({
          i128: () => ({
            lo: () => ({ toString: () => (amount & ((1n << 64n) - 1n)).toString() }),
            hi: () => ({ toString: () => (amount >> 64n).toString() }),
          }),
        }),
      },
      {
        key: () => ({ sym: () => ({ toString: () => "staked_at" }) }),
        val: () => ({ u64: () => BigInt(stakedAt) }),
      },
      {
        key: () => ({ sym: () => ({ toString: () => "cooldown_end" }) }),
        val: () => ({ u64: () => BigInt(cooldownEnd) }),
      },
    ],
  };
}

/**
 * Create a mock ScVal map representing StakingRewards.
 */
function createMockRewardsResult(
  pendingRewards: bigint,
  claimedRewards: bigint,
  projectedAPYBps: number,
  rewardToken: string = MOCK_REWARD_TOKEN,
) {
  return {
    map: () => [
      {
        key: () => ({ sym: () => ({ toString: () => "pending_rewards" }) }),
        val: () => ({
          i128: () => ({
            lo: () => ({ toString: () => (pendingRewards & ((1n << 64n) - 1n)).toString() }),
            hi: () => ({ toString: () => (pendingRewards >> 64n).toString() }),
          }),
        }),
      },
      {
        key: () => ({ sym: () => ({ toString: () => "claimed_rewards" }) }),
        val: () => ({
          i128: () => ({
            lo: () => ({ toString: () => (claimedRewards & ((1n << 64n) - 1n)).toString() }),
            hi: () => ({ toString: () => (claimedRewards >> 64n).toString() }),
          }),
        }),
      },
      {
        key: () => ({ sym: () => ({ toString: () => "projected_apy" }) }),
        val: () => ({ u32: () => projectedAPYBps }),
      },
      {
        key: () => ({ sym: () => ({ toString: () => "reward_token" }) }),
        val: () => ({
          address: () => ({ toString: () => rewardToken }),
        }),
      },
    ],
  };
}

/**
 * Create a mock ScVal map representing CooldownStatus.
 */
function createMockCooldownResult(cooldownEnd: number) {
  return {
    map: () => [
      {
        key: () => ({ sym: () => ({ toString: () => "cooldown_end" }) }),
        val: () => ({ u64: () => BigInt(cooldownEnd) }),
      },
    ],
  };
}

/**
 * Create a mock ScVal for getStakingAPY (returns u32 basis points).
 */
function createMockAPYResult(apyBps: number) {
  return {
    u32: () => apyBps,
  };
}

/**
 * Helper to build a mock client that returns different sim results
 * for sequential calls (e.g. getCooldownStatus then getStakedBalance).
 */
function createSequentialMockClient(
  simResults: unknown[],
  submitSuccess = true,
): CoralSwapClient {
  let callCount = 0;
  const simulateTransactionFn = jest.fn().mockImplementation(() => {
    const result = simResults[callCount];
    callCount++;
    if (result) {
      return createSuccessSimResponse(result);
    }
    return createFailedSimResponse();
  });

  return createMockClient({
    simulateTransactionFn,
    submitSuccess,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StakingModule", () => {
  // -----------------------------------------------------------------------
  // stake()
  // -----------------------------------------------------------------------
  describe("stake()", () => {
    it("should return tx hash on successful stake", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      const txHash = await module.stake(MOCK_LP_TOKEN, 1000n, signer);

      expect(txHash).toBe(MOCK_TX_HASH);
      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it("should reject zero amount with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.stake(MOCK_LP_TOKEN, 0n, signer),
      ).rejects.toThrow(ValidationError);
    });

    it("should reject negative amount with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.stake(MOCK_LP_TOKEN, -100n, signer),
      ).rejects.toThrow(ValidationError);
    });

    it("should reject invalid LP token address with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.stake("invalid_address", 1000n, signer),
      ).rejects.toThrow(ValidationError);
    });

    it("should throw TransactionError on failed submission", async () => {
      const client = createMockClient({
        submitSuccess: false,
        submitErrorMessage: "Insufficient balance",
      });
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.stake(MOCK_LP_TOKEN, 1000n, signer),
      ).rejects.toThrow(TransactionError);
    });
  });

  // -----------------------------------------------------------------------
  // getStakedBalance()
  // -----------------------------------------------------------------------
  describe("getStakedBalance()", () => {
    it("should return zero position for non-staker", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      const position = await module.getStakedBalance(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(position.amount).toBe(0n);
      expect(position.stakedAt).toBe(0);
      expect(position.cooldownEnd).toBe(0);
    });

    it("should return correct staked position", async () => {
      const mockResult = createMockStakeResult(5000n, 1719400000, 1719500000);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const position = await module.getStakedBalance(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(position.amount).toBe(5000n);
      expect(position.stakedAt).toBe(1719400000);
      expect(position.cooldownEnd).toBe(1719500000);
    });

    it("should reject invalid address with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      await expect(
        module.getStakedBalance("bad", MOCK_LP_TOKEN),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // getStakingAPY()
  // -----------------------------------------------------------------------
  describe("getStakingAPY()", () => {
    it("should return annualized APY from basis points", async () => {
      const mockResult = createMockAPYResult(1200); // 12%
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const apy = await module.getStakingAPY(MOCK_LP_TOKEN);

      expect(apy).toBeCloseTo(0.12);
    });

    it("should return 0 when no staking data exists", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      const apy = await module.getStakingAPY(MOCK_LP_TOKEN);

      expect(apy).toBe(0);
    });

    it("should reject invalid LP token address", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      await expect(
        module.getStakingAPY("not_valid"),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // getStakingRewards()
  // -----------------------------------------------------------------------
  describe("getStakingRewards()", () => {
    it("should return zero rewards for non-staker", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      const rewards = await module.getStakingRewards(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(rewards.pendingRewards).toBe(0n);
      expect(rewards.claimedRewards).toBe(0n);
      expect(rewards.projectedAPY).toBe(0);
      expect(rewards.rewardToken).toBe("");
    });

    it("should return correct reward accrual", async () => {
      const mockResult = createMockRewardsResult(500n, 2000n, 1500);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const rewards = await module.getStakingRewards(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(rewards.pendingRewards).toBe(500n);
      expect(rewards.claimedRewards).toBe(2000n);
      expect(rewards.projectedAPY).toBeCloseTo(0.15);
    });

    it("should correctly annualize projectedAPY", async () => {
      const mockResult = createMockRewardsResult(100n, 0n, 10000); // 100%
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const rewards = await module.getStakingRewards(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(rewards.projectedAPY).toBeCloseTo(1.0);
    });
  });

  // -----------------------------------------------------------------------
  // claimRewards()
  // -----------------------------------------------------------------------
  describe("claimRewards()", () => {
    it("should return tx hash when rewards are claimed", async () => {
      const mockRewards = createMockRewardsResult(500n, 0n, 1200);
      const client = createMockClient({ simulationResult: mockRewards });
      const module = new StakingModule(client);
      const signer = createMockSigner();

      const txHash = await module.claimRewards(MOCK_LP_TOKEN, signer);

      expect(txHash).toBe(MOCK_TX_HASH);
    });

    it("should throw StakingError when no rewards are pending", async () => {
      const client = createMockClient(); // null simulation = 0 pending
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.claimRewards(MOCK_LP_TOKEN, signer),
      ).rejects.toThrow(StakingError);
    });

    it("should throw StakingError with correct message when no rewards", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.claimRewards(MOCK_LP_TOKEN, signer),
      ).rejects.toThrow("No rewards pending to claim");
    });
  });

  // -----------------------------------------------------------------------
  // unstake()
  // -----------------------------------------------------------------------
  describe("unstake()", () => {
    it("should return tx hash on successful unstake after cooldown", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const mockCooldown = createMockCooldownResult(pastTimestamp);
      const mockStake = createMockStakeResult(1000n, pastTimestamp - 86400, pastTimestamp);

      const client = createSequentialMockClient([mockCooldown, mockStake]);
      const module = new StakingModule(client);
      const signer = createMockSigner();

      const txHash = await module.unstake(MOCK_LP_TOKEN, 500n, signer);

      expect(txHash).toBe(MOCK_TX_HASH);
    });

    it("should throw CooldownError during active cooldown", async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
      const mockCooldown = createMockCooldownResult(futureTimestamp);

      const client = createMockClient({ simulationResult: mockCooldown });
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.unstake(MOCK_LP_TOKEN, 500n, signer),
      ).rejects.toThrow(CooldownError);
    });

    it("should include cooldownEnd in CooldownError", async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
      const mockCooldown = createMockCooldownResult(futureTimestamp);

      const client = createMockClient({ simulationResult: mockCooldown });
      const module = new StakingModule(client);
      const signer = createMockSigner();

      try {
        await module.unstake(MOCK_LP_TOKEN, 500n, signer);
        fail("Should have thrown CooldownError");
      } catch (err) {
        expect(err).toBeInstanceOf(CooldownError);
        expect((err as CooldownError).cooldownEnd).toBe(futureTimestamp);
        expect((err as CooldownError).canWithdrawAt).toBeInstanceOf(Date);
      }
    });

    it("should reject zero unstake amount with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.unstake(MOCK_LP_TOKEN, 0n, signer),
      ).rejects.toThrow(ValidationError);
    });

    it("should throw StakingError when unstake exceeds staked balance", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const mockCooldown = createMockCooldownResult(pastTimestamp);
      const mockStake = createMockStakeResult(100n, pastTimestamp - 86400, pastTimestamp);

      const client = createSequentialMockClient([mockCooldown, mockStake]);
      const module = new StakingModule(client);
      const signer = createMockSigner();

      await expect(
        module.unstake(MOCK_LP_TOKEN, 200n, signer),
      ).rejects.toThrow(StakingError);
    });

    it("should support partial unstake", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const mockCooldown = createMockCooldownResult(pastTimestamp);
      const mockStake = createMockStakeResult(1000n, pastTimestamp - 86400, pastTimestamp);

      const client = createSequentialMockClient([mockCooldown, mockStake]);
      const module = new StakingModule(client);
      const signer = createMockSigner();

      // Partial unstake of 300 from 1000 staked
      const txHash = await module.unstake(MOCK_LP_TOKEN, 300n, signer);
      expect(txHash).toBe(MOCK_TX_HASH);
    });
  });

  // -----------------------------------------------------------------------
  // getCooldownStatus()
  // -----------------------------------------------------------------------
  describe("getCooldownStatus()", () => {
    it("should return not in cooldown when no data exists", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      const status = await module.getCooldownStatus(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(status.isInCooldown).toBe(false);
      expect(status.cooldownEnd).toBe(0);
    });

    it("should detect active cooldown when end is in the future", async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 7200;
      const mockResult = createMockCooldownResult(futureTimestamp);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const status = await module.getCooldownStatus(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(status.isInCooldown).toBe(true);
      expect(status.cooldownEnd).toBe(futureTimestamp);
      expect(status.canWithdrawAt).toBeInstanceOf(Date);
      expect(status.canWithdrawAt.getTime()).toBe(futureTimestamp * 1000);
    });

    it("should detect expired cooldown when end is in the past", async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const mockResult = createMockCooldownResult(pastTimestamp);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const status = await module.getCooldownStatus(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(status.isInCooldown).toBe(false);
      expect(status.cooldownEnd).toBe(pastTimestamp);
    });

    it("should reject invalid address with ValidationError", async () => {
      const client = createMockClient();
      const module = new StakingModule(client);

      await expect(
        module.getCooldownStatus("xyz", MOCK_LP_TOKEN),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("should handle max uint128 staked amount", async () => {
      const maxU128 = (1n << 128n) - 1n;
      const mockResult = createMockStakeResult(maxU128, 1719400000, 0);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const position = await module.getStakedBalance(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(position.amount).toBe(maxU128);
    });

    it("should handle zero cooldown end (never staked)", async () => {
      const mockResult = createMockCooldownResult(0);
      const client = createMockClient({ simulationResult: mockResult });
      const module = new StakingModule(client);

      const status = await module.getCooldownStatus(MOCK_ADDRESS, MOCK_LP_TOKEN);

      expect(status.isInCooldown).toBe(false);
      expect(status.cooldownEnd).toBe(0);
    });
  });
});
