import { ValidationError } from '../src/errors';
import { PositionsModule } from '../src/modules/positions';
import {
  EnrichedLPPositionSchema,
  PositionMathSchema,
  PositionSummarySchema,
  validateWithSchema,
} from '../src/schemas';
import { EnrichedLPPosition } from '../src/types/positions';

/**
 * Schema validation for LP position entries.
 *
 * PositionsModule assembles an entry from several independent RPC reads
 * (reserves, tokens, fee state, balance/supply). These tests pin both
 * halves of the contract: a well-formed entry passes through untouched,
 * and a malformed read — missing keys, wrong types, NaN/out-of-range
 * numbers — surfaces as a typed ValidationError rather than an untyped
 * runtime shape error.
 */

// Valid checksummed addresses; the schema only requires non-empty strings
// (address checksums are enforced by validateAddress on the inputs).
const OWNER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const PAIR_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_0 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TOKEN_1 = 'CBQHNAXSI55GX3BZPHDKBE4IMPBPJGZBDZIUMSOUAKVISQ3DTLAZQNSC';
const LP_TOKEN = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WRTP5AP5WOJVRY3WNT';

const validEntry = (): EnrichedLPPosition => ({
  pairAddress: PAIR_ADDR,
  lpTokenAddress: LP_TOKEN,
  balance: 500n,
  totalSupply: 1000n,
  share: 0.5,
  token0Amount: 1000n,
  token1Amount: 2000n,
  token0: TOKEN_0,
  token1: TOKEN_1,
  reserve0: 2000n,
  reserve1: 4000n,
  feeBps: 30,
});

const expectValidationError = (run: () => unknown, label: string, fragment: string): void => {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(ValidationError);
  const message = (caught as ValidationError).message;
  expect(message).toContain(`Invalid ${label}`);
  expect(message).toContain(fragment);
};

describe('EnrichedLPPositionSchema', () => {
  it('accepts a well-formed position entry unchanged', () => {
    const entry = validEntry();

    const parsed = validateWithSchema(EnrichedLPPositionSchema, entry, 'position');

    expect(parsed).toEqual(entry);
    expect(parsed.balance).toBe(500n);
    expect(parsed.share).toBe(0.5);
  });

  it('keeps the optional token symbols when present', () => {
    const entry = { ...validEntry(), token0Symbol: 'USDC', token1Symbol: 'XLM' };

    expect(validateWithSchema(EnrichedLPPositionSchema, entry, 'position')).toEqual(entry);
  });

  it('accepts the boundary values of every range', () => {
    const zero = {
      ...validEntry(),
      balance: 0n,
      totalSupply: 0n,
      share: 0,
      token0Amount: 0n,
      token1Amount: 0n,
      reserve0: 0n,
      reserve1: 0n,
      feeBps: 0,
    };
    const ceiling = {
      ...validEntry(),
      share: 1,
      feeBps: 10000,
    };

    expect(() => validateWithSchema(EnrichedLPPositionSchema, zero, 'position')).not.toThrow();
    expect(() => validateWithSchema(EnrichedLPPositionSchema, ceiling, 'position')).not.toThrow();
  });

  it.each([
    ['a missing pairAddress', { pairAddress: undefined }, 'pairAddress'],
    ['an empty token0', { token0: '' }, 'token0'],
    ['a missing lpTokenAddress', { lpTokenAddress: undefined }, 'lpTokenAddress'],
    ['a balance that is a number', { balance: 500 }, 'balance'],
    ['a balance that is a string', { balance: '500' }, 'balance'],
    ['a negative balance', { balance: -1n }, 'balance'],
    ['a non-bigint reserve0', { reserve0: '2000' }, 'reserve0'],
    ['a negative reserve1', { reserve1: -1n }, 'reserve1'],
    ['a NaN share', { share: Number.NaN }, 'share'],
    ['an infinite share', { share: Number.POSITIVE_INFINITY }, 'share'],
    ['a share above 1', { share: 1.5 }, 'share'],
    ['a negative share', { share: -0.25 }, 'share'],
    ['a token0Amount that is a number', { token0Amount: 1000 }, 'token0Amount'],
    ['a fractional feeBps', { feeBps: 30.5 }, 'feeBps'],
    ['a negative feeBps', { feeBps: -1 }, 'feeBps'],
    ['a feeBps above the bps ceiling', { feeBps: 10001 }, 'feeBps'],
  ])('rejects %s', (_label, patch, fragment) => {
    expectValidationError(
      () => validateWithSchema(EnrichedLPPositionSchema, { ...validEntry(), ...patch }, 'position'),
      'position',
      fragment,
    );
  });

  it('reports every offending field at once', () => {
    let caught: ValidationError | undefined;
    try {
      validateWithSchema(
        EnrichedLPPositionSchema,
        { ...validEntry(), token0: '', feeBps: -1 },
        'position',
      );
    } catch (err) {
      caught = err as ValidationError;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught?.message).toContain('token0');
    expect(caught?.message).toContain('feeBps');
    expect(Array.isArray(caught?.details?.zodErrors)).toBe(true);
  });
});

describe('PositionMathSchema', () => {
  const validMath = () => ({
    balance: 500n,
    totalSupply: 1000n,
    reserve0: 2000n,
    reserve1: 4000n,
  });

  it('accepts bigint operands unchanged', () => {
    const math = validMath();

    expect(validateWithSchema(PositionMathSchema, math, 'position math')).toEqual(math);
  });

  it('accepts the all-zero operands (empty pool)', () => {
    const math = { balance: 0n, totalSupply: 0n, reserve0: 0n, reserve1: 0n };

    expect(() =>
      validateWithSchema(PositionMathSchema, math, 'position math'),
    ).not.toThrow();
  });

  it.each([
    ['a reserve0 that is a number', { reserve0: 2000 }, 'reserve0'],
    ['a balance that is a string', { balance: '500' }, 'balance'],
    ['a negative totalSupply', { totalSupply: -1n }, 'totalSupply'],
    ['a missing reserve1', { reserve1: undefined }, 'reserve1'],
  ])('rejects %s before it reaches BigInt arithmetic', (_label, patch, fragment) => {
    expectValidationError(
      () => validateWithSchema(PositionMathSchema, { ...validMath(), ...patch }, 'position math'),
      'position math',
      fragment,
    );
  });
});

describe('PositionSummarySchema', () => {
  const validSummary = () => ({
    owner: OWNER,
    totalPools: 1,
    positions: [validEntry()],
    truncated: false,
    pageInfo: {
      limit: undefined as number | undefined,
      cursor: undefined as string | undefined,
      nextCursor: null as string | null,
      hasNextPage: false,
      hasMore: false,
    },
  });

  it('accepts a well-formed summary', () => {
    const summary = validSummary();

    expect(validateWithSchema(PositionSummarySchema, summary, 'position summary')).toEqual(summary);
  });

  it.each([
    ['an empty owner', { owner: '' }, 'owner'],
    ['a negative totalPools', { totalPools: -1 }, 'totalPools'],
    ['a fractional totalPools', { totalPools: 1.5 }, 'totalPools'],
    ['positions that are not an array', { positions: {} }, 'positions'],
  ])('rejects %s', (_label, patch, fragment) => {
    const summary = { ...validSummary(), ...patch };

    let caught: unknown;
    try {
      validateWithSchema(PositionSummarySchema, summary, 'position summary');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain(fragment);
  });

  it('rejects a summary carrying one malformed entry', () => {
    const summary = { ...validSummary(), positions: [{ ...validEntry(), share: 3 }] };

    let caught: unknown;
    try {
      validateWithSchema(PositionSummarySchema, summary, 'position summary');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain('positions.0.share');
  });
});

// ---------------------------------------------------------------------------
// Module-level: validation runs at the getPosition / getPositions boundary
// ---------------------------------------------------------------------------

interface MockPair {
  getReserves: jest.Mock;
  getTokens: jest.Mock;
  getLPTokenAddress: jest.Mock;
  getFeeState: jest.Mock;
}

const makeMockClient = () => {
  const mockPair: MockPair = {
    getReserves: jest.fn().mockResolvedValue({ reserve0: 2000n, reserve1: 4000n }),
    getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_0, token1: TOKEN_1 }),
    getLPTokenAddress: jest.fn().mockResolvedValue(LP_TOKEN),
    getFeeState: jest.fn().mockResolvedValue({ feeCurrent: 30 }),
  };

  const mockLpToken = {
    balance: jest.fn().mockResolvedValue(500n),
    totalSupply: jest.fn().mockResolvedValue(1000n),
  };

  const client = {
    pair: jest.fn().mockReturnValue(mockPair),
    lpToken: jest.fn().mockReturnValue(mockLpToken),
    factory: { getAllPairs: jest.fn().mockResolvedValue([PAIR_ADDR]) },
  };

  return { client, mockPair, mockLpToken };
};

describe('PositionsModule schema validation', () => {
  it('returns an entry that satisfies the schema', async () => {
    const { client } = makeMockClient();
    const mod = new PositionsModule(client as never);

    const pos = await mod.getPosition(PAIR_ADDR, OWNER);

    expect(() => validateWithSchema(EnrichedLPPositionSchema, pos, 'position')).not.toThrow();
    expect(pos).toEqual(expect.objectContaining({ pairAddress: PAIR_ADDR, feeBps: 30 }));
  });

  it('rejects a position with a missing token address as a ValidationError', async () => {
    const { client, mockPair } = makeMockClient();
    mockPair.getTokens.mockResolvedValue({ token0: undefined, token1: TOKEN_1 });
    const mod = new PositionsModule(client as never);

    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toBeInstanceOf(ValidationError);
    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toThrow(/position.*token0/i);
  });

  it('rejects an out-of-range fee read from the pair', async () => {
    const { client, mockPair } = makeMockClient();
    mockPair.getFeeState.mockResolvedValue({ feeCurrent: 10001 });
    const mod = new PositionsModule(client as never);

    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toBeInstanceOf(ValidationError);
    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toThrow(/feeBps/);
  });

  it('rejects a balance larger than the supply (share above 1)', async () => {
    const { client, mockLpToken } = makeMockClient();
    mockLpToken.balance.mockResolvedValue(2000n);
    mockLpToken.totalSupply.mockResolvedValue(1000n);
    const mod = new PositionsModule(client as never);

    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toBeInstanceOf(ValidationError);
    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toThrow(/share/);
  });

  it('rejects non-bigint reserves instead of throwing a raw TypeError', async () => {
    const { client, mockPair } = makeMockClient();
    mockPair.getReserves.mockResolvedValue({ reserve0: 2000, reserve1: 4000 });
    const mod = new PositionsModule(client as never);

    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toBeInstanceOf(ValidationError);
    await expect(mod.getPosition(PAIR_ADDR, OWNER)).rejects.toThrow(/reserve0/);
  });

  it('getPositions surfaces a malformed position instead of dropping the pool', async () => {
    const { client, mockPair } = makeMockClient();
    mockPair.getTokens.mockResolvedValue({ token0: undefined, token1: TOKEN_1 });
    const mod = new PositionsModule(client as never);

    await expect(mod.getPositions(OWNER)).rejects.toBeInstanceOf(ValidationError);
    await expect(mod.getPositions(OWNER)).rejects.toThrow(/position summary|position/i);
  });

  it('getPositions still skips transient per-pair RPC failures', async () => {
    const { client, mockPair } = makeMockClient();
    mockPair.getReserves.mockRejectedValue(new Error('rpc timeout'));
    const mod = new PositionsModule(client as never);

    const summary = await mod.getPositions(OWNER);

    expect(summary.positions).toHaveLength(0);
    expect(summary.totalPools).toBe(0);
    expect(() =>
      validateWithSchema(PositionSummarySchema, summary, 'position summary'),
    ).not.toThrow();
  });

  it('getPositions returns a schema-valid summary', async () => {
    const { client } = makeMockClient();
    const mod = new PositionsModule(client as never);

    const summary = await mod.getPositions(OWNER, { limit: 10 });

    expect(() =>
      validateWithSchema(PositionSummarySchema, summary, 'position summary'),
    ).not.toThrow();
    expect(summary.owner).toBe(OWNER);
    expect(summary.positions).toHaveLength(1);
  });

  it('validates the empty-page summary too', async () => {
    const { client } = makeMockClient();
    client.factory.getAllPairs.mockResolvedValue([]);
    const mod = new PositionsModule(client as never);

    const summary = await mod.getPositions(OWNER);

    expect(() =>
      validateWithSchema(PositionSummarySchema, summary, 'position summary'),
    ).not.toThrow();
    expect(summary.positions).toEqual([]);
  });
});
