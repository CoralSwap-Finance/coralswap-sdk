import { ValidationError } from "@/errors";

const REDSTONE_PRICE_URL =
  "https://api.redstone.finance/prices?symbol={symbol}&provider=redstone";

export interface PriceAlertParams {
  tokenAddress: string;
  /** Token symbol used for RedStone price lookup (e.g. "XLM", "USDC") */
  tokenSymbol: string;
  targetPriceUSD: number;
  direction: "above" | "below";
  pairAddress?: string;
  label?: string;
}

export interface PriceAlert {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  targetPriceUSD: number;
  direction: "above" | "below";
  pairAddress?: string;
  label?: string;
  triggered: boolean;
  /** True while price is on the trigger side; resets when it crosses back */
  armed: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
  lastPriceUSD: number | null;
}

/** In-memory store keyed by wallet address → alerts */
const store = new Map<string, PriceAlert[]>();

function generateId(): string {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function fetchPriceUSD(symbol: string): Promise<number> {
  const url = REDSTONE_PRICE_URL.replace("{symbol}", encodeURIComponent(symbol));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`RedStone price fetch failed for ${symbol}: ${res.status}`);
  }
  const data = (await res.json()) as { value: number }[];
  if (!data?.length || typeof data[0].value !== "number") {
    throw new Error(`No price data returned for ${symbol}`);
  }
  return data[0].value;
}

/**
 * Create a price alert for a token.
 *
 * Alert triggers when `currentPrice` crosses `targetPriceUSD` in the specified
 * `direction`. It will not re-trigger until the price crosses back and returns.
 *
 * @param walletAddress - Owner address used to scope alerts
 * @param params - Alert configuration
 * @returns The created PriceAlert
 * @throws {ValidationError} If targetPriceUSD is not positive
 */
export async function createPriceAlert(
  walletAddress: string,
  params: PriceAlertParams,
): Promise<PriceAlert> {
  if (params.targetPriceUSD <= 0) {
    throw new ValidationError("targetPriceUSD must be positive", {
      targetPriceUSD: params.targetPriceUSD,
    });
  }
  if (!params.tokenAddress) {
    throw new ValidationError("tokenAddress must not be empty");
  }
  if (!params.tokenSymbol) {
    throw new ValidationError("tokenSymbol must not be empty");
  }

  // Fetch current price to set initial armed state
  const currentPrice = await fetchPriceUSD(params.tokenSymbol);
  const alreadyOnTriggerSide =
    params.direction === "above"
      ? currentPrice > params.targetPriceUSD
      : currentPrice < params.targetPriceUSD;

  const alert: PriceAlert = {
    id: generateId(),
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    targetPriceUSD: params.targetPriceUSD,
    direction: params.direction,
    pairAddress: params.pairAddress,
    label: params.label,
    triggered: false,
    armed: !alreadyOnTriggerSide,
    createdAt: Date.now(),
    lastCheckedAt: Date.now(),
    lastPriceUSD: currentPrice,
  };

  const existing = store.get(walletAddress) ?? [];
  existing.push(alert);
  store.set(walletAddress, existing);

  return alert;
}

/**
 * Get all active (non-triggered) price alerts for a wallet address,
 * refreshing their state against the current RedStone price.
 *
 * @param walletAddress - Owner address
 * @returns Array of current PriceAlert objects
 */
export async function getPriceAlerts(
  walletAddress: string,
): Promise<PriceAlert[]> {
  const alerts = store.get(walletAddress);
  if (!alerts?.length) return [];

  // Group by symbol to minimise fetch calls
  const symbols = [...new Set(alerts.map((a) => a.tokenSymbol))];
  const prices = new Map<string, number>();
  await Promise.all(
    symbols.map(async (sym) => {
      prices.set(sym, await fetchPriceUSD(sym));
    }),
  );

  for (const alert of alerts) {
    const price = prices.get(alert.tokenSymbol)!;
    alert.lastCheckedAt = Date.now();
    alert.lastPriceUSD = price;

    const onTriggerSide =
      alert.direction === "above"
        ? price > alert.targetPriceUSD
        : price < alert.targetPriceUSD;

    if (alert.armed && onTriggerSide) {
      alert.triggered = true;
      alert.armed = false; // disarm until price crosses back
    } else if (!alert.armed && !onTriggerSide) {
      // Price crossed back -- re-arm so it can trigger again
      alert.armed = true;
    }
  }

  return alerts;
}
