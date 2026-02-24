import 'dotenv/config';
import { Network } from '../src/types/common';
import { CoralSwapClient } from '../src/client';

async function main() {
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const tokenA = process.env.CORALSWAP_TOKEN_A;
  const tokenB = process.env.CORALSWAP_TOKEN_B;

  if (!rpcUrl || !secretKey || !publicKey || !tokenA || !tokenB) {
    console.error(
      'Missing required environment variables. Please copy .env.example to .env and fill in the values.',
    );
    process.exit(1);
  }

  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;

  const client = new CoralSwapClient({
    network,
    rpcUrl,
    secretKey,
    publicKey,
  });

  console.log('Looking up pair address for tokens...');
  const pairAddress = await client.getPairAddress(tokenA, tokenB);

  if (!pairAddress) {
    console.error('Pair not found for the provided tokens.');
    process.exit(1);
  }

  console.log('Found pair at address:', pairAddress);

  const amountIn = process.env.CORALSWAP_AMOUNT_IN ?? '10000000';

  console.log('Simulating swap...');
  console.log(
    `This example is a placeholder showing how to construct a CoralSwapClient and look up a pair address.`,
  );
  console.log(
    `Once swap helpers are added to the SDK, you can use the router contract to perform an actual swap of ${amountIn} units from ${tokenA} to ${tokenB}.`,
  );
}

main().catch((err) => {
  console.error('Error running simple-swap example:', err);
  process.exit(1);
});
