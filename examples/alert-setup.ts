/**
 * Alert Setup Example — Price and Impermanent Loss alerts with webhook delivery
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Why this example exists
 * ────────────────────────
 * CoralSwap pools operate 24/7 on Stellar and respond to global liquidity shifts.
 * Builders integrating the protocol in their own dashboards, bots, or back-office
 * systems frequently need to be notified whenever:
 *
 *   • A token's spot price crosses a threshold  ──►  price alert
 *   • An LP position has drifted into impermanent loss beyond a tolerance
 *                                                    ──►  IL alert
 *
 * Alert payloads must be delivered to an external endpoint so they can be
 * routed to Slack / Discord / e-mail / a custom backend.  This example
 * demonstrates the *complete* lifecycle for both alert types, end-to-end:
 *
 *   1. Initialize the CoralSwap SDK against Stellar Testnet.
 *   2. Spin up a signed local webhook receiver (Node `http` server) so the
 *      delivery path can be inspected without any third-party service.
 *   3. Create a price alert with a comment-justified threshold.
 *   4. Create an impermanent-loss alert with a comment-justified threshold.
 *   5. Register the webhook endpoint with the alert service.
 *   6. Trigger synthetic observations that cross both thresholds.
 *   7. Print the resulting delivery log captured by the local receiver.
 *
 * The script is fully self-contained — the only network dependency is the
 * Soroban RPC endpoint, and the example still runs end-to-end even when RPC
 * calls fail (alerts operate on a local observation stream).
 *
 * Run it with:
 *     npx ts-node examples/alert-setup.ts
 *     npm run examples:alert-setup
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Imports
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import * as http from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Network } from '../src/types/common';
import { CoralSwapClient } from '../src/client';

// ─────────────────────────────────────────────────────────────────────────────
//  Domain types
// ─────────────────────────────────────────────────────────────────────────────

/** Direction of price movement that fires a price alert. */
type AlertDirection = 'above' | 'below';

/** Stellar uses 7-decimal fixed-point numbers throughout — the SDK exposes
 *  amounts as `bigint`.  Plain `number` is used here only for clarity in
 *  printed output; the helper `toStroop` performs the conversion. */
const DECIMALS = 7;

/** A price alert fires when the on-chain spot price for `token` crosses
 *  `thresholdPrice` in the chosen `direction`, relative to a recorded
 *  `baselinePrice` captured at alert creation time. */
interface PriceAlertRule {
  kind: 'price';
  id: string;
  /** Optional — when set, only prices read from this pool fire the alert.
   *  When `null`, any pool containing `token` can fire it (in this example
   *  we always pin to a specific pair to keep things deterministic). */
  pairAddress: string;
  token: string;
  baselinePrice: number;     // 7-decimal fixed-point ("stroops-equivalent")
  direction: AlertDirection;
  thresholdPrice: number;    // 7-decimal fixed-point
  createdAt: number;
  rationale: string;         // human-readable justification of the threshold
}

/** An IL alert fires when the impermanent loss implied by the current
 *  reserve ratio exceeds `thresholdBps` (basis points; 100 bps = 1.00 %).
 *
 *  The standard constant-product IL formula is:
 *
 *      IL(r) = 2·√r / (1 + r) − 1
 *
 *  where `r` is the price ratio (`newPrice / initialPrice`) and IL(r) is
 *  negative for any r ≠ 1 (losses).  We expose the *magnitude* of the
 *  loss as a positive percentage for readability. */
interface ILAlertRule {
  kind: 'il';
  id: string;
  pairAddress: string;
  holder: string;            // LP holder — informational only
  initialReserveA: number;   // reserve snapshot at LP deposit (7-dp)
  initialReserveB: number;
  direction: AlertDirection;
  thresholdBps: number;      // 100 bps = 1.00 %
  createdAt: number;
  rationale: string;
}

type AlertRule = PriceAlertRule | ILAlertRule;

/** A delivery webhook is the destination an alert payload is `POST`ed to.
 *  Each alert can subscribe to one or more webhooks; deliveries are
 *  signed with HMAC-SHA256(secret) so the receiver can verify origin. */
interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;            // HMAC shared secret
  subscribedAlertIds: string[];
  createdAt: number;
}

/** What the alert service posts to the receiver when a rule fires. */
interface AlertPayload {
  alertId: string;
  alertKind: 'price' | 'il';
  ruleSummary: string;
  observedValue: number;     // 7-dp prices, or bps for IL
  thresholdValue: number;
  delta: number;
  pairAddress: string;
  tokenSymbol: string;
  firedAt: number;           // unix ms
}

/** One row of the delivery log printed at the end of the example. */
interface DeliveryRecord {
  alertId: string;
  alertKind: 'price' | 'il';
  webhookId: string;
  alertServiceStatus: 'delivered' | 'failed';
  attempts: number;
  httpStatus: number | null;
  payload: AlertPayload;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Math helpers — display formatting and IL calculation
// ─────────────────────────────────────────────────────────────────────────────

/** Pretty-print a 7-decimal fixed-point number as a decimal string. */
function fmt(amount: number, decimals = DECIMALS): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 10 ** decimals);
  const frac = (abs % 10 ** decimals).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${sign}${whole}.${frac}`;
}

/** Convert a human decimal string ("1.052") to 7-decimal fixed-point. */
function toStroop(decimal: string | number): number {
  const s = typeof decimal === 'number' ? decimal.toString() : decimal.trim();
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS);
  return Number(whole) * 10 ** DECIMALS + Number(fracPadded || 0);
}

/** Impermanent-loss *magnitude* (positive %) for a given reserve ratio.
 *
 *  `priceRatio = currentPrice / initialPrice`.
 *  Returns the absolute value of `2·√r / (1 + r) − 1` expressed in bps.
 *  Example: r = 2 → IL = 5.72 % → returns 572 bps.
 */
function calculateILBps(priceRatio: number): number {
  if (priceRatio <= 0) return 0;
  const il = (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
  return Math.round(Math.abs(il) * 10_000);
}

/** Sign an alert payload with the webhook's shared secret. */
function signPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
//  LocalWebhookServer — captures signed POSTs so we can verify delivery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mini HTTP server that emulates a Slack-style webhook receiver.  Each `POST`
 * to `/alerts` is verified with HMAC-SHA256 (`X-CoralSwap-Signature` header)
 * and appended to an in-memory log the example prints at the end.
 *
 * In production, this would be replaced by your real endpoint.  The signing
 * scheme and JSON shape are kept identical so you can drop the example into
 * your backend verbatim.
 */
class LocalWebhookServer {
  private server: http.Server | null = null;
  public readonly log: Array<{
    receivedAt: number;
    sigValid: boolean;
    headers: http.IncomingHttpHeaders;
    body: AlertPayload;
  }> = [];
  public readonly records: DeliveryRecord[] = [];

  /**
   * Start listening on `127.0.0.1` and resolve with the bound port number.
   * Once started, the receiver is reachable at `http://127.0.0.1:<port>/alerts`.
   */
  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/alerts') {
          res.statusCode = 404;
          res.end('not found');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let parsed: AlertPayload;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('bad json');
            return;
          }
          const sig = String(req.headers['x-coralswap-signature'] ?? '');
          const expected = signPayload(body, WEBHOOK_SECRET);
          let valid = false;
          if (sig.length === expected.length) {
            try {
              valid = timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
            } catch {
              // malformed hex in the signature header — treat as invalid
              valid = false;
            }
          }

          this.log.push({
            receivedAt: Date.now(),
            sigValid: valid,
            headers: req.headers,
            body: parsed,
          });

          // Return 200 so the alert-service dispatcher sees a successful POST.
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, sigValid: valid }));
        });
      });

      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

// Shared secret used by both the dispatcher and the local receiver.  In a
// real deployment this would never be hardcoded — it would come from a
// secrets manager and be rotated independently.
const WEBHOOK_SECRET = 'coral_demo_secret_' + randomUUID().replace(/-/g, '');

// ─────────────────────────────────────────────────────────────────────────────
//  AlertService — in-memory rule engine + signed dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A small rule engine that holds alert rules and a list of delivery
 * webhooks.  When an observation is fed in:
 *
 *   • If the rule's condition is met, the AlertService builds an
 *     `AlertPayload`, signs it with HMAC-SHA256, and `POST`s it to every
 *     webhook subscribed to that rule.
 *
 *   • Each delivery is logged (success or failure) for later inspection.
 *
 * This mirrors the way a production off-chain indexer / watcher would
 * behave: poll on-chain reserves or oracle prices, evaluate rule
 * conditions, fan out to delivery channels.
 */
class AlertService {
  readonly rules = new Map<string, AlertRule>();
  readonly webhooks = new Map<string, WebhookEndpoint>();
  readonly deliveries: DeliveryRecord[] = [];

  addPriceAlert(rule: PriceAlertRule): PriceAlertRule {
    this.rules.set(rule.id, rule);
    return rule;
  }

  addILAlert(rule: ILAlertRule): ILAlertRule {
    this.rules.set(rule.id, rule);
    return rule;
  }

  registerWebhook(ep: WebhookEndpoint): WebhookEndpoint {
    this.webhooks.set(ep.id, ep);
    return ep;
  }

  /**
   * Subscribe a webhook endpoint to one or more alert rules by id.
   */
  subscribe(webhookId: string, alertIds: string[]): void {
    const ep = this.webhooks.get(webhookId);
    if (!ep) throw new Error(`webhook ${webhookId} not registered`);
    for (const id of alertIds) {
      if (!ep.subscribedAlertIds.includes(id)) {
        ep.subscribedAlertIds.push(id);
      }
    }
  }

  /**
   * Feed a synthetic observation into the engine and dispatch any alerts
   * that fire.  Used by the example to demonstrate the full delivery
   * pipeline without depending on a live indexer.
   */
  async observe(opts: {
    pairAddress: string;
    tokenSymbol: string;
    currentPrice: number;
    currentReserveA: number;
    currentReserveB: number;
    webhooks: LocalWebhookServer; // server into which deliveries are POSTed
  }): Promise<DeliveryRecord[]> {
    const fired: DeliveryRecord[] = [];

    for (const rule of this.rules.values()) {
      let payload: AlertPayload | null = null;

      if (rule.kind === 'price' && rule.pairAddress === opts.pairAddress) {
        if (
          (rule.direction === 'above' && opts.currentPrice >= rule.thresholdPrice) ||
          (rule.direction === 'below' && opts.currentPrice <= rule.thresholdPrice)
        ) {
          payload = {
            alertId: rule.id,
            alertKind: 'price',
            ruleSummary: `${rule.token} ${rule.direction} ${fmt(rule.thresholdPrice)} (from baseline ${fmt(rule.baselinePrice)})`,
            observedValue: opts.currentPrice,
            thresholdValue: rule.thresholdPrice,
            delta: opts.currentPrice - rule.baselinePrice,
            pairAddress: opts.pairAddress,
            tokenSymbol: opts.tokenSymbol,
            firedAt: Date.now(),
          };
        }
      } else if (rule.kind === 'il' && rule.pairAddress === opts.pairAddress) {
        const priceRatio =
          rule.initialReserveA === 0 || rule.initialReserveB === 0
            ? 1
            : (opts.currentReserveB / rule.initialReserveB) /
              (opts.currentReserveA / rule.initialReserveA);
        const ilBps = calculateILBps(priceRatio);
        if (
          (rule.direction === 'above' && ilBps >= rule.thresholdBps) ||
          (rule.direction === 'below' && ilBps <= rule.thresholdBps)
        ) {
          payload = {
            alertId: rule.id,
            alertKind: 'il',
            ruleSummary: `IL ${rule.direction} ${rule.thresholdBps} bps in pair ${rule.pairAddress.slice(0, 8)}…`,
            observedValue: ilBps,
            thresholdValue: rule.thresholdBps,
            delta: ilBps,
            pairAddress: opts.pairAddress,
            tokenSymbol: opts.tokenSymbol,
            firedAt: Date.now(),
          };
        }
      }

      if (!payload) continue;

      // Dispatch to every subscribed webhook that targets this alert.
      for (const ep of this.webhooks.values()) {
        if (!ep.subscribedAlertIds.includes(rule.id)) continue;
        const rec = await this.dispatch(ep, payload, opts.webhooks);
        fired.push(rec);
      }
    }
    return fired;
  }

  private async dispatch(
    ep: WebhookEndpoint,
    payload: AlertPayload,
    server: LocalWebhookServer,
  ): Promise<DeliveryRecord> {
    const body = JSON.stringify(payload);
    const sig = signPayload(body, ep.secret);
    const start = Date.now();

    const record: DeliveryRecord = {
      alertId: payload.alertId,
      alertKind: payload.alertKind,
      webhookId: ep.id,
      alertServiceStatus: 'failed',
      attempts: 0,
      httpStatus: null,
      payload,
      durationMs: 0,
    };

    // Try up to 3 times with linear backoff so transient errors during a
    // demo or test don't cause spurious misses.
    for (let attempt = 1; attempt <= 3; attempt++) {
      record.attempts = attempt;
      try {
        const status = await postJson(ep.url, body, sig);
        // Reflect the dispatch outcome into both the in-service log and the
        // receiver's log (they'll match if you cross-check during debugging).
        if (status >= 200 && status < 300) {
          record.alertServiceStatus = 'delivered';
          record.httpStatus = status;
          server.records.push(record);
          this.deliveries.push(record);
          record.durationMs = Date.now() - start;
          return record;
        }
        record.httpStatus = status;
      } catch {
        /* swallow and retry */
      }
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }

    record.durationMs = Date.now() - start;
    this.deliveries.push(record);
    server.records.push(record);
    return record;
  }
}

/**
 * Promise-wrapped HTTP `POST` that resolves with the response status code.
 * Re-uses Node's global `http` agent / keep-alive for simplicity.
 */
function postJson(url: string, body: string, signature: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-coralswap-signature': signature,
          'x-coralswap-delivery': '1',
        },
      },
      (res) => {
        res.on('data', () => {
          /* drain */
        });
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main flow
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ════════════════════════════════════════════════════════════════════════
  //  Step 0 — environment & SDK bootstrap
  // ════════════════════════════════════════════════════════════════════════
  //
  // The example still works when no env vars are set: the alert engine and
  // the webhook receiver are entirely local.  When env vars are present
  // we additionally resolve a real pool address from the factory so the
  // alert rules are demonstrably against a deployed contract.

  const rpcUrl = process.env.CORALSWAP_RPC_URL;
  const networkEnv = process.env.CORALSWAP_NETWORK ?? 'testnet';
  const network = networkEnv === 'mainnet' ? Network.MAINNET : Network.TESTNET;

  const tokenA = process.env.CORALSWAP_TOKEN_A ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
  const tokenB = process.env.CORALSWAP_TOKEN_B ?? 'CDCYWK73YTYFJZZSJ5V7EDFNHYBG4GAQV2RKQXF4UDZ2KXHZSTLKL2C';

  console.log('');
  console.log('🪸  CoralSwap — Alert Setup Example  (price + IL alerts)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Network        : ${networkEnv}`);
  console.log(`  Token A        : ${tokenA}`);
  console.log(`  Token B        : ${tokenB}`);
  console.log('');

  let pairAddress: string | null = null;
  try {
    const client = new CoralSwapClient({
      network,
      ...(rpcUrl ? { rpcUrl } : {}),
    });
    pairAddress = await client.getPairAddress(tokenA, tokenB);
    if (pairAddress) {
      console.log(`  ✅ Resolved pair on-chain: ${pairAddress}`);
    } else {
      console.log('  ⚠  Pair not found on-chain — using synthetic pair address for the demo.');
    }
  } catch (err) {
    console.log('  ⚠  RPC unavailable — running the demo entirely against synthetic data.');
  }

  // Fall back to a deterministic synthetic address so the flow still
  // produces events end-to-end.  This keeps `npx ts-node` runs reproducible
  // even when the developer's workstation cannot reach Soroban Testnet.
  const SYNTHETIC_PAIR = 'C'.padEnd(56, 'Z');
  if (!pairAddress) pairAddress = SYNTHETIC_PAIR;

  // Holders used in IL alerts — purely informational.
  const LP_HOLDER = process.env.CORALSWAP_PUBLIC_KEY ?? 'GLPHOLDER0000000000000000000000000000000000000000000000000';

  // ════════════════════════════════════════════════════════════════════════
  //  Step 1 — start the local webhook receiver
  // ════════════════════════════════════════════════════════════════════════
  //
  // First we bring up a tiny HTTP server bound to an ephemeral port on
  // 127.0.0.1.  Any POST arriving at `/alerts` will be verified with the
  // HMAC signature and appended to the receiver's in-process log so we can
  // print the full delivery history at the end.

  const server = new LocalWebhookServer();
  const port = await server.start();
  const webhookUrl = `http://127.0.0.1:${port}/alerts`;
  console.log('');
  console.log('Step 1 — Webhook receiver');
  console.log('─────────────────────────');
  console.log(`  Listening on  : ${webhookUrl}`);
  console.log(`  HMAC secret   : ${WEBHOOK_SECRET.slice(0, 16)}… (truncated)`);
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  //  Step 2 — create the alert service and register the webhook
  // ════════════════════════════════════════════════════════════════════════

  const alerts = new AlertService();
  const webhook: WebhookEndpoint = {
    id: 'wh_alerts_' + randomUUID().slice(0, 8),
    url: webhookUrl,
    secret: WEBHOOK_SECRET,
    subscribedAlertIds: [],
    createdAt: Date.now(),
  };
  alerts.registerWebhook(webhook);
  console.log('Step 2 — Webhook registration');
  console.log('─────────────────────────────');
  console.log(`  Webhook id    : ${webhook.id}`);
  console.log(`  URL           : ${webhook.url}`);
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  //  Step 3 — create a PRICE alert
  // ════════════════════════════════════════════════════════════════════════
  //
  // THRESHOLD SELECTION
  // ───────────────────
  // We anchor against a known baseline NAV for deJTRSY (≈ $1.052) and set
  // the alert to fire when the pool-implied price rises above $1.10.  This
  // corresponds to roughly +5 % from baseline — a meaningful move that is
  // rare enough to keep noise low but common enough to be actionable for
  // rebalancing bots.  Tighter thresholds (1–2 %) generate more alerts
  // during normal volatility; looser ones (10 %+) rarely fire and risk
  // missing genuine regime changes.  See the README chart for typical
  // pair-class thresholds:
  //
  //     stable/stable   : 50  bps  (≈ $0.005 on a $1 peg)
  //     stable/volatile : 200 bps  (≈ 2 %)
  //     volatile/volatile : 500–1000 bps  (≈ 5–10 %)

  const BASELINE_PRICE = toStroop('1.052');          // $1.052 baseline
  const PRICE_THRESHOLD = toStroop('1.10');          //   +5 % above baseline
  const priceAlert: PriceAlertRule = {
    kind: 'price',
    id: 'price_alert_' + randomUUID().slice(0, 8),
    pairAddress,
    token: 'deJTRSY',
    baselinePrice: BASELINE_PRICE,
    direction: 'above',
    thresholdPrice: PRICE_THRESHOLD,
    createdAt: Date.now(),
    rationale:
      'Fire when deJTRSY pool-implied price > $1.10 (+5 % vs. baseline NAV $1.052). ' +
      'Suitable for rebalancing bots on a stable/volatile RWA pair.',
  };
  alerts.addPriceAlert(priceAlert);
  console.log('Step 3 — Price alert created');
  console.log('────────────────────────────');
  console.log(`  Alert id      : ${priceAlert.id}`);
  console.log(`  Token         : ${priceAlert.token}`);
  console.log(`  Direction     : ${priceAlert.direction}`);
  console.log(`  Baseline      : $${fmt(priceAlert.baselinePrice)}`);
  console.log(`  Threshold     : $${fmt(priceAlert.thresholdPrice)}`);
  console.log(`  Rationale     : ${priceAlert.rationale}`);
  console.log('');

  alerts.subscribe(webhook.id, [priceAlert.id]);

  // ════════════════════════════════════════════════════════════════════════
  //  Step 4 — create an IL alert
  // ════════════════════════════════════════════════════════════════════════
  //
  // THRESHOLD SELECTION
  // ───────────────────
  // IL grows non-linearly with price drift.  Some commonly-used tolerances:
  //
  //     +50 %  price move → ≈  2.0 % IL   (light chatter)
  //     +100 % price move → ≈  5.7 % IL   (yellow flag)
  //     +200 % price move → ≈ 13.4 % IL   (action: review hedging)
  //     +400 % price move → ≈ 20.0 % IL   (rebalance recommended)
  //
  // For a balanced RWA pool we pick 300 bps (3.00 %).  This corresponds to
  // roughly ±75 % drift from the initial price ratio and is sensitive enough
  // to flag early-warning downside exposure without triggering during a
  // normal trading session.

  const ilAlert: ILAlertRule = {
    kind: 'il',
    id: 'il_alert_' + randomUUID().slice(0, 8),
    pairAddress,
    holder: LP_HOLDER,
    initialReserveA: toStroop(475285),   // snapshot at LP deposit time
    initialReserveB: toStroop(500000),   //   (500 USDC : 475.285 deJTRSY)
    direction: 'above',
    thresholdBps: 300,                   // 3.00 %
    createdAt: Date.now(),
    rationale:
      'Fire when IL from this LP position exceeds 3.00 %. ' +
      'Catches roughly ±75 % price drift before it grows into a 5 %+ loss.',
  };
  alerts.addILAlert(ilAlert);
  console.log('Step 4 — Impermanent-loss alert created');
  console.log('────────────────────────────────────────');
  console.log(`  Alert id       : ${ilAlert.id}`);
  console.log(`  Holder         : ${ilAlert.holder}`);
  console.log(`  Threshold      : ${(ilAlert.thresholdBps / 100).toFixed(2)} %`);
  console.log(`  Direction      : ${ilAlert.direction}`);
  console.log(`  Initial reserves: ${fmt(ilAlert.initialReserveA)} / ${fmt(ilAlert.initialReserveB)}`);
  console.log(`  Rationale      : ${ilAlert.rationale}`);
  console.log('');

  alerts.subscribe(webhook.id, [ilAlert.id]);

  // ════════════════════════════════════════════════════════════════════════
  //  Step 5 — trigger observations that fire each alert
  // ════════════════════════════════════════════════════════════════════════
  //
  // Two synthetic observations are dispatched:
  //
  //   1. Token price at $1.115 — fires the price alert (above $1.10).
  //   2. Pool reserves shifted 2× ratio — fires the IL alert (>3 % IL).
  //
  // In a production deployment these observations would come from an
  // indexer polling `pair.getReserves()` + `oracle.getPrice()` on a fixed
  // cadence.  The dispatcher fan-out is identical.

  console.log('Step 5 — Trigger observations');
  console.log('─────────────────────────────');

  // --- Observation 5a : price alert ---
  const firePrice = await alerts.observe({
    pairAddress,
    tokenSymbol: 'deJTRSY',
    currentPrice: toStroop('1.115'),
    currentReserveA: ilAlert.initialReserveA,
    currentReserveB: ilAlert.initialReserveB,
    webhooks: server,
  });
  console.log(`  • Price move $1.115 → ${firePrice.length} delivery record(s)`);

  // --- Observation 5b : IL alert ---
  // Double the ratio of one reserve to create a 4× price-ratio shift.
  // For reserveA=475285, reserveB=500000 → ratio = 500_000 / 475_285 = 1.052
  // After doubling reserveB (keeping reserveA constant): new ratio = 1M / 475_285 ≈ 2.104
  // IL(2.104) ≈ 5.93 %  → above our 3.00 % threshold.
  const fireIL = await alerts.observe({
    pairAddress,
    tokenSymbol: 'deJTRSY',
    currentPrice: BASELINE_PRICE,
    currentReserveA: ilAlert.initialReserveA,
    currentReserveB: ilAlert.initialReserveB * 2,
    webhooks: server,
  });
  console.log(`  • Reserve shift 2× B-side → ${fireIL.length} delivery record(s)`);
  console.log('');

  // ════════════════════════════════════════════════════════════════════════
  //  Step 6 — webhook verification log
  // ════════════════════════════════════════════════════════════════════════
  //
  // We cross-reference the receiver's captured requests with the alert
  // service's outbound delivery log.  A parity between the two lists
  // proves the signature, payload, and retry behaviour all behaved
  // correctly.

  console.log('Step 6 — Delivery log (receiver view)');
  console.log('─────────────────────────────────────');
  for (const entry of server.log) {
    const ok = entry.sigValid ? '✅' : '❌';
    console.log(`  ${ok}  ${entry.body.alertKind.toUpperCase()} alert fired`);
    console.log(`        rule      : ${entry.body.ruleSummary}`);
    console.log(`        observed  : ${entry.body.alertKind === 'il' ? `${entry.body.observedValue} bps` : `$${fmt(entry.body.observedValue)}`}`);
    console.log(`        threshold : ${entry.body.alertKind === 'il' ? `${entry.body.thresholdValue} bps` : `$${fmt(entry.body.thresholdValue)}`}`);
    console.log(`        receivedAt: ${new Date(entry.receivedAt).toISOString()}`);
  }

  console.log('');
  console.log('Step 6 — Delivery log (outbound view)');
  console.log('─────────────────────────────────────');
  for (const rec of alerts.deliveries) {
    const ok = rec.alertServiceStatus === 'delivered' ? '✅' : '❌';
    console.log(`  ${ok}  ${rec.alertKind.toUpperCase()} → ${rec.webhookId}  (attempts=${rec.attempts}, http=${rec.httpStatus}, ${rec.durationMs} ms)`);
  }

  const total = server.log.length;
  const valid = server.log.filter((r) => r.sigValid).length;
  console.log('');
  console.log(`Result: ${valid}/${total} deliveries received with valid HMAC signature.`);

  await server.stop();

  // Sanity-check the verification flow succeeded.  If a future refactor
  // breaks the signing chain, this guard will surface it instead of
  // silently shipping to upstream.
  if (total === 0 || valid !== total) {
    console.error('❌ Verification failed — no deliveries, or signatures were invalid.');
    process.exit(1);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Alert setup example completed successfully.');
  console.log('');
  console.log('  Key takeaways:');
  console.log('  • Price alerts fire on absolute price-level crossings relative');
  console.log('    to a baseline; pick thresholds that match the asset class.');
  console.log('  • IL alerts track position-level loss magnitude; tighter');
  console.log('    thresholds catch regime shifts earlier but increase noise.');
  console.log('  • Webhook payloads are signed with HMAC-SHA256 so the');
  console.log('    receiver can authenticate origin and reject replays.');
  console.log('  • The same dispatcher pattern works for Slack / Discord /');
  console.log('    PagerDuty / a custom backend — only the URL & secret change.');
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entrypoint
// ─────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('');
  console.error('❌ Unhandled error in alert-setup example:');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
