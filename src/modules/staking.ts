import {
  Contract,
  rpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { CoralSwapClient } from "@/client";
import {
  StakedPosition,
  StakingRewards,
  CooldownStatus,
  VoteEligibility,
} from "@/types/staking";
import { Signer } from "@/types/common";
import { RemoveLiquidityRequest, LiquidityResult } from "@/types/liquidity";
import {
  ValidationError,
  TransactionError,
  CooldownError,
  StakingError,
} from "@/errors";
import {
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateDistinctTokens,
} from "@/utils/validation";
import { isValidAddress } from "@/utils/addresses";
import { validateWithSchema } from "@/schemas";
import { z } from "zod";

/**
 * Staking module — manages LP token staking for governance weight
 * and protocol rewards in CoralSwap pools.
 *
 * Provides staking, unstaking with cooldown enforcement, reward
 * accrual/claiming, and APY querying through the staking contract.
 *
 * @example
 * ```ts
 * const staking = new StakingModule(client);
 *
 * // Stake LP tokens
 * const txHash = await staking.stake(lpTokenAddr, 1000n, signer);
 *
 * // Check rewards
 * const rewards = await staking.getStakingRewards(myAddr, lpTokenAddr);
 * console.log('Pending:', rewards.pendingRewards);
 * ```
 */
// ---------------------------------------------------------------------------
// Zod schema — validates stake/unstake input parameters
// ---------------------------------------------------------------------------

const StakeOperationSchema = z.object({
  lpTokenAddress: z
    .string()
    .min(1, "lpTokenAddress must not be empty")
    .superRefine((val, ctx) => {
      if (!isValidAddress(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `lpTokenAddress is not a valid Stellar address: ${val}`,
        });
      }
    }),
  amount: z.bigint().superRefine((val, ctx) => {
    if (val <= 0n) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `amount must be greater than 0, got ${val}`,
      });
    }
  }),
});

/**
 * Validate stake/unstake parameters against the Zod schema.
 *
 * @throws {ValidationError} If any parameter fails validation.
 */
function validateStakeParams(lpTokenAddress: string, amount: bigint): void {
  validateWithSchema(
    StakeOperationSchema,
    { lpTokenAddress, amount },
    "stake.params",
  );
}

export class StakingModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Stake LP tokens into the staking contract for governance weight
   * and reward accrual.
   *
   * @param lpTokenAddress - The contract address of the LP token to stake.
   * @param amount - The amount of LP tokens to stake (must be > 0).
   * @param signer - The signer authorizing the stake transaction.
   * @returns The transaction hash of the submitted stake operation.
   * @throws {ValidationError} If amount is not positive or address is invalid.
   * @throws {TransactionError} If the transaction fails on-chain.
   *
   * @example
   * ```ts
   * const txHash = await staking.stake('CAAAA...', 1000n, mySigner);
   * ```
   */
  buildStakeOperation(
    lpTokenAddress: string,
    amount: bigint,
    publicKey: string,
  ): xdr.Operation {
    validateStakeParams(lpTokenAddress, amount);

    const contract = new Contract(lpTokenAddress);

    return contract.call(
      "stake",
      nativeToScVal(Address.fromString(publicKey), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
  }

  async stake(
    lpTokenAddress: string,
    amount: bigint,
    signer: Signer,
  ): Promise<string> {
    validateStakeParams(lpTokenAddress, amount);
    const publicKey = await signer.publicKey();

    const op = this.buildStakeOperation(lpTokenAddress, amount, publicKey);

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Stake failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return result.txHash!;
  }

  /**
   * Get the staked LP token position for an address.
   *
   * @param address - The Stellar address of the staker.
   * @param lpTokenAddress - The contract address of the LP token.
   * @returns The staker's position including amount, stake time, and cooldown end.
   *
   * @example
   * ```ts
   * const position = await staking.getStakedBalance('GABC...', 'CAAAA...');
   * console.log('Staked:', position.amount);
   * ```
   */
  async getStakedBalance(
    address: string,
    lpTokenAddress: string,
  ): Promise<StakedPosition> {
    validateAddress(address, "address");
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const contract = new Contract(lpTokenAddress);

    const op = contract.call(
      "get_stake",
      nativeToScVal(Address.fromString(address), { type: "address" }),
    );

    const result = await this.simulateRead(op);

    if (!result) {
      return { amount: 0n, stakedAt: 0, cooldownEnd: 0 };
    }

    const fields = result.type === "scvMap" ? result.map : undefined;
    return {
      amount: this.extractI128(fields, "amount"),
      stakedAt: this.extractU64(fields, "staked_at"),
      cooldownEnd: this.extractU64(fields, "cooldown_end"),
    };
  }

  /**
   * Get the current staking APY for an LP token pool.
   *
   * The APY is annualized based on the current reward emission rate
   * and total staked supply.
   *
   * @param lpTokenAddress - The contract address of the LP token.
   * @returns The annualized staking yield as a decimal (e.g. 0.12 = 12%).
   *
   * @example
   * ```ts
   * const apy = await staking.getStakingAPY('CAAAA...');
   * console.log(`APY: ${(apy * 100).toFixed(2)}%`);
   * ```
   */
  async getStakingAPY(lpTokenAddress: string): Promise<number> {
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const contract = new Contract(lpTokenAddress);
    const op = contract.call("get_staking_apy");

    const result = await this.simulateRead(op);

    if (!result) {
      return 0;
    }

    // APY is returned as basis points (u32), convert to decimal
    const apyVal = result.type === "scvU32" ? result.u32 : 0;
    return apyVal / 10000;
  }

  /**
   * Get accrued staking rewards for an address.
   *
   * Returns pending (unclaimed) rewards, historical claimed rewards,
   * projected APY, and the reward token address.
   *
   * @param address - The Stellar address of the staker.
   * @param lpTokenAddress - The contract address of the LP token.
   * @returns The staker's reward details.
   *
   * @example
   * ```ts
   * const rewards = await staking.getStakingRewards('GABC...', 'CAAAA...');
   * if (rewards.pendingRewards > 0n) {
   *   console.log('Claimable:', rewards.pendingRewards);
   * }
   * ```
   */
  async getStakingRewards(
    address: string,
    lpTokenAddress: string,
  ): Promise<StakingRewards> {
    validateAddress(address, "address");
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const contract = new Contract(lpTokenAddress);

    const op = contract.call(
      "get_rewards",
      nativeToScVal(Address.fromString(address), { type: "address" }),
    );

    const result = await this.simulateRead(op);

    if (!result) {
      return {
        pendingRewards: 0n,
        claimedRewards: 0n,
        projectedAPY: 0,
        rewardToken: "",
      };
    }

    const fields = result.type === "scvMap" ? result.map : undefined;
    return {
      pendingRewards: this.extractI128(fields, "pending_rewards"),
      claimedRewards: this.extractI128(fields, "claimed_rewards"),
      projectedAPY: this.extractU32(fields, "projected_apy") / 10000,
      rewardToken: this.extractAddress(fields, "reward_token"),
    };
  }

  /**
   * Claim accrued staking rewards.
   *
   * Transfers all pending reward tokens to the caller's address.
   *
   * @param lpTokenAddress - The contract address of the LP token.
   * @param signer - The signer authorizing the claim transaction.
   * @returns The transaction hash of the submitted claim operation.
   * @throws {StakingError} If no rewards are pending.
   * @throws {TransactionError} If the transaction fails on-chain.
   *
   * @example
   * ```ts
   * const txHash = await staking.claimRewards('CAAAA...', mySigner);
   * ```
   */
  async claimRewards(lpTokenAddress: string, signer: Signer): Promise<string> {
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const publicKey = await signer.publicKey();
    const rewards = await this.getStakingRewards(publicKey, lpTokenAddress);

    if (rewards.pendingRewards === 0n) {
      throw new StakingError("No rewards pending to claim", {
        address: publicKey,
        lpTokenAddress,
      });
    }

    const contract = new Contract(lpTokenAddress);

    const op = contract.call(
      "claim_rewards",
      nativeToScVal(Address.fromString(publicKey), { type: "address" }),
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Claim rewards failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return result.txHash!;
  }

  /**
   * Unstake LP tokens from the staking contract.
   *
   * Supports partial unstaking. Validates that the cooldown period
   * has elapsed before allowing withdrawal.
   *
   * @param lpTokenAddress - The contract address of the LP token.
   * @param amount - The amount of LP tokens to unstake (must be > 0).
   * @param signer - The signer authorizing the unstake transaction.
   * @returns The transaction hash of the submitted unstake operation.
   * @throws {ValidationError} If amount is not positive or address is invalid.
   * @throws {CooldownError} If the cooldown period has not elapsed.
   * @throws {StakingError} If unstake amount exceeds staked balance.
   * @throws {TransactionError} If the transaction fails on-chain.
   *
   * @example
   * ```ts
   * const txHash = await staking.unstake('CAAAA...', 500n, mySigner);
   * ```
   */
  async unstake(
    lpTokenAddress: string,
    amount: bigint,
    signer: Signer,
  ): Promise<string> {
    const publicKey = await signer.publicKey();
    const op = await this.buildUnstakeOperation(
      lpTokenAddress,
      amount,
      publicKey,
    );

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new TransactionError(
        `Unstake failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return result.txHash!;
  }

  /**
   * Validate cooldown/balance and build the `unstake` operation, without
   * submitting it. Shared by {@link unstake} and {@link unstakeAndWithdraw}.
   */
  private async buildUnstakeOperation(
    lpTokenAddress: string,
    amount: bigint,
    publicKey: string,
  ): Promise<xdr.Operation> {
    validateStakeParams(lpTokenAddress, amount);

    // Enforce cooldown period
    const cooldownStatus = await this.getCooldownStatus(
      publicKey,
      lpTokenAddress,
    );
    if (cooldownStatus.isInCooldown) {
      throw new CooldownError(BigInt(cooldownStatus.cooldownEnd));
    }

    // Validate unstake amount does not exceed staked balance
    const position = await this.getStakedBalance(publicKey, lpTokenAddress);
    if (amount > position.amount) {
      throw new StakingError(
        `Unstake amount ${amount} exceeds staked balance ${position.amount}`,
        {
          requested: amount.toString(),
          staked: position.amount.toString(),
        },
      );
    }

    const contract = new Contract(lpTokenAddress);

    return contract.call(
      "unstake",
      nativeToScVal(Address.fromString(publicKey), { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
  }

  /**
   * Unstake LP tokens and withdraw them from the pool as a single atomic
   * transaction, once cooldown has elapsed.
   *
   * Unstaking (subject to cooldown) followed by withdrawing from the pool is
   * a common exit flow, normally done as two sequential transactions. This
   * composes both operations with a {@link TransactionComposer} so a failure
   * in either leg rolls back both — there's no window where LP tokens have
   * been unstaked but liquidity hasn't been withdrawn, or vice versa.
   *
   * @param lpTokenAddress - The contract address of the staked LP token.
   * @param amount - The amount of LP tokens to unstake (must be > 0).
   * @param removeLiquidityRequest - Parameters for the liquidity withdrawal.
   *   `removeLiquidityRequest.liquidity` should match `amount`.
   * @param signer - The signer authorizing both operations.
   * @returns The withdrawal amounts plus the transaction hash/ledger of the
   *   single atomic transaction.
   * @throws {ValidationError} If amount or liquidity-request fields are invalid.
   * @throws {CooldownError} If the cooldown period has not elapsed.
   * @throws {StakingError} If unstake amount exceeds staked balance.
   * @throws {TransactionError} If the composed transaction is rejected — in
   *   that case neither the unstake nor the withdrawal took effect.
   *
   * @example
   * ```ts
   * const result = await staking.unstakeAndWithdraw(
   *   lpTokenAddr,
   *   500n,
   *   {
   *     tokenA: 'CAAA...',
   *     tokenB: 'CBBB...',
   *     liquidity: 500n,
   *     amountAMin: 0n,
   *     amountBMin: 0n,
   *     to: myAddress,
   *   },
   *   mySigner,
   * );
   * ```
   */
  async unstakeAndWithdraw(
    lpTokenAddress: string,
    amount: bigint,
    removeLiquidityRequest: RemoveLiquidityRequest,
    signer: Signer,
  ): Promise<LiquidityResult> {
    validateAddress(removeLiquidityRequest.tokenA, "tokenA");
    validateAddress(removeLiquidityRequest.tokenB, "tokenB");
    validateDistinctTokens(
      removeLiquidityRequest.tokenA,
      removeLiquidityRequest.tokenB,
    );
    validateAddress(removeLiquidityRequest.to, "to");
    validatePositiveAmount(removeLiquidityRequest.liquidity, "liquidity");
    validateNonNegativeAmount(removeLiquidityRequest.amountAMin, "amountAMin");
    validateNonNegativeAmount(removeLiquidityRequest.amountBMin, "amountBMin");

    const publicKey = await signer.publicKey();
    const unstakeOp = await this.buildUnstakeOperation(
      lpTokenAddress,
      amount,
      publicKey,
    );

    const deadline =
      removeLiquidityRequest.deadline ?? this.client.getDeadline();
    const withdrawOp = this.client.router.buildRemoveLiquidity(
      removeLiquidityRequest.to,
      removeLiquidityRequest.tokenA,
      removeLiquidityRequest.tokenB,
      removeLiquidityRequest.liquidity,
      removeLiquidityRequest.amountAMin,
      removeLiquidityRequest.amountBMin,
      deadline,
    );

    const composer = this.client.transactionComposer();
    composer.addOperation(unstakeOp).addOperation(withdrawOp);

    const result = await composer.submit();

    if (!result.success || !result.data) {
      throw new TransactionError(
        `unstakeAndWithdraw failed: ${result.error?.message ?? "Unknown error"}`,
        result.txHash,
      );
    }

    return {
      txHash: result.data.txHash,
      ledger: result.data.ledger,
      amountA: removeLiquidityRequest.amountAMin,
      amountB: removeLiquidityRequest.amountBMin,
      liquidity: removeLiquidityRequest.liquidity,
    };
  }

  /**
   * Get the cooldown status for a staker's position.
   *
   * Determines whether the user is currently in a cooldown period
   * and when withdrawal becomes available.
   *
   * @param address - The Stellar address of the staker.
   * @param lpTokenAddress - The contract address of the LP token.
   * @returns The cooldown status with remaining time information.
   *
   * @example
   * ```ts
   * const status = await staking.getCooldownStatus('GABC...', 'CAAAA...');
   * if (status.isInCooldown) {
   *   console.log('Can withdraw at:', status.canWithdrawAt);
   * }
   * ```
   */
  async getCooldownStatus(
    address: string,
    lpTokenAddress: string,
  ): Promise<CooldownStatus> {
    validateAddress(address, "address");
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const contract = new Contract(lpTokenAddress);

    const op = contract.call(
      "get_cooldown",
      nativeToScVal(Address.fromString(address), { type: "address" }),
    );

    const result = await this.simulateRead(op);

    if (!result) {
      return {
        isInCooldown: false,
        cooldownEnd: 0,
        canWithdrawAt: new Date(0),
      };
    }

    const fields = result.type === "scvMap" ? result.map : undefined;
    const cooldownEnd = this.extractU64(fields, "cooldown_end");
    const nowSec = Math.floor(Date.now() / 1000);
    const isInCooldown = cooldownEnd > nowSec;

    return {
      isInCooldown,
      cooldownEnd,
      canWithdrawAt: new Date(cooldownEnd * 1000),
    };
  }

  /**
   * Get vote eligibility status for a staked position.
   *
   * Determines whether a stake has settled long enough to count toward
   * governance voting power. Fresh stakes are typically subject to a
   * settlement period to prevent flash-loan governance attacks.
   *
   * **Note:** Actual vote-weight enforcement is a contract-level concern.
   * This method provides accurate client-side display for building honest
   * governance UIs that warn users when their stake is too recent to count.
   *
   * @param address - The Stellar address of the staker.
   * @param lpTokenAddress - The contract address of the LP token.
   * @returns Vote eligibility status including settlement timestamps.
   *
   * @example
   * ```ts
   * const eligibility = await staking.getVoteEligibility('GABC...', 'CAAAA...');
   * if (!eligibility.isEligible) {
   *   console.log('Stake becomes eligible at:', eligibility.eligibleAtDate);
   * }
   * ```
   */
  async getVoteEligibility(
    address: string,
    lpTokenAddress: string,
  ): Promise<VoteEligibility> {
    validateAddress(address, "address");
    validateAddress(lpTokenAddress, "lpTokenAddress");

    const position = await this.getStakedBalance(address, lpTokenAddress);

    if (position.amount === 0n || position.stakedAt === 0) {
      return {
        isEligible: false,
        stakedAt: 0,
        eligibleAt: 0,
        eligibleAtDate: new Date(0),
      };
    }

    // Typical settlement period: 1 ledger (≈5 seconds on Stellar)
    // This is a conservative client-side estimate; actual on-chain
    // enforcement depends on the governance contract implementation.
    const settlementPeriodSec = 5;
    const eligibleAt = position.stakedAt + settlementPeriodSec;
    const nowSec = Math.floor(Date.now() / 1000);
    const isEligible = nowSec >= eligibleAt;

    return {
      isEligible,
      stakedAt: position.stakedAt,
      eligibleAt,
      eligibleAtDate: new Date(eligibleAt * 1000),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Simulate a read-only contract call and return the return value.
   *
   * Uses a well-known zero-balance account as the source so no funds
   * are required — consistent with LPTokenClient.simulateRead.
   */
  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await this.client.server.getAccount(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await this.client.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }

  /**
   * Extract an i128 value from a Soroban ScMap by key name.
   */
  private extractI128(
    fields: xdr.ScMapEntry[] | null | undefined,
    key: string,
  ): bigint {
    if (!fields) return 0n;
    const entry = fields.find(
      (f) => f.key.type === "scvSymbol" && f.key.sym.toString() === key,
    );
    if (!entry) return 0n;
    const val = entry.val;
    if (val.type !== "scvI128") return 0n;
    const i128 = val.i128 as unknown;
    if (typeof i128 === "bigint") return i128;
    const parts = i128 as { hi: bigint; lo: bigint };
    return (parts.hi << 64n) + parts.lo;
  }

  /**
   * Extract a u64 value from a Soroban ScMap by key name.
   */
  private extractU64(
    fields: xdr.ScMapEntry[] | null | undefined,
    key: string,
  ): number {
    if (!fields) return 0;
    const entry = fields.find(
      (f) => f.key.type === "scvSymbol" && f.key.sym.toString() === key,
    );
    if (!entry) return 0;
    const val = entry.val;
    if (val.type !== "scvU64") return 0;
    return Number(val.u64);
  }

  /**
   * Extract a u32 value from a Soroban ScMap by key name.
   */
  private extractU32(
    fields: xdr.ScMapEntry[] | null | undefined,
    key: string,
  ): number {
    if (!fields) return 0;
    const entry = fields.find(
      (f) => f.key.type === "scvSymbol" && f.key.sym.toString() === key,
    );
    if (!entry) return 0;
    const val = entry.val;
    if (val.type !== "scvU32") return 0;
    return val.u32;
  }

  /**
   * Extract an address value from a Soroban ScMap by key name.
   */
  private extractAddress(
    fields: xdr.ScMapEntry[] | null | undefined,
    key: string,
  ): string {
    if (!fields) return "";
    const entry = fields.find(
      (f) => f.key.type === "scvSymbol" && f.key.sym.toString() === key,
    );
    if (!entry) return "";
    try {
      return Address.fromScVal(entry.val).toString();
    } catch {
      const val = entry.val as unknown as {
        address?: { toString(): string };
      };
      return val.address?.toString() ?? "";
    }
  }
}
