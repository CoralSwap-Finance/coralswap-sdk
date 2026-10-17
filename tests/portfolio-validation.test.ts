import { CoralSwapClient } from '../src/client';
import { ValidationError } from '../src/errors';
import { PortfolioModule } from '../src/modules/portfolio';
import { PositionsModule } from '../src/modules/positions';
import { TreasuryModuleOptions } from '../src/modules/treasury';
import { Network } from '../src/types/common';

/**
 * Unit tests for the input validation guards on PortfolioModule.
 *
 * Every rejection path must fail fast with a typed `ValidationError` whose
 * message contains the offending value, *before* any RPC work happens — the
 * `getPositions` spy is asserted not to have been called on those paths.
 * No network calls are made: the position/pair/factory collaborators are
 * stubbed.
 */

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';

// Real, checksum-valid addresses (G… public key and C… contract IDs).
const OWNER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const CONTRACT_OWNER = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const PAIR = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const TOKEN_STABLE = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
const TOKEN_OTHER = 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3';
const MALFORMED = 'not-a-stellar-address';

interface PortfolioHarness {
  client: CoralSwapClient;
  portfolio: PortfolioModule;
  getPositions: jest.Mock;
}

function makePortfolio(options: TreasuryModuleOptions = {}): PortfolioHarness {
  const client = new CoralSwapClient({
    network: Network.TESTNET,
    secretKey: TEST_SECRET,
  });
  const portfolio = new PortfolioModule(client, options);

  // Stub every collaborator that would otherwise hit the network.
  const positions = (
    portfolio as unknown as { positions: PositionsModule }
  ).positions;
  const getPositions = jest
    .spyOn(positions, 'getPositions')
    .mockResolvedValue({ positions: [] } as never);

  jest.spyOn(client, 'factory', 'get').mockReturnValue({
    getAllPairs: jest.fn().mockResolvedValue([]),
  } as never);

  jest.spyOn(client, 'pair').mockReturnValue({
    getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_STABLE, token1: TOKEN_OTHER }),
    getReserves: jest.fn().mockResolvedValue({ reserve0: 1000n, reserve1: 2000n }),
  } as never);

  return { client, portfolio, getPositions };
}

/** Assert a promise rejects with ValidationError and return it for message checks. */
async function catchValidationError(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.name).toBe('ValidationError');
      return err;
    }
    throw err;
  }
  throw new Error('expected the call to throw a ValidationError, but it resolved');
}

describe('PortfolioModule input validation', () => {
  describe('address guards', () => {
    it('rejects a malformed owner address, naming the invalid value', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(portfolio.getPortfolio(MALFORMED));

      expect(err.message).toContain(MALFORMED);
      expect(err.message).toContain('owner');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects an empty owner address before any RPC call', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(portfolio.get(''));

      expect(err.message).toContain('owner');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a malformed pairAddresses entry, naming the index and value', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { pairAddresses: [PAIR, MALFORMED] }),
      );

      expect(err.message).toContain('pairAddresses[1]');
      expect(err.message).toContain(MALFORMED);
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a non-array pairAddresses value', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, {
          pairAddresses: MALFORMED as unknown as string[],
        }),
      );

      expect(err.message).toContain('pairAddresses');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('accepts a valid G… owner address (boundary)', async () => {
      const { portfolio, getPositions } = makePortfolio();

      await expect(
        portfolio.getPortfolio(OWNER, { pairAddresses: [PAIR] }),
      ).resolves.toEqual(expect.objectContaining({ owner: OWNER, positions: [], totalValueUSD: 0 }));
    });

    it('accepts a valid C… contract ID as owner (boundary)', async () => {
      const { portfolio, getPositions } = makePortfolio();

      await expect(
        portfolio.getPortfolio(CONTRACT_OWNER, { pairAddresses: [PAIR] }),
      ).resolves.toEqual(expect.objectContaining({ owner: CONTRACT_OWNER, positions: [], totalValueUSD: 0 }));
    });
  });

  describe('date-range guards', () => {
    const inThePast = new Date('2026-01-01T00:00:00.000Z');
    const alsoInThePast = new Date('2026-02-01T00:00:00.000Z');

    it('rejects a fromDate in the future', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { fromDate: future }),
      );

      expect(err.message).toContain(future.toISOString());
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a toDate in the future', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { toDate: future }),
      );

      expect(err.message).toContain(future.toISOString());
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects fromDate === toDate', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const same = new Date('2026-01-01T00:00:00.000Z');

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { fromDate: same, toDate: new Date(same) }),
      );

      expect(err.message).toContain('fromDate must be earlier than toDate');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects an inverted range (toDate before fromDate)', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.get(OWNER, { fromDate: alsoInThePast, toDate: inThePast }),
      );

      expect(err.message).toContain('fromDate must be earlier than toDate');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects an Invalid Date', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { fromDate: new Date('not-a-date') }),
      );

      expect(err.message).toContain('fromDate');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a non-Date value passed as fromDate', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, {
          fromDate: '2026-01-01' as unknown as Date,
        }),
      );

      expect(err.message).toContain('2026-01-01');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('accepts a past range where fromDate < toDate (boundary)', async () => {
      const { portfolio, getPositions } = makePortfolio();

      await expect(
        portfolio.getPortfolio(OWNER, {
          pairAddresses: [PAIR],
          fromDate: inThePast,
          toDate: alsoInThePast,
        }),
      ).resolves.toEqual(expect.objectContaining({ owner: OWNER, positions: [], totalValueUSD: 0 }));
    });
  });

  describe('limit guards', () => {
    it('accepts the maximum boundary limit of 1000', async () => {
      const { portfolio, getPositions } = makePortfolio();

      await expect(
        portfolio.getPortfolio(OWNER, { pairAddresses: [PAIR], limit: 1000 }),
      ).resolves.toEqual(expect.objectContaining({ owner: OWNER, positions: [], totalValueUSD: 0 }));

      expect(getPositions).toHaveBeenCalledWith(
        OWNER,
        expect.objectContaining({ limit: 1000 }),
      );
    });

    it('rejects limit = 1001 (above the cap), naming the value', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { limit: 1001 }),
      );

      expect(err.message).toContain('1001');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a negative limit', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { limit: -1 }),
      );

      expect(err.message).toContain('-1');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects limit = 0 (not positive)', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.get(OWNER, { limit: 0 }),
      );

      expect(err.message).toContain('positive integer');
      expect(err.message).toContain('0');
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a fractional limit', async () => {
      const { portfolio, getPositions } = makePortfolio();

      const err = await catchValidationError(
        portfolio.getPortfolio(OWNER, { limit: 1.5 }),
      );

      expect(err.message).toContain('1.5');
      expect(getPositions).not.toHaveBeenCalled();
    });
  });

  describe('snapshot and PnL guards', () => {
    it('rejects a snapshot whose owner is malformed', () => {
      const { portfolio } = makePortfolio();
      const snapshot = {
        owner: MALFORMED,
        totalValueUSD: 0,
        positions: [],
        capturedAt: 1,
      };

      expect(() => portfolio.createSnapshot(snapshot)).toThrow(ValidationError);
      expect(() => portfolio.createSnapshot(snapshot)).toThrow(MALFORMED);
    });

    it('rejects a missing portfolio object in createSnapshot', () => {
      const { portfolio } = makePortfolio();

      expect(() =>
        portfolio.createSnapshot(undefined as never),
      ).toThrow(ValidationError);
    });

    it('accepts a valid snapshot (boundary)', () => {
      const { portfolio } = makePortfolio();

      const snapshot = portfolio.createSnapshot({
        owner: OWNER,
        totalValueUSD: 0,
        positions: [],
      });

      expect(snapshot.owner).toBe(OWNER);
      expect(snapshot.positions).toEqual([]);
      expect(typeof snapshot.capturedAt).toBe('number');
    });

    it('rejects a PnL call with a malformed owner', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const entry = {
        owner: OWNER,
        totalValueUSD: 0,
        positions: [],
        capturedAt: 1,
      };

      const err = await catchValidationError(
        portfolio.getPortfolioPnL(MALFORMED, entry),
      );

      expect(err.message).toContain(MALFORMED);
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a PnL call whose snapshot owner is malformed', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const entry = {
        owner: MALFORMED,
        totalValueUSD: 0,
        positions: [],
        capturedAt: 1,
      };

      const err = await catchValidationError(
        portfolio.getPortfolioPnL(OWNER, entry),
      );

      expect(err.message).toContain('entry.owner');
      expect(err.message).toContain(MALFORMED);
      expect(getPositions).not.toHaveBeenCalled();
    });

    it('rejects a PnL call whose snapshot positions are not an array', async () => {
      const { portfolio, getPositions } = makePortfolio();
      const entry = {
        owner: OWNER,
        totalValueUSD: 0,
        positions: undefined,
        capturedAt: 1,
      } as unknown as Parameters<PortfolioModule['getPortfolioPnL']>[1];

      const err = await catchValidationError(
        portfolio.getPortfolioPnL(OWNER, entry),
      );

      expect(err.message).toContain('entry.positions');
      expect(getPositions).not.toHaveBeenCalled();
    });
  });
});
