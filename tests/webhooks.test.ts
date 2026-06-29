import { WebhookModule } from '../src/modules/webhooks';
import { ValidationError } from '../src/errors';
import type { FetchFn } from '../src/modules/webhooks';
import type { Webhook, WebhookEventType } from '../src/types/webhooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_URL = 'https://example.com/hooks/coralswap';
const VALID_URL_2 = 'https://other.example.com/hooks';

/** Build a FetchFn that always returns the given HTTP status code. */
function makeFetch(status: number): FetchFn {
  return jest.fn().mockResolvedValue({ status });
}

/** Build a FetchFn that throws a network-level error. */
function makeNetworkErrorFetch(message = 'Network error'): FetchFn {
  return jest.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// registerWebhook
// ---------------------------------------------------------------------------

describe('registerWebhook()', () => {
  it('creates a webhook and returns an object with a string ID', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL });

    expect(typeof wh.id).toBe('string');
    expect(wh.id.length).toBeGreaterThan(0);
  });

  it('new webhook starts as unverified', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL });

    expect(wh.verified).toBe(false);
    expect(wh.status).toBe('unverified');
  });

  it('stores the supplied URL', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL });

    expect(wh.url).toBe(VALID_URL);
  });

  it('defaults to all event types when events is omitted', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL });

    expect(wh.events).toEqual(
      expect.arrayContaining([
        'swap',
        'liquidity_add',
        'liquidity_remove',
        'flash_loan',
        'price_alert',
        'fee_change',
      ]),
    );
    expect(wh.events.length).toBe(6);
  });

  it('stores a custom event filter list', async () => {
    const m = new WebhookModule(makeFetch(200));
    const events: WebhookEventType[] = ['swap', 'price_alert'];
    const wh = await m.registerWebhook({ url: VALID_URL, events });

    expect(wh.events).toEqual(['swap', 'price_alert']);
  });

  it('initialises failCount and lastDelivery to defaults', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL });

    expect(wh.failCount).toBe(0);
    expect(wh.lastDelivery).toBeNull();
  });

  it('rejects a non-URL string', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(
      m.registerWebhook({ url: 'not-a-url' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an empty URL', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(m.registerWebhook({ url: '' })).rejects.toThrow(ValidationError);
  });

  it('rejects an unrecognised event type', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(
      m.registerWebhook({ url: VALID_URL, events: ['swap', 'unknown_event' as WebhookEventType] }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an empty event list', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(
      m.registerWebhook({ url: VALID_URL, events: [] }),
    ).rejects.toThrow(ValidationError);
  });

  it('assigns unique IDs to different webhooks', async () => {
    const m = new WebhookModule(makeFetch(200));
    const a = await m.registerWebhook({ url: VALID_URL });
    const b = await m.registerWebhook({ url: VALID_URL_2 });

    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

describe('verifyWebhook()', () => {
  it('marks the webhook verified when the endpoint returns 200', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const result = await m.verifyWebhook(id);

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('promotes status to active after a successful verification', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await m.verifyWebhook(id);

    const [wh] = await m.listWebhooks();
    expect(wh.status).toBe('active');
    expect(wh.verified).toBe(true);
  });

  it('resets failCount to 0 after successful verification', async () => {
    // Pre-accumulate failures via recordDelivery then verify successfully.
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });
    m.recordDelivery(id, false);
    m.recordDelivery(id, false);

    await m.verifyWebhook(id);

    const [wh] = await m.listWebhooks();
    expect(wh.failCount).toBe(0);
  });

  it('sets lastDelivery timestamp after successful verification', async () => {
    const before = new Date().toISOString();
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await m.verifyWebhook(id);

    const [wh] = await m.listWebhooks();
    expect(wh.lastDelivery).not.toBeNull();
    expect(wh.lastDelivery! >= before).toBe(true);
  });

  it('sends the test payload via POST with JSON content-type', async () => {
    const fetchFn = makeFetch(200);
    const m = new WebhookModule(fetchFn);
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await m.verifyWebhook(id);

    expect(fetchFn).toHaveBeenCalledWith(
      VALID_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('includes type=verification in the test payload body', async () => {
    const fetchFn = makeFetch(200);
    const m = new WebhookModule(fetchFn);
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await m.verifyWebhook(id);

    const [, init] = (fetchFn as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.type).toBe('verification');
    expect(body.webhookId).toBe(id);
  });

  it('marks the webhook unverified when the endpoint returns non-200', async () => {
    const m = new WebhookModule(makeFetch(404));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const result = await m.verifyWebhook(id);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.error).toContain('404');

    const [wh] = await m.listWebhooks();
    expect(wh.verified).toBe(false);
    expect(wh.status).toBe('unverified');
  });

  it('marks the webhook unverified on a network-level error', async () => {
    const m = new WebhookModule(makeNetworkErrorFetch('ECONNREFUSED'));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const result = await m.verifyWebhook(id);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');

    const [wh] = await m.listWebhooks();
    expect(wh.verified).toBe(false);
  });

  it('throws ValidationError for an unknown webhook ID', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(m.verifyWebhook('nonexistent')).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// updateWebhook
// ---------------------------------------------------------------------------

describe('updateWebhook()', () => {
  it('updates the URL', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const updated = await m.updateWebhook(id, { url: VALID_URL_2 });

    expect(updated.url).toBe(VALID_URL_2);
  });

  it('resets verified to false when the URL is changed', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    // First verify the webhook.
    await m.verifyWebhook(id);
    let [wh] = await m.listWebhooks();
    expect(wh.verified).toBe(true);

    // Now change the URL — should invalidate verification.
    await m.updateWebhook(id, { url: VALID_URL_2 });
    [wh] = await m.listWebhooks();
    expect(wh.verified).toBe(false);
    expect(wh.status).toBe('unverified');
  });

  it('updates the event filter list', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const updated = await m.updateWebhook(id, { events: ['swap'] });

    expect(updated.events).toEqual(['swap']);
  });

  it('event filter update does not change verification status', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });
    await m.verifyWebhook(id);

    await m.updateWebhook(id, { events: ['swap', 'fee_change'] });

    const [wh] = await m.listWebhooks();
    expect(wh.verified).toBe(true);
    expect(wh.status).toBe('active');
  });

  it('allows updating both URL and events simultaneously', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const updated = await m.updateWebhook(id, {
      url: VALID_URL_2,
      events: ['flash_loan'],
    });

    expect(updated.url).toBe(VALID_URL_2);
    expect(updated.events).toEqual(['flash_loan']);
  });

  it('rejects an invalid URL update', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await expect(
      m.updateWebhook(id, { url: 'bad-url' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an unrecognised event type on update', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    await expect(
      m.updateWebhook(id, { events: ['swap', 'bogus' as WebhookEventType] }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for an unknown webhook ID', async () => {
    const m = new WebhookModule(makeFetch(200));

    await expect(
      m.updateWebhook('nonexistent', { url: VALID_URL }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// listWebhooks
// ---------------------------------------------------------------------------

describe('listWebhooks()', () => {
  it('returns an empty array when no webhooks are registered', async () => {
    const m = new WebhookModule(makeFetch(200));

    const list = await m.listWebhooks();

    expect(list).toEqual([]);
  });

  it('returns all registered webhooks', async () => {
    const m = new WebhookModule(makeFetch(200));
    await m.registerWebhook({ url: VALID_URL });
    await m.registerWebhook({ url: VALID_URL_2, events: ['swap'] });

    const list = await m.listWebhooks();

    expect(list).toHaveLength(2);
  });

  it('includes webhooks of every status in the list', async () => {
    const m = new WebhookModule(makeFetch(200));

    // unverified
    await m.registerWebhook({ url: VALID_URL });

    // active
    const { id: activeId } = await m.registerWebhook({ url: VALID_URL_2 });
    await m.verifyWebhook(activeId);

    // disabled — exceed fail threshold
    const fetchDisabled = makeFetch(500);
    const mDisabled = new WebhookModule(fetchDisabled);
    const { id: disabledId } = await mDisabled.registerWebhook({ url: VALID_URL });
    for (let i = 0; i <= 5; i++) mDisabled.recordDelivery(disabledId, false);
    const [disabled] = await mDisabled.listWebhooks();
    expect(disabled.status).toBe('disabled');

    // Back on the main instance — both unverified and active appear
    const list = await m.listWebhooks();
    const statuses = list.map((w: Webhook) => w.status);
    expect(statuses).toContain('unverified');
    expect(statuses).toContain('active');
  });

  it('returns snapshots, not live references', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const [snapshot] = await m.listWebhooks();
    // Mutating the snapshot should not affect stored state.
    (snapshot as Webhook & { url: string }).url = 'https://mutated.example.com/x';

    const [fresh] = await m.listWebhooks();
    expect(fresh.url).toBe(VALID_URL);
    void id;
  });
});

// ---------------------------------------------------------------------------
// Events filter (acceptance criterion: events filter alert types)
// ---------------------------------------------------------------------------

describe('events filter', () => {
  it('a webhook with only swap events does not include price_alert in its list', async () => {
    const m = new WebhookModule(makeFetch(200));
    const wh = await m.registerWebhook({ url: VALID_URL, events: ['swap'] });

    expect(wh.events).not.toContain('price_alert');
    expect(wh.events).toContain('swap');
  });

  it('a webhook with multiple event types contains all specified types', async () => {
    const m = new WebhookModule(makeFetch(200));
    const events: WebhookEventType[] = ['swap', 'flash_loan', 'price_alert'];
    const wh = await m.registerWebhook({ url: VALID_URL, events });

    expect(wh.events).toEqual(events);
  });
});

// ---------------------------------------------------------------------------
// Auto-disable on consecutive failures
// ---------------------------------------------------------------------------

describe('auto-disable on consecutive failures', () => {
  it('disables the webhook after more than 5 consecutive failures', async () => {
    const m = new WebhookModule(makeFetch(500));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    // 6 failures (> 5)
    for (let i = 0; i < 6; i++) {
      m.recordDelivery(id, false);
    }

    const [wh] = await m.listWebhooks();
    expect(wh.status).toBe('disabled');
    expect(wh.verified).toBe(false);
  });

  it('does NOT disable the webhook at exactly 5 consecutive failures', async () => {
    const m = new WebhookModule(makeFetch(500));
    const { id } = await m.registerWebhook({ url: VALID_URL });
    await m.verifyWebhook(id);

    for (let i = 0; i < 5; i++) {
      m.recordDelivery(id, false);
    }

    const [wh] = await m.listWebhooks();
    expect(wh.status).not.toBe('disabled');
    expect(wh.failCount).toBe(5);
  });

  it('resets failCount to 0 after a successful delivery', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    m.recordDelivery(id, false);
    m.recordDelivery(id, false);
    m.recordDelivery(id, true);

    const [wh] = await m.listWebhooks();
    expect(wh.failCount).toBe(0);
  });

  it('records lastDelivery timestamp on each delivery attempt', async () => {
    const m = new WebhookModule(makeFetch(200));
    const { id } = await m.registerWebhook({ url: VALID_URL });

    const before = new Date().toISOString();
    m.recordDelivery(id, true);
    const after = new Date().toISOString();

    const [wh] = await m.listWebhooks();
    expect(wh.lastDelivery).not.toBeNull();
    expect(wh.lastDelivery! >= before).toBe(true);
    expect(wh.lastDelivery! <= after).toBe(true);
  });

  it('throws ValidationError when recording delivery for unknown webhook', () => {
    const m = new WebhookModule(makeFetch(200));

    expect(() => m.recordDelivery('nonexistent', true)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Full registration + verification flow
// ---------------------------------------------------------------------------

describe('end-to-end: register → verify → update', () => {
  it('full happy path: register, verify, update events, re-list', async () => {
    const m = new WebhookModule(makeFetch(200));

    // 1. Register
    const wh = await m.registerWebhook({ url: VALID_URL, events: ['swap'] });
    expect(wh.status).toBe('unverified');

    // 2. Verify
    const result = await m.verifyWebhook(wh.id);
    expect(result.success).toBe(true);

    // 3. Update event filter
    const updated = await m.updateWebhook(wh.id, { events: ['swap', 'fee_change'] });
    expect(updated.events).toEqual(['swap', 'fee_change']);
    expect(updated.verified).toBe(true); // event-only update preserves verification

    // 4. List
    const list = await m.listWebhooks();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('active');
  });

  it('changing URL after verification requires re-verification', async () => {
    const m = new WebhookModule(makeFetch(200));

    const wh = await m.registerWebhook({ url: VALID_URL });
    await m.verifyWebhook(wh.id);

    let [snapshot] = await m.listWebhooks();
    expect(snapshot.status).toBe('active');

    await m.updateWebhook(wh.id, { url: VALID_URL_2 });

    [snapshot] = await m.listWebhooks();
    expect(snapshot.verified).toBe(false);
    expect(snapshot.status).toBe('unverified');
  });
});
