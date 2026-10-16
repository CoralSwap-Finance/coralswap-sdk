# Module Boundary Decisions

- **Date**: 2026-06-29
- **Status**: Accepted

## Context

The CoralSwap SDK is split into separate domain modules under `src/modules/` rather than exposing all functionality through a single monolithic class. Each module encapsulates the client logic for a specific CoralSwap protocol feature, and types are co-located in `src/types/`.

The three modules covered by this decision are:

- **Governance** (`src/modules/governance.ts`, `src/types/governance.ts`) — proposal creation, voting (`for`/`against`/`abstain`), LP-token delegation, and proposal history queries.
- **Staking** (`src/modules/staking.ts`, `src/types/staking.ts`) — LP token staking for governance weight, reward accrual and claiming, cooldown-based unstaking, and APY queries.
- **Treasury** (`src/modules/treasury.ts`, `src/types/treasury.ts`) — protocol treasury balance and allocation views, fee revenue tracking across all pools, and USD valuation via on-chain spot prices.

Each module depends on `CoralSwapClient` for RPC access but is otherwise self-contained: it maintains its own contract address, validates its own inputs, and defines its own error handling.

## Decision

Each protocol concern is isolated in its own module class with a focused API surface rather than lumping all methods into a single client or scattering them across ad-hoc functions.

1. **GovernanceModule** — accepts a `CoralSwapClient` and a governance contract address. Exposes `createProposal`, `castVote`, `delegate`, `undelegate`, `getProposal`, `getActiveProposals`, `getProposalHistory`, and `getDelegationState`.
2. **StakingModule** — accepts a `CoralSwapClient`. Exposes `stake`, `unstake`, `claimRewards`, `getStakedBalance`, `getStakingAPY`, `getStakingRewards`, and `getCooldownStatus`.
3. **TreasuryModule** — accepts a `CoralSwapClient` and optional `TreasuryModuleOptions` (stablecoin addresses for USD pricing). Exposes `getTreasuryAddress`, `getTreasuryBalance`, `getTreasuryAllocation`, and `getFeeRevenue`.

This separation solves the following problems:

- **Cohesion**: Related operations (e.g., all voting-related methods) live together instead of being spread across namespaces.
- **Independent versioning & testing**: Each module can be unit-tested in isolation by mocking `CoralSwapClient`.
- **Tree-shakeability**: Consumers import only the modules they need rather than pulling in the entire SDK surface.
- **Clear ownership**: Each module has well-defined inputs and outputs, making it straightforward to audit, extend, or replace.

## Consequences

### Positive

- Modules are easier to maintain because each file stays focused on one domain.
- Testing is simpler — each module simulates its own contract calls and validates its own arguments without coupling to unrelated features.
- Extending the SDK (e.g., adding a new module) follows a predictable pattern: create `src/modules/new-feature.ts`, define types in `src/types/new-feature.ts`, and export from `src/modules/index.ts`.

### Negative

- Cross-module concerns (e.g., staking affects governance voting power) are not automatically coordinated — callers must orchestrate inter-module workflows themselves.
- The `CoralSwapClient` dependency is injected manually into each module constructor, which adds boilerplate compared to a single all-in-one client.
- Module discovery is implicit — consumers must know which module class to import rather than calling methods on a unified API object.
