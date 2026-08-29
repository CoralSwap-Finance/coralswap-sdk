/**
 * Strict-mode consumer fixture for the @coralswap/sdk public API.
 *
 * This file is compiled with strict: true (see smoke-test/tsconfig.strict.json)
 * to catch type-inference gaps, implicit `any`, and missing signatures before
 * the package is published.  It is NOT a runtime test — the sole purpose is to
 * make tsc fail if the exported surface has a typing regression.
 *
 * Closes #1779
 */

// ─── Core client & config ──────────────────────────────────────────────────

import {
  // Core
  CoralSwapClient,
  KeypairSigner,
  // Config
  CoralSwapConfig,
  NetworkConfig,
  NETWORK_CONFIGS,
  TESTNET_NETWORK,
  MAINNET_NETWORK,
  STAGING_NETWORK,
  DEFAULTS,
  DEFAULT_SLIPPAGE,
  PRECISION,
  // Enums
  Network,
  TradeType,
  ContractType,
  TxStatus,
  ActionType,
  // Contract clients
  FactoryClient,
  PairClient,
  RouterClient,
  LPTokenClient,
  encodeFlashLoanData,
  decodeFlashLoanData,
  calculateRepayment,
  validateFeeFloor,
  // Feature modules
  SwapModule,
  LiquidityModule,
  FlashLoanModule,
  FeeModule,
  OracleModule,
  PortfolioModule,
  RiskMetricsModule,
  TokenListModule,
  FactoryModule,
  RouterModule,
  TreasuryModule,
  AlertsModule,
  AlertModule,
  WebhookModule,
  MonitoringModule,
  StopLossModule,
  LeaderboardModule,
  HealthCheckModule,
  TaxReportingModule,
  GovernanceModule,
  DCAModule,
  LimitOrderModule,
  SquidModule,
  BlendModule,
  MIN_TWAP_WINDOW_SECONDS,
  // Utilities — amounts
  toSorobanAmount,
  fromSorobanAmount,
  formatAmount,
  formatLargeNumber,
  toBps,
  applyBps,
  percentDiff,
  safeMul,
  safeDiv,
  minBigInt,
  maxBigInt,
  parseTokenAmount,
  // Utilities — addresses
  isValidPublicKey,
  isValidContractId,
  isValidAddress,
  isNativeToken,
  getNativeAssetContractAddress,
  resolveTokenIdentifier,
  sortTokens,
  truncateAddress,
  toScAddress,
  getPairAddress,
  // Utilities — simulation
  isSimulationSuccess,
  getSimulationReturnValue,
  getResourceEstimate,
  exceedsBudget,
  decodeDiagnosticEvents,
  buildSimulationResult,
  estimateGas,
  // Utilities — retry / sleep
  withRetry,
  isRetryable,
  sleep,
  // Utilities — transaction
  getTransactionStatus,
  shouldRetrySubmission,
  // Utilities — validation
  validateAddress,
  validatePositiveAmount,
  validateNonNegativeAmount,
  validateSlippage,
  validateDistinctTokens,
  isValidPath,
  // Utilities — events
  EventParser,
  EVENT_TOPICS,
  decodeEvents,
  decodeEventsFromXdr,
  EventCursor,
  decodeEventTopic,
  MIN_START_LEDGER,
  // Utilities — batch / connection
  batchCall,
  batchCallSequential,
  batchRequest,
  batchRequestOrThrow,
  DEFAULT_BATCH_CONCURRENCY,
  ConnectionPool,
  // Schema validation
  validateWithSchema,
  OrderBookAddressSchema,
  TradeFilterSchema,
  GetOpenOrdersSchema,
  GetOrderSummarySchema,
  // Errors
  CoralSwapSDKError,
  NetworkError,
  RpcError,
  SimulationError,
  TransactionError,
  DeadlineError,
  SlippageError,
  InsufficientLiquidityError,
  PairNotFoundError,
  ValidationError,
  FlashLoanError,
  FlashLoanFailedError,
  CrossChainError,
  CircuitBreakerError,
  SignerError,
  MissingPriceFeedError,
  AddressNotFoundError,
  PortfolioCalculationError,
  WebhookError,
  WebhookDisabledError,
  mapError,
  // Transaction builder
  TransactionComposer,
} from "@coralswap/sdk";

// Re-export type-only imports to verify they are visible under strict mode
import type {
  Logger,
  OptimalPath,
  TWAPObservation,
  TWAPResult,
  TraderRanking,
  GetTopTradersOptions,
  TreasuryModuleOptions,
  LeaderboardEntry,
  LeaderboardOptions,
  RetryConfig,
  SimulationResult,
  SimulationResourceEstimate,
  WaitNextLedgerOptions,
  DecodeEventsOptions,
  SimulateFn,
  BatchRequestOptions,
  BatchResult,
  TransactionStatus,
  RetryDecision,
  EventCursorOptions,
  // Common types from @/types
  Result,
  SwapRequest,
  SwapQuote,
  SwapResult,
  SwapHistoryFilter,
  SwapHistoryEvent,
  FlashLoanRequest,
  FlashLoanResult,
  FlashLoanFeeEstimate,
  FeeEstimate,
} from "@coralswap/sdk";

// ─── Enum values are accessible ────────────────────────────────────────────

const _network: Network = Network.TESTNET;
const _tradeType: TradeType = TradeType.EXACT_IN;
const _contractType: ContractType = ContractType.FACTORY;
const _txStatus: TxStatus = TxStatus.PENDING;
const _actionType: ActionType = ActionType.PAUSE;

// ─── Config constants are typed correctly ──────────────────────────────────

const _testnet: NetworkConfig = TESTNET_NETWORK;
const _mainnet: NetworkConfig = MAINNET_NETWORK;
const _staging: NetworkConfig = STAGING_NETWORK;
const _configs: Record<Network, NetworkConfig> = NETWORK_CONFIGS;
const _defaults: typeof DEFAULTS = DEFAULTS;
const _defaultSlippage: number = DEFAULT_SLIPPAGE;
// PRECISION is a const object with PRICE_SCALE, BPS_DENOMINATOR, MIN_LIQUIDITY (all bigint)
const _priceScale: bigint = PRECISION.PRICE_SCALE;
const _bpsDenominator: bigint = PRECISION.BPS_DENOMINATOR;
const _minLiquidity: bigint = PRECISION.MIN_LIQUIDITY;

// ─── Client construction is type-safe ──────────────────────────────────────

function buildConfig(): CoralSwapConfig {
  return {
    network: Network.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    secretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  };
}

// CoralSwapClient accepts CoralSwapConfig
declare const client: CoralSwapClient;

// ─── KeypairSigner ─────────────────────────────────────────────────────────

declare const signer: KeypairSigner;
// publicKey() is async on KeypairSigner — use the sync field instead
const _signerPublicKey: string = signer.publicKeySync;

// ─── Module constructors accept CoralSwapClient ────────────────────────────

declare const swapMod: SwapModule;
declare const liqMod: LiquidityModule;
declare const flashMod: FlashLoanModule;
declare const feeMod: FeeModule;
declare const oracleMod: OracleModule;
declare const portfolioMod: PortfolioModule;
declare const riskMod: RiskMetricsModule;
declare const tokenMod: TokenListModule;
declare const factoryMod: FactoryModule;
declare const routerMod: RouterModule;
declare const treasuryMod: TreasuryModule;
declare const alertsMod: AlertsModule;
declare const alertMod: AlertModule;
declare const webhookMod: WebhookModule;
declare const monitorMod: MonitoringModule;
declare const stopLossMod: StopLossModule;
declare const leaderboardMod: LeaderboardModule;
declare const healthMod: HealthCheckModule;
declare const taxMod: TaxReportingModule;
declare const govMod: GovernanceModule;
declare const dcaMod: DCAModule;
declare const limitOrderMod: LimitOrderModule;
declare const squidMod: SquidModule;
declare const blendMod: BlendModule;

// ─── Contract clients ──────────────────────────────────────────────────────

declare const factoryClient: FactoryClient;
declare const pairClient: PairClient;
declare const routerClient: RouterClient;
declare const lpTokenClient: LPTokenClient;

// ─── Contract helpers are callable ────────────────────────────────────────

const _repayment: bigint = calculateRepayment(1000000n, 30);
const _feeValid: boolean = validateFeeFloor(30, 10);

// ─── Amount utilities return the right types ──────────────────────────────

const _amt: bigint = toSorobanAmount("1.5", 7);
const _display: string = fromSorobanAmount(15000000n, 7);
const _fmt: string = formatAmount(15000000n, 7, 2);
const _large: string = formatLargeNumber(15000000n, 7);
// toBps(numerator: bigint, denominator: bigint): number
const _bps: number = toBps(30n, 10000n);
const _applied: bigint = applyBps(1000000n, 30);
const _diff: number = percentDiff(100n, 110n);
const _mulResult: bigint = safeMul(100n, 200n);
const _divResult: bigint = safeDiv(1000n, 3n);
const _minB: bigint = minBigInt(10n, 20n);
const _maxB: bigint = maxBigInt(10n, 20n);
const _parsed: bigint = parseTokenAmount("1.5", 7);

// ─── Address utilities ─────────────────────────────────────────────────────

const _isPublicKey: boolean = isValidPublicKey("GABC...");
const _isContractId: boolean = isValidContractId("CABC...");
const _isAddress: boolean = isValidAddress("CABC...");
const _isNative: boolean = isNativeToken("XLM");
const _networkPassphrase = "Test SDF Network ; September 2015";
const _nativeAddr: string = getNativeAssetContractAddress(_networkPassphrase);
const _resolved: string = resolveTokenIdentifier("XLM", _networkPassphrase);
const [_token0, _token1]: [string, string] = sortTokens("CABC...", "CDEF...");
const _truncated: string = truncateAddress("GABC...", 6);
// getPairAddress(factoryAddress, tokenA, tokenB, networkPassphrase): string
const _pairAddr: string = getPairAddress("CFACTORY...", "CABC...", "CDEF...", _networkPassphrase);

// ─── Validation helpers ────────────────────────────────────────────────────

// These functions require a name parameter and return void (throw on failure)
validateAddress("CABC...", "tokenIn");
validatePositiveAmount(100n, "amount");
validateNonNegativeAmount(0n, "minAmount");
validateSlippage(50);
validateDistinctTokens("CABC...", "CDEF...");
const _validPath: boolean = isValidPath(["CABC...", "CDEF...", "CGHI..."]);

// ─── Retry / sleep utilities ───────────────────────────────────────────────

// RetryConfig requires backoffMultiplier and maxDelayMs
const _retryConfig: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 10000,
};
const _isRet: boolean = isRetryable(new Error("timeout"));
// sleep returns a Promise<void>
const _sleepPromise: Promise<void> = sleep(100);

// ─── Event utilities ───────────────────────────────────────────────────────

declare const _ep: EventParser;
const _topics: typeof EVENT_TOPICS = EVENT_TOPICS;
const _minLedger: number = MIN_START_LEDGER;
const _twapWindow: number = MIN_TWAP_WINDOW_SECONDS;
const _batchConcurrency: number = DEFAULT_BATCH_CONCURRENCY;

// ─── Schema validators callable ───────────────────────────────────────────

declare const _schema: typeof OrderBookAddressSchema;
declare const _tradeFilter: typeof TradeFilterSchema;
declare const _openOrders: typeof GetOpenOrdersSchema;
declare const _orderSummary: typeof GetOrderSummarySchema;

// ─── Error classes are constructable and extend correctly ──────────────────

// CoralSwapSDKError(code, message, details?)
const _sdkErr: CoralSwapSDKError = new CoralSwapSDKError("SDK_ERROR", "test");
// NetworkError(message, details?)
const _netErr: NetworkError = new NetworkError("net");
const _rpcErr: RpcError = new RpcError("rpc");
const _simErr: SimulationError = new SimulationError("sim");
// TransactionError(message, txHash?, details?, code?)
const _txErr: TransactionError = new TransactionError("tx");
// DeadlineError(deadline: number)
const _deadlineErr: DeadlineError = new DeadlineError(Date.now() + 60000);
// SlippageError(expected, actual, toleranceBps, details?)
const _slipErr: SlippageError = new SlippageError(100n, 90n, 50);
// InsufficientLiquidityError(pairAddress, details?)
const _liqErr: InsufficientLiquidityError = new InsufficientLiquidityError("CPAIR...");
// PairNotFoundError(tokenA, tokenB)
const _pairErr: PairNotFoundError = new PairNotFoundError("CABC...", "CDEF...");
const _valErr: ValidationError = new ValidationError("val");
// FlashLoanError(message, details?, txHash?)
const _flashErr: FlashLoanError = new FlashLoanError("flash");
// FlashLoanFailedError(message, txHash?, event?, details?)
const _flashFailErr: FlashLoanFailedError = new FlashLoanFailedError("flashfail");
const _crossChainErr: CrossChainError = new CrossChainError("cross");
// CircuitBreakerError(pairAddress)
const _circuitErr: CircuitBreakerError = new CircuitBreakerError("CPAIR...");
// SignerError()
const _signerErr: SignerError = new SignerError();
// MissingPriceFeedError(tokenAddress, fallbackUsed?)
const _priceFeedErr: MissingPriceFeedError = new MissingPriceFeedError("CTOKEN...");
// AddressNotFoundError(address, network)
const _addrErr: AddressNotFoundError = new AddressNotFoundError("CABC...", "testnet");
// PortfolioCalculationError(failedPool, reason)
const _portfolioErr: PortfolioCalculationError = new PortfolioCalculationError("CPAIR...", "zero reserves");
const _webhookErr: WebhookError = new WebhookError("webhook");
// WebhookDisabledError(webhookId, consecutiveFailures, details?)
const _webhookDisabledErr: WebhookDisabledError = new WebhookDisabledError("wh-1", 5);

// mapError returns CoralSwapSDKError
const _mapped: CoralSwapSDKError = mapError(new Error("something"));

// error codes are strings
const _code: string = _sdkErr.code;

// ─── TransactionComposer ───────────────────────────────────────────────────

declare const _composer: TransactionComposer;

// ─── Type-only exports are usable as type annotations ──────────────────────

declare const _logger: Logger;
declare const _optimalPath: OptimalPath;
declare const _twapObs: TWAPObservation;
declare const _twapResult: TWAPResult;
declare const _traderRanking: TraderRanking;
declare const _topTradersOpts: GetTopTradersOptions;
declare const _treasuryOpts: TreasuryModuleOptions;
declare const _lbEntry: LeaderboardEntry;
declare const _lbOptions: LeaderboardOptions;
declare const _retryConf: RetryConfig;
// SimulationResult is generic: SimulationResult<T>
declare const _simResult: SimulationResult<boolean>;
declare const _simResource: SimulationResourceEstimate;
declare const _waitNextLedger: WaitNextLedgerOptions;
declare const _decodeEventsOpts: DecodeEventsOptions;
declare const _simulateFn: SimulateFn;
// BatchRequestOptions is NOT generic
declare const _batchReqOpts: BatchRequestOptions;
// BatchResult<T> is a union type
declare const _batchRes: BatchResult<string>;
declare const _txStatus2: TransactionStatus;
declare const _retryDecision: RetryDecision;
declare const _ecOptions: EventCursorOptions;
declare const _resultWrapper: Result<string>;
declare const _swapReq: SwapRequest;
declare const _swapQuote: SwapQuote;
declare const _swapResult: SwapResult;
declare const _swapFilter: SwapHistoryFilter;
declare const _swapEvent: SwapHistoryEvent;
declare const _flashReq: FlashLoanRequest;
declare const _flashResult: FlashLoanResult;
declare const _flashFeeEst: FlashLoanFeeEstimate;
declare const _feeEst: FeeEstimate;

// ─── No implicit any — explicit use of generic APIs ───────────────────────

async function exerciseWithRetry(): Promise<string> {
  // withRetry<T>(fn, options, logger?, label?): Promise<T>
  const result: string = await withRetry<string>(async () => "ok", _retryConfig);
  return result;
}

async function exerciseBatchCall(): Promise<BatchResult<number>[]> {
  const tasks: Array<() => Promise<number>> = [
    async () => 1,
    async () => 2,
  ];
  // batchCall<T>(calls, options?): Promise<BatchResult<T>[]>
  const results: BatchResult<number>[] = await batchCall<number>(tasks);
  return results;
}

async function exerciseBatchCallSequential(): Promise<BatchResult<number>[]> {
  const tasks: Array<() => Promise<number>> = [async () => 1, async () => 2];
  // batchCallSequential<T>(calls, delayMs?): Promise<BatchResult<T>[]>
  return batchCallSequential<number>(tasks, 0);
}

async function exerciseBatchRequest(): Promise<BatchResult<string>[]> {
  const tasks: Array<() => Promise<string>> = [async () => "a"];
  return batchRequest<string>(tasks, { concurrency: 2 });
}

async function exerciseBatchRequestOrThrow(): Promise<string[]> {
  const tasks: Array<() => Promise<string>> = [async () => "a"];
  return batchRequestOrThrow<string>(tasks);
}

// Suppress unused variable warnings for declaration-only identifiers
void _network; void _tradeType; void _contractType; void _txStatus; void _actionType;
void _testnet; void _mainnet; void _staging; void _configs; void _defaults;
void _defaultSlippage; void _priceScale; void _bpsDenominator; void _minLiquidity;
void buildConfig;
void _signerPublicKey;
void swapMod; void liqMod; void flashMod; void feeMod; void oracleMod;
void portfolioMod; void riskMod; void tokenMod; void factoryMod; void routerMod;
void treasuryMod; void alertsMod; void alertMod; void webhookMod; void monitorMod;
void stopLossMod; void leaderboardMod; void healthMod; void taxMod; void govMod;
void dcaMod; void limitOrderMod; void squidMod; void blendMod;
void factoryClient; void pairClient; void routerClient; void lpTokenClient;
void _repayment; void _feeValid;
void _amt; void _display; void _fmt; void _large; void _bps; void _applied;
void _diff; void _mulResult; void _divResult; void _minB; void _maxB; void _parsed;
void _isPublicKey; void _isContractId; void _isAddress; void _isNative;
void _nativeAddr; void _resolved; void _token0; void _token1;
void _truncated; void _pairAddr;
void _validPath; void _isRet; void _sleepPromise;
void _topics; void _minLedger; void _twapWindow; void _batchConcurrency;
void _schema; void _tradeFilter; void _openOrders; void _orderSummary;
void _sdkErr; void _netErr; void _rpcErr; void _simErr; void _txErr;
void _deadlineErr; void _slipErr; void _liqErr; void _pairErr; void _valErr;
void _flashErr; void _flashFailErr; void _crossChainErr; void _circuitErr;
void _signerErr; void _priceFeedErr; void _addrErr; void _portfolioErr;
void _webhookErr; void _webhookDisabledErr; void _mapped; void _code;
void _composer; void client; void signer;
void exerciseWithRetry; void exerciseBatchCall; void exerciseBatchCallSequential;
void exerciseBatchRequest; void exerciseBatchRequestOrThrow;
void encodeFlashLoanData; void decodeFlashLoanData;
void validateWithSchema; void decodeDiagnosticEvents; void buildSimulationResult;
void estimateGas; void getTransactionStatus; void shouldRetrySubmission;
void decodeEvents; void decodeEventsFromXdr; void decodeEventTopic;
void isSimulationSuccess; void getSimulationReturnValue; void getResourceEstimate;
void exceedsBudget; void toScAddress;
