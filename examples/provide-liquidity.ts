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

  const lpAmountA = process.env.CORALSWAP_LIQUIDITY_AMOUNT_A ?? '10000000';
  const lpAmountB = process.env.CORALSWAP_LIQUIDITY_AMOUNT_B ?? '10000000';

  console.log('Pair address:', pairAddress);
  console.log(
    'This example shows how to construct a CoralSwapClient and look up a pair before providing liquidity.',
  );
  console.log(
    `Once liquidity helper functions are added to the SDK, you can call them here to add ${lpAmountA} units of token A and ${lpAmountB} units of token B to the pool.`,
  );
  console.log(
    'You can also extend this script to call remove-liquidity helpers once they are available.',
  );
}

main().catch((err) => {
  console.error('Error running provide-liquidity example:', err);
  process.exit(1);
});

