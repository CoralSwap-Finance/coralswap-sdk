import { xdr } from '@stellar/stellar-sdk';
import { EventCursor, encodeTopic } from '../src/utils/events';

describe('encodeTopic()', () => {
  it('encodes raw topic strings into valid ScVal symbol base64', () => {
    const encodedSwap = encodeTopic('swap');
    expect(encodedSwap).toBe(xdr.ScVal.scvSymbol('swap').toXDR('base64'));

    const encodedSync = encodeTopic('sync');
    expect(encodedSync).toBe(xdr.ScVal.scvSymbol('sync').toXDR('base64'));
  });

  it('preserves topic if already an xdr.ScVal object', () => {
    const scVal = xdr.ScVal.scvSymbol('mint');
    expect(encodeTopic(scVal)).toBe(scVal.toXDR('base64'));
  });

  it('preserves topic if already valid ScVal base64 string', () => {
    const base64 = xdr.ScVal.scvSymbol('burn').toXDR('base64');
    expect(encodeTopic(base64)).toBe(base64);
  });
});

describe('EventCursor', () => {
  it('encodes raw string topics when instantiating cursor and making getEvents requests', async () => {
    const mockGetEvents = jest.fn().mockResolvedValue({
      events: [],
      cursor: 'cursor_123',
    });

    const mockServer = {
      getEvents: mockGetEvents,
    } as any;

    const cursor = new EventCursor({
      server: mockServer,
      contractIds: ['C123'],
      topics: [['swap'], ['sync']],
      startLedger: 100,
      endLedger: 200,
      limit: 50,
    });

    await cursor.next();

    expect(mockGetEvents).toHaveBeenCalledTimes(1);
    const request = mockGetEvents.mock.calls[0][0];
    expect(request.startLedger).toBe(100);
    expect(request.filters[0].contractIds).toEqual(['C123']);
    expect(request.filters[0].topics).toEqual([
      [xdr.ScVal.scvSymbol('swap').toXDR('base64')],
      [xdr.ScVal.scvSymbol('sync').toXDR('base64')],
    ]);
  });

  it('paginates correctly across multiple pages via fetchAll()', async () => {
    const mockGetEvents = jest
      .fn()
      .mockResolvedValueOnce({
        events: [{ id: 'evt1' } as any, { id: 'evt2' } as any],
        cursor: 'c1',
      })
      .mockResolvedValueOnce({
        events: [{ id: 'evt3' } as any],
        cursor: 'c2',
      });

    const mockServer = {
      getEvents: mockGetEvents,
    } as any;

    const cursor = new EventCursor({
      server: mockServer,
      limit: 2,
    });

    const events = await cursor.fetchAll();

    expect(events.length).toBe(3);
    expect(mockGetEvents).toHaveBeenCalledTimes(2);

    const secondCallRequest = mockGetEvents.mock.calls[1][0];
    expect(secondCallRequest.cursor).toBe('c1');
  });

  it('resets cursor state on reset()', async () => {
    const mockGetEvents = jest.fn().mockResolvedValue({
      events: [{ id: 'evt1' } as any],
      cursor: 'c1',
    });

    const mockServer = {
      getEvents: mockGetEvents,
    } as any;

    const cursor = new EventCursor({
      server: mockServer,
      limit: 1,
    });

    await cursor.next();
    cursor.reset();

    await cursor.next();
    expect(mockGetEvents.mock.calls[1][0].cursor).toBeUndefined();
  });
});
