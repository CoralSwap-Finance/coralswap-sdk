import { NotConfiguredError } from '../errors';

export interface VotingPower {
  ownStake: bigint;
  delegatedStake: bigint;
  totalPower: bigint;
  percentOfTotal: number;
}

export interface VotingPowerQueryResult {
  address?: string;
  ownStake?: bigint | number | string;
  delegatedStake?: bigint | number | string;
  totalVotingPower?: bigint | number | string;
  totalPower?: bigint | number | string;
  ledger?: number;
}

export type VotingPowerQueryProvider = (
  address: string,
  ledger?: number,
) => Promise<VotingPowerQueryResult | null> | VotingPowerQueryResult | null;

let votingPowerQueryProvider: VotingPowerQueryProvider | undefined;

function zeroVotingPower(): VotingPower {
  return {
    ownStake: 0n,
    delegatedStake: 0n,
    totalPower: 0n,
    percentOfTotal: 0,
  };
}

function normalizeBigInt(value: bigint | number | string | undefined, fallback: bigint = 0n): bigint {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      return BigInt(trimmed);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function buildVotingPower(snapshot: VotingPowerQueryResult | null | undefined): VotingPower {
  if (!snapshot) return zeroVotingPower();

  const ownStake = normalizeBigInt(snapshot.ownStake);
  const delegatedStake = normalizeBigInt(snapshot.delegatedStake);
  const totalPower = normalizeBigInt(snapshot.totalPower, ownStake + delegatedStake);
  const totalVotingPower = normalizeBigInt(snapshot.totalVotingPower);

  let percentOfTotal = 0;
  if (totalVotingPower > 0n) {
    percentOfTotal = Number((totalPower * 10000n) / totalVotingPower) / 100;
  }

  return {
    ownStake,
    delegatedStake,
    totalPower,
    percentOfTotal,
  };
}

export function setVotingPowerQueryProvider(provider?: VotingPowerQueryProvider): void {
  votingPowerQueryProvider = provider;
}

export async function getVotingPower(address: string): Promise<VotingPower> {
  if (!address) return zeroVotingPower();

  if (!votingPowerQueryProvider) {
    throw new NotConfiguredError('Voting power query provider');
  }
  const snapshot = await votingPowerQueryProvider(address);
  return buildVotingPower(snapshot);
}

export async function getVotingPowerAtLedger(address: string, ledger: number): Promise<VotingPower> {
  if (!address) return zeroVotingPower();

  if (!votingPowerQueryProvider) {
    throw new NotConfiguredError('Voting power query provider');
  }
  const snapshot = await votingPowerQueryProvider(address, ledger);
  return buildVotingPower(snapshot);
}
