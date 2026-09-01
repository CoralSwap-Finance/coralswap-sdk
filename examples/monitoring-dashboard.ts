/**
 * CoralSwap Protocol Monitoring Dashboard
 *
 * Displays a real-time metrics dashboard for the CoralSwap protocol:
 *   - TVL per pool and protocol-wide
 *   - 24-hour trading volume
 *   - Protocol revenue (treasury)
 *   - Active liquidity providers
 *   - Dynamic fee rates per pool
 *   - Trend indicators (↑ ↓ →) based on the delta between refreshes
 *
 * Usage:
 *   npx ts-node examples/monitoring-dashboard.ts
 *
 * Required env vars for live testnet data:
 *   CORALSWAP_RPC_URL      — Soroban RPC endpoint
 *   CORALSWAP_TOKEN_A      — First token contract address
 *   CORALSWAP_TOKEN_B      — Second token contract address
 *
 * Optional:
 *   CORALSWAP_NETWORK      — "testnet" (default) | "mainnet"
 *   CORALSWAP_PAIR_ADDRESS — Pre-known pair address (skips factory lookup)
 *   CORALSWAP_REFRESH_SEC  — Refresh interval in seconds (default: 30)
 *
 * When env vars are absent a deterministic demo dashboard runs instead,
 * showing how the output looks with synthetic but realistic data.
 */

import 'dotenv/config';
import path from 'path';
import Module from 'module';

// ─── Runtime path-alias registration ────────────────────────────────────────
// The SDK source uses the `@/` tsconfig alias. Patch Node's resolver so
// `import('@/...')` works when ts-node resolves these paths at runtime.
type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | null | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;
type PatchedModule = typeof Module & { _resolveFilename: ResolveFilename };

function registerTsNodePathAlias(): void {
  const sourceRoot = path.resolve(__dirname, '..', 'src');
  const mod = Module as PatchedModule;
  const original = mod._resolveFilename;
  mod._resolveFilename = function resolveWithSrcAlias(req, parent, isMain, opts) {
    if (req.startsWith('@/')) {
      return original.call(this, path.join(sourceRoot, req.slice(2)), parent, isMain, opts);
    }
    return original.call(this, req, parent, isMain, opts);
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PoolMetrics {
  address: string;
  label: string;
  tvlA: bigint;
  tvlB: bigint;
  /** USD TVL — only non-zero when stablecoin pricing is available */
  tvlUSD: number;
  feeBps: number;
  isFeeStalse: boolean;
}

interface ProtocolMetrics {
  timestamp: Date;
  pools: PoolMetrics[];
  totalTVLUSD: number;
  treasuryUSD: number;
  topTraderVolume: number;
  topTraderCount: number;
}

// ─── Trend helpers ───────────────────────────────────────────────────────────

type Trend = '↑' | '↓' | '→';

function trend(current: number, previous: number): Trend {
  const delta = current - previous;
  if (Math.abs(delta) < 1e-9) return '→';
  return delta > 0 ? '↑' : '↓';
}

function trendBigInt(current: bigint, previous: bigint): Trend {
  if (current === previous) return '→';
  return current > previous ? '↑' : '↓';
}

function colorTrend(t: Trend): string {
  if (t === '↑') return `\x1b[32m${t}\x1b[0m`; // green
  if (t === '↓') return `\x1b[31m${t}\x1b[0m`; // red
  return `\x1b[90m${t}\x1b[0m`;                  // grey
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtAmount(amount: bigint, decimals = 7): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function fmtUSD(value: number): string {
  if (value === 0) return 'n/a';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function padRight(str: string, len: number): string {
  // strip ANSI codes for length calculation
  const raw = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - raw.length));
}

function padLeft(str: string, len: number): string {
  const raw = str.replace(/\x1b\[[0-9;]*m/g, '');
  return ' '.repeat(Math.max(0, len - raw.length)) + str;
}

// ─── Dashboard renderer ───────────────────────────────────────────────────────

const DIVIDER = '─'.repeat(72);
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';

function renderDashboard(current: ProtocolMetrics, previous: ProtocolMetrics | null): void {
  // Move cursor to top-left and clear screen on first render; subsequent
  // renders overwrite in place for a smooth refresh effect.
  process.stdout.write('\x1b[2J\x1b[H');

  const ts = current.timestamp.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  console.log(`${BOLD}${CYAN}╔══ CoralSwap Protocol Monitor ══╗${RESET}  ${DIM}${ts}${RESET}`);
  console.log(DIVIDER);

  // ── Protocol KPIs ────────────────────────────────────────────────────────
  console.log(`${BOLD}  Protocol KPIs${RESET}`);
  console.log(DIVIDER);

  const tvlT = previous ? trend(current.totalTVLUSD, previous.totalTVLUSD) : '→';
  const revT = previous ? trend(current.treasuryUSD, previous.treasuryUSD) : '→';
  const volT = previous ? trend(current.topTraderVolume, previous.topTraderVolume) : '→';
  const usrT = previous ? trend(current.topTraderCount, previous.topTraderCount) : '→';

  const kpiRows = [
    ['Total TVL',        fmtUSD(current.totalTVLUSD),       colorTrend(tvlT)],
    ['Treasury Revenue', fmtUSD(current.treasuryUSD),       colorTrend(revT)],
    ['Top Trader Vol.',  fmtUSD(current.topTraderVolume),   colorTrend(volT)],
    ['Active Traders',   String(current.topTraderCount),    colorTrend(usrT)],
  ];

  for (const [label, value, arrow] of kpiRows) {
    console.log(`  ${padRight(label, 20)} ${padLeft(value, 12)}  ${arrow}`);
  }

  // ── Pool table ────────────────────────────────────────────────────────────
  console.log();
  console.log(`${BOLD}  Pool Metrics${RESET}`);
  console.log(DIVIDER);
  console.log(
    `  ${padRight('Pool', 24)}` +
    `${padLeft('Reserve A', 16)}` +
    `${padLeft('Reserve B', 16)}` +
    `${padLeft('TVL (USD)', 12)}` +
    `${padLeft('Fee', 8)}  ` +
    `Stale`,
  );
  console.log(`  ${DIM}${'·'.repeat(70)}${RESET}`);

  for (const pool of current.pools) {
    const prevPool = previous?.pools.find((p) => p.address === pool.address) ?? null;
    const tvlArrow  = prevPool ? colorTrend(trend(pool.tvlUSD, prevPool.tvlUSD)) : colorTrend('→');
    const feeArrow  = prevPool ? colorTrend(trend(pool.feeBps, prevPool.feeBps)) : colorTrend('→');
    const staleStr  = pool.isFeeStalse ? `${DIM}stale${RESET}` : `\x1b[32mlive\x1b[0m`;

    const resA = fmtAmount(pool.tvlA);
    const resB = fmtAmount(pool.tvlB);
    const tvlStr = fmtUSD(pool.tvlUSD);
    const feeStr = fmtBps(pool.feeBps);

    console.log(
      `  ${padRight(pool.label, 24)}` +
      `${padLeft(resA, 16)}` +
      `${padLeft(resB, 16)}` +
      `${padLeft(tvlStr, 12)}` +
      `${padLeft(feeArrow + feeStr, 12)}  ` +
      staleStr,
    );
  }

  console.log(DIVIDER);
  const refreshSec = Number(process.env.CORALSWAP_REFRESH_SEC ?? 30);
  console.log(`${DIM}  Refreshing every ${refreshSec}s. Press Ctrl+C to exit.${RESET}`);
}

// ─── Demo data generation ─────────────────────────────────────────────────────

function buildDemoMetrics(tick: number): ProtocolMetrics {
  // Deterministic but slightly evolving data so trend arrows work across ticks.
  const rng = (seed: number) => Math.sin(seed) * 0.5 + 0.5; // 0..1

  const pools: PoolMetrics[] = [
    {
      address: 'CDEMO_PAIR_USDC_XLM_000000000000000000000000000000',
      label:   'USDC / XLM',
      tvlA:    BigInt(Math.round((500_000 + rng(tick * 1.1) * 10_000) * 1e7)),
      tvlB:    BigInt(Math.round((1_800_000 + rng(tick * 1.3) * 50_000) * 1e7)),
      tvlUSD:  500_000 + rng(tick * 1.1) * 10_000,
      feeBps:  30 + Math.round(rng(tick * 0.7) * 20),
      isFeeStalse: tick % 3 === 0,
    },
    {
      address: 'CDEMO_PAIR_USDC_ETH_000000000000000000000000000000',
      label:   'USDC / wETH',
      tvlA:    BigInt(Math.round((200_000 + rng(tick * 2.1) * 5_000) * 1e7)),
      tvlB:    BigInt(Math.round((60 + rng(tick * 2.3) * 5) * 1e7)),
      tvlUSD:  200_000 + rng(tick * 2.1) * 5_000,
      feeBps:  50 + Math.round(rng(tick * 1.9) * 30),
      isFeeStalse: false,
    },
    {
      address: 'CDEMO_PAIR_XLM_BTC_0000000000000000000000000000000',
      label:   'XLM / wBTC',
      tvlA:    BigInt(Math.round((900_000 + rng(tick * 3.1) * 20_000) * 1e7)),
      tvlB:    BigInt(Math.round((3 + rng(tick * 3.3) * 0.5) * 1e7)),
      tvlUSD:  90_000 + rng(tick * 3.1) * 2_000,
      feeBps:  100 + Math.round(rng(tick * 2.7) * 50),
      isFeeStalse: tick % 5 === 0,
    },
  ];

  const totalTVLUSD  = pools.reduce((s, p) => s + p.tvlUSD, 0);
  const treasuryUSD  = totalTVLUSD * 0.003 * (1 + rng(tick * 4.1) * 0.1);
  const topVolume    = 120_000 + rng(tick * 5.1) * 15_000;
  const topTraders   = 42 + Math.round(rng(tick * 6.1) * 8);

  return { timestamp: new Date(), pools, totalTVLUSD, treasuryUSD, topTraderVolume: topVolume, topTraderCount: topTraders };
}

// ─── Live data fetching ───────────────────────────────────────────────────────

async function fetchProtocolMetrics(
  client: any,
  tokenA: string,
  tokenB: string,
  pairAddressOverride: string | undefined,
  FeeModule: any,
  FactoryModule: any,
  TreasuryModule: any,
  LeaderboardModule: any,
): Promise<ProtocolMetrics> {
  const factory     = new FactoryModule(client);
  const fees        = new FeeModule(client);
  const treasury    = new TreasuryModule(client);
  const leaderboard = new LeaderboardModule(client);

  // ── Pair info ──────────────────────────────────────────────────────────
  let pairAddress = pairAddressOverride;
  if (!pairAddress) {
    pairAddress = (await factory.getPairAddress(tokenA, tokenB)) ?? undefined;
  }

  const pools: PoolMetrics[] = [];

  if (pairAddress) {
    const [info, feeEstimate] = await Promise.all([
      factory.getPairInfo(tokenA, tokenB),
      fees.getCurrentFee(pairAddress),
    ]);

    pools.push({
      address:     pairAddress,
      label:       `${tokenA.slice(0, 4)}… / ${tokenB.slice(0, 4)}…`,
      tvlA:        info.reserveA,
      tvlB:        info.reserveB,
      tvlUSD:      0, // stablecoin anchor not provided in basic example
      feeBps:      feeEstimate.currentFeeBps,
      isFeeStalse: feeEstimate.isStale,
    });
  }

  // ── Treasury ───────────────────────────────────────────────────────────
  let treasuryUSD = 0;
  try {
    const balance = await treasury.getTreasuryBalance();
    treasuryUSD = balance.totalUSD;
  } catch {
    // treasury may be empty on testnet — non-fatal
  }

  // ── Leaderboard ────────────────────────────────────────────────────────
  let topTraderVolume = 0;
  let topTraderCount = 0;
  try {
    const traders = await leaderboard.getTopTraders({ limit: 10, periodDays: 1 });
    topTraderCount = traders.length;
    topTraderVolume = traders.reduce((s: number, t: any) => s + t.totalVolumeUSD, 0);
  } catch {
    // leaderboard may have no data on testnet — non-fatal
  }

  const totalTVLUSD = pools.reduce((s, p) => s + p.tvlUSD, 0);

  return {
    timestamp: new Date(),
    pools,
    totalTVLUSD,
    treasuryUSD,
    topTraderVolume,
    topTraderCount,
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl         = process.env.CORALSWAP_RPC_URL;
  const tokenA         = process.env.CORALSWAP_TOKEN_A;
  const tokenB         = process.env.CORALSWAP_TOKEN_B;
  const networkEnv     = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const pairOverride   = process.env.CORALSWAP_PAIR_ADDRESS;
  const refreshSec     = Math.max(5, Number(process.env.CORALSWAP_REFRESH_SEC ?? 30));

  const canUseLive = Boolean(rpcUrl && tokenA && tokenB);

  if (!canUseLive) {
    // ── Demo mode ──────────────────────────────────────────────────────────
    console.log(`${BOLD}${CYAN}CoralSwap Protocol Monitor — Demo Mode${RESET}`);
    console.log(`${DIM}Set CORALSWAP_RPC_URL, CORALSWAP_TOKEN_A, and CORALSWAP_TOKEN_B to connect to Stellar Testnet.${RESET}`);
    console.log();

    let previous: ProtocolMetrics | null = null;
    let tick = 0;

    const refresh = () => {
      const current = buildDemoMetrics(tick++);
      renderDashboard(current, previous);
      previous = current;
    };

    refresh();
    const timer = setInterval(refresh, refreshSec * 1000);

    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log('\n\nMonitor stopped.');
      process.exit(0);
    });

    return;
  }

  // ── Live mode ──────────────────────────────────────────────────────────────
  registerTsNodePathAlias();

  const { CoralSwapClient, Network }  = await import('../src/client' as any);
  const { FeeModule }                 = await import('../src/modules/fees');
  const { FactoryModule }             = await import('../src/modules/factory');
  const { TreasuryModule }            = await import('../src/modules/treasury');
  const { LeaderboardModule }         = await import('../src/modules/leaderboard');

  const network = networkEnv === 'mainnet' ? (Network as any).MAINNET : (Network as any).TESTNET;
  const client  = new CoralSwapClient({ network, rpcUrl });

  console.log(`${BOLD}${CYAN}CoralSwap Protocol Monitor — Live (${networkEnv})${RESET}`);
  console.log(`${DIM}Connecting to ${rpcUrl} …${RESET}`);

  // Verify RPC connectivity before entering the loop
  try {
    const healthy = await client.isHealthy();
    if (!healthy) {
      console.error('RPC endpoint is not healthy. Check CORALSWAP_RPC_URL.');
      process.exit(1);
    }
  } catch (err: any) {
    console.error('Failed to reach RPC endpoint:', err.message ?? err);
    process.exit(1);
  }

  let previous: ProtocolMetrics | null = null;

  const refresh = async () => {
    try {
      const current = await fetchProtocolMetrics(
        client,
        tokenA!,
        tokenB!,
        pairOverride,
        FeeModule,
        FactoryModule,
        TreasuryModule,
        LeaderboardModule,
      );
      renderDashboard(current, previous);
      previous = current;
    } catch (err: any) {
      // Do not crash the loop on transient RPC errors — log and retry next tick.
      process.stdout.write(`\x1b[2J\x1b[H`);
      console.error(`[${new Date().toISOString()}] Fetch error: ${err.message ?? err}`);
      console.error(`Retrying in ${refreshSec}s …`);
    }
  };

  await refresh();
  const timer = setInterval(refresh, refreshSec * 1000);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n\nMonitor stopped.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
