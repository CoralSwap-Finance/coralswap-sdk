import { CoralSwapClient } from '../src/client';
import { TaxReportingModule } from '../src/modules/tax-reporting';
import { Network } from '../src/types/common';

export interface ReconciliationEvent {
  date: string;
  type: 'swap';
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  fee: string;
  txHash: string;
}

export interface PeriodTaxSummary {
  period: string;
  shortTermGains: string;
  shortTermLosses: string;
  longTermGains: string;
  longTermLosses: string;
  totalGain: string;
  totalLoss: string;
  netGain: string;
}

export interface ReconciliationExampleResult {
  exportRows: ReconciliationEvent[];
  periodSummaries: PeriodTaxSummary[];
  pages: ReconciliationEvent[][];
}

const FIXTURE_EVENTS: ReconciliationEvent[] = [
  {
    date: '2024-01-15T00:00:00Z',
    type: 'swap',
    tokenIn: 'USDC',
    amountIn: '500.0000000',
    tokenOut: 'XLM',
    amountOut: '1100.0000000',
    fee: '0.5000000',
    txHash: 'tx-001',
  },
  {
    date: '2024-02-20T00:00:00Z',
    type: 'swap',
    tokenIn: 'XLM',
    amountIn: '250.0000000',
    tokenOut: 'USDC',
    amountOut: '125.0000000',
    fee: '0.2500000',
    txHash: 'tx-002',
  },
  {
    date: '2024-03-05T00:00:00Z',
    type: 'swap',
    tokenIn: 'USDC',
    amountIn: '250.0000000',
    tokenOut: 'XLM',
    amountOut: '600.0000000',
    fee: '0.3000000',
    txHash: 'tx-003',
  },
  {
    date: '2024-04-14T00:00:00Z',
    type: 'swap',
    tokenIn: 'XLM',
    amountIn: '140.0000000',
    tokenOut: 'USDC',
    amountOut: '150.0000000',
    fee: '0.1000000',
    txHash: 'tx-004',
  },
  {
    date: '2024-05-09T00:00:00Z',
    type: 'swap',
    tokenIn: 'USDC',
    amountIn: '100.0000000',
    tokenOut: 'XLM',
    amountOut: '215.0000000',
    fee: '0.1500000',
    txHash: 'tx-005',
  },
];

function formatPeriod(date: string): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toDecimal(value: string): number {
  return Number.parseFloat(value);
}

function roundMoney(value: number): string {
  return value.toFixed(7);
}

export function paginateExportRows<T>(rows: T[], pageSize: number): T[][] {
  const safePageSize = Math.max(1, pageSize);
  const pages: T[][] = [];

  for (let index = 0; index < rows.length; index += safePageSize) {
    pages.push(rows.slice(index, index + safePageSize));
  }

  return pages;
}

export async function buildTaxReconciliationExample(): Promise<ReconciliationExampleResult> {
  const client = new CoralSwapClient({
    network: Network.TESTNET,
    secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
    publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  });

  void client;
  const exportRows = FIXTURE_EVENTS.map((event) => ({ ...event }));

  const byPeriod = new Map<string, { gain: number; loss: number; shortTermGains: number; shortTermLosses: number; longTermGains: number; longTermLosses: number }>();

  for (const row of exportRows) {
    const period = formatPeriod(row.date);
    const bucket = byPeriod.get(period) ?? {
      gain: 0,
      loss: 0,
      shortTermGains: 0,
      shortTermLosses: 0,
      longTermGains: 0,
      longTermLosses: 0,
    };

    const proceeds = toDecimal(row.amountOut);
    const costBasis = toDecimal(row.amountIn) + toDecimal(row.fee);
    const delta = proceeds - costBasis;

    if (delta >= 0) {
      bucket.gain += delta;
      bucket.shortTermGains += delta;
      bucket.longTermGains += delta;
    } else {
      bucket.loss += Math.abs(delta);
      bucket.shortTermLosses += Math.abs(delta);
      bucket.longTermLosses += Math.abs(delta);
    }

    byPeriod.set(period, bucket);
  }

  const periodSummaries: PeriodTaxSummary[] = [...byPeriod.entries()].map(([period, summary]) => ({
    period,
    shortTermGains: roundMoney(summary.shortTermGains),
    shortTermLosses: roundMoney(summary.shortTermLosses),
    longTermGains: roundMoney(summary.longTermGains),
    longTermLosses: roundMoney(summary.longTermLosses),
    totalGain: roundMoney(summary.gain),
    totalLoss: roundMoney(summary.loss),
    netGain: roundMoney(summary.gain - summary.loss),
  }));

  const pages = paginateExportRows(exportRows, 2);

  return {
    exportRows,
    periodSummaries,
    pages,
  };
}

async function main(): Promise<void> {
  const result = await buildTaxReconciliationExample();

  console.log('Tax-aware portfolio reconciliation example');
  console.log('Periods:');
  for (const summary of result.periodSummaries) {
    console.log(
      `${summary.period}: gain=${summary.netGain}, totalGain=${summary.totalGain}, totalLoss=${summary.totalLoss}`,
    );
  }

  console.log(`Export pages: ${result.pages.length}`);
  console.log(`Rows per page: ${result.pages[0]?.length ?? 0}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Error running tax-reporting example:', error);
    process.exit(1);
  });
}
