# Contributing to CoralSwap SDK

Thank you for your interest in contributing. This document covers the setup, standards, and process for contributing to the CoralSwap TypeScript SDK.

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0
- **Git** with commit signing recommended

## Local Setup

```bash
git clone https://github.com/CoralSwap-Finance/coralswap-sdk.git
cd coralswap-sdk
npm install
npm run build
npm test
```

## Project Structure

```
src/
  client.ts          -- Main SDK entry point (CoralSwapClient)
  config.ts          -- Network configs and defaults
  errors.ts          -- Typed error hierarchy
  index.ts           -- Public API barrel exports
  contracts/         -- Contract client bindings
    factory.ts       -- FactoryClient
    pair.ts          -- PairClient
    router.ts        -- RouterClient
    lp-token.ts      -- LPTokenClient
    flash-receiver.ts -- FlashReceiverClient
  modules/           -- High-level protocol interaction modules
    swap.ts          -- Swap quoting and execution
    liquidity.ts     -- LP position management
    flash-loan.ts    -- Flash loan building
    fees.ts          -- Dynamic fee queries
    oracle.ts        -- TWAP oracle queries
  types/             -- TypeScript type definitions
  utils/             -- Utility functions (amounts, addresses, retry, simulation)
tests/               -- Jest unit tests
```

## Coding Standards

- All code must pass `npm run lint` (ESLint with TypeScript rules)
- All code must compile with `npm run build` (strict TypeScript)
- Use `bigint` for all token amounts -- never `number`
- Use typed errors from `src/errors.ts` -- never raw `throw new Error()`
- All public functions and classes must have JSDoc comments
- Prefer `async/await` over raw Promises
- No `any` types -- use `unknown` and narrow with type guards

## Commit Messages

Use conventional commits in past active voice:

```
feat(swap): implemented multi-hop routing logic
fix(client): resolved RPC timeout on slow networks
test(oracle): added TWAP calculation edge-case tests
docs(readme): updated installation instructions
refactor(errors): consolidated error mapping function
```

**Format:** `type(scope): description`

**Types:** `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `ci`

**Scopes:** `client`, `swap`, `liquidity`, `flash-loan`, `fees`, `oracle`, `errors`, `utils`, `contracts`

## Pull Request Process

1. Fork the repo and create a branch: `feat/issue-NUMBER-short-description`
2. Make your changes following the standards above
3. Ensure CI passes: `npm run lint && npm run build && npm test`
4. Open a PR against `main` using the PR template
5. Reference the issue number in your PR description
6. Wait for review -- first response within 24 hours

## Testing

The SDK uses [Jest](https://jestjs.io/) with [ts-jest](https://kulshekhar.github.io/ts-jest/) for all tests.
Configuration lives in [jest.config.js](jest.config.js); tests must reside in `tests/` and be named `<module>.test.ts`.

### Running Tests

| Command | Description |
|---|---|
| `npm test` | Run the full test suite once |
| `npm run test:watch` | Re-run tests on file save (TDD mode) |
| `npm run test:coverage` | Run tests and generate a coverage report |

Coverage output is written to `coverage/` and reported in three formats: `text` (terminal), `lcov`, and `json-summary`.
All PRs must keep the test suite passing; coverage regressions will block merge.

### Test Categories

#### 1. Pure Unit Tests

For functions that have no external dependencies (math, utilities, validation), test them directly without any mocks.
Instantiate with a `null` client where the method under test does not call the network:

```typescript
// tests/swap-math.test.ts — testing pure bigint math
import { SwapModule } from '../src/modules/swap';

describe('Swap Math', () => {
  let swap: SwapModule;

  beforeEach(() => {
    swap = new SwapModule(null as any); // no RPC needed
  });

  it('calculates correct output for standard swap', () => {
    const out = swap.getAmountOut(1_000_000n, 1_000_000_000n, 1_000_000_000n, 30);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(1_000_000n);
  });
});
```

#### 2. Module Tests (with Mocks)

For modules that talk to contracts or the Soroban RPC, replace network calls with `jest.fn()` stubs.
Attach mocks directly to the `client.server` or client helper objects rather than mocking the entire SDK module:

```typescript
// tests/client.test.ts — mocking RPC methods on the server object
import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';

describe('CoralSwapClient', () => {
  it('returns true when server responds healthy', async () => {
    const client = new CoralSwapClient({ network: Network.TESTNET, secretKey: '...' });
    client.server.getHealth = jest.fn().mockResolvedValue({ status: 'healthy' });

    expect(await client.isHealthy()).toBe(true);
  });
});
```

When an entire third-party module needs stubbing, use `jest.mock()` at the top of the file
and restore real implementations with `jest.requireActual`:

```typescript
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      assembleTransaction: jest.fn((tx) => ({ build: () => tx })),
    },
  };
});
```

For higher-level module tests (swap, liquidity, oracle, etc.), build a minimal mock client object
using factory helpers so each `describe` block starts from a clean state:

```typescript
function buildMockClient(pairMap: Record<string, PairConfig>) {
  return {
    config: { defaultSlippageBps: 50 },
    getDeadline: jest.fn().mockReturnValue(9_999_999_999),
    getPairAddress: jest.fn().mockImplementation(async (a, b) => `${a}|${b}`),
    pair: jest.fn().mockImplementation((addr) => mockPair(pairMap[addr])),
    submitTransaction: jest.fn().mockResolvedValue({ success: true, txHash: 'MOCK_HASH' }),
  };
}
```

### Writing New Tests

1. **File placement** — add `tests/<module>.test.ts` mirroring the source path (`src/modules/swap.ts` → `tests/swap.test.ts`).
2. **Naming** — use `describe` blocks that match the exported class or function; use `it` strings that read as plain English.
3. **BigInt amounts** — always use `bigint` literals (`1_000_000n`). Never use `number` for token amounts.
4. **Error assertions** — assert against the specific typed error class, not just `Error`:
   ```typescript
   expect(() => swap.getAmountOut(0n, 1000n, 1000n, 30)).toThrow(ValidationError);
   // Also verify the base class for hierarchy checks:
   expect(() => swap.getAmountOut(0n, 1000n, 1000n, 30)).toThrow(CoralSwapSDKError);
   ```
5. **Async tests** — `await` every async call and use `rejects.toBeInstanceOf()` for async errors:
   ```typescript
   await expect(swap.getMultiHopQuote({ path: [A, B], ... })).rejects.toBeInstanceOf(ValidationError);
   ```
6. **Edge cases** — each new function should include tests for: zero inputs, maximum values, reserve imbalance, and negative/invalid inputs.
7. **Shared helpers** — place reusable factories and fixtures in [tests/helpers.ts](tests/helpers.ts) and import them where needed.

### Coverage Requirements

- Every new public function or method must have at least one passing test.
- Every error path (typed throws, validation guards) must be exercised.
- Run `npm run test:coverage` locally before opening a PR and check the `text` summary in the terminal for uncovered lines.

## Security

- Never commit secrets, keys, or `.env` files
- Never log private keys or secret keys
- Report vulnerabilities privately via GitHub Security Advisories
- All BigInt operations must handle edge cases (zero, overflow)

## License

By contributing, you agree that your contributions will be licensed under the project's MIT License.
