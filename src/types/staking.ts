/**
 * Staking-related type definitions for CoralSwap SDK.
 *
 * Covers LP token staking positions, reward accrual,
 * and cooldown period enforcement.
 */

/**
 * A user's staked LP token position.
 *
 * Returned by {@link StakingModule.getStakedBalance}.
 */
export interface StakedPosition {
  /** Amount of LP tokens currently staked (i128). */
  amount: bigint;
  /** Unix timestamp (seconds) when the tokens were staked. */
  stakedAt: number;
  /** Unix timestamp (seconds) when the cooldown period ends. 0 if no cooldown. */
  cooldownEnd: number;
}

/**
 * Accrued staking rewards for a user.
 *
 * Returned by {@link StakingModule.getStakingRewards}.
 */
export interface StakingRewards {
  /** Unclaimed reward tokens accrued since last claim (i128). */
  pendingRewards: bigint;
  /** Total reward tokens claimed historically (i128). */
  claimedRewards: bigint;
  /** Projected annual percentage yield based on current emission rate. */
  projectedAPY: number;
  /** Contract address of the reward token. */
  rewardToken: string;
}

/**
 * Cooldown period status for an unstake request.
 *
 * Returned by {@link StakingModule.getCooldownStatus}.
 */
export interface CooldownStatus {
  /** Whether the user is currently in a cooldown period. */
  isInCooldown: boolean;
  /** Unix timestamp (seconds) when the cooldown period ends. 0 if not in cooldown. */
  cooldownEnd: number;
  /** Date object representing when withdrawal becomes available. */
  canWithdrawAt: Date;
}

/**
 * Stake eligibility status for governance voting.
 *
 * Returned by {@link StakingModule.getVoteEligibility}.
 * Indicates whether a stake has settled long enough to count
 * toward governance voting power.
 */
export interface VoteEligibility {
  /** Whether this stake is eligible to count toward governance votes. */
  isEligible: boolean;
  /** Unix timestamp (seconds) when the stake was created. */
  stakedAt: number;
  /** Unix timestamp (seconds) when the stake becomes vote-eligible. */
  eligibleAt: number;
  /** Human-readable Date when the stake becomes eligible. */
  eligibleAtDate: Date;
}
