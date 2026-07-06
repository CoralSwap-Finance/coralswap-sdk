import { describe, expect, it } from '@jest/globals';
import { parseGovernanceArgs } from '../examples/governance-vote';

describe('parseGovernanceArgs', () => {
  it('parses address, string, boolean and numeric values', () => {
    const parsed = parseGovernanceArgs(JSON.stringify([
      { type: 'address', value: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
      'create',
      true,
      3,
    ]));

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toBeDefined();
    expect(parsed[1]).toBeDefined();
    expect(parsed[2]).toBeDefined();
    expect(parsed[3]).toBeDefined();
  });

  it('falls back to an empty array for invalid JSON', () => {
    expect(parseGovernanceArgs('not-json')).toEqual([]);
  });
});
