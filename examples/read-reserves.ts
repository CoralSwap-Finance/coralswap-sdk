import 'dotenv/config';
import { Network } from '../src/types/common';
import { CoralSwapClient } from '../src/client';

async function main() {
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const tokenA = process.env.CORALSWAP_TOKEN_A;
  const tokenB = process.env.CORALSWAP_TOKEN_B;

  if (!rpcUrl || !tokenA || !tokenB) {
    console.error(
      'Missing required environment variables. Please copy .env.example to .env and fill in the values.',
    );
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;

  const client = new CoralSwapClient({
    network,
    rpcUrl,
  });

  console.log('Looking up pair address for tokens...');
  const pairAddress = await client.getPairAddress(tokenA, tokenB);

  if (!pairAddress) {
    console.error('Pair not found for the provided tokens.');
    process.exit(1);
  }

  console.log('Pair address:', pairAddress);
  console.log(
    'This example demonstrates how to discover the pair contract, which you can then use with PairClient APIs to poll reserves and other state.',
  );
}

main().catch((err) => {
  console.error('Error running read-reserves example:', err);
  process.exit(1);
});
