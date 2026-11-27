# Issue #463 — Blend integration tests: not implemented

Issue #463 requests `tests/integration/blend.integration.test.ts` covering
`blend.ts`'s `getBlendPortfolio()` against real Blend Testnet contract
state (LP collateral + borrow positions).

That module and method do not exist in this codebase:

- There is no `src/modules/blend.ts`, no `src/types/blend.ts`, and no
  `getBlendPortfolio()` anywhere in the SDK.
- Blend integration is explicitly called out as **out of scope** in
  [`src/modules/factory.ts`](../../src/modules/factory.ts):

  > **External contracts** (Blend, Squid) are out of scope — they are not
  > CoralSwap pairs and therefore cannot be verified against the CoralSwap
  > factory registry.

Writing an integration test for a module that doesn't exist would mean
fabricating a new Blend contract-client module and API surface from
scratch — that's net-new feature development, not test coverage for
existing behavior, and it contradicts the scope boundary documented above.

No test code was added in this PR. Flagging for a maintainer to either:

1. Close #463 as out of scope, consistent with the `factory.ts` note, or
2. Re-scope it as a feature request to build LP-collateral integration
   with Blend (in which case the module should be designed and reviewed
   before integration tests are written against it).
