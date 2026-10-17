/**
 * CoralSwap Protocol Monitoring Dashboard
 *
 * Displays a real-time metrics dashboard for the CoralSwap protocol,
 * consuming real TVL / volume / fees aggregation from the SDK's
 * MonitoringModule instead of fabricated fixtures.
 *
 *   - TVL per pool and protocol-wide
 *   - 24-hour trading volume and fee revenue
 *   - Protocol treasury revenue
 *   - Active traders and swap counts
 *   - Dynamic fee rates per pool
 *   - Trend indicators (↑ ↓ →) based on the delta between refreshes
 *
 * Usage:
 *   npx ts-node examples/monitoring-dashboard.ts
 *
 * Required env vars for live testnet data:
 *   CORALSWAP_RPC_URL      — Soroban RPC endpoint
 *
 * Optional:
 *   CORALSWAP_NETWORK           — "testnet" (default) | "mainnet"
 *   CORALSWAP_REFRESH_SEC       — Refresh interval in seconds (default: 30)
 *   CORALSWAP_STABLE_ADDRESSES  — Comma-separated stablecoin addresses for USD pricing
 *
 * When CORALSWAP_RPC_URL is absent a deterministic demo dashboard runs instead,
 * showing how the output looks with fixture data that mirrors the real
 * aggregation types.
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
  /** 24h trading volume in USD */
  volume24hUSD: number;
  /** 24h fee revenue in USD */
  fees24hUSD: number;
  /** Number of swaps in the trailing 24h window */
  totalSwaps24h: number;
  /** Unique senders in the trailing 24h window */
  uniqueUsers24h: number;
  feeBps: number;
  isFeeStalse: boolean;
}

interface ProtocolMetrics {
  timestamp: Date;
  pools: PoolMetrics[];
  totalTVLUSD: number;
  totalVolume24hUSD: number;
  totalFees24hUSD: number;
  treasuryUSD: number;
  topTraderVolume: number;
  topTraderCount: number;
  totalSwaps24h: number;
  uniqueUsers24h: number;
}

// ─── Trend helpers ───────────────────────────────────────────────────────────

type Trend = '↑' | '↓' | '→';

function trend(current: number, previous: number): Trend {
  const delta = current - previous;
  if (Math.abs(delta) < 1e-9) return '→';
  return delta > 0 ? '↑' : '↓';
}

function colorTrend(t: Trend): string {
  if (t === '↑') return `\x1b[32m${t}\x1b[0m`; // green
  if (t === '↓') return `\x1b[31m${t}\x1b[0m`; // red
  return `\x1b[90m${t}\x1b[0m`;                  // grey
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

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
  const volT = previous ? trend(current.totalVolume24hUSD, previous.totalVolume24hUSD) : '→';
  const feeT = previous ? trend(current.totalFees24hUSD, previous.totalFees24hUSD) : '→';
  const revT = previous ? trend(current.treasuryUSD, previous.treasuryUSD) : '→';
  const swapT = previous ? trend(current.totalSwaps24h, previous.totalSwaps24h) : '→';
  const usrT = previous ? trend(current.uniqueUsers24h, previous.uniqueUsers24h) : '→';

  const kpiRows = [
    ['Total TVL',           fmtUSD(current.totalTVLUSD),           colorTrend(tvlT)],
    ['24h Volume',          fmtUSD(current.totalVolume24hUSD),     colorTrend(volT)],
    ['24h Fees',            fmtUSD(current.totalFees24hUSD),       colorTrend(feeT)],
    ['Treasury Revenue',    fmtUSD(current.treasuryUSD),           colorTrend(revT)],
    ['24h Swaps',           String(current.totalSwaps24h),         colorTrend(swapT)],
    ['Unique Traders (24h)',String(current.uniqueUsers24h),        colorTrend(usrT)],
  ];

  for (const [label, value, arrow] of kpiRows) {
    console.log(`  ${padRight(label, 24)} ${padLeft(value, 12)}  ${arrow}`);
  }

  // ── Pool table ────────────────────────────────────────────────────────────
  console.log();
  console.log(`${BOLD}  Pool Metrics${RESET}`);
  console.log(DIVIDER);
  console.log(
    `  ${padRight('Pool', 24)}` +
    `${padLeft('TVL (USD)', 12)}` +
    `${padLeft('24h Vol.', 12)}` +
    `${padLeft('24h Fees', 10)}` +
    `${padLeft('Swaps', 8)}` +
    `${padLeft('Fee', 8)}  ` +
    `Status`,
  );
  console.log(`  ${DIM}${'·'.repeat(76)}${RESET}`);

  for (const pool of current.pools) {
    const prevPool = previous?.pools.find((p) => p.address === pool.address) ?? null;
    const tvlArrow  = prevPool ? colorTrend(trend(pool.tvlUSD, prevPool.tvlUSD)) : colorTrend('→');
    const volArrow  = prevPool ? colorTrend(trend(pool.volume24hUSD, prevPool.volume24hUSD)) : colorTrend('→');
    const feeArrow  = prevPool ? colorTrend(trend(pool.feeBps, prevPool.feeBps)) : colorTrend('→');
    const staleStr  = pool.isFeeStalse ? `${DIM}stale${RESET}` : `\x1b[32mlive\x1b[0m`;

    const tvlStr  = fmtUSD(pool.tvlUSD);
    const volStr  = fmtUSD(pool.volume24hUSD);
    const feeStr  = fmtUSD(pool.fees24hUSD);
    const swapStr = String(pool.totalSwaps24h);
    const feeBps  = fmtBps(pool.feeBps);

    console.log(
      `  ${padRight(pool.label, 24)}` +
      `${padLeft(tvlArrow + tvlStr, 16)}` +
      `${padLeft(volArrow + volStr, 16)}` +
      `${padLeft(feeStr, 14)}` +
      `${padLeft(swapStr, 12)}` +
      `${padLeft(feeArrow + feeBps, 12)}  ` +
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
      volume24hUSD: 85_000 + rng(tick * 1.5) * 12_000,
      fees24hUSD:   255 + rng(tick * 1.6) * 36,
      totalSwaps24h: 320 + Math.round(rng(tick * 1.7) * 60),
      uniqueUsers24h: 45 + Math.round(rng(tick * 1.8) * 10),
      feeBps:  30 + Math.round(rng(tick * 0.7) * 20),
      isFeeStalse: tick % 3 === 0,
    },
    {
      address: 'CDEMO_PAIR_USDC_ETH_000000000000000000000000000000',
      label:   'USDC / wETH',
      tvlA:    BigInt(Math.round((200_000 + rng(tick * 2.1) * 5_000) * 1e7)),
      tvlB:    BigInt(Math.round((60 + rng(tick * 2.3) * 5) * 1e7)),
      tvlUSD:  200_000 + rng(tick * 2.1) * 5_000,
      volume24hUSD: 42_000 + rng(tick * 2.5) * 6_000,
      fees24hUSD:   210 + rng(tick * 2.6) * 30,
      totalSwaps24h: 180 + Math.round(rng(tick * 2.7) * 40),
      uniqueUsers24h: 28 + Math.round(rng(tick * 2.8) * 8),
      feeBps:  50 + Math.round(rng(tick * 1.9) * 30),
      isFeeStalse: false,
    },
    {
      address: 'CDEMO_PAIR_XLM_BTC_0000000000000000000000000000000',
      label:   'XLM / wBTC',
      tvlA:    BigInt(Math.round((900_000 + rng(tick * 3.1) * 20_000) * 1e7)),
      tvlB:    BigInt(Math.round((3 + rng(tick * 3.3) * 0.5) * 1e7)),
      tvlUSD:  90_000 + rng(tick * 3.1) * 2_000,
      volume24hUSD: 18_000 + rng(tick * 3.5) * 3_000,
      fees24hUSD:   180 + rng(tick * 3.6) * 30,
      totalSwaps24h: 95 + Math.round(rng(tick * 3.7) * 20),
      uniqueUsers24h: 15 + Math.round(rng(tick * 3.8) * 5),
      feeBps:  100 + Math.round(rng(tick * 2.7) * 50),
      isFeeStalse: tick % 5 === 0,
    },
  ];

  const totalTVLUSD       = pools.reduce((s, p) => s + p.tvlUSD, 0);
  const totalVolume24hUSD = pools.reduce((s, p) => s + p.volume24hUSD, 0);
  const totalFees24hUSD   = pools.reduce((s, p) => s + p.fees24hUSD, 0);
  const totalSwaps24h     = pools.reduce((s, p) => s + p.totalSwaps24h, 0);
  const uniqueUsers24h    = pools.reduce((s, p) => s + p.uniqueUsers24h, 0);
  const treasuryUSD       = totalFees24hUSD * 0.15 * (1 + rng(tick * 4.1) * 0.1);
  const topVolume         = 35_000 + rng(tick * 5.1) * 8_000;
  const topTraders        = 12 + Math.round(rng(tick * 6.1) * 5);

  return {
    timestamp: new Date(),
    pools,
    totalTVLUSD,
    totalVolume24hUSD,
    totalFees24hUSD,
    treasuryUSD,
    topTraderVolume: topVolume,
    topTraderCount: topTraders,
    totalSwaps24h,
    uniqueUsers24h,
  };
}

// ─── Live data fetching ───────────────────────────────────────────────────────

async function fetchProtocolMetrics(
  monitor: any,
  treasury: any,
  leaderboard: any,
): Promise<ProtocolMetrics> {
  // ── Protocol-wide metrics (TVL, 24h volume, active pools, users, swaps) ──
  const protocolMetrics = await monitor.getProtocolMetrics();

  // ── Per-pool metrics ──────────────────────────────────────────────────────
  const allPairs = await monitor.client.factory.getAllPairs();
  const pools: PoolMetrics[] = [];

  for (const pairAddress of allPairs) {
    try {
      const pm = await monitor.getPoolMetrics(pairAddress);
      // Skip pools with zero reserves (inactive)
      if (pm.reserve0 === 0n && pm.reserve1 === 0n) continue;
      pools.push({
        address: pairAddress,
        label: `${pm.pairAddress.slice(0, 4)}…`,
        tvlA: pm.reserve0,
        tvlB: pm.reserve1,
        tvlUSD: pm.tvlUSD,
        volume24hUSD: pm.volume24hUSD,
        fees24hUSD: 0, // populated below from treasury
        totalSwaps24h: pm.totalSwaps24h,
        uniqueUsers24h: pm.uniqueUsers24h,
        feeBps: pm.feeBps,
        isFeeStalse: false,
      });
    } catch {
      // Skip pools we can't read — non-fatal
    }
  }

  // ── Treasury fee revenue ──────────────────────────────────────────────────
  let treasuryUSD = 0;
  try {
    const revenue = await treasury.getFeeRevenue();
    treasuryUSD = revenue.totalUSD;
    // Enrich pool fees from treasury revenue data
    for (const pool of pools) {
      const poolRev = revenue.byPool.find((r: any) => r.pairAddress === pool.address);
      if (poolRev) {
        pool.fees24hUSD = poolRev.revenueUSD;
      }
    }
  } catch {
    // treasury may be empty on testnet — non-fatal
  }

  // ── Leaderboard top traders ───────────────────────────────────────────────
  let topTraderVolume = 0;
  let topTraderCount = 0;
  try {
    const traders = await leaderboard.getTopTraders({ limit: 10, periodDays: 1 });
    topTraderCount = traders.length;
    topTraderVolume = traders.reduce((s: number, t: any) => s + t.totalVolumeUSD, 0);
  } catch {
    // leaderboard may have no data on testnet — non-fatal
  }

  return {
    timestamp: new Date(),
    pools,
    totalTVLUSD: protocolMetrics.tvlUSD,
    totalVolume24hUSD: protocolMetrics.volume24hUSD,
    totalFees24hUSD: treasuryUSD,
    treasuryUSD,
    topTraderVolume,
    topTraderCount,
    totalSwaps24h: protocolMetrics.totalSwaps24h,
    uniqueUsers24h: protocolMetrics.uniqueUsers24h,
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl         = process.env.CORALSWAP_RPC_URL;
  const networkEnv     = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const refreshSec     = Math.max(5, Number(process.env.CORALSWAP_REFRESH_SEC ?? 30));

  const canUseLive = Boolean(rpcUrl);

  if (!canUseLive) {
    // ── Demo mode ──────────────────────────────────────────────────────────
    console.log(`${BOLD}${CYAN}CoralSwap Protocol Monitor — Demo Mode${RESET}`);
    console.log(`${DIM}Set CORALSWAP_RPC_URL to connect to Stellar Testnet and see real aggregation data.${RESET}`);
    console.log(`${DIM}Optionally set CORALSWAP_STABLE_ADDRESSES (comma-separated) for USD pricing.${RESET}`);
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
  const { MonitoringModule }          = await import('../src/modules/monitoring');
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

  // Accept stable addresses for USD pricing (optional, defaults to no pricing)
  const stableEnv = process.env.CORALSWAP_STABLE_ADDRESSES;
  const stableAddresses = stableEnv ? stableEnv.split(',').map((s) => s.trim()) : [];

  const monitor    = new MonitoringModule(client, { stableAddresses });
  const treasury   = new TreasuryModule(client, { stableAddresses });
  const leaderboard = new LeaderboardModule(client);

  let previous: ProtocolMetrics | null = null;

  const refresh = async () => {
    try {
      const current = await fetchProtocolMetrics(
        monitor,
        treasury,
        leaderboard,
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
