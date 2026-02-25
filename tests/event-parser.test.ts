import { xdr, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { EventParser, EVENT_TOPICS } from '../src/utils/events';
import {
  SwapEvent,
  LiquidityEvent,
  FlashLoanEvent,
  MintEvent,
  BurnEvent,
  SyncEvent,
  FeeUpdateEvent,
} from '../src/types/events';

// ---------------------------------------------------------------------------
// Helpers to build mock ScVal / DiagnosticEvent structures
// ---------------------------------------------------------------------------

function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

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
  const mapEntries = entries.map(
    ([key, val]) => new xdr.ScMapEntry({ key: symbolVal(key), val }),
  );
  return xdr.ScVal.scvMap(mapEntries);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ADDR_SENDER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_TOKEN_A = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const ADDR_TOKEN_B = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const CONTRACT_ADDR = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const CONTRACT_BUF = Address.fromString(CONTRACT_ADDR).toBuffer();

/**
 * Build a mock xdr.DiagnosticEvent with the given topic and data.
 */
function makeDiagnosticEvent(
  topic: string,
  data: xdr.ScVal,
  inSuccess = true,
  contractBuf: Buffer = CONTRACT_BUF,
): xdr.DiagnosticEvent {
  const topics = [symbolVal(topic)];
  const bodyV0 = new xdr.ContractEventV0({ topics, data });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = new (xdr.ContractEventBody as any)(0, bodyV0) as xdr.ContractEventBody;

  const contractEvent = new xdr.ContractEvent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ext: new (xdr.ExtensionPoint as any)(0) as xdr.ExtensionPoint,
    contractId: contractBuf,
    type: xdr.ContractEventType.contract(),
    body,
  });

  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: inSuccess,
    event: contractEvent,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventParser', () => {
  let parser: EventParser;

  beforeEach(() => {
    parser = new EventParser();
  });

  // -----------------------------------------------------------------------
  // Swap events
  // -----------------------------------------------------------------------

  describe('swap events', () => {
    const swapData = scMap([
      ['sender', addressVal(ADDR_SENDER)],
      ['token_in', addressVal(ADDR_TOKEN_A)],
      ['token_out', addressVal(ADDR_TOKEN_B)],
      ['amount_in', i128Val(1000000n)],
      ['amount_out', i128Val(980000n)],
      ['fee_bps', u32Val(30)],
    ]);

    it('parses a valid swap event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.SWAP, swapData);
      const result = parser.parse([diag], 'tx_abc', 12345);

      expect(result).toHaveLength(1);
      const swap = result[0] as SwapEvent;
      expect(swap.type).toBe('swap');
      expect(swap.sender).toBe(ADDR_SENDER);
      expect(swap.amountIn).toBe(1000000n);
      expect(swap.amountOut).toBe(980000n);
      expect(swap.feeBps).toBe(30);
      expect(swap.txHash).toBe('tx_abc');
      expect(swap.ledger).toBe(12345);
    });
  });

  // -----------------------------------------------------------------------
  // Liquidity events
  // -----------------------------------------------------------------------

  describe('liquidity events', () => {
    const liqData = scMap([
      ['provider', addressVal(ADDR_SENDER)],
      ['token_a', addressVal(ADDR_TOKEN_A)],
      ['token_b', addressVal(ADDR_TOKEN_B)],
      ['amount_a', i128Val(500000n)],
      ['amount_b', i128Val(600000n)],
      ['liquidity', i128Val(547722n)],
    ]);

    it('parses an add_liquidity event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.ADD_LIQUIDITY, liqData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const liq = result[0] as LiquidityEvent;
      expect(liq.type).toBe('add_liquidity');
      expect(liq.provider).toBe(ADDR_SENDER);
      expect(liq.amountA).toBe(500000n);
      expect(liq.liquidity).toBe(547722n);
    });

    it('parses a remove_liquidity event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.REMOVE_LIQUIDITY, liqData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('remove_liquidity');
    });
  });

  // -----------------------------------------------------------------------
  // Flash loan events
  // -----------------------------------------------------------------------

  describe('flash loan events', () => {
    const flashData = scMap([
      ['borrower', addressVal(ADDR_SENDER)],
      ['token', addressVal(ADDR_TOKEN_A)],
      ['amount', i128Val(2000000n)],
      ['fee', i128Val(600n)],
    ]);

    it('parses a flash_loan event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.FLASH_LOAN, flashData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const fl = result[0] as FlashLoanEvent;
      expect(fl.type).toBe('flash_loan');
      expect(fl.borrower).toBe(ADDR_SENDER);
      expect(fl.amount).toBe(2000000n);
      expect(fl.fee).toBe(600n);
    });
  });

  // -----------------------------------------------------------------------
  // Mint events
  // -----------------------------------------------------------------------

  describe('mint events', () => {
    const mintData = scMap([
      ['sender', addressVal(ADDR_SENDER)],
      ['amount_a', i128Val(300000n)],
      ['amount_b', i128Val(400000n)],
      ['liquidity', i128Val(346410n)],
    ]);

    it('parses a mint event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.MINT, mintData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const mint = result[0] as MintEvent;
      expect(mint.type).toBe('mint');
      expect(mint.sender).toBe(ADDR_SENDER);
      expect(mint.amountA).toBe(300000n);
      expect(mint.amountB).toBe(400000n);
      expect(mint.liquidity).toBe(346410n);
    });
  });

  // -----------------------------------------------------------------------
  // Burn events
  // -----------------------------------------------------------------------

  describe('burn events', () => {
    const burnData = scMap([
      ['sender', addressVal(ADDR_SENDER)],
      ['amount_a', i128Val(150000n)],
      ['amount_b', i128Val(200000n)],
      ['liquidity', i128Val(173205n)],
      ['to', addressVal(ADDR_SENDER)],
    ]);

    it('parses a burn event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.BURN, burnData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const burn = result[0] as BurnEvent;
      expect(burn.type).toBe('burn');
      expect(burn.sender).toBe(ADDR_SENDER);
      expect(burn.amountA).toBe(150000n);
      expect(burn.liquidity).toBe(173205n);
      expect(burn.to).toBe(ADDR_SENDER);
    });
  });

  // -----------------------------------------------------------------------
  // Sync events
  // -----------------------------------------------------------------------

  describe('sync events', () => {
    const syncData = scMap([
      ['reserve0', i128Val(5000000n)],
      ['reserve1', i128Val(6000000n)],
    ]);

    it('parses a sync event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.SYNC, syncData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const sync = result[0] as SyncEvent;
      expect(sync.type).toBe('sync');
      expect(sync.reserve0).toBe(5000000n);
      expect(sync.reserve1).toBe(6000000n);
    });
  });

  // -----------------------------------------------------------------------
  // Fee update events
  // -----------------------------------------------------------------------

  describe('fee update events', () => {
    const feeData = scMap([
      ['previous_fee_bps', u32Val(30)],
      ['new_fee_bps', u32Val(45)],
      ['volatility', i128Val(150000n)],
    ]);

    it('parses a fee_update event', () => {
      const diag = makeDiagnosticEvent(EVENT_TOPICS.FEE_UPDATE, feeData);
      const result = parser.parse([diag]);

      expect(result).toHaveLength(1);
      const fee = result[0] as FeeUpdateEvent;
      expect(fee.type).toBe('fee_update');
      expect(fee.previousFeeBps).toBe(30);
      expect(fee.newFeeBps).toBe(45);
    });
  });

  // -----------------------------------------------------------------------
  // Batch parsing & filtering
  // -----------------------------------------------------------------------

  describe('parse (batch)', () => {
    const swapData = scMap([
      ['sender', addressVal(ADDR_SENDER)],
      ['token_in', addressVal(ADDR_TOKEN_A)],
      ['token_out', addressVal(ADDR_TOKEN_B)],
      ['amount_in', i128Val(100n)],
      ['amount_out', i128Val(90n)],
      ['fee_bps', u32Val(30)],
    ]);

    it('handles multiple events and skips unknown topics', () => {
      const events = [
        makeDiagnosticEvent('swap', swapData),
        makeDiagnosticEvent('unknown_topic', xdr.ScVal.scvVoid()),
        makeDiagnosticEvent('swap', swapData),
      ];

      const result = parser.parse(events);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('swap');
      expect(result[1].type).toBe('swap');
    });

    it('returns empty array for empty input', () => {
      expect(parser.parse([])).toHaveLength(0);
    });

    it('skips events not in a successful contract call', () => {
      const diag = makeDiagnosticEvent('swap', swapData, false);
      const result = parser.parse([diag]);
      expect(result).toHaveLength(0);
    });

    it('skips events with malformed data', () => {
      const diag = makeDiagnosticEvent('swap', xdr.ScVal.scvVoid());
      const result = parser.parse([diag]);
      expect(result).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Contract ID filtering
  // -----------------------------------------------------------------------

  describe('contract filtering', () => {
    const swapData = scMap([
      ['sender', addressVal(ADDR_SENDER)],
      ['token_in', addressVal(ADDR_TOKEN_A)],
      ['token_out', addressVal(ADDR_TOKEN_B)],
      ['amount_in', i128Val(100n)],
      ['amount_out', i128Val(90n)],
      ['fee_bps', u32Val(30)],
    ]);

    it('filters events by contract ID when configured', () => {
      const OTHER_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
      const filtered = new EventParser([OTHER_ADDR]);

      const diag = makeDiagnosticEvent('swap', swapData);
      const result = filtered.parse([diag]);
      // Event is from CONTRACT_ADDR which is not OTHER_ADDR
      expect(result).toHaveLength(0);
    });

    it('allows events when contract matches filter', () => {
      const filtered = new EventParser([CONTRACT_ADDR]);

      const diag = makeDiagnosticEvent('swap', swapData);
      const result = filtered.parse([diag]);
      expect(result).toHaveLength(1);
    });

    it('allows all events when no contract filter is set', () => {
      const noFilter = new EventParser();

      const diag = makeDiagnosticEvent('swap', swapData);
      const result = noFilter.parse([diag]);
      expect(result).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Strict mode
  // -----------------------------------------------------------------------

  describe('parseStrict', () => {
    it('still skips unknown topics without throwing', () => {
      const diag = makeDiagnosticEvent('unknown_topic', xdr.ScVal.scvVoid());
      const result = parser.parseStrict([diag]);
      expect(result).toHaveLength(0);
    });

    it('throws on malformed data for a known topic', () => {
      const diag = makeDiagnosticEvent('swap', xdr.ScVal.scvVoid());
      expect(() => parser.parseStrict([diag])).toThrow();
    });
  });
});
