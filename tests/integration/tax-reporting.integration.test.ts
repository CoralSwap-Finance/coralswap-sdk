import { CoralSwapClient } from '../../src/client';
import { Network } from '../../src/types/common';
import { LiquidityModule } from '../../src/modules/liquidity';
import { SwapModule } from '../../src/modules/swap';
import { TaxReportingModule, TaxReportRow } from '../../src/modules/tax-reporting';
import { TradeType } from '../../src/types/common';
import { toSorobanAmount, fromSorobanAmount } from '../../src/utils/amounts';

/**
 * Integration test: tax-reporting CSV/JSON export against real testnet swap
 * history for a known address.
 *
 * Prerequisites (set via env vars):
 *   STELLAR_TESTNET  – must be 'true' to run
 *   TEST_KEYPAIR     – funded testnet secret key (S...)
 *   TEST_TOKEN_A     – contract address of token A
 *   TEST_TOKEN_B     – contract address of token B
 *   TEST_RPC_URL     – optional RPC override
 *
 * The "known address with known real swap history" is the test account
 * itself: the suite executes real swaps against a real testnet pool, records
 * their on-chain tx hashes/amounts, then verifies exportTradeHistory()
 * reproduces those exact events from real RPC event data (not mocks).
 *
 * Idempotent: reuses an existing pair and adds liquidity only if the LP
 * balance is insufficient to support the test swaps.
 */

const SKIP = process.env.STELLAR_TESTNET !== 'true';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const describeIntegration = SKIP ? describe.skip : describe;

describeIntegration('Tax reporting module (testnet)', () => {
  let client: CoralSwapClient;
  let liquidity: LiquidityModule;
  let swap: SwapModule;
  let taxReporting: TaxReportingModule;
  let tokenA: string;
  let tokenB: string;
  let pairAddress: string;

  const AMOUNT_A = toSorobanAmount('1', 7);
  const SWAP_AMOUNT = toSorobanAmount('0.05', 7);
  const MIN_LP_BALANCE = 1n;
  const SLIPPAGE_BPS = 200;

  /** Known swap events executed by this suite, to verify against the export. */
  interface KnownSwap {
    txHash: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOut: bigint;
  }
  const knownSwaps: KnownSwap[] = [];
  let suiteStart: Date;

  beforeAll(async () => {
    suiteStart = new Date();
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: requireEnv('TEST_KEYPAIR'),
      ...(process.env.TEST_RPC_URL ? { rpcUrl: process.env.TEST_RPC_URL } : {}),
    });
    tokenA = requireEnv('TEST_TOKEN_A');
    tokenB = requireEnv('TEST_TOKEN_B');
    liquidity = new LiquidityModule(client);
    swap = new SwapModule(client);
    taxReporting = new TaxReportingModule(client);

    pairAddress = await ensurePair(tokenA, tokenB);
    await ensureLiquidity(pairAddress, tokenA, tokenB);

    await executeKnownSwap(tokenA, tokenB);
    await executeKnownSwap(tokenB, tokenA);
  });

  async function ensurePair(tokenX: string, tokenY: string): Promise<string> {
    let addr = await client.getPairAddress(tokenX, tokenY);
    if (!addr) {
      const op = client.factory.buildCreatePair(client.publicKey, tokenX, tokenY);
      const result = await client.submitTransaction([op]);
      expect(result.success).toBe(true);
      addr = await client.getPairAddress(tokenX, tokenY);
    }
    expect(addr).toBeTruthy();
    return addr!;
  }

  async function ensureLiquidity(
    pairAddr: string,
    tA: string,
    tB: string,
  ): Promise<void> {
    const lpAddr = await client.pair(pairAddr).getLPTokenAddress();
    const lpBalance = await client.lpToken(lpAddr).balance(client.publicKey);
    if (lpBalance >= MIN_LP_BALANCE) return;

    const quote = await liquidity.getAddLiquidityQuote(tA, tB, AMOUNT_A);
    const result = await liquidity.addLiquidity({
      tokenA: tA,
      tokenB: tB,
      amountADesired: quote.amountA,
      amountBDesired: quote.amountB,
      amountAMin: (quote.amountA * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      amountBMin: (quote.amountB * BigInt(10000 - SLIPPAGE_BPS)) / 10000n,
      to: client.publicKey,
      deadline: client.getDeadline(300),
    });
    expect(result.txHash).toBeTruthy();
  }

  /** Executes a real swap and records it as a ground-truth event to verify against. */
  async function executeKnownSwap(tokenIn: string, tokenOut: string): Promise<void> {
    const quote = await swap.getQuote({
      tokenIn,
      tokenOut,
      amount: SWAP_AMOUNT,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(quote.amountOut).toBeGreaterThan(0n);

    const result = await swap.execute({
      tokenIn,
      tokenOut,
      amount: SWAP_AMOUNT,
      tradeType: TradeType.EXACT_IN,
      slippageBps: SLIPPAGE_BPS,
      deadline: client.getDeadline(60),
    });
    expect(result.txHash).toBeTruthy();

    knownSwaps.push({
      txHash: result.txHash,
      tokenIn,
      tokenOut,
      amountIn: result.amountIn,
      amountOut: result.amountOut,
    });
  }

  // -----------------------------------------------------------------------
  // 1. JSON export — row count and key fields match real on-chain events
  // -----------------------------------------------------------------------
  it('exportTradeHistory (json) includes every known swap with matching fields', async () => {
    const json = await taxReporting.exportTradeHistory(client.publicKey, {
      format: 'json',
      fromDate: new Date(suiteStart.getTime() - 60_000),
      toDate: new Date(Date.now() + 60_000),
    });
    const rows: TaxReportRow[] = JSON.parse(json);

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(knownSwaps.length);

    for (const known of knownSwaps) {
      const row = rows.find((r) => r.txHash === known.txHash);
      expect(row).toBeDefined();
      expect(row!.type).toBe('swap');
      expect(row!.tokenIn).toBe(known.tokenIn);
      expect(row!.tokenOut).toBe(known.tokenOut);
      expect(row!.amountIn).toBe(fromSorobanAmount(known.amountIn, 7));
      expect(row!.amountOut).toBe(fromSorobanAmount(known.amountOut, 7));

      const rowDate = new Date(row!.date);
      expect(rowDate.getTime()).toBeGreaterThanOrEqual(suiteStart.getTime() - 60_000);
      expect(rowDate.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  });

  // -----------------------------------------------------------------------
  // 2. CSV export — same events, correctly encoded as CSV rows
  // -----------------------------------------------------------------------
  it('exportTradeHistory (csv) contains a row per known swap with matching fields', async () => {
    const csv = await taxReporting.exportTradeHistory(client.publicKey, {
      format: 'csv',
      fromDate: new Date(suiteStart.getTime() - 60_000),
      toDate: new Date(Date.now() + 60_000),
    });

    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'Date,Type,Token In,Amount In,Token Out,Amount Out,Fee,USD Value,Tx Hash',
    );
    expect(lines.length - 1).toBeGreaterThanOrEqual(knownSwaps.length);

    for (const known of knownSwaps) {
      const matching = lines.slice(1).filter((line) => line.includes(known.txHash));
      expect(matching.length).toBe(1);

      const fields = matching[0].split(',');
      const [, type, tokenIn, amountIn, tokenOut, amountOut, , , txHash] = fields;
      expect(type).toBe('swap');
      expect(tokenIn).toBe(known.tokenIn);
      expect(amountIn).toBe(fromSorobanAmount(known.amountIn, 7));
      expect(tokenOut).toBe(known.tokenOut);
      expect(amountOut).toBe(fromSorobanAmount(known.amountOut, 7));
      expect(txHash).toBe(known.txHash);
    }
  });
});
