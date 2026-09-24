import 'dotenv/config';
import { KeypairSigner } from '../src/utils/signer';
import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';
import { NETWORK_CONFIGS } from '../src/config';
import type { xdr } from '@stellar/stellar-sdk';

/**
 * Submit account transactions one at a time. CoralSwapClient also enforces
 * this invariant internally, but keeping the loop sequential is important
 * when composing several independently-built operations in an application.
 */
export async function submitSequentially(
  client: CoralSwapClient,
  operations: xdr.Operation[],
): Promise<void> {
  for (const [index, operation] of operations.entries()) {
    const result = await client.submitTransaction([operation]);
    if (!result.success) {
      throw new Error(
        `Transaction ${index + 1} failed: ${result.error?.message ?? 'unknown error'}`,
      );
    }
    console.log(`Transaction ${index + 1} confirmed: ${result.data?.txHash}`);
  }
}

async function main(): Promise<void> {
  const network = process.env.CORALSWAP_NETWORK === 'mainnet'
    ? Network.MAINNET
    : Network.TESTNET;
  const networkConfig = NETWORK_CONFIGS[network];
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const configuredPassphrase = process.env.CORALSWAP_NETWORK_PASSPHRASE
    ?? networkConfig.networkPassphrase;

  if (!secretKey) {
    throw new Error('Set CORALSWAP_SECRET_KEY to a funded testnet secret key.');
  }

  // A signer must use the passphrase of the network where the transaction
  // will be submitted. A testnet-signed transaction is not valid on mainnet.
  if (configuredPassphrase !== networkConfig.networkPassphrase) {
    throw new Error(
      `Network passphrase mismatch for ${network}: expected "${networkConfig.networkPassphrase}". `
      + 'Unset CORALSWAP_NETWORK_PASSPHRASE or set it to the selected network passphrase.',
    );
  }

  const signer = new KeypairSigner(secretKey, configuredPassphrase);
  const client = new CoralSwapClient({
    network,
    rpcUrl: process.env.CORALSWAP_RPC_URL,
    signer,
    publicKey: signer.publicKeySync,
  });

  console.log(`Signer: ${signer.publicKeySync}`);
  console.log(`Connected to ${network} (${networkConfig.rpcUrl})`);
  console.log('Use submitSequentially(client, operations) for multiple submissions.');

  // The default path is a harmless testnet connectivity check. Applications
  // can call submitSequentially with their own built operations below.
  const healthy = await client.isHealthy();
  if (!healthy) {
    throw new Error('Soroban RPC health check failed.');
  }
  console.log('Soroban RPC is healthy.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Signer example failed: ${message}`);
  process.exitCode = 1;
});
