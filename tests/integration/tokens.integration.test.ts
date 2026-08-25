import { Address, Contract, SorobanRpc, TransactionBuilder, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';

/**
 * Integration test: verify token balance and allowance reads against the live
 * Stellar Testnet state for a funded account.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_SAC_TOKEN   – optional SAC contract address for the token under test
 *   TEST_TOKEN_A     – fallback SAC contract address if TEST_SAC_TOKEN is absent
 *   TEST_SPENDER     – optional spender address for allowance checks
 *   TEST_RPC_URL     – optional RPC override
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true' || !process.env.TEST_KEYPAIR;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Token balance and allowance integration (testnet)', () => {
  let client: CoralSwapClient;
  let publicKey: string;
  let sacTokenAddress: string;
  let spenderAddress: string;

  beforeAll(async () => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });

    publicKey = client.publicKey;
    sacTokenAddress = process.env.TEST_SAC_TOKEN ?? process.env.TEST_TOKEN_A ?? '';
    if (!sacTokenAddress) {
      throw new Error('TEST_SAC_TOKEN or TEST_TOKEN_A env var is required for token integration tests');
    }
    spenderAddress = process.env.TEST_SPENDER ?? publicKey;
  });

  async function fetchSacBalance(tokenAddress: string, owner: string): Promise<bigint> {
    const account = await client.server.getAccount(publicKey);
    const op = new Contract(tokenAddress).call(
      'balance',
      nativeToScVal(Address.fromString(owner), { type: 'address' }),
    );
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await client.server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      return 0n;
    }

    const parsed = scValToNative(sim.result.retval);
    return typeof parsed === 'bigint' ? parsed : BigInt(String(parsed));
  }

  async function fetchSacAllowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
    const account = await client.server.getAccount(publicKey);
    const op = new Contract(tokenAddress).call(
      'allowance',
      nativeToScVal(Address.fromString(owner), { type: 'address' }),
      nativeToScVal(Address.fromString(spender), { type: 'address' }),
    );
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: client.networkConfig.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await client.server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      return 0n;
    }

    const parsed = scValToNative(sim.result.retval);
    return typeof parsed === 'bigint' ? parsed : BigInt(String(parsed));
  }

  async function fetchNativeXlmBalance(owner: string): Promise<bigint> {
    const account = (await client.server.getAccount(owner)) as unknown as {
      balances?: Array<{ asset_type: string; balance: string }>;
    };
    const nativeBalance = account.balances?.find(
      (balance) => balance.asset_type === 'native',
    );
    return nativeBalance ? BigInt(nativeBalance.balance) : 0n;
  }

  it('fetches the SAC balance for the funded Testnet account', async () => {
    const balance = await fetchSacBalance(sacTokenAddress, publicKey);
    const account = await client.server.getAccount(publicKey);

    expect(account.accountId()).toBe(publicKey);
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(typeof balance).toBe('bigint');
  });

  it('fetches the native XLM balance for the funded Testnet account', async () => {
    const balance = await fetchNativeXlmBalance(publicKey);
    const account = await client.server.getAccount(publicKey);

    expect(account.accountId()).toBe(publicKey);
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(typeof balance).toBe('bigint');
  });

  it('fetches the SAC allowance for a spender on the funded Testnet account', async () => {
    const allowance = await fetchSacAllowance(sacTokenAddress, publicKey, spenderAddress);

    expect(allowance).toBeGreaterThanOrEqual(0n);
    expect(typeof allowance).toBe('bigint');
  });
});
