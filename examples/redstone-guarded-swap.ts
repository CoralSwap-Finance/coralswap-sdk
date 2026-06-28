/**
 * RedStone Guarded Swap Example
 *
 * This example demonstrates how to integrate a RedStone price oracle to guard
 * swaps against severe price impacts or AMM manipulation.
 * 
 * Flow:
 * 1. Fetch RedStone attestation via the price-feed module.
 * 2. Get a swap quote from the CoralSwap AMM.
 * 3. Check deviation between the AMM quote and the oracle price.
 * 4. Attach the payload and submit if within the allowed deviation threshold.
 */

import 'dotenv/config';
import { Network, TradeType } from '../src/types/common';
import { CoralSwapClient } from '../src/client';
import { SwapModule } from '../src/modules/swap';
import { fetchPriceAttestation } from './price-feed';
import { navAdjustedSwapOutput } from '../src/rwa';

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const DEJTRS_TESTNET = process.env.CORALSWAP_RWA_TOKEN ?? 'CDCYWK73YTYFJZZSJ5V7EDFNHYBG4GAQV2RKQXF4UDZ2KXHZSTLKL2C';

const MAX_DEVIATION_BPS = 100; // 1%

function formatAmount(amount: bigint, decimals: number = 7): string {
  const divisor = BigInt(10 ** decimals);
  const integerPart = amount / divisor;
  const fractionalPart = (amount % divisor).toString().padStart(decimals, '0');
  return `${integerPart}.${fractionalPart}`;
}

async function executeGuardedSwap(client: CoralSwapClient, amountInUsdc: bigint, simulateBadPrice: boolean = false) {
  const swapModule = new SwapModule(client);
  
  console.log(`\n--- Executing Guarded Swap (simulateBadPrice: ${simulateBadPrice}) ---`);
  
  // 1. Fetch RedStone attestation
  console.log('1. Fetching RedStone attestation...');
  const simulatedOraclePrice = simulateBadPrice ? 0.95 : 1.052; // Bad price diverges by ~10%
  const attestation = await fetchPriceAttestation('deJTRSY', simulatedOraclePrice);
  
  console.log(`   Oracle Price: $${attestation.price} per token`);
  
  // 2. Get swap quote from AMM
  console.log('2. Getting AMM swap quote...');
  const quote = await swapModule.getQuote({
    tokenIn: USDC_TESTNET,
    tokenOut: DEJTRS_TESTNET,
    amount: amountInUsdc,
    tradeType: TradeType.EXACT_IN,
  });
  
  console.log(`   AMM Quote: ${formatAmount(quote.amountOut)} deJTRSY`);
  
  // 3. Check deviation
  console.log('3. Checking price deviation...');
  
  // Oracle output: how much deJTRSY we *should* get based on the oracle price
  const navPerToken = BigInt(Math.floor(attestation.price * 10**7));
  const oracleExpectedOut = navAdjustedSwapOutput(amountInUsdc, navPerToken);
  
  // Calculate deviation in basis points
  let deviationBps = 0n;
  if (oracleExpectedOut > 0n) {
    const diff = quote.amountOut > oracleExpectedOut 
      ? quote.amountOut - oracleExpectedOut 
      : oracleExpectedOut - quote.amountOut;
      
    deviationBps = (diff * 10000n) / oracleExpectedOut;
  }
  
  console.log(`   Expected Output (Oracle): ${formatAmount(oracleExpectedOut)} deJTRSY`);
  console.log(`   Deviation: ${deviationBps} bps (Max allowed: ${MAX_DEVIATION_BPS} bps)`);
  
  if (deviationBps > BigInt(MAX_DEVIATION_BPS)) {
    console.error(`   ❌ Deviation check failed! Price difference is too high (${deviationBps} bps). Catching bad price locally instead of a raw revert.`);
    return;
  }
  
  console.log('   ✅ Deviation check passed.');
  
  // 4. Attach payload and submit
  console.log('4. Attaching RedStone payload and submitting swap transaction...');
  console.log(`   [Attached Payload]: ${attestation.payload}`);
  
  // In a real implementation, the payload would be attached to the transaction 
  // via an additional operation or passed to a custom router contract.
  // Here we proceed with the standard SDK execute to fulfill the happy path on testnet.
  try {
    const result = await swapModule.execute({
      tokenIn: USDC_TESTNET,
      tokenOut: DEJTRS_TESTNET,
      amount: amountInUsdc,
      tradeType: TradeType.EXACT_IN,
      quote // pass the existing quote
    });
    
    console.log(`   ✅ Guarded swap successful! Tx Hash: ${result.txHash}`);
  } catch (err: any) {
    console.error('   ❌ Swap execution failed:', err.message);
  }
}

async function main() {
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  
  if (!secretKey || !publicKey) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
  }
  
  const client = new CoralSwapClient({
    network: Network.TESTNET,
    ...(rpcUrl ? { rpcUrl } : {}),
    secretKey,
    publicKey,
  });
  
  const amountToSwap = 100000000n; // 10 USDC
  
  // Run Happy Path
  await executeGuardedSwap(client, amountToSwap, false);
  
  // Run Failure Case (Bad Price)
  await executeGuardedSwap(client, amountToSwap, true);
}

main().catch((err) => {
  console.error('Error running guarded swap example:', err);
  process.exit(1);
});
