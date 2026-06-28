/**
 * Staking & Delegation Lifecycle
 *
 * Walks through the full staking flow on Stellar Testnet:
 *   stake LP tokens → check rewards → delegate voting power →
 *   undelegate → initiate unstake (cooldown) → complete withdrawal
 *
 * Prerequisites:
 * - A CoralSwap LP token with balance on Testnet
 * - A staking contract deployed on Testnet
 * - A governance/delegation contract deployed on Testnet
 * - Environment variables configured (see comments below)
 *
 * Key concepts demonstrated:
 * - LP token approval & staking
 * - Reward accrual & APY calculation
 * - Voting power delegation & undelegation
 * - Cooldown period mechanics
 * - Time-locked withdrawal
 *
 * APY Calculation (inline comments in step 3):
 *   rewardRate = tokens/second paid to all stakers
 *   totalStaked = sum of all LP tokens staked
 *   user APY = (rewardRate * SECONDS_PER_YEAR / totalStaked) * 100
 */

import 'dotenv/config';
import {
  Contract,
  Address,
  nativeToScVal,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Network } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { LPTokenClient } from '../src/contracts/lp-token';
import { fromSorobanAmount, formatAmount } from '../src/utils/amounts';
import { withRetry, RetryOptions } from '../src/utils/retry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds in a Gregorian year (365.25 days) used for APY calculation. */
const SECONDS_PER_YEAR = 31_557_600n;

/** Default retry policy for read-only simulations. */
const READ_RETRY: RetryOptions = {
  maxRetries: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 10_000,
};

// ---------------------------------------------------------------------------
// Local helper: StakingContractClient
//
// Wraps raw Soroban calls to the CoralSwap staking contract.
// No dedicated SDK module exists yet — this inline client shows the pattern.
// ---------------------------------------------------------------------------

class StakingContractClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(address: string, server: SorobanRpc.Server, networkPassphrase: string) {
    this.contract = new Contract(address);
    this.server = server;
    this.networkPassphrase = networkPassphrase;
  }

  // -- Write operations (build XDR ops to bundle into a tx) -----------------

  buildStake(sender: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      'stake',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }

  buildRequestUnstake(sender: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      'request_unstake',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
      nativeToScVal(amount, { type: 'i128' }),
    );
  }

  buildWithdraw(sender: string): xdr.Operation {
    return this.contract.call(
      'withdraw',
      nativeToScVal(Address.fromString(sender), { type: 'address' }),
    );
  }

  // -- Read operations (simulate & parse) -----------------------------------

  async getStaked(addr: string): Promise<bigint> {
    return this.readBigInt(
      this.contract.call('get_staked', nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
  }

  async getReward(addr: string): Promise<bigint> {
    return this.readBigInt(
      this.contract.call('get_reward', nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
  }

  async getTotalStaked(): Promise<bigint> {
    return this.readBigInt(this.contract.call('get_total_staked'));
  }

  /** Returns the per-second reward rate emitted to all stakers (i128). */
  async getRewardRate(): Promise<bigint> {
    return this.readBigInt(this.contract.call('get_reward_rate'));
  }

  /** Returns the cooldown window length in seconds. */
  async getCooldownSeconds(): Promise<bigint> {
    return this.readBigInt(this.contract.call('get_cooldown_seconds'));
  }

  /** Returns cooldown state for an address: { endLedger, amount }. */
  async getCooldown(addr: string): Promise<{ endLedger: bigint; amount: bigint }> {
    const result = await this.simulateRead(
      this.contract.call('get_cooldown', nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
    if (!result) return { endLedger: 0n, amount: 0n };
    const m = this.parseScStruct(result);
    return {
      endLedger: this.scValToBigInt(m['end_ledger'] ?? m['end'] ?? m['end_ts']),
      amount: this.scValToBigInt(m['amount']),
    };
  }

  // -- Internal helpers -----------------------------------------------------

  private async readBigInt(op: xdr.Operation): Promise<bigint> {
    const result = await this.simulateRead(op);
    return result ? this.scValToBigInt(result) : 0n;
  }

  private scValToBigInt(val: xdr.ScVal): bigint {
    const tag = val.switch().name;
    if (tag === 'scvI128') {
      const p = val.i128();
      return BigInt(p.lo().toString()) + (BigInt(p.hi().toString()) << 64n);
    }
    if (tag === 'scvU64') return val.u64().toBigInt();
    if (tag === 'scvU32') return BigInt(val.u32());
    if (tag === 'scvI64') return BigInt(val.i64().toString());
    return 0n;
  }

  private parseScStruct(val: xdr.ScVal): Record<string, xdr.ScVal> {
    const map = val.map();
    if (!map) return {};
    const result: Record<string, xdr.ScVal> = {};
    for (const entry of map) {
      const k = entry.key();
      const key = k.switch().name === 'scvSymbol' ? k.sym().toString() : k.str().toString();
      result[key] = entry.val();
    }
    return result;
  }

  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await withRetry(
      () => this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
      READ_RETRY,
    );
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local helper: DelegationContractClient
//
// Wraps raw Soroban calls to the CoralSwap governance/delegation contract.
// ---------------------------------------------------------------------------

class DelegationContractClient {
  private contract: Contract;
  private server: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(address: string, server: SorobanRpc.Server, networkPassphrase: string) {
    this.contract = new Contract(address);
    this.server = server;
    this.networkPassphrase = networkPassphrase;
  }

  buildDelegate(voter: string, representative: string): xdr.Operation {
    return this.contract.call(
      'delegate',
      nativeToScVal(Address.fromString(voter), { type: 'address' }),
      nativeToScVal(Address.fromString(representative), { type: 'address' }),
    );
  }

  /** Undelegate by delegating back to self (returns voting power to the voter). */
  buildUndelegate(voter: string): xdr.Operation {
    return this.contract.call(
      'undelegate',
      nativeToScVal(Address.fromString(voter), { type: 'address' }),
    );
  }

  async getDelegate(addr: string): Promise<string | null> {
    const result = await this.simulateRead(
      this.contract.call('get_delegate', nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
    if (!result) return null;
    try {
      return Address.fromScVal(result).toString();
    } catch {
      return null;
    }
  }

  async getVotingPower(addr: string): Promise<bigint> {
    return this.readBigInt(
      this.contract.call('get_voting_power', nativeToScVal(Address.fromString(addr), { type: 'address' })),
    );
  }

  // -- Internal helpers -----------------------------------------------------

  private async readBigInt(op: xdr.Operation): Promise<bigint> {
    const result = await this.simulateRead(op);
    if (!result) return 0n;
    const tag = result.switch().name;
    if (tag === 'scvI128') {
      const p = result.i128();
      return BigInt(p.lo().toString()) + (BigInt(p.hi().toString()) << 64n);
    }
    if (tag === 'scvU64') return result.u64().toBigInt();
    if (tag === 'scvU32') return BigInt(result.u32());
    return 0n;
  }

  private async simulateRead(op: xdr.Operation): Promise<xdr.ScVal | null> {
    const account = await withRetry(
      () => this.server.getAccount('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
      READ_RETRY,
    );
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(sim) && sim.result) {
      return sim.result.retval;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LP_DECIMALS = 7;

function separator(): void {
  console.log('');
  console.log('-'.repeat(60));
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ==========================================================================
  // Environment Configuration
  // ==========================================================================

  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';

  const stakingContract = process.env.CORALSWAP_STAKING_CONTRACT;
  const delegationContract = process.env.CORALSWAP_DELEGATION_CONTRACT;
  const lpTokenAddress = process.env.CORALSWAP_LP_TOKEN_ADDRESS;
  const stakeAmountStr = process.env.CORALSWAP_STAKE_AMOUNT;
  const delegateTo = process.env.CORALSWAP_DELEGATE_TO;
  const skipCooldown = process.env.CORALSWAP_SKIP_COOLDOWN === 'true';

  if (!rpcUrl || !secretKey || !publicKey || !stakingContract || !delegationContract || !lpTokenAddress || !stakeAmountStr || !delegateTo) {
    console.error('Missing required environment variables.');
    console.error('');
    console.error('  CORALSWAP_RPC_URL');
    console.error('  CORALSWAP_SECRET_KEY');
    console.error('  CORALSWAP_PUBLIC_KEY');
    console.error('  CORALSWAP_STAKING_CONTRACT');
    console.error('  CORALSWAP_DELEGATION_CONTRACT');
    console.error('  CORALSWAP_LP_TOKEN_ADDRESS');
    console.error('  CORALSWAP_STAKE_AMOUNT');
    console.error('  CORALSWAP_DELEGATE_TO');
    console.error('');
    console.error('Optional:');
    console.error('  CORALSWAP_NETWORK         (default: testnet)');
    console.error('  CORALSWAP_SKIP_COOLDOWN   (set "true" to bypass cooldown wait)');
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const stakeAmount = BigInt(stakeAmountStr);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        CoralSwap Staking & Delegation Lifecycle             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Network:            ${networkEnv}`);
  console.log(`  Staking Contract:   ${stakingContract}`);
  console.log(`  Delegation Contract:${delegationContract}`);
  console.log(`  LP Token:           ${lpTokenAddress}`);
  console.log(`  Stake Amount:       ${stakeAmount.toString()} (${formatAmount(stakeAmount, LP_DECIMALS, 7)} LP)`);
  console.log(`  Delegate To:        ${delegateTo}`);
  console.log(`  Skip Cooldown:      ${skipCooldown}`);
  console.log('');

  // ==========================================================================
  // Initialize SDK Client & Contract Clients
  // ==========================================================================

  const client = new CoralSwapClient({ network, rpcUrl, secretKey, publicKey });

  const lpToken = new LPTokenClient(
    lpTokenAddress,
    client.server,
    client.networkConfig.networkPassphrase,
    { maxRetries: 3, retryDelayMs: 1000, maxRetryDelayMs: 10_000 },
  );

  const staking = new StakingContractClient(
    stakingContract,
    client.server,
    client.networkConfig.networkPassphrase,
  );

  const delegation = new DelegationContractClient(
    delegationContract,
    client.server,
    client.networkConfig.networkPassphrase,
  );

  // ==========================================================================
  // Step 1: Stake LP Tokens
  // ==========================================================================

  separator();
  console.log('STEP 1: Stake LP Tokens');
  console.log('');
  console.log('  Before staking, the staking contract must be approved as a');
  console.log('  spender of our LP tokens (ERC-20 / SEP-41 approve pattern).');
  console.log('');

  // 1a. Check current LP balance
  console.log('  Checking LP token balance...');
  const balance = await lpToken.balance(publicKey);
  console.log(`    LP Balance: ${balance.toString()} (${formatAmount(balance, LP_DECIMALS, 7)} LP)`);

  if (balance < stakeAmount) {
    console.error(`  Insufficient LP balance. Have ${formatAmount(balance, LP_DECIMALS, 7)}, need ${formatAmount(stakeAmount, LP_DECIMALS, 7)}`);
    process.exit(1);
  }
  console.log('  Balance sufficient.');
  console.log('');

  // 1b. Approve staking contract
  //     We use a distant ledger number so the approval doesn't expire mid-flow.
  const currentLedger = await client.getCurrentLedger();
  const expirationLedger = currentLedger + 50_000;
  console.log(`  Approving staking contract to spend ${formatAmount(stakeAmount, LP_DECIMALS, 7)} LP tokens...`);
  console.log(`    Approval expires at ledger ${expirationLedger}`);

  const approveOp = lpToken.buildApprove(publicKey, stakingContract, stakeAmount, expirationLedger);
  const approveResult = await client.submitTransaction([approveOp]);

  if (!approveResult.success) {
    console.error('  Approve transaction failed:', approveResult.error?.message);
    process.exit(1);
  }
  console.log(`    ✓ Approved. TxHash: ${approveResult.txHash}`);
  console.log('');

  // 1c. Execute stake
  console.log(`  Staking ${formatAmount(stakeAmount, LP_DECIMALS, 7)} LP tokens...`);
  const stakeOp = staking.buildStake(publicKey, stakeAmount);
  const stakeResult = await client.submitTransaction([stakeOp]);

  if (!stakeResult.success) {
    console.error('  Stake transaction failed:', stakeResult.error?.message);
    process.exit(1);
  }
  console.log(`    ✓ Staked. TxHash: ${stakeResult.txHash}`);
  console.log('');

  // 1d. Verify staked balance
  const stakedBalance = await staking.getStaked(publicKey);
  console.log(`    Staked balance confirmed: ${formatAmount(stakedBalance, LP_DECIMALS, 7)} LP`);

  // ==========================================================================
  // Step 2: Check Staking Rewards
  // ==========================================================================

  separator();
  console.log('STEP 2: Check Staking Rewards & APY');
  console.log('');

  // 2a. Read reward state
  const rewardRate = await staking.getRewardRate();
  const totalStaked = await staking.getTotalStaked();
  const accumulatedReward = await staking.getReward(publicKey);

  console.log('  Current contract state:');
  console.log(`    Reward Rate:  ${rewardRate.toString()} (tokens/second emitted to all stakers)`);
  console.log(`    Total Staked: ${formatAmount(totalStaked, LP_DECIMALS, 7)} LP`);
  console.log(`    My Rewards:   ${accumulatedReward.toString()} (${formatAmount(accumulatedReward, LP_DECIMALS, 7)})`);
  console.log('');

  // ------------------------------------------------------------------
  // APY Calculation
  //
  // rewardRate = tokens/second emitted across all stakers
  // totalStaked = total LP tokens locked in the contract
  //
  // perSecondYield = rewardRate / totalStaked
  //   → the fraction of the staked pool distributed as rewards each second
  //
  // annualizedReturn = perSecondYield * SECONDS_PER_YEAR
  //   → the fraction distributed over one year (compounding ignored for linear APY)
  //
  // APY = annualizedReturn * 100  → percentage
  //
  // Example with realistic values:
  //   rewardRate  = 500_000_000  (50 LP tokens per second at 7 decimals)
  //   totalStaked = 10_000_000_000_000  (1,000,000 LP tokens at 7 decimals)
  //   perSecondYield = 500_000_000 / 10_000_000_000_000 = 0.00005
  //   annualizedReturn = 0.00005 * 31_557_600 = 1_577.88
  //   APY = 1_577.88 * 100 = 157_788%  (very high, unrealistic)
  //
  // More realistic:
  //   rewardRate  = 317  (≈ 0.1 LP/year → 0.1 / 31_557_600 tokens/sec)
  //   totalStaked = 10_000_000_000_000  (1,000,000 LP)
  //   perSecondYield = 317 / 10_000_000_000_000 ≈ 3.17e-11
  //   annualizedReturn = 3.17e-11 * 31_557_600 ≈ 0.001
  //   APY ≈ 0.1%
  //
  // Note: Soroban uses i128 (bigint) for all arithmetic. Floating-point
  // division is not available on-chain, so APY is computed off-chain
  // for display purposes.
  // ------------------------------------------------------------------

  if (totalStaked > 0n && rewardRate > 0n) {
    // Compute APY with BigInt precision, then convert to a readable number.
    //
    // annualizedBasisPoints = rewardRate * SECONDS_PER_YEAR * 10_000 / totalStaked
    //   → gives the annual return in basis points (10000 = 100%)
    const annualizedBps = Number((rewardRate * SECONDS_PER_YEAR * 10_000n) / totalStaked);
    const apyPercent = annualizedBps / 100;

    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │  APY Calculation                                        │');
    console.log('  │                                                         │');
    console.log(`  │  rewardRate        = ${rewardRate.toString().padEnd(20)} tokens/sec          │`);
    console.log(`  │  totalStaked       = ${totalStaked.toString().padEnd(20)} tokens              │`);
    console.log('  │  SECONDS_PER_YEAR  = 31,557,600                         │');
    console.log('  │                                                         │');
    console.log(`  │  annualizedBps     = rewardRate × SECONDS_PER_YEAR      │`);
    console.log('  │                       × 10,000 / totalStaked            │');
    console.log(`  │                    = ${annualizedBps.toString().padEnd(20)} bps                │`);
    console.log('  │                                                         │');
    console.log(`  │  APY               = ${apyPercent.toFixed(4).padEnd(20)}%                      │`);
    console.log('  │                                                         │');
    console.log('  │  Formula:                                               │');
    console.log('  │    perSecondYield  = rewardRate / totalStaked           │');
    console.log('  │    annualReturn    = perSecondYield × SECONDS_PER_YEAR  │');
    console.log('  │    APY             = annualReturn × 100                 │');
    console.log('  └─────────────────────────────────────────────────────────┘');
  } else {
    console.log('  APY cannot be calculated yet (totalStaked or rewardRate is zero).');
  }

  console.log('');

  // ==========================================================================
  // Step 3: Delegate Voting Power
  // ==========================================================================

  separator();
  console.log('STEP 3: Delegate Voting Power');
  console.log('');
  console.log('  Delegation lets a staker assign their governance voting power');
  console.log('  to a representative without transferring their LP tokens.');
  console.log('');

  // 3a. Current delegate
  let currentDelegate = await delegation.getDelegate(publicKey);
  console.log('  Before delegation:');
  console.log(`    Delegate: ${currentDelegate ?? '(none — self)'}`);
  console.log('');

  // 3b. Delegate
  console.log(`  Delegating voting power to ${delegateTo}...`);
  const delegateOp = delegation.buildDelegate(publicKey, delegateTo);
  const delegateResult = await client.submitTransaction([delegateOp]);

  if (!delegateResult.success) {
    console.error('  Delegate transaction failed:', delegateResult.error?.message);
    process.exit(1);
  }
  console.log(`    ✓ Delegated. TxHash: ${delegateResult.txHash}`);
  console.log('');

  // 3c. Verify
  currentDelegate = await delegation.getDelegate(publicKey);
  console.log(`  Confirmed delegate: ${currentDelegate}`);

  const votingPower = await delegation.getVotingPower(publicKey);
  console.log(`  Voting power: ${votingPower.toString()} (${formatAmount(votingPower, LP_DECIMALS, 7)} wei)`);

  // ==========================================================================
  // Step 4: Undelegate (return voting power to self)
  // ==========================================================================

  separator();
  console.log('STEP 4: Undelegate (Return Voting Power)');
  console.log('');
  console.log('  Undelegation returns voting power to the original staker.');
  console.log('  This is required before initiating unstake in some protocols.');
  console.log('');

  console.log('  Undelegating...');
  const undelegateOp = delegation.buildUndelegate(publicKey);
  const undelegateResult = await client.submitTransaction([undelegateOp]);

  if (!undelegateResult.success) {
    console.error('  Undelegate transaction failed:', undelegateResult.error?.message);
    console.log('  (Continuing — undelegation may not be required before unstake.)');
  } else {
    console.log(`    ✓ Undelegated. TxHash: ${undelegateResult.txHash}`);
  }
  console.log('');

  // Verify
  currentDelegate = await delegation.getDelegate(publicKey);
  console.log(`  After undelegation, delegate: ${currentDelegate ?? '(self)'}`);

  // ==========================================================================
  // Step 5: Initiate Unstake (Cooldown)
  // ==========================================================================

  separator();
  console.log('STEP 5: Initiate Unstake (Start Cooldown)');
  console.log('');
  console.log('  The staking contract enforces a cooldown period between');
  console.log('  requesting an unstake and being able to withdraw LP tokens.');
  console.log('  This prevents flash-loan style governance attacks.');
  console.log('');

  // 5a. Read cooldown configuration from the contract
  const cooldownSeconds = await staking.getCooldownSeconds();
  const cooldownHours = Number(cooldownSeconds) / 3600;
  console.log(`  Contract cooldown period: ${cooldownSeconds.toString()} seconds (${cooldownHours.toFixed(1)} hours)`);
  console.log('');

  // 5b. Request unstake
  console.log(`  Requesting unstake of ${formatAmount(stakeAmount, LP_DECIMALS, 7)} LP...`);
  const unstakeOp = staking.buildRequestUnstake(publicKey, stakeAmount);
  const unstakeResult = await client.submitTransaction([unstakeOp]);

  if (!unstakeResult.success) {
    console.error('  Unstake request failed:', unstakeResult.error?.message);
    process.exit(1);
  }
  console.log(`    ✓ Unstake requested. TxHash: ${unstakeResult.txHash}`);
  console.log('');

  // 5c. Verify cooldown state
  const cooldown = await staking.getCooldown(publicKey);
  console.log('  Cooldown state:');
  console.log(`    End ledger:  ${cooldown.endLedger.toString()}`);
  console.log(`    Unstaking:   ${formatAmount(cooldown.amount, LP_DECIMALS, 7)} LP`);
  console.log('');

  // ==========================================================================
  // Step 6: Check Cooldown & Withdraw
  // ==========================================================================

  separator();
  console.log('STEP 6: Complete Withdrawal (After Cooldown)');
  console.log('');

  // 6a. Check ledger progress
  const latestLedger = await client.getCurrentLedger();
  const remainingLedgers = cooldown.endLedger > 0n
    ? Number(cooldown.endLedger - BigInt(latestLedger))
    : 0;

  console.log(`  Current ledger:  ${latestLedger}`);
  console.log(`  Cooldown ends:   ${cooldown.endLedger.toString()}`);
  console.log(`  Ledgers remaining: ${Math.max(0, remainingLedgers)}`);

  if (remainingLedgers > 0 && !skipCooldown) {
    // In production, you would poll until the cooldown elapses:
    //
    //   while (remainingLedgers > 0) {
    //     await sleep(pollIntervalMs);
    //     remainingLedgers = cooldown.endLedger - currentLedger;
    //   }
    //
    console.log('');
    console.log('  ⏳ Cooldown period has not elapsed yet.');
    console.log(`     ${remainingLedgers} ledgers remain (≈ ${Math.ceil(remainingLedgers * 5 / 60)} min at ~5s/ledger).`);
    console.log('');
    console.log('  In a production scenario you would poll the ledger until');
    console.log('  cooldown.endLedger <= currentLedger, then call withdraw().');
    console.log('');
    console.log('  To bypass this wait for demo purposes, set:');
    console.log('    CORALSWAP_SKIP_COOLDOWN=true');
    console.log('');
    console.log('  Skipping withdrawal step for now.');
    console.log('  Re-run with SKIP_COOLDOWN=true to demonstrate the withdrawal.');
    console.log('');
    return;
  }

  if (remainingLedgers > 0 && skipCooldown) {
    console.log('  (Cooldown bypassed via CORALSWAP_SKIP_COOLDOWN=true)');
    console.log('');
  } else {
    console.log('  ✓ Cooldown has elapsed! Proceeding with withdrawal.');
    console.log('');
  }

  // 6b. Execute withdrawal
  console.log('  Withdrawing LP tokens from staking contract...');
  const withdrawOp = staking.buildWithdraw(publicKey);
  const withdrawResult = await client.submitTransaction([withdrawOp]);

  if (!withdrawResult.success) {
    console.error('  Withdrawal failed:', withdrawResult.error?.message);
    process.exit(1);
  }
  console.log(`    ✓ Withdrawn. TxHash: ${withdrawResult.txHash}`);
  console.log('');

  // 6c. Final balance check
  const finalBalance = await lpToken.balance(publicKey);
  console.log('  Final LP balance:');
  console.log(`    ${finalBalance.toString()} (${formatAmount(finalBalance, LP_DECIMALS, 7)} LP)`);
  console.log('');

  // ==========================================================================
  // Summary
  // ==========================================================================

  separator();
  console.log('SUMMARY');
  console.log('');
  console.log('  ✓ Step 1 — Staked LP tokens');
  console.log('  ✓ Step 2 — Checked rewards & APY');
  console.log('  ✓ Step 3 — Delegated voting power');
  console.log('  ✓ Step 4 — Undelegated');
  console.log('  ✓ Step 5 — Initiated unstake (cooldown started)');
  console.log('  ✓ Step 6 — Completed withdrawal');
  console.log('');
  console.log('  Full staking lifecycle demonstrated.');
  console.log('');
}

// ===========================================================================
// Entry point
// ===========================================================================

main().catch((err) => {
  console.error('');
  console.error('Unhandled error in staking-flow example:', err);
  process.exit(1);
});
