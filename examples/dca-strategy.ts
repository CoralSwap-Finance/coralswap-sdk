import 'dotenv/config';
import path from 'path';
import Module from 'module';

interface Signer {
  publicKey(): Promise<string>;
  signTransaction(xdr: string): Promise<string>;
}

interface DCAPerformance {
  scheduleId: string;
  totalInvested: bigint;
  totalReceived: bigint;
  lumpSumReceived: bigint;
  savings: bigint;
  savingsBps: number;
}

interface DCASchedule {
  id: string;
  status: string;
  executedCount: number;
  totalIntervals: number;
  remainingCount: number;
  nextExecutionAt: number;
}

const SCALE = 10_000_000n;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const TOTAL_WEEKS = 12;
const BPS_DENOMINATOR = 10_000;


function registerTsNodePathAlias(): void {
  // The SDK source uses the `@/` tsconfig path alias. Examples are intended to
  // run directly with `npx ts-node examples/dca-strategy.ts`, so we install the
  // same alias at runtime instead of requiring an extra ts-node flag.
  const sourceRoot = path.resolve(__dirname, '..', 'src');
  type ResolveFilename = (request: string, parent: NodeJS.Module | null | undefined, isMain: boolean, options?: { paths?: string[] }) => string;
  type ModuleWithResolver = typeof Module & { _resolveFilename: ResolveFilename };
  const moduleWithResolver = Module as ModuleWithResolver;
  const originalResolveFilename = moduleWithResolver._resolveFilename;
  moduleWithResolver._resolveFilename = function resolveWithSrcAlias(
    request: string,
    parent: NodeJS.Module | null | undefined,
    isMain: boolean,
    options?: { paths?: string[] },
  ) {
    if (request.startsWith('@/')) {
      return originalResolveFilename.call(this, path.join(sourceRoot, request.slice(2)), parent, isMain, options);
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

function parseAmount(value: string): bigint {
  return BigInt(value.replace(/_/g, ''));
}

function formatAmount(amount: bigint, decimals = 7): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function printPerformance(label: string, performance: DCAPerformance): void {
  const sign = performance.savings >= 0n ? '+' : '-';
  const absoluteSavings = performance.savings >= 0n ? performance.savings : -performance.savings;

  console.log(`\n${label}`);
  console.log(`  Invested so far     : ${formatAmount(performance.totalInvested)} USDC`);
  console.log(`  DCA XLM received    : ${formatAmount(performance.totalReceived)} XLM`);
  console.log(`  Lump-sum baseline   : ${formatAmount(performance.lumpSumReceived)} XLM`);
  console.log(`  DCA savings         : ${sign}${formatAmount(absoluteSavings)} XLM (${formatBps(performance.savingsBps)})`);
}

function buildDemoPerformance(week: number, amountPerWeek: bigint): DCAPerformance {
  // A small deterministic price path makes the example runnable without waiting
  // twelve real weeks. On-chain, these values come from getDCAPerformance().
  const xlmPerUsdcByWeek = [2.1, 2.35, 2.2, 2.55, 2.4, 2.8, 2.65, 2.9, 2.75, 3.05, 2.95, 3.2];
  const lumpSumXlmPerUsdc = xlmPerUsdcByWeek[0];

  const weeklyUsdc = Number(amountPerWeek) / Number(SCALE);
  const totalInvested = amountPerWeek * BigInt(week);
  const totalReceivedFloat = xlmPerUsdcByWeek
    .slice(0, week)
    .reduce((sum, price) => sum + weeklyUsdc * price, 0);
  const lumpSumReceivedFloat = weeklyUsdc * week * lumpSumXlmPerUsdc;

  const totalReceived = BigInt(Math.round(totalReceivedFloat * Number(SCALE)));
  const lumpSumReceived = BigInt(Math.round(lumpSumReceivedFloat * Number(SCALE)));
  const savings = totalReceived - lumpSumReceived;
  const savingsBps = lumpSumReceived === 0n ? 0 : Number((savings * BigInt(BPS_DENOMINATOR)) / lumpSumReceived);

  return {
    scheduleId: 'demo-weekly-usdc-xlm',
    totalInvested,
    totalReceived,
    lumpSumReceived,
    savings,
    savingsBps,
  };
}

function printSchedule(schedule: DCASchedule): void {
  console.log('\nSchedule state');
  console.log(`  ID                  : ${schedule.id}`);
  console.log(`  Status              : ${schedule.status}`);
  console.log(`  Executed / total    : ${schedule.executedCount} / ${schedule.totalIntervals}`);
  console.log(`  Remaining intervals : ${schedule.remainingCount}`);
  console.log(`  Next execution      : ${new Date(schedule.nextExecutionAt * 1000).toISOString()}`);
}

async function main() {
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const network = networkEnv === 'mainnet' ? 'mainnet' : 'testnet';
  const rpcUrl = process.env.CORALSWAP_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const secretKey = process.env.CORALSWAP_SECRET_KEY;
  const publicKey = process.env.CORALSWAP_PUBLIC_KEY;
  const usdc = process.env.CORALSWAP_USDC ?? process.env.CORALSWAP_TOKEN_A;
  const xlm = process.env.CORALSWAP_XLM ?? process.env.CORALSWAP_TOKEN_B;
  const pairAddress = process.env.CORALSWAP_USDC_XLM_PAIR ?? process.env.CORALSWAP_PAIR_ADDRESS;
  const dcaContract = process.env.CORALSWAP_DCA_CONTRACT;
  const amountPerWeek = parseAmount(process.env.CORALSWAP_DCA_WEEKLY_USDC ?? '100_0000000');

  console.log('CoralSwap weekly USDC → XLM DCA example');
  console.log('Strategy: split a 12-week budget into equal weekly swaps instead of buying all XLM today.');
  console.log('Benefit: DCA can reduce timing risk because only one slice is exposed to any single weekly price.');
  console.log(`Weekly amount: ${formatAmount(amountPerWeek)} USDC for ${TOTAL_WEEKS} weeks`);
  console.log(`Total budget : ${formatAmount(amountPerWeek * BigInt(TOTAL_WEEKS))} USDC`);

  const canUseTestnet = Boolean(secretKey && publicKey && usdc && xlm && pairAddress && dcaContract);

  if (!canUseTestnet) {
    console.log('\nMissing one or more Testnet variables, so printing a deterministic walkthrough instead of submitting transactions.');
    console.log('Set CORALSWAP_SECRET_KEY, CORALSWAP_PUBLIC_KEY, CORALSWAP_USDC, CORALSWAP_XLM, CORALSWAP_USDC_XLM_PAIR, and CORALSWAP_DCA_CONTRACT to run against Stellar Testnet.');

    for (let week = 1; week <= TOTAL_WEEKS; week += 1) {
      printPerformance(`Execution ${week}/${TOTAL_WEEKS} performance`, buildDemoPerformance(week, amountPerWeek));
    }

    const executedWeeks = 4;
    const refund = amountPerWeek * BigInt(TOTAL_WEEKS - executedWeeks);
    console.log('\nEarly cancellation demo');
    console.log(`  Cancel after        : ${executedWeeks} executions`);
    console.log(`  Refund calculation  : ${formatAmount(amountPerWeek)} USDC × ${TOTAL_WEEKS - executedWeeks} unexecuted weeks`);
    console.log(`  Refunded escrow     : ${formatAmount(refund)} USDC`);
    return;
  }

  registerTsNodePathAlias();
  const { CoralSwapClient } = await import('../src/client');
  const { DCAModule } = await import('../src/modules/dca');

  const client = new CoralSwapClient({ network: network as never, rpcUrl, secretKey, publicKey });
  const signer: Signer = {
    publicKey: async () => publicKey!,
    signTransaction: async (xdr) => xdr,
  };
  const dca = new DCAModule(client, dcaContract!);

  console.log('\nCreating Testnet DCA schedule...');
  const scheduleId = await dca.createDCA({
    tokenIn: usdc!,
    tokenOut: xlm!,
    amountPerInterval: amountPerWeek,
    intervalSeconds: WEEK_SECONDS,
    totalIntervals: TOTAL_WEEKS,
    pairAddress: pairAddress!,
  }, signer);
  console.log(`Created schedule: ${scheduleId}`);

  // Keeper execution is time-based on-chain. This loop observes the schedule and
  // prints metrics whenever another weekly execution has settled. For demos, set
  // CORALSWAP_DCA_OBSERVE_EXECUTIONS to a small number and trigger the keeper in
  // another terminal/test harness between polls.
  const executionsToObserve = Number(process.env.CORALSWAP_DCA_OBSERVE_EXECUTIONS ?? '1');
  let lastExecutedCount = 0;
  for (let observed = 0; observed < executionsToObserve;) {
    const schedule = await dca.getDCASchedule(scheduleId);
    if (schedule.executedCount > lastExecutedCount) {
      lastExecutedCount = schedule.executedCount;
      observed += 1;
      printSchedule(schedule);
      printPerformance(`Execution ${schedule.executedCount}/${TOTAL_WEEKS} performance`, await dca.getDCAPerformance(scheduleId));
    } else {
      console.log('Waiting for the next weekly DCA execution to be performed by the keeper...');
      break;
    }
  }

  const performance = await dca.getDCAPerformance(scheduleId);
  printPerformance('Current DCA vs lump-sum comparison', performance);

  const cancellation = await dca.cancelDCA(scheduleId, signer);
  console.log('\nCancelled DCA early');
  console.log(`  Tx hash             : ${cancellation.txHash}`);
  console.log(`  Refund calculation  : ${formatAmount(amountPerWeek)} USDC × remaining unexecuted intervals`);
  console.log(`  Refunded escrow     : ${formatAmount(cancellation.refundAmount)} USDC`);
}

main().catch((err) => {
  console.error('Error running DCA strategy example:', err);
  process.exit(1);
});
