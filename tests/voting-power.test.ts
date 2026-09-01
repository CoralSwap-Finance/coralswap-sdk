import {
  getVotingPower,
  getVotingPowerAtLedger,
  setVotingPowerQueryProvider,
} from '../src/utils/voting-power';

describe('voting power utilities', () => {
  afterEach(() => {
    setVotingPowerQueryProvider(undefined);
  });

  it('computes total power and percent share from own and delegated stake', async () => {
    setVotingPowerQueryProvider(async (address: string) => ({
      address,
      ownStake: 1200n,
      delegatedStake: 4800n,
      totalVotingPower: 20000n,
    }));

    const result = await getVotingPower('GABC123');

    expect(result.ownStake).toBe(1200n);
    expect(result.delegatedStake).toBe(4800n);
    expect(result.totalPower).toBe(6000n);
    expect(result.percentOfTotal).toBe(30);
  });

  it('uses the requested ledger for historical snapshots', async () => {
    const query = jest.fn(async (_address: string, ledger?: number) => ({
      address: 'GABC123',
      ownStake: 300n,
      delegatedStake: 700n,
      totalVotingPower: 10000n,
      ledger,
    }));

    setVotingPowerQueryProvider(query);

    const result = await getVotingPowerAtLedger('GABC123', 42);

    expect(query).toHaveBeenCalledWith('GABC123', 42);
    expect(result.totalPower).toBe(1000n);
    expect(result.percentOfTotal).toBe(10);
  });

  it('returns zero power for non-stakers', async () => {
    setVotingPowerQueryProvider(async () => null);

    const result = await getVotingPower('GNONSTAKER');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  // ---- NULL/UNDEFINED/DEGENERATE SNAPSHOT TESTS ----

  it('handles null snapshot gracefully', async () => {
    setVotingPowerQueryProvider(async () => null);

    const result = await getVotingPower('GNULL');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles partial snapshot with missing ownStake', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GPARTIAL',
      delegatedStake: 5000n,
      totalVotingPower: 10000n,
    }));

    const result = await getVotingPower('GPARTIAL');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(5000n);
    expect(result.totalPower).toBe(5000n);
    expect(result.percentOfTotal).toBe(50);
  });

  it('handles partial snapshot with missing delegatedStake', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GPARTIAL',
      ownStake: 3000n,
      totalVotingPower: 10000n,
    }));

    const result = await getVotingPower('GPARTIAL');

    expect(result.ownStake).toBe(3000n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(3000n);
    expect(result.percentOfTotal).toBe(30);
  });

  it('handles partial snapshot with missing totalVotingPower', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GPARTIAL',
      ownStake: 2000n,
      delegatedStake: 3000n,
    }));

    const result = await getVotingPower('GPARTIAL');

    expect(result.ownStake).toBe(2000n);
    expect(result.delegatedStake).toBe(3000n);
    expect(result.totalPower).toBe(5000n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles degenerate snapshot with totalVotingPower: 0n', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GZERO',
      ownStake: 1000n,
      delegatedStake: 2000n,
      totalVotingPower: 0n,
    }));

    const result = await getVotingPower('GZERO');

    expect(result.ownStake).toBe(1000n);
    expect(result.delegatedStake).toBe(2000n);
    expect(result.totalPower).toBe(3000n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles degenerate snapshot with ownStake: 0n and delegatedStake: 0n', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GZERO',
      ownStake: 0n,
      delegatedStake: 0n,
      totalVotingPower: 10000n,
    }));

    const result = await getVotingPower('GZERO');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles BigInt inputs as strings', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GBIGINT',
      ownStake: '1500',
      delegatedStake: '3500',
      totalVotingPower: '20000',
    }));

    const result = await getVotingPower('GBIGINT');

    expect(result.ownStake).toBe(1500n);
    expect(result.delegatedStake).toBe(3500n);
    expect(result.totalPower).toBe(5000n);
    expect(result.percentOfTotal).toBe(25);
  });

  it('handles number inputs (converted to BigInt)', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GNUMBER',
      ownStake: 800,
      delegatedStake: 1200,
      totalVotingPower: 10000,
    }));

    const result = await getVotingPower('GNUMBER');

    expect(result.ownStake).toBe(800n);
    expect(result.delegatedStake).toBe(1200n);
    expect(result.totalPower).toBe(2000n);
    expect(result.percentOfTotal).toBe(20);
  });

  it('handles null/undefined fields in snapshot gracefully', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GNIL',
      ownStake: null,
      delegatedStake: undefined,
      totalVotingPower: 10000n,
    }));

    const result = await getVotingPower('GNIL');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles snapshot with only address (empty snapshot)', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GEMPTY',
    }));

    const result = await getVotingPower('GEMPTY');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles snapshot with invalid data types (garbage)', async () => {
    setVotingPowerQueryProvider(async () => ({
      address: 'GARBAGE',
      ownStake: 'not-a-number',
      delegatedStake: 'invalid',
      totalVotingPower: 'also-invalid',
    }));

    const result = await getVotingPower('GARBAGE');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles undefined provider (fallback to zero)', async () => {
    setVotingPowerQueryProvider(undefined);

    const result = await getVotingPower('GNOFALLBACK');

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });

  it('handles partial snapshot at specific ledger', async () => {
    const query = jest.fn(async () => ({
      address: 'GLEDGER',
      ownStake: 500n,
      totalVotingPower: 5000n,
      ledger: 100,
    }));

    setVotingPowerQueryProvider(query);

    const result = await getVotingPowerAtLedger('GLEDGER', 100);

    expect(result.ownStake).toBe(500n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(500n);
    expect(result.percentOfTotal).toBe(10);
  });

  it('handles null snapshot at specific ledger', async () => {
    const query = jest.fn(async () => null);

    setVotingPowerQueryProvider(query);

    const result = await getVotingPowerAtLedger('GNULLLEDGER', 999);

    expect(result.ownStake).toBe(0n);
    expect(result.delegatedStake).toBe(0n);
    expect(result.totalPower).toBe(0n);
    expect(result.percentOfTotal).toBe(0);
  });
});
