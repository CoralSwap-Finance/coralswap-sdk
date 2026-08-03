/**
 * RWA Pool Example — USDC / deJTRSY T-bill pool on CoralSwap
 *
 * This example demonstrates a complete lifecycle for an RWA (Real-World Asset)
 * liquidity pool pairing a fiat stablecoin (USDC) with a tokenised T-bill
 * (deJTRSY issued via Centrifuge).
 *
 * What makes RWA pools different from vanilla volatile pairs
 * ──────────────────────────────────────────────────────────
 * A standard AMM pool (e.g. USDC/XLM) relies solely on arbitrage to keep its
 * price in line with the market.  An RWA pool adds a second price anchor: the
 * Net Asset Value (NAV) published by a trusted oracle (RedStone in this case).
 *
 * The RWA token (deJTRSY) represents a share of a portfolio of short-duration
 * U.S. Treasury bills held by Centrifuge.  Every day the portfolio accrues
 * interest and the NAV per token rises.  This means:
 *
 *   1. The pool spot price drifts upward relative to its initialisation price
 *      even without any trades — because 1 deJTRSY buys more USDC over time.
 *   2. LPs earn yield from TWO sources: swap fees AND the embedded T-bill rate.
 *   3. Swap quotes must be NAV-adjusted so buyers do not over-pay for the
 *      appreciated asset.
 *
 * Flow implemented here
 * ─────────────────────
 *   Step 1  Register the pair on-chain with the NAV price feed address
 *   Step 2  Quote and execute an add-liquidity deposit
 *   Step 3  Read on-chain state and compute combined APY via getRWAPoolAPY()
 *   Step 4  Get a swap quote and compare it with the NAV-adjusted fair-value
 *
 * Testnet addresses used
 * ──────────────────────
 * The addresses below are representative Stellar testnet Soroban contract
 * identifiers.  Replace them with your own deployed contracts when running
 * this script.  The deJTRSY address mirrors the Centrifuge testnet deployment.
 *
 * Prerequisites
 * ─────────────
 *   cp .env.example .env   # fill in CORALSWAP_SECRET_KEY, CORALSWAP_PUBLIC_KEY,
 *                          # CORALSWAP_RPC_URL (optional), and the token addresses
 */

import 'dotenv/config';
import { Network, TradeType } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { LiquidityModule } from '../src/modules/liquidity';
import { SwapModule } from '../src/modules/swap';
import {
  getRWAPoolAPY,
  navAdjustedSwapOutput,
  navPremiumRatio,
  RWAModule,
  RWAPoolConfig,
} from '../src/rwa';

// ────────────────────────────────────────────────────────────────────────────
// Well-known testnet contract addresses
// ────────────────────────────────────────────────────────────────────────────

/**
 * USDC on Stellar Testnet — issued by Circle via SEP-0001 anchor.
 * This is the canonical testnet address used by most Stellar dApps.
 */
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

/**
 * deJTRSY on Stellar Testnet — Centrifuge tokenised U.S. T-bill pool (Junior tranche).
 *
 * This Soroban contract wraps a Centrifuge DROP token representing a portfolio
 * of 3-month U.S. Treasury bills with daily NAV updates published via RedStone.
 * Replace with the live Centrifuge testnet deployment address once available.
 */
const DEJTRS_TESTNET = process.env.CORALSWAP_RWA_TOKEN ?? 'CDCYWK73YTYFJZZSJ5V7EDFNHYBG4GAQV2RKQXF4UDZ2KXHZSTLKL2C';

/**
 * RedStone NAV price feed contract address on Stellar Testnet.
 *
 * RedStone delivers the Net Asset Value per deJTRSY token as a Soroban
 * oracle contract.  The factory records this address at pair-creation time
 * so the pair contract can later query current NAV for parity enforcement.
 */
const REDSTONE_NAV_FEED = process.env.CORALSWAP_NAV_FEED ?? 'CBVJ3SFNXDKZPCUV7WDQTFLFJXRN3FJGQNEXR5BZMJB3GBJT4LDABCX';

// ────────────────────────────────────────────────────────────────────────────
// Helper: format Stellar 7-decimal amounts as human-readable strings
// ────────────────────────────────────────────────────────────────────────────

/** Convert a Stellar 7-decimal bigint amount to a decimal string. */
function fmt(amount: bigint, decimals = 7): string {
  const scale = BigInt(10 ** decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  // Environment validation
  // ══════════════════════════════════════════════════════════════════════════

  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';

  if (!secretKey || !publicKey) {
    console.error('❌ Missing required environment variables.');
    console.error('   Set CORALSWAP_SECRET_KEY and CORALSWAP_PUBLIC_KEY in your .env file.');
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;
  const usdcAddress = process.env.CORALSWAP_USDC ?? USDC_TESTNET;
  const rwaAddress = process.env.CORALSWAP_RWA_TOKEN ?? DEJTRS_TESTNET;
  const navFeedAddress = process.env.CORALSWAP_NAV_FEED ?? REDSTONE_NAV_FEED;

  console.log('');
  console.log('🪸  CoralSwap — RWA Pool Example  (USDC / deJTRSY T-bill)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Network        : ${networkEnv}`);
  console.log(`  USDC address   : ${usdcAddress}`);
  console.log(`  deJTRSY address: ${rwaAddress}`);
  console.log(`  NAV feed       : ${navFeedAddress}`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // SDK client setup
  // ══════════════════════════════════════════════════════════════════════════

  const client = new CoralSwapClient({
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
    secretKey,
    publicKey,
  });

  const liquidityModule = new LiquidityModule(client);
  const swapModule = new SwapModule(client);
  const rwaModule = new RWAModule(client);

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1: Create the USDC / deJTRSY pair with NAV price feed
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Unlike a standard pair, RWA pairs are registered with a NAV price feed
  // contract address.  The factory stores this address so that:
  //   a) The pair can emit NAV-keyed events for off-chain indexers.
  //   b) Governance-triggered rebalancing windows can enforce NAV parity.
  //
  // If the pair already exists this step is skipped — pair creation is
  // idempotent from the example's perspective.

  console.log('Step 1 — Pair creation');
  console.log('──────────────────────');

  let pairAddress = await client.getPairAddress(usdcAddress, rwaAddress);

  if (pairAddress) {
    console.log(`  ℹ  Pair already exists: ${pairAddress}`);
  } else {
    console.log('  Creating USDC / deJTRSY pair with RedStone NAV price feed...');

    // rwaModule.createRWAPair() builds and submits the factory's
    // `create_rwa_pair` call. RWA pool interactions move real funds against
    // NAV-priced positions, so a client-side timeout here must never trigger
    // a blind resubmission -- that could attempt to register the same pair
    // twice. On a retryable failure it checks the transaction's real
    // on-chain status before ever resubmitting.
    let createResult;
    try {
      createResult = await rwaModule.createRWAPair({
        tokenA: usdcAddress,
        tokenB: rwaAddress,
        navPriceFeedAddress: navFeedAddress,
      });
    } catch (err) {
      console.error('  ❌ Pair creation failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    pairAddress = createResult.pairAddress;

    if (!pairAddress) {
      console.error('  ❌ Pair was submitted but address could not be resolved.');
      process.exit(1);
    }

    console.log(`  ✅ Pair created: ${pairAddress}`);
    console.log(`     Tx: ${createResult.txHash} (ledger ${createResult.ledger})`);
  }

  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2: Add liquidity to the USDC / deJTRSY pool
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The first liquidity deposit sets the initial exchange rate.  For an RWA
  // pool the initial ratio should mirror the current NAV so traders see a
  // fair starting price.
  //
  // We deposit at a 1 : NAV ratio, i.e.:
  //   500,000 USDC ↔ 475,285 deJTRSY   (assuming NAV = $1.052 per deJTRSY)
  //
  // In practice source these amounts from the RedStone feed before depositing.

  console.log('Step 2 — Add liquidity');
  console.log('──────────────────────');

  // Amounts in Stellar's 7-decimal representation (stroops equivalent for tokens).
  // 500,000 USDC  →  500_000 × 10^7 = 5_000_000_0000000
  const usdcAmount = BigInt(process.env.CORALSWAP_LIQUIDITY_USDC ?? '5000000_0000000');

  // deJTRSY amount at current NAV ($1.052): 500,000 / 1.052 ≈ 475,285
  // 475,285 × 10^7 = 4_752_850_0000000
  const rwaAmount = BigInt(process.env.CORALSWAP_LIQUIDITY_RWA ?? '4752850_0000000');

  // Accept up to 0.5 % slippage on each side.
  const slipBps = 50n;
  const usdcMin = usdcAmount - (usdcAmount * slipBps) / 10_000n;
  const rwaMin = rwaAmount - (rwaAmount * slipBps) / 10_000n;

  console.log(`  USDC desired : ${fmt(usdcAmount)} USDC`);
  console.log(`  deJTRSY desired: ${fmt(rwaAmount)} deJTRSY`);

  // Get an on-chain quote first so we can display the expected LP token share.
  const lpQuote = await liquidityModule.getAddLiquidityQuote(
    usdcAddress,
    rwaAddress,
    usdcAmount,
  );

  console.log(`  Estimated LP tokens: ${fmt(lpQuote.estimatedLPTokens)}`);
  console.log(`  Pool share         : ${(lpQuote.shareOfPool * 100).toFixed(4)} %`);
  console.log('');
  console.log('  Submitting add-liquidity transaction...');

  const lpResult = await liquidityModule.addLiquidity({
    tokenA: usdcAddress,
    tokenB: rwaAddress,
    amountADesired: usdcAmount,
    amountBDesired: rwaAmount,
    amountAMin: usdcMin,
    amountBMin: rwaMin,
    to: publicKey,
  });

  console.log(`  ✅ Liquidity added — tx: ${lpResult.txHash}`);
  console.log(`     USDC deposited    : ${fmt(lpResult.amountA)} USDC`);
  console.log(`     deJTRSY deposited : ${fmt(lpResult.amountB)} deJTRSY`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 3: Query pool state and compute combined APY
  // ══════════════════════════════════════════════════════════════════════════
  //
  // getRWAPoolAPY() combines two independent yield sources:
  //
  //   Swap-fee APY — every time someone trades through this pool, LPs collect
  //   a fraction of the notional traded.  For a 30-bps pool with 0.5 % daily
  //   volume/TVL the annualised contribution is ~54 bps (≈ 0.54 %).
  //
  //   Underlying yield — deJTRSY accrues value daily as the T-bill portfolio
  //   matures.  A 5.20 % T-bill rate contributes 520 bps to the total APY.
  //   This yield is captured by LPs because they hold deJTRSY inside the pool
  //   and the token's rising NAV is reflected in their LP redemption value.
  //
  // The two components are additive: an LP in this pool earns both
  // simultaneously without any extra steps.

  console.log('Step 3 — Combined APY query');
  console.log('───────────────────────────');

  // Read live pool state from chain.
  const pair = client.pair(pairAddress!);
  const [poolReserves, feeState] = await Promise.all([
    pair.getReserves(),
    pair.getFeeState(),
  ]);

  // RedStone NAV: $1.052 per deJTRSY token.
  // In a production deployment this value is fetched from the on-chain oracle:
  //   const navPerToken = await navFeedContract.getLatestNAV();
  // Here we use the value from the environment or a representative testnet constant.
  const navPerToken = BigInt(process.env.CORALSWAP_NAV_PER_TOKEN ?? '10520000'); // 1.052 × 10^7

  // Current U.S. 3-month T-bill yield: 5.20 % annualised.
  // In production source this from the same RedStone feed or Centrifuge API.
  const tBillYieldBps = Number(process.env.CORALSWAP_TBILL_YIELD_BPS ?? '520');

  const rwaConfig: RWAPoolConfig = {
    rwaTokenAddress: rwaAddress,
    stablecoinAddress: usdcAddress,
    navPriceFeedAddress: navFeedAddress,
    navPerToken,
    underlyingYieldBps: tBillYieldBps,
  };

  const poolStateForAPY = {
    reserve0: poolReserves.reserve0,
    reserve1: poolReserves.reserve1,
    feeState: { feeCurrent: feeState.feeCurrent },
  };

  const apy = getRWAPoolAPY(poolStateForAPY, rwaConfig);

  console.log(`  Swap-fee APY       : ${(apy.swapFeeApyBps / 100).toFixed(2)} %  (${apy.swapFeeApyBps} bps)`);
  console.log(`  T-bill yield APY   : ${(apy.underlyingYieldApyBps / 100).toFixed(2)} %  (${apy.underlyingYieldApyBps} bps)`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Combined APY       : ${apy.combinedApyPercent.toFixed(2)} %  (${apy.combinedApyBps} bps)`);
  console.log('');

  // ══════════════════════════════════════════════════════════════════════════
  // Step 4: NAV-adjusted swap quote
  // ══════════════════════════════════════════════════════════════════════════
  //
  // deJTRSY is a yield-bearing token: its NAV increases every day as T-bill
  // interest accrues.  When a trader wants to buy deJTRSY with USDC, the AMM
  // uses its constant-product reserves to calculate the output amount.
  //
  // The NAV-adjusted quote provides an independent fair-value reference:
  //   output_rwa = stablecoin_in / navPerToken
  //
  // Comparing the two tells us how far the pool price has drifted from NAV:
  //   • pool output < NAV output → pool under-prices deJTRSY (cheap to buy)
  //   • pool output > NAV output → pool over-prices deJTRSY  (expensive)
  //   • premium ratio ≈ 1.0     → pool is at NAV parity (efficient)
  //
  // Institutional arb bots watch this spread and close it within seconds on
  // mainnet, but on testnet a gap may persist between deployments.

  console.log('Step 4 — NAV-adjusted swap quote');
  console.log('────────────────────────────────');

  // Swap 10,000 USDC → deJTRSY.
  const swapAmountIn = BigInt(process.env.CORALSWAP_SWAP_AMOUNT ?? '100000_0000000'); // 10,000 USDC

  // AMM quote: uses constant-product formula with the current pool reserves.
  const ammQuote = await swapModule.getQuote({
    tokenIn: usdcAddress,
    tokenOut: rwaAddress,
    amount: swapAmountIn,
    tradeType: TradeType.EXACT_IN,
  });

  // NAV oracle quote: straightforward division by current NAV price.
  // deJTRSY tokens received = USDC paid / NAV per token
  const navOutput = navAdjustedSwapOutput(swapAmountIn, navPerToken);

  // Premium ratio: how many cents per dollar the pool charges above/below NAV.
  // Scaled to 7 dp; 10_000_000 = 1.0 (exact parity).
  const premiumRatioRaw = navPremiumRatio(
    // Spot price = reserveUSDC / reserveRWA (which side is which depends on token sort order)
    // Here we compute directly from the AMM quote for simplicity.
    (swapAmountIn * BigInt(1e7)) / (ammQuote.amountOut > 0n ? ammQuote.amountOut : 1n),
    navPerToken,
  );
  const premiumPct = (Number(premiumRatioRaw) / 1e7 - 1) * 100;

  console.log(`  Swap input         : ${fmt(swapAmountIn)} USDC`);
  console.log('');
  console.log('  AMM pool quote (constant-product):');
  console.log(`    deJTRSY out  : ${fmt(ammQuote.amountOut)}`);
  console.log(`    Min out (slippage-adjusted): ${fmt(ammQuote.amountOutMin)}`);
  console.log(`    Fee paid     : ${fmt(ammQuote.feeAmount)} USDC  (${ammQuote.feeBps} bps)`);
  console.log(`    Price impact : ${(ammQuote.priceImpactBps / 100).toFixed(2)} %`);
  console.log('');
  console.log('  NAV oracle quote (RedStone feed):');
  console.log(`    deJTRSY out  : ${fmt(navOutput)}  (at NAV = $${fmt(navPerToken)} per deJTRSY)`);
  console.log('');
  console.log(`  NAV premium      : ${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(4)} %`);
  if (Math.abs(premiumPct) < 0.1) {
    console.log('  ✅ Pool is within 0.10 % of NAV parity — healthy RWA pool state.');
  } else if (premiumPct < 0) {
    console.log('  ⚠  Pool under-prices deJTRSY vs NAV — arb opportunity to buy from pool.');
  } else {
    console.log('  ⚠  Pool over-prices deJTRSY vs NAV — arb opportunity to sell into pool.');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  RWA pool example completed successfully.');
  console.log('');
  console.log('  Key takeaways:');
  console.log('  • deJTRSY is a yield-bearing token: its NAV rises daily as');
  console.log('    the underlying T-bills accrue interest.');
  console.log('  • LPs earn both swap fees AND the embedded T-bill yield,');
  console.log('    combining two normally separate return streams.');
  console.log('  • NAV-adjusted quotes let you verify pool health without');
  console.log('    relying solely on reserve-derived prices.');
  console.log('  • The RedStone price feed is registered at pair-creation time');
  console.log('    so any on-chain actor can fetch the canonical NAV.');
  console.log('');
}

main().catch((err) => {
  console.error('');
  console.error('❌ Unhandled error in rwa-pool example:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
