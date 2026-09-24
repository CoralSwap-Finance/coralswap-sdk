import {
  xdr,
  Address,
  Contract,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { TypedEventCursor } from '../src/utils/event-cursor';
import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';
import { SwapEvent, SyncEvent } from '../src/types/events';

// ---------------------------------------------------------------------------
// ScVal / EventResponse fixture helpers
// ---------------------------------------------------------------------------

const CONTRACT_ADDR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const OTHER_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const ADDR_SENDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_TOKEN_A = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ADDR_TOKEN_B = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: 'address' });
}

function i128Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: 'i128' });
}

function u32Val(n: number): xdr.ScVal {
  return xdr.ScVal.scvU32(n);
}

function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
    ),
  );
}

const SWAP_DATA = scMap([
  ['sender', addressVal(ADDR_SENDER)],
  ['token_in', addressVal(ADDR_TOKEN_A)],
  ['token_out', addressVal(ADDR_TOKEN_B)],
  ['amount_in', i128Val(1_000_000n)],
  ['amount_out', i128Val(980_000n)],
  ['fee_bps', u32Val(30)],
]);

const SYNC_DATA = scMap([
  ['reserve0', i128Val(5_000_000n)],
  ['reserve1', i128Val(6_000_000n)],
]);

/**
 * Build a mock `rpc.Api.EventResponse` as returned by `server.getEvents`.
 */
function makeEventResponse(
  topic: string,
  data: xdr.ScVal,
  overrides: Partial<rpc.Api.EventResponse> = {},
): rpc.Api.EventResponse {
  return {
    type: 'contract',
    ledger: 100,
    ledgerClosedAt: '2020-01-01T00:00:00Z',
    contractId: new Contract(CONTRACT_ADDR),
    id: '0001',
    pagingToken: '0001',
    inSuccessfulContractCall: true,
    txHash: 'tx_abc',
    topic: [xdr.ScVal.scvSymbol(topic)],
    value: data,
    ...overrides,
  } as unknown as rpc.Api.EventResponse;
}

/**
 * Build a mock RPC server backed by the given `getEvents` responses (one per
 * successive call so pagination can be exercised).
 */
function makeServer(pages: Array<{ events: unknown[]; latestLedger: number }>) {
  let call = 0;
  return {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 2000 }),
    getEvents: jest.fn().mockImplementation(async () => {
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return page;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TypedEventCursor', () => {
  it('applies the given topic filters at the cursor level (base64 XDR, not raw strings)', async () => {
    const server = makeServer([{ events: [], latestLedger: 2000 }]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR, ['swap']);

    await cursor.scan();

    const req = server.getEvents.mock.calls[0][0];
    const topicEntry = req.filters[0].topics[0][0];
    expect(topicEntry).toBe(xdr.ScVal.scvSymbol('swap').toXdr('base64'));
    expect(topicEntry).not.toBe('swap');
    expect(req.filters[0].contractIds).toEqual([CONTRACT_ADDR]);
  });

  it('decodes raw getEvents responses into typed CoralSwap events', async () => {
    const server = makeServer([
      {
        events: [
          makeEventResponse('swap', SWAP_DATA),
          makeEventResponse('sync', SYNC_DATA),
        ],
        latestLedger: 2000,
      },
    ]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR);

    const events = await cursor.scan();

    expect(events).toHaveLength(2);

    const swap = events[0] as SwapEvent;
    expect(swap.type).toBe('swap');
    expect(swap.contractId).toBe(CONTRACT_ADDR);
    expect(swap.sender).toBe(ADDR_SENDER);
    expect(swap.amountIn).toBe(1_000_000n);
    expect(swap.amountOut).toBe(980_000n);
    expect(swap.feeBps).toBe(30);
    expect(swap.txHash).toBe('tx_abc');
    expect(swap.ledger).toBe(100);

    const sync = events[1] as SyncEvent;
    expect(sync.type).toBe('sync');
    expect(sync.reserve0).toBe(5_000_000n);
    expect(sync.reserve1).toBe(6_000_000n);
  });

  it('drops events emitted by other contracts', async () => {
    const server = makeServer([
      {
        events: [
          makeEventResponse('swap', SWAP_DATA, {
            contractId: new Contract(OTHER_ADDR),
          }),
        ],
        latestLedger: 2000,
      },
    ]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR, ['swap']);

    const events = await cursor.scan();
    expect(events).toHaveLength(0);
  });

  it('reuses EventCursor pagination and aggregates decoded events across pages', async () => {
    const server = makeServer([
      {
        events: [
          makeEventResponse('swap', SWAP_DATA, { ledger: 10 }),
          makeEventResponse('swap', SWAP_DATA, { ledger: 11 }),
        ],
        latestLedger: 20,
      },
      {
        events: [makeEventResponse('swap', SWAP_DATA, { ledger: 12 })],
        latestLedger: 20,
      },
    ]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR, ['swap']);

    // limit 2 → first (full) page triggers a second fetch, which is short and stops.
    const events = await cursor.scan({ fromLedger: 1, limit: 2 });

    expect(server.getEvents).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'swap')).toBe(true);
    // Second page must start after the last ledger of the first page.
    expect(server.getEvents.mock.calls[1][0].startLedger).toBe(12);
  });

  it('streams typed events one at a time via the async iterator', async () => {
    const server = makeServer([
      {
        events: [
          makeEventResponse('swap', SWAP_DATA),
          makeEventResponse('sync', SYNC_DATA),
        ],
        latestLedger: 2000,
      },
    ]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR);

    const collected: string[] = [];
    for await (const event of cursor.stream()) {
      collected.push(event.type);
    }

    expect(collected).toEqual(['swap', 'sync']);
  });

  it('skips events that did not run in a successful contract call', async () => {
    const server = makeServer([
      {
        events: [
          makeEventResponse('swap', SWAP_DATA, {
            inSuccessfulContractCall: false,
          }),
        ],
        latestLedger: 2000,
      },
    ]);
    const cursor = new TypedEventCursor(server as any, CONTRACT_ADDR);

    expect(await cursor.scan()).toHaveLength(0);
  });
});

describe('CoralSwapClient.allEvents', () => {
  const TEST_SECRET =
    'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';

  function makeClient(server: unknown): CoralSwapClient {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });
    client.server = server as rpc.Server;
    return client;
  }

  it('returns a typed, cursor-pagination-aware cursor', async () => {
    const server = makeServer([
      { events: [makeEventResponse('swap', SWAP_DATA)], latestLedger: 2000 },
    ]);
    const client = makeClient(server);

    const cursor = client.allEvents(CONTRACT_ADDR, ['swap']);
    expect(cursor).toBeInstanceOf(TypedEventCursor);

    const events = await cursor.scan();
    expect(events).toHaveLength(1);
    const swap = events[0] as SwapEvent;
    expect(swap.type).toBe('swap');
    expect(swap.amountIn).toBe(1_000_000n);

    // Filter was applied at the cursor level.
    const req = server.getEvents.mock.calls[0][0];
    expect(req.filters[0].topics[0][0]).toBe(
      xdr.ScVal.scvSymbol('swap').toXdr('base64'),
    );
  });
});
