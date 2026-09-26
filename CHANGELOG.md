# Changelog

## 1.0.0 (2026-09-26)


### Features

* [#153](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/153) [SDK] Add flash loan event parsing ([a1ec919](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a1ec919e9c97b76a911808b4b81105b74ea04b2e))
* **#153:** add flash loan event parsing with decoded success/failure results ([06d5ad8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/06d5ad8190a54546f91164de2620ed3e3348e440))
* **#153:** add flash loan event parsing with decoded success/failure… ([1d10914](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/1d109145811627ad3f67f565cdcc7172d78822fc))
* **#224-227:** add GovernanceModule with proposal, voting, and delegation support ([f93eb8f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f93eb8fea76fccbbba9a2cd3423f14856dbe09ab))
* **#232:** add treasury.ts module with getTreasuryBalance and getTreasuryAddress ([9eae7fa](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9eae7fa7ab0037b46be8ee3d10d583d78c752caf))
* **#233:** add getTreasuryAllocation() breakdown by token ([25f025c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/25f025c9c759a1729de2f6aa7a5922e846ebf1d5))
* **#234:** add getFeeRevenue() protocol revenue tracker ([99c100f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/99c100f21bab0717fa1b26e7c292bf0db8bf329a))
* **#235:** add unit tests for TreasuryModule ([06debb6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/06debb6a6b4b207f769282c4c34e6c616b97ec2c))
* **#692:** CI coverage gate per core module with trend reporting ([#743](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/743)) ([4d12e10](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4d12e1026492fb112f1ff653803149458ae3edf5))
* add .env-based contract address overrides for CoralSwap SDK ([6dcf3f4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6dcf3f4069a9d74f50ad5bbc03b3db45d5ff6971))
* add .env-based contract address overrides for CoralSwap SDK ([#158](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/158)) ([4227603](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4227603c58fb4b0763a251a03364b086f127f845))
* add alerts module ([#367](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/367)) ([cd66be9](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cd66be914e69fd4c0ddaa2b6984a181e424b0040))
* add API reference docs for alerts, webhooks, and monitoring modules ([e1c91a3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e1c91a3a6c14b200bd527f14e28bf2193882e38f))
* add API reference docs for alerts, webhooks, and monitoring modules ([#315](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/315)) ([224eb87](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/224eb87dc26fc9e3717fe9dfef99e1d78d6087d7))
* add API reference documentation for limit-orders module ([29b2a57](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/29b2a57b74aeff1da76a819d2e42ec45e8ac6b55))
* add batchCall and batchCallSequential to batch-request.ts ([#293](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/293)) ([#376](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/376)) ([c91c8f8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c91c8f87850d7c38c07add09fc6f79fcf3de2ee4))
* add benchmark snapshot for batch token-price fetch ([#753](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/753)) ([b182fef](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b182fef31ffb35263d89525fdff811d90ea09feb))
* add blend, analytics, and price-feed modules ([d60d50d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d60d50d2a29f44b407b0015e2be72edc29aa5147))
* add blend, analytics, and price-feed modules ([#178](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/178), [#180](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/180), [#181](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/181), [#182](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/182)) ([6a000bf](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6a000bf72f5c4696dbf63276e1335b05fac9ef2a))
* add comprehensive flash loan documentation and examples ([ad6eec6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ad6eec6f1140e764d62540757ca7d4e74c81cabe)), closes [#98](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/98)
* Add comprehensive flash loan documentation and examples ([f9abaf7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f9abaf76ddc3455200a2f1ef4d12ffd4c8c90305))
* add comprehensive portfolio test suite with 23 test cases ([9291b1e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9291b1e19f09ef33f774473a06650bfe76313b9c))
* add contract status health reporting ([#424](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/424)) ([4b32ca3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4b32ca3d32a510fcafbd81b84a07cbee9bdf8eb2))
* add dashboard metrics aggregator to MonitoringModule ([#558](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/558)) ([97c492c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/97c492c17346b3e64602326938ea965f531bf754)), closes [#284](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/284)
* add DCAModule for dollar-cost-averaging schedules ([#244](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/244)) ([b107ece](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b107eceb3e065cafadded61862463a53c534f693))
* Add deadline-aware retry — stop retrying after transaction deadline. CLOSES [#150](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/150) ([998869c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/998869cbbfda0ce3b5ee71beca9be33c47ba421a))
* add Dependabot configuration for automated dependency updates ([#348](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/348)) ([419f3af](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/419f3af09e122980cbdfa4fe3595ba294221e7a2))
* add examples/monitoring-dashboard.ts ([#287](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/287)) ([#423](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/423)) ([cec18bc](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cec18bc094fc2b947edb6928753988272f153922))
* add examples/rwa-pool.ts and src/rwa.ts for RWA pool support ([ea91f73](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ea91f731c6708289109e03a0c6d1e17d6266c53d))
* add fee tier comparison to flash loan module ([#154](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/154)) ([5b0f588](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5b0f58814538a9cdf7ed306f579b8b1e4bd046b7))
* add filterEvents utility and event-filtering tests ([0cfc8e4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0cfc8e4bfbcf788c0f661d338402f2e98a2e0fbb))
* add full event decoding for all contract event types ([79c7a59](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/79c7a59a1ab1cd171ac90398ed859f9b0fe66303))
* add full event decoding for all contract event types ([c501862](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c5018622fdf35fc29182ed2e31953a2b0ae54b2e))
* add fuzz tests for Pair mint/burn with random reserve ratios ([0ef4eb1](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0ef4eb17fac9d56bd1de2623f58e9d84418f642a))
* add gas estimation, named network exports, formatLargeNumber, a… ([ef9608e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ef9608e2667ef11be590d191ba9d55379f50f6bd))
* add gas estimation, named network exports, formatLargeNumber, and STAGING_NETWORK ([4a591c7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4a591c729648b64c80201c06db50f6bd1018f33c))
* add getLPYield() method to FeeModule ([cd9b6c5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cd9b6c5edbb60c67ba5fb74df78d3050ccf7758e))
* add getLPYield() method to FeeModule ([489c146](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/489c146e1d2c2b3b8ffe191e466c3e4f0c6ff9bc)), closes [#179](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/179)
* add governance snapshot voting, staking eligibility, and flash-loan validation ([#517](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/517)) ([fc02ea2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/fc02ea2566e326982b15d9adbd27524bdccb060e))
* add GovernanceModule — proposal creation, voting, delegation, history, and tests ([e583f36](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e583f36b70362ca1f5f274566d4969de7ba9c6f9))
* add GovernanceModule — proposal creation, voting, delegation, history, and tests ([e583f36](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e583f36b70362ca1f5f274566d4969de7ba9c6f9))
* add integration tests for positions module against Stellar Testnet ([#586](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/586)) ([92804d2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/92804d2974c89cbecaa62d172e67b17e4346bc67)), closes [#450](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/450)
* add integration tests for tax reporting module with CSV/JSON ex… ([#559](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/559)) ([d1b329b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d1b329ba1de841761fe2297cec47cc3d28e0b941))
* add migration utilities and unit tests ([#299](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/299)) ([742ad29](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/742ad2973745fa450e0f92951c015f222ce80b89))
* add MIGRATION.md guide for upgrading from v1 to v2 ([cf800bc](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cf800bca0e1dfac59308ae62bff2548e2316a6bf))
* add migration.ts utility with SDK version compatibility checker ([#364](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/364)) ([60d3d77](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/60d3d77dde2f2ec305f0330c2dcd9be078626d31))
* add MockProvider for offline SDK testing ([#106](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/106)) ([6df3de8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6df3de83674e660e3f49f05010ecb09d658946b3))
* add oracle integration tests for TWAP and volatility score against testnet ([#550](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/550)) ([2313850](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/2313850924efe97f70719595674c2752d304e520))
* add portfolio and risk metrics modules ([fd2c109](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/fd2c109e7c57b19d01593a03c211df5e94b299ce))
* add portfolio and risk metrics modules ([#256](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/256) [#261](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/261) [#262](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/262)) ([5e4422b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5e4422ba1ac52886b1f01c0316a16f97703b18a5))
* Add portfolio risk metrics, enhance tax reporting, and improve stop-loss ordering ([cfca4c9](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cfca4c9a449df3623b093c89125fc5ba21495a43))
* add portfolio tests covering getPortfolio, getPortfolioValue, getPortfolioPnL ([172e3ee](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/172e3eeeb8afbd270bcbbb60443c8259a52d9073))
* add PortfolioModule with getPortfolioPnL for LP PnL tracking ([03a461b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/03a461b4b0c0eb8aa0a8655c62f3d96c43e38c2c))
* add PortfolioModule with getPortfolioPnL for LP PnL tracking ([03a461b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/03a461b4b0c0eb8aa0a8655c62f3d96c43e38c2c))
* add PortfolioModule with getPortfolioPnL for LP PnL tracking ([bf383c3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bf383c39c5de2b69f213005534af12ff48c49ef6))
* add PortfolioModule with getPortfolioPnL for LP PnL tracking ([7d492a9](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7d492a99318c593176d590c50d722e97e916e422))
* add router module integration tests for testnet ([#581](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/581)) ([283b6d8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/283b6d856550a3d7e302d956ebef8bcf5543c185))
* add runtime deprecation warnings ([45486f7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/45486f7c1c5ac6500e832d9c88ecad68e0482a73))
* add runtime deprecation warnings ([3217ca7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3217ca7f5679aefa0a042f41e17fab492b25b969))
* add runtime deprecation warnings ([06c0477](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/06c0477aabb2a01574997c6b143aaa38c18b087f))
* add RWA pool example and src/rwa.ts module ([bc04d0f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bc04d0f6092effb460ee419c0d0ba96afae32bfd))
* add smoke test suite and debugging utilities for contract read … ([#727](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/727)) ([b9f048c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b9f048c4881c3fc997db01a69216572196158024))
* add squid cross-chain module ([ab8e0e7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ab8e0e7b34b58dee49ec62740c547a8ebccaeb0b))
* add squid cross-chain module ([4928531](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/492853110bb0b8ed2c5fad84849cf421b4f9119d))
* add STAGING_NETWORK environment configuration ([#128](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/128)) ([af6646c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/af6646c91d44ca13f63393e7e5febe260743bc5a))
* add stop-loss.ts module with oracle integration ([#248](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/248)) ([c753445](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c753445e2ba210d0b611116bb92160d3431dd218))
* add TaxReportingModule for CSV/JSON trade history export ([e8c9446](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e8c9446f9b270145d5cdd79e3cca63a77e0e987e))
* add token-bucket RateLimiter with setTimeout-based throttling ([#292](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/292)) ([c2d55fb](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c2d55fb4c30da314a9e4e559b550db3947d3fa17))
* add token-bucket RateLimiter with setTimeout-based throttling ([#292](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/292)) ([24bd247](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/24bd2475f54fbab6b19d0170ba6bbf03892b8bae))
* add transaction composer workflow ([#524](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/524)) ([6c22a27](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6c22a27ad9d0da0ad824868981cf01197a2ab7e1))
* add unit tests for migration utilities ([#299](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/299)) ([064c4ce](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/064c4ce6873366f0eda2d501b218e953693c3cbe))
* add validation guards to GovernanceModule methods ([c6251ea](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c6251ea010aa5234b725f2d9dbc7e690fc3d3c1c))
* add validation guards to GovernanceModule methods ([243d694](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/243d69415af17a071ddcff024fd74b0510e9165b))
* **alerts:** add alert system with createAlert, checkAlerts, deleteAlert and 4 alert types ([#377](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/377)) ([54bd441](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/54bd44197df6ef037981de4a1ef3add97a4228de))
* approve helper, TWAP audit, fuzzing, address trust boundary ([#516](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/516)) ([b9d53b0](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b9d53b05abf4af458b0f3fcad9016a596d02087c))
* **benchmarks:** add RPC performance benchmarks with JSON output ([#350](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/350)) ([10cd268](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/10cd268bfbe3c060821d3e349742a681ee982b5d))
* **blend:** adopt idempotent resubmission for LP-collateral operations ([#532](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/532)) ([33219ed](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/33219edb89daa49d780cf387740e9a98e3ba185d))
* **ci:** add benchmark regression detection workflow ([1a94180](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/1a94180e3ff214595238046e947addcb583f433f))
* **ci:** add benchmark regression detection workflow ([27fc4be](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/27fc4be31354ee921b4f82ea291efc72bd10837d))
* **client:** add allEvents(contractId, filters) typed cursor for composed event listeners ([#785](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/785)) ([76dffb5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/76dffb52535aebefb06585036c81be43f27f979e))
* **client:** reject cleartext RPC URLs in production config ([#745](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/745)) ([9be5857](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9be5857e721f3ff41fb81add2a1d07d775cccd8b))
* **coralswap-sdk:** sdk-add-performance-md-tuning-guide-for-high-thr ([#347](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/347)) ([a190ef4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a190ef457258fbba8d2b3e9bc825c754fc888bee))
* **docs:** add comprehensive API reference docs for governance module ([a755437](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a7554371f842dd2a2e28714b92d20b20c21565a2))
* **docs:** add comprehensive API reference docs for governance module ([5603dfd](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5603dfd4d2aa421c898b101518120cc9a14e0073))
* **docs:** add comprehensive API reference docs for governance module ([3256c5a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3256c5a32d7ff76721a0a518c4a011fc80c78c70))
* **engine:** introduce aethermint holographic rendering pipeline ([#569](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/569)) ([3ec9623](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3ec96235b7dfe77c6d6017131e65f0e802fed4c0))
* enhance simulateTransaction with typed result and simulation options ([#146](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/146)) ([de191e8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/de191e82bcf08d6ceb5721ce614e52afa40b3e38))
* **examples:** add alert-setup.ts for price and IL alerts ([a41e9e6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a41e9e6790e3ba33dcc45709ff87185a8688e65d)), closes [#286](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/286)
* **examples:** add alert-setup.ts for price and IL alerts ([b307341](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b30734148867aa76e9c3280d4eee77a47dc09eda)), closes [#286](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/286)
* **examples:** add serialized-submission bot example ([#778](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/778)) ([1c6de25](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/1c6de252dd437fc6df8f4a43aa4e2a8218aa78bb))
* **fees:** add getFeeHistory and analyzeTrend to FeeModule ([b8d4dbe](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b8d4dbea371a41077b2626fcdd3248420f01c9b6))
* **fees:** add getFeeHistory and analyzeTrend to FeeModule ([ceb383c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ceb383ca7e374ca32c082a8e6ff7ccd867041831))
* **health-check:** add HealthCheckModule with unit tests ([#283](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/283)) ([0acc733](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0acc733e5f6b36e151429b2a85be3485d4d59bb4))
* **health-check:** add HealthCheckModule with unit tests ([#283](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/283)) ([5a2e72e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5a2e72ed228198cc9a8fe49ae8a37da965815c6e))
* idempotent resubmission for swap.execute() ([#573](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/573)) ([43592ca](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/43592ca5c8d5247448ed00330b4e74a21fd437ed))
* implement changelog parser for SDK ([#353](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/353)) ([2c20549](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/2c20549c1f6022cde1a35c0be805aa402375a9dc))
* implement circuit breaker and deadline-aware retry ([#167](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/167)) ([acb19c0](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/acb19c012ec9d1eff925db604665ec1f12e75386))
* Implement circuit breaker pattern in ret ([9a1f47c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9a1f47c66bf2e0ec03cf708ab9354abbc88d9516))
* implement findOptimalPath utility in Router ([69088ea](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/69088ea34ca707be90db348c24db4e704aa03d77))
* **leaderboard:** add getTopTraders() ranked by swap volume and restore getSwapHistory() ([#378](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/378)) ([0bc8a1d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0bc8a1d86e6b932eb2ec94e948b738107e38c1b6))
* **leaderboard:** implemented leaderboard module for rankings ([d0c6852](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d0c6852e0c6c52c9009ae7b589e437ee0dc66c7c))
* **limit-orders:** add exhaustive input validation guards ([#290](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/290)) ([e096f2d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e096f2d70b406647506083e52a3ac3898414b0f1))
* **limit-orders:** add exhaustive input validation guards ([#290](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/290)) ([7d1b2ad](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7d1b2ad073b0ddc6691ac19b0135cc2de9e09a48))
* **liquidity:** add calculateIL impermanent loss utility ([47e4591](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/47e459166881cd6f51da0ec282a98455c017dad9))
* **liquidity:** add calculateIL impermanent loss utility (closes [#176](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/176)) ([1502d1a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/1502d1a03508c6ee58ed0803dbe0fc6add1da50c))
* **liquidity:** migrate input validation to zod schemas ([#796](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/796)) ([7ddc289](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7ddc289a46f76006c290ed4856a9b2d39c50ae15))
* make transaction timeout configurable ([0f3a336](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0f3a336e4f01a1bbd7633e85d31f3781834c4c60))
* make transaction timeout configurable across all contract clients and client ([d5d6e25](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d5d6e25bb471f18b96cee4378735492819795725))
* **monitoring:** Add integration tests for monitoring module against… ([#543](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/543)) ([9e1acde](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9e1acdea9d44de44b45d7056b948b5259a8b95ba))
* **monitoring:** getSystemMetrics() on the shared EventCursor ([#478](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/478)) ([#602](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/602)) ([151a94e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/151a94e44fe3cb9e79317a0f92f0115b1e1eab93))
* **portfolio:** add input validation guards to PortfolioModule ([#798](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/798)) ([0d73bc2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0d73bc2417dce8192c34e667b56f9c5a7619098a)), closes [#291](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/291)
* **retry:** wire deadlineMs through CoralSwapConfig into retry options [#434](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/434) ([#591](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/591)) ([7b2199d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7b2199de8c43397a7c48105dd119ef0e1ed33ac0))
* **router:** add EXACT_OUT pathfinding and swap improvements ([#164](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/164)) ([76130e8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/76130e8cc55bf5cafcae8f84b3a830b94e5fa45a))
* **rwa:** add idempotent resubmission for RWA pool write operations ([#575](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/575)) ([0abc012](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0abc01236b58da12de22103a8bdc5c8d9cee26c2)), closes [#473](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/473)
* **sdk:** add getLimitOrderStatus() order state query and watchOrder… ([ea58a9d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ea58a9d3647fddab905c199276244fe7e1495301))
* **sdk:** add positions.ts module — LP position tracker per address ([3b80928](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3b8092862acf222f818369d747b720dc641429e6))
* **sdk:** add shared EventCursor utility ([#539](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/539)) ([a8f4913](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a8f491373a70165385b20e45eaea522f743e11ef))
* **sdk:** add shared Zod validation schema pattern for SDK module inputs ([#577](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/577)) ([d5e860e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d5e860ecbfb8284770284c7203036a4639b66b13)), closes [#485](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/485)
* **sdk:** add verifyWebhook/updateWebhook/listWebhooks and the Webhook view ([#797](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/797)) ([c0101f5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c0101f54a1d81352b9ef820a0896f18dd703e0c0))
* **squid:** add SquidModule with idempotent cross-chain swap execution ([#574](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/574)) ([c6f1e33](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c6f1e3350a448c865f03179747ef4472c9e0b22c)), closes [#474](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/474)
* **staking:** add LP token staking module with cooldown enforcement and unit tests ([d6ed4e2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d6ed4e26d0e9d5f351b8b6143fc14b15b3340e12))
* **swap:** add getSwapHistory() for historical swap queries ([bd02860](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bd02860b1d2e4277361c54c4cb7d981bd86fca8f))
* **swap:** implemented swap history retrieval ([0ea93c5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0ea93c5af2f791d462ecc0ab2554f72dc14c1fdd))
* **swap:** migrate input validation to zod schemas ([#541](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/541)) ([ab44887](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ab44887f70f6ec7108cb10bab9ee3d9474aeb582))
* **tax-reporting, risk-metrics, stop-loss:** add portfolio risk scoring and enhance tax/stop-loss modules ([0e32c7e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0e32c7ec4feec76c5ed6d23362a56a902e38bacb))
* **tax-reporting, risk-metrics, stop-loss:** add portfolio risk scoring and enhance tax/stop-loss modules ([53756d2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/53756d20142d2f5b9076aad456f60cc054cc14a2))
* **tests:** add limit-orders integration tests against Stellar testnet ([#305](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/305)) ([#425](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/425)) ([4108080](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/410808099b851176e134acb1c1e1d6f61b38aa32))
* **tokens:** add on-chain balance & allowance fetch utilities ([b20bce7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b20bce71bfc6d17170b041b4bb6a95e1bf71e745))
* **tokens:** add on-chain balance and allowance fetch utilities ([918bd54](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/918bd54d5ff0197341fcc361f3f088a8f28c0809)), closes [#172](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/172) [#173](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/173) [#174](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/174) [#175](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/175)
* **treasury:** add integration test for treasury allocation against Testnet ([#566](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/566)) ([28ff602](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/28ff6028250d1f1b49301b7f83a06529d260c349))
* unified error taxonomy documentation ([#777](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/777)) ([9fd6a96](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9fd6a9687eb8b174d68b7c145e40f09e897e6852))
* use idempotent resubmission for flash-loan execution ([#554](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/554)) ([a8a583f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a8a583f7e98047d6fccf75915af6aedc83ce55ce)), closes [#472](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/472)
* **utils:** add decodeEvents utility for Pair events ([#163](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/163)) ([366b835](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/366b8359cf5ac7be139c88ed0b4c56eb6e88d617))
* **utils:** add RPC endpoint health-check and latency monitoring ([#522](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/522)) ([ceebfaf](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ceebfafa4c227d442cb6110cd2c9cc6045f2ba73))
* **utils:** add shared ledgerToApproxTime helper for consistent ledger-time rendering ([#792](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/792)) ([9f2cd58](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9f2cd5800d076c11b6d0fd2cc9162efc58744bd9))
* **utils:** implement formatLargeNumber utility ([#127](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/127)) ([429e9ad](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/429e9ad5a72e0f0c6e4490ccbdc6340d2766bd5e))
* **webhooks:** add outbound webhook delivery module with HMAC-SHA256 signing ([b948a24](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b948a2492a12f18e3052a9719c20a1674ff31da2)), closes [#276](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/276)
* **webhooks:** add outbound webhook delivery module with HMAC-SHA256 signing ([4e43fb6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4e43fb6cf6260df8af2dd3f86bac7b16de17bdcc))
* **webhooks:** add outbound webhook delivery module with HMAC-SHA256 signing ([4e0e229](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4e0e229ffbc249d49222ebc02642c4275f047f06)), closes [#276](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/276)
* **webhooks:** add testnet integration tests for webhook registration, delivery, and retry behavior ([b56c700](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b56c700f4c2591f5edf3ee086fc6ebfa85d46c4d))
* **webhooks:** add testnet integration tests for webhook registration, delivery, and retry behavior ([8a00177](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8a00177f87c3d37c6deec279b5e2cf0951224d71))
* wired rateLimiter into CoralSwapClient RPC calls ([#547](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/547)) ([02e77f3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/02e77f3cea089001934be9daf38495dfa4824410))


### Bug Fixes

* **#680:** parameter validation audit — enforce ValidationError for all public method inputs ([#742](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/742)) ([8a70a62](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8a70a624a1364c7378093573b0afaec55498c0ad))
* add atomic composed flows and stale-price guard for createStopLoss ([#521](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/521)) ([8f12cc8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8f12cc8b9b4d7e9602ce1a8d38e25e2cae2149e4))
* add BigInt serialization support for Jest workers ([51db914](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/51db9143dcab194e2e03e429782467652478a96c))
* add missing Asset import in addresses.ts for native XLM support ([#142](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/142)) ([0615296](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/061529623ecf15ab4a979df885935bd3eb7e0c68)), closes [#130](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/130)
* add missing error context in alerts module exceptions ([fa3ff0b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/fa3ff0ba437621a7749a84b2d8176f4ac7148e38))
* add missing error context in alerts module exceptions ([08063c4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/08063c4cde93359a26e83c5e49897eb4d3cae72a))
* add missing error context in alerts module exceptions ([4c5554f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4c5554f7c015bac429d757919bfbc90ffc91a230))
* add missing error context in governance module exceptions ([#300](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/300)) ([6a03f64](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6a03f644fb18e647826cce8aeace61399d26fea5))
* add missing error context in governance module exceptions ([#300](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/300)) ([175ec1d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/175ec1d6cfa034d995c5d72cb68f38daeacae348))
* add networkConfig to swap mocks and use valid addresses in tests ([38f4c5a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/38f4c5a6d9d9058006f47ceb8360db01eee80d16))
* add server setter to allow test mock injection ([8161e2f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8161e2fde597f61f287d73249b97083223d8494f))
* add setupFilesAfterFramework for BigInt Jest support ([6937df4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6937df4c50f8008c4084bcc13f09ecce3ac29ac9))
* address swap and flash-loan execution correctness issues ([#165](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/165)) ([6fc473a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6fc473a57ebef33b73497d9372cd1461155846a5))
* **alerts:** Use TWAP-backed price source to resist manipulation ([#555](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/555)) ([55e009e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/55e009e8e4c2d0796de64911fb9398917be510d3))
* apply bug fixes from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) (errors, config, flash-loan) ([1cbd200](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/1cbd20042eaf1c31bcc0d2865a4924bf5c99a35b))
* apply bug fixes from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) (errors, config, flash-loan) ([04202b1](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/04202b1660581f6a9bf10c1f38cee12d31990279))
* apply bug fixes from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) (errors, config, flash-loan) ([477a0e4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/477a0e40e2484e1dfc9eff3e91aa7954c04d6275))
* apply client.test.ts fixes from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([dcf9f7c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/dcf9f7cf63695bc471dbb7d21bc9b5c05acd6b0e))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([538f6d2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/538f6d2f47b909241e78f2b3a93e23d2608cc041))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([0c8c243](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/0c8c2434a6c5ce8c85ef6a7f51c84942ad59cf7f))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([fd27f39](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/fd27f399f63bbb20a25e6ccba3ac40e87cff9e3d))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([5c6ab39](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5c6ab39c82376b48c4b3e6f805e3611fc9f0b5e8))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([7b8448b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7b8448b9902ca46a9f33f6465bfd32810a12f59f))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([b5f3d01](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b5f3d012732a59869335ea2aaa8e666063c9a366))
* apply test fixes and package.json updates from PR [#196](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/196) ([aad52c5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/aad52c5e16d5573699a01b5d648df8dadb0159e5))
* **benchmarks:** update RateLimiter constructor to match refactored API ([8f19aa5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8f19aa55766d32270e055c06a77694f8f0a2ef96))
* cast through unknown to resolve benchmark type error ([3885db8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3885db8ccd9af2bfb736b3e50e6a997bf41da925))
* **client:** preserve networkConfig immutability during failover rotation [#688](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/688) ([#749](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/749)) ([32cb9bd](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/32cb9bdb7803c08d5b84990fccf8979aaef9d76c))
* **client:** short-circuit executeWithFallback on non-retryable errors ([#572](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/572)) ([f4ed14c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f4ed14c7c4b8effb384203b812fd79593ddb7bca)), closes [#435](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/435)
* encode swap event topic as base64 XDR in getSwapHistory() ([#576](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/576)) ([aafe95c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/aafe95c82a9c192eb01f46e3182ed7a9b898167f))
* **errors:** normalize Soroban host-level error strings into typed SDK errors ([#773](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/773)) ([7f0f62a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/7f0f62af775fe1a216d52bb17267ddee7faa07c9))
* **errors:** reconciled overlapping Router and Factory contract error code ranges ([#567](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/567)) ([de5870c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/de5870c2d20a09539eb61ef31305611c329f7e29))
* **event-cursor:** validate limit in scan(), reject bad values with ValidationError ([#766](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/766)) ([66c95c9](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/66c95c9d5325b00c640d23aac4fb7c18ec0277bd))
* **events:** derive event timestamp from tx close time, not ledger sequence ([#806](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/806)) ([ca9020d](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ca9020d58ca90f02ad360f80f62d54c5ecc4b20d)), closes [#652](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/652)
* **events:** eliminate silent fabrication and add decodeStatus to con… ([#756](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/756)) ([46df1c5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/46df1c557e0cfc1970e82bb267f29c622cc1da1c))
* export DEFAULT_SLIPPAGE from public API surface ([#129](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/129)) ([6efb21a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/6efb21aaa7dcc3803af843d54e494fef682ce161))
* **fees:** make getFeeEstimates() type-check and lint ([#781](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/781)) ([a7d629f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a7d629fc2375be46d51043eb4986b172099dad4c))
* handle zero inputs in safeMul to prevent BigInt TypeError ([#144](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/144)) ([ad82a48](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ad82a4874e4a89788d16c703cb6b25912d2cba70)), closes [#132](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/132)
* **lint:** use bare catch{} to avoid unused-vars error in flash-loan.ts ([bb688b4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bb688b45877351e11052ebbb2d597687b5c51556))
* **math:** Fix Fraction.invert() and divide() for negative values - Fix invert() to normalize sign onto numerator before constructing result so negative input never lands negative value in denominator position - Fix divide() the same way when divisor is negative - Ensures denominator stays positive per constructor contract - Add test cases for negative-value invert and negative-divisor divide Fixes [#431](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/431) - new Fraction(-1, 3).invert() now returns valid Fraction (-3/1), no throw - Dividing by negative Fraction returns correct signed result, no throw - All 1326+ existing tests still pass ([#564](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/564)) ([97a71f2](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/97a71f2d10ef9c76d4772f983dc9fb9a396e9a5b))
* **oracle:** Harden TWAP minimum window and implement price_deviation metric ([#552](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/552)) ([bc5c0c8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bc5c0c80dc11bc405068a7a442a1ecaf38aa7d9c))
* **oracle:** prune observation cache by window coverage, not raw coun… ([#790](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/790)) ([b011a35](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b011a35557f32531f328280b0fe9f5486bea6193)), closes [#689](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/689)
* pass SorobanRpc.Server instance to PairClient (updated constructor from PR [#170](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/170)) ([97b8dcf](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/97b8dcfa11ccd03b15bc22d05ccd27e8ae4e69e6))
* **portfolio:** resolve CI failures - ESLint, tests, regex safety ([#604](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/604)) ([ac443ec](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ac443ecddc86918afc73db0898703a8e447b2906))
* remove duplicate declarations from retry.ts, restore withRetry export ([c83e428](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c83e4282e1484cafb0d9a15c4a160d1280ccdf00))
* remove duplicate maxRetryDelayMs property from DEFAULTS ([3dafffa](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3dafffa354490e0f5741a27746893ec70b7951c2))
* remove duplicate quorum status export ([f70e9cd](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f70e9cd4a32c3efb70b42ed1ea7e5e88c0368fd4))
* remove duplicate RetryConfig, DEFAULT_RETRY_CONFIG, sleep, isRetryable, withRetry declarations ([d8dbfaa](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d8dbfaaaa069b8b8c9ccdc196919502b33a9d547))
* remove environment gate from integration workflow ([b700a97](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b700a97e9e0e376d883dc6d44e6a5eebc79fa4db))
* remove orphaned duplicate error system in src/modules/errors.ts ([#570](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/570)) ([7321191](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/73211912f41a6af4502c4a8c9988389cb84eea59))
* remove unused DEFAULTS import from flash-loan.ts ([87fb2d6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/87fb2d6f63965e653711700644f313aa332d6561))
* remove unused imports and exports from merge resolution ([a7143f3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a7143f306023b67b4449f4e83b9f7f1a89228660))
* repair the coverage workflow and the report stub scanner ([#800](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/800)) ([96c8c9c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/96c8c9cfa0153a8d3ee8338f1361d00ef899fb35))
* replace generic limit order errors with typed SDK errors ([4445f88](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4445f881f4b89961255685f2db64b342cbc4daa5))
* replace generic limit order errors with typed SDK errors ([52fbaaa](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/52fbaaa60886d7f65c82ad22f7e4304ad7775093))
* replace generic limit order errors with typed SDK errors ([cb4eb83](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cb4eb831fee246b7af59daa64d3e9e9abeed8105))
* replace hardcoded placeholder account in PairClient.simulateRead() ([#145](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/145)) ([3021604](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3021604ca0679abb6b5e5da8234a1c7237a08db5)), closes [#134](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/134)
* replace this.withRetry with executeWithFallback in simulateTransaction ([335d3db](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/335d3dba501e701f842944c3f22f777e22e696d8))
* resolve all 37 failing tests across errors, flash-loan, swap, router, client, and mock infrastructure ([aa723c3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/aa723c3b092e0f3dd769b0b82ab6a41b92e75f6d))
* resolve all build errors across modules, simulation, and types ([c95ef3c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c95ef3cfe2a9c3245c29fc4b5440b65f51a38075))
* resolve conflict markers and type errors from PR merges ([d657d9a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d657d9ad4f1a97fd6e8ac8df3d1ac0dd8fdf3948))
* resolve conflicts for PR [#166](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/166) ([3bdb06f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3bdb06f8070d696180961ca19d949b4965329556))
* resolve conflicts for PR [#209](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/209) ([8ea010e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8ea010eb1e974949b359861440f4f8b9ba57c0ef))
* resolve conflicts for PR [#210](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/210) ([46726be](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/46726be6050ceffd062c1ddf0ab41799da61142b))
* resolve conflicts for PR [#211](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/211) ([bb9ec13](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/bb9ec13e10ddd1db31337dac869d388ddbda9bbd))
* resolve conflicts for PR [#218](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/218) ([e2deb29](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e2deb29e7fa78c2d4b244a7809b6d03a8cdb39b2))
* resolve conflicts for PR [#326](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/326) ([a9ec6a6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a9ec6a6307978b9595078fef146a5e0ec021fbc2))
* resolve conflicts for PR [#327](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/327) ([b621bae](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/b621bae8af7dc6cfd1368909235e8aad030feb02))
* resolve conflicts for PR [#328](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/328) ([996b7b6](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/996b7b66a6b1edffc4d871f25e260032ec69ccee))
* resolve conflicts for PR [#329](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/329) ([a881046](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a8810463f537a560540dd1ad5c1719fd6ab33328))
* resolve conflicts for PR [#331](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/331) ([e3d3631](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e3d363128314c802fe9a6f94fb31316b1b8a307a))
* resolve conflicts for PR [#333](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/333) ([4981c26](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4981c26238d0450214343e94b55d99e98cd0c2d4))
* resolve conflicts for PR [#334](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/334) ([3ab9a81](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3ab9a81b2e46dbbf6707137b94ee713a49b3041c))
* resolve conflicts for PR [#335](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/335) ([cdef42c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/cdef42c608b952506270b2db27d6a239333ec82c))
* resolve conflicts for PR [#336](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/336) ([ddc924e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/ddc924e047a1ba4f32839ff8f46472ad84630ce6))
* resolve conflicts, compilation errors, and test failures ([5af6c27](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5af6c2727fbb089ada2acc18061834b4533e4701))
* resolve DiagnosticEvent[] and SorobanDataBuilder type errors in simulation.ts ([9d3710f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9d3710f1a655d512bbf11a032dcb2f889fd4d245))
* resolve lint errors and test failure in network.test.ts ([319c69e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/319c69e5f05396775d28184f0549d284261400c0))
* resolve lint errors and test failures in governance module ([4135850](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4135850fa7e20ac0a75585d5a584dcc9e0551ae5))
* resolve merge conflicts from rebase onto main ([32664e5](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/32664e5329fb0c0709fe952c5013bdf18b44a6e6))
* restore files overwritten by [#784](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/784) (CHANGELOG CI check) ([f80df2b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f80df2b27a24e187690a3c187b91a6e4fe763221))
* restore files overwritten by [#785](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/785) (TypedEventCursor / allEvents) ([9b42bb4](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/9b42bb47462cfc362b4482ce8043fd4e4c3ab4f5))
* restore files overwritten by [#789](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/789) (factory/pair contract views) ([25d8bab](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/25d8bab6fa00cd1ec0e7b4f3ff011bb18a9c231f))
* restore files overwritten by [#790](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/790) (oracle cache pruning) ([835db2e](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/835db2e2655706accb194afe78e2c82872a13544))
* restore files overwritten by [#792](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/792) (ledgerToApproxTime) ([74ecbb3](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/74ecbb3ea9bacd3662c7356790b3cd3a5f32b1d7))
* restore package.json and package-lock.json broken by [#784](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/784)/[#786](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/786)/[#789](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/789) ([e5fd79f](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/e5fd79f3e15e568f8f048cbe5961aa1855ecf14c))
* restore public export barrels (src/index.ts, src/utils/index.ts) ([5a28fbf](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5a28fbf26cafe4ee6e70aed47cf625994095e253))
* **resubmission:** block idempotent resubmission on indeterminate tx status ([#768](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/768)) ([5e434b8](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5e434b8c7f409e6cce5c353c8836d9d79d7a25ef))
* sanitize logger/error handling to prevent secret leakage ([#515](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/515)) ([218c547](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/218c5471998a02f8225b6864251fe6468a36e3c8))
* **stop-loss:** enforce oracle staleness checks in enrichOrder paths (Closes [#499](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/499)) ([#556](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/556)) ([8c0f09c](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/8c0f09c2a55f311a9ff4e54b0cfda39b5cc08756))
* sync networkConfig.rpcUrl when custom rpcUrl is provided ([5a6b858](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/5a6b85810febe35997d6e5b6e27b717dda7377cb))
* typed reads for order slots — empty slots return null, decode fa… ([#741](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/741)) ([2d1b60a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/2d1b60ab9413770c1d28f7b06fee4e5ccd67489b))
* use setupFilesAfterEnv (correct Jest config key for BigInt support) ([4024b4a](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/4024b4a0e2d85dc129491116d99bd30730adce96))
* use valid contract IDs in setNetwork singleton test ([3ca2cbb](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/3ca2cbb8853f8186cf478928a04a9c645354fde6))
* use valid contract IDs in setNetwork singleton test ([f885d6b](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/f885d6b77552076ac4dd009eada6a817750a3a2b))
* validate Fraction denominator to prevent silent divide-by-zero ([#143](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/143)) ([c4246e7](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/c4246e784abf6ea6f860f755bdf0127060fd01c6)), closes [#131](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/131)
* validate pair existence in getPosition() – throws PairNotFoundError ([d48ab13](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/d48ab130e7c79a0ed2fef595b4021aa7eac9aa9d))
* **webhooks:** preserve original payload bytes on retry ([#755](https://github.com/CoralSwap-Finance/coralswap-sdk/issues/755)) ([a1ab6ec](https://github.com/CoralSwap-Finance/coralswap-sdk/commit/a1ab6ec4d1f6f740571c8ac7c56bbbeafa79127c))

## [Unreleased]

### Added
- Webhook endpoint verification for the SDK webhook module:
  - `verifyWebhook(webhookId)` posts a signed challenge payload and records the result — a `2xx` marks the endpoint `verified: true`, a failed handshake (non-`2xx`, network error or timeout) marks it `verified: false`
  - `updateWebhook(webhookId, updates)` changes a registered webhook's `url`, `events` and/or `secret` with the same validation as `registerWebhook()`; changing the url resets `verified` and clears the failure counter, re-enabling a webhook that was auto-disabled
  - `listWebhooks()` now returns `Webhook[]` views carrying `verified`, `failCount` and `lastDelivery` alongside the configuration, and `getWebhook()` returns the same view; `isWebhookVerified()` and `listWebhooksForEvent()` expose the verification state and event subscription directly
  - `sendWebhook(webhookId, payload, { event })` honours the webhook's event subscription: an event the endpoint did not subscribe to is skipped without an HTTP request (`filtered: true`)
- `Webhook` and `WebhookUpdate` types for the above
- CI check requiring a CHANGELOG entry under `[Unreleased]` for PRs that change `src/`
- Input validation guards on `PortfolioModule` methods: `owner` and every `pairAddresses` entry must be a valid Stellar address (`G…` or `C…`), `fromDate`/`toDate` must be real dates that are not in the future and must satisfy `fromDate < toDate`, and `limit` must be a positive integer no greater than 1000 — every failure throws a typed `ValidationError` whose message includes the invalid value
- `MonitoringModule.getSystemMetrics(period)`: TVL, swap volume, fee revenue, and unique-user change vs. the previous equal-length window, plus top growing/declining pools. Historical figures are read through the shared `TypedEventCursor` (#478)

### Changed
- Bundle-size budget re-baselined from 200 KiB to 225 KiB: the original cap was measured before the check merged, and `main` was already 213.9 KiB when it landed, so the CI job failed on every commit. The current public surface measures 215.1 KiB (220,313 bytes) at `0d73bc2`; the cap keeps the intended ~4.5% headroom (#810)
- Liquidity module validates add/remove-liquidity and add-liquidity-quote inputs with Zod schemas via `validateWithSchema`, replacing the hand-written guards while preserving every existing rule and error message

### Fixed
- Restored source, config, and test files corrupted when #784, #785, #786, #789, #790, and #792 were merged (overwritten code, invalid `package.json` / `package-lock.json`), which left `main` unable to install, compile, or pass CI

## [1.1.0] - 2026-02-17

### Added
- Pluggable `Signer` interface in `src/types/common.ts` for wallet adapter support
- `KeypairSigner` default implementation in `src/utils/signer.ts`
- `signer` option in `CoralSwapConfig` for external wallet integration (Freighter, Albedo)
- Core SDK client with direct Soroban RPC interaction
- Factory, Pair, Router, LP Token contract bindings
- Flash Receiver interface and helpers
- Swap module with dynamic fee-aware quoting
- Liquidity module with LP position management
- Flash Loan module with fee estimation
- Fee module for dynamic fee transparency
- TWAP Oracle module for manipulation-resistant price feeds
- Typed error hierarchy (12 error classes)
- Utility modules: amounts, addresses, simulation, retry
- Test scaffolding with Jest configuration
- Full README documentation with examples


### Changed
- `CoralSwapClient` now accepts both `secretKey` and `signer` config options
- `submitTransaction()` now awaits `signer.signTransaction()` 

### Backward Compatible
- Existing `secretKey` usage continues to work unchanged

## [2.0.0] - 2026-06-29

### Added
- Full [Migration Guide](./MIGRATION.md) from v1 to v2
- Treasury, Staking, Governance, Limit Orders, DCA, Stop Loss, Positions modules
- Alerts, Webhooks, Monitoring modules
- RouterModule with multi-hop swap support
- Enhanced `simulateTransaction()` with typed return values
- `estimateOnly` option on liquidity operations
- `Signer` interface for external wallet adapters (Freighter, Albedo)
- `mapError()` utility for automatic contract error mapping
- `CircuitBreakerError`, `PriceDeviationError`, `StaleOracleError`, `SignerError` error classes
- 18 new utility functions (validation, simulation, gas, events)

### Changed
- Improved error handling with `executeWithFallback` for multi-RPC resilience
- `CoralSwapClient` constructor now supports `rpcUrl` as string array for fallback URLs
- `SwapModule.getQuote()`/`execute()` now accept `path` for multi-hop routing
- `LiquidityModule.getAddLiquidityQuote()` signature simplified (removed `amountBDesired`)

### Deprecated
- Legacy `simulateTransaction(ops, source)` string form — prefer enhanced options object
- Manual `instanceof` error chain — prefer `mapError()`
