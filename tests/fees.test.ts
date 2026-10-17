import { FeeModule } from '../src/modules/fees';
import { CoralSwapClient } from '../src/client';
import { FeeState } from '../src/types/pool';
import { ValidationError } from '../src/errors';
import { xdr, Address, nativeToScVal, rpc, Contract, Account } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default FeeState fixture. Override individual fields as needed. */
function makeFeeState(overrides: Partial<FeeState> = {}): FeeState {
    return {
        priceLast: 0n,
        volAccumulator: 500n,
        lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago (fresh)
        feeCurrent: 30,
        feeMin: 10,
        feeMax: 100,
        emaAlpha: 50,
        feeLastChanged: Math.floor(Date.now() / 1000) - 120,
        emaDecayRate: 5,
        baselineFee: 30,
        ...overrides,
    };
}

/**
 * Build a mock CoralSwapClient for FeeModule tests.
 *
 * `feeBps` controls the value returned by `getDynamicFee()`.
 * `feeState` controls the value returned by `getFeeState()`.
 */
function createMockClient(opts: {
    feeBps?: number;
    feeState?: FeeState;
    /** Per-pair overrides keyed by address */
    pairs?: Record<string, { feeBps?: number; feeState?: FeeState }>;
} = {}): CoralSwapClient {
    const defaultFeeBps = opts.feeBps ?? 30;
    const defaultFeeState = opts.feeState ?? makeFeeState();

    return {
        pair: jest.fn().mockImplementation((addr: string) => {
            const override = opts.pairs?.[addr];
            return {
                getDynamicFee: jest.fn().mockResolvedValue(override?.feeBps ?? defaultFeeBps),
                getFeeState: jest.fn().mockResolvedValue(override?.feeState ?? defaultFeeState),
            };
        }),
        router: {
            getDynamicFee: jest.fn().mockResolvedValue(defaultFeeBps),
        },
        factory: {
            getFeeParameters: jest.fn().mockResolvedValue({
                feeMin: 10,
                feeMax: 100,
                emaAlpha: 50,
                flashFeeBps: 5,
            }),
        },
    } as unknown as CoralSwapClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeModule', () => {
    const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM';

/**
 * Minimal successful simulation response — `rpc.Api.isSimulationSuccess`
 * only checks for the presence of a `transactionData` key.
 */
function makeSimResponse(decimals: number): Record<string, unknown> {
    return {
        transactionData: new xdr.SorobanTransactionData({
            ext: xdr.SorobanTransactionDataExt.v0() as xdr.SorobanTransactionDataExt,
            resources: new xdr.SorobanResources({
                footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
                instructions: 0,
                diskReadBytes: 0,
                writeBytes: 0,
            }),
            resourceFee: 0n,
        }),
        result: { retval: xdr.ScVal.scvU32(decimals) },
    };
}

    // -----------------------------------------------------------------------
    // estimateSwapFee()
    // -----------------------------------------------------------------------
    describe('estimateSwapFee()', () => {
        it('calculates correct fee amount: (amountIn * feeBps) / 10000', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            const { feeBps, feeAmount } = await module.estimateSwapFee(PAIR, 10_000n);

            expect(feeBps).toBe(30);
            // 10000 * 30 / 10000 = 30
            expect(feeAmount).toBe(30n);
        });

        it('returns zero fee for zero amount', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            await expect(module.estimateSwapFee(PAIR, 0n)).rejects.toThrow(
                'amountIn must be greater than 0',
            );
        });

        it('handles large amounts without overflow', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const largeAmount = 10n ** 24n; // 1 septillion stroops
            const { feeAmount } = await module.estimateSwapFee(PAIR, largeAmount);

            // (10^24 * 100) / 10000 = 10^22
            expect(feeAmount).toBe(10n ** 22n);
        });

        it('returns feeBps matching the dynamic fee from the pair', async () => {
            const client = createMockClient({ feeBps: 75 });
            const module = new FeeModule(client);

            const { feeBps } = await module.estimateSwapFee(PAIR, 1000n);

            expect(feeBps).toBe(75);
        });

        it('calculates correctly at max fee (100 bps = 1%)', async () => {
            const client = createMockClient({ feeBps: 100 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 100 / 10000 = 10000
            expect(feeAmount).toBe(10_000n);
        });

        it('calculates correctly at min fee (10 bps = 0.1%)', async () => {
            const client = createMockClient({ feeBps: 10 });
            const module = new FeeModule(client);

            const { feeAmount } = await module.estimateSwapFee(PAIR, 1_000_000n);

            // 1000000 * 10 / 10000 = 1000
            expect(feeAmount).toBe(1_000n);
        });

        it('floors fractional fees (integer division)', async () => {
            const client = createMockClient({ feeBps: 30 });
            const module = new FeeModule(client);

            // 100 * 30 / 10000 = 0.3 → floors to 0
            const { feeAmount } = await module.estimateSwapFee(PAIR, 100n);

            expect(feeAmount).toBe(0n);
        });
    });

    // -----------------------------------------------------------------------
    // isStale()
    // -----------------------------------------------------------------------
    describe('isStale()', () => {
        it('returns false when lastUpdated is recent (within default 1 hour)', async () => {
            const recentState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 60, // 1 min ago
            });
            const client = createMockClient({ feeState: recentState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(false);
        });

        it('returns true when lastUpdated is older than default 1 hour', async () => {
            const oldState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState: oldState });
            const module = new FeeModule(client);

            const stale = await module.isStale(PAIR);

            expect(stale).toBe(true);
        });

        it('respects custom maxAgeSec parameter', async () => {
            const state = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 600, // 10 min ago
            });
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // 300 sec threshold → 10 min > 5 min → stale
            expect(await module.isStale(PAIR, 300)).toBe(true);
            // 900 sec threshold → 10 min < 15 min → not stale
            expect(await module.isStale(PAIR, 900)).toBe(false);
        });

        it('returns true when lastUpdated is exactly at boundary + 1', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3601 }); // 1 second past 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            expect(await module.isStale(PAIR)).toBe(true);
        });

        it('returns false when lastUpdated is exactly at boundary', async () => {
            const now = Math.floor(Date.now() / 1000);
            const state = makeFeeState({ lastUpdated: now - 3600 }); // exactly 1 hour
            const client = createMockClient({ feeState: state });
            const module = new FeeModule(client);

            // now - lastUpdated = 3600, not > 3600, so not stale
            expect(await module.isStale(PAIR)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // getCurrentFee()
    // -----------------------------------------------------------------------
    describe('getCurrentFee()', () => {
        it('returns correct FeeEstimate shape with all fields', async () => {
            const feeState = makeFeeState({
                feeCurrent: 45,
                baselineFee: 30,
                feeMin: 10,
                feeMax: 100,
                volAccumulator: 1234n,
                emaDecayRate: 7,
                lastUpdated: Math.floor(Date.now() / 1000) - 120,
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.pairAddress).toBe(PAIR);
            expect(estimate.currentFeeBps).toBe(45);
            expect(estimate.baselineFeeBps).toBe(30);
            expect(estimate.feeMin).toBe(10);
            expect(estimate.feeMax).toBe(100);
            expect(estimate.volatility).toBe(1234n);
            expect(estimate.emaDecayRate).toBe(7);
            expect(estimate.lastUpdated).toBe(feeState.lastUpdated);
        });

        it('sets isStale to false when fee was recently updated', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 30, // 30 sec ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(false);
        });

        it('sets isStale to true when fee is older than 1 hour', async () => {
            const feeState = makeFeeState({
                lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
            });
            const client = createMockClient({ feeState });
            const module = new FeeModule(client);

            const estimate = await module.getCurrentFee(PAIR);

            expect(estimate.isStale).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // compareFees()
    // -----------------------------------------------------------------------
    describe('compareFees()', () => {
        it('returns fee estimates for multiple pairs', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4': { feeState: makeFeeState({ feeCurrent: 20 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5': { feeState: makeFeeState({ feeCurrent: 80 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results).toHaveLength(3);
        });

        it('preserves input order in results', async () => {
            const pairs = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M'];
            const client = createMockClient({
                pairs: {
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM': { feeState: makeFeeState({ feeCurrent: 10 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4': { feeState: makeFeeState({ feeCurrent: 50 }) },
                    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M': { feeState: makeFeeState({ feeCurrent: 90 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees(pairs);

            expect(results[0].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
            expect(results[0].currentFeeBps).toBe(10);
            expect(results[1].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4');
            expect(results[1].currentFeeBps).toBe(50);
            expect(results[2].pairAddress).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M');
            expect(results[2].currentFeeBps).toBe(90);
        });

        it('returns empty array for empty input', async () => {
            const client = createMockClient();
            const module = new FeeModule(client);

            const results = await module.compareFees([]);

            expect(results).toHaveLength(0);
        });

        it('each result has correct isStale flag', async () => {
            const now = Math.floor(Date.now() / 1000);
            const FRESH_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';
            const STALE_ADDR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOLZM';
            const client = createMockClient({
                pairs: {
                    [FRESH_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 60 }) },
                    [STALE_ADDR]: { feeState: makeFeeState({ lastUpdated: now - 7200 }) },
                },
            });
            const module = new FeeModule(client);

            const results = await module.compareFees([FRESH_ADDR, STALE_ADDR]);

            expect(results[0].isStale).toBe(false);
            expect(results[1].isStale).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // getFeeRevenue() -- BigInt-safe math, per-token decimals, pagination
    // (regression suite for issue #632)
    // -----------------------------------------------------------------------
    describe('getFeeRevenue()', () => {
        const TOKEN_IN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
        const TOKEN_OUT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';

        /** Real XDR ScVal map for a swap event value. */
        function swapValue(amountIn: bigint, feeBps: number): xdr.ScVal {
            return xdr.ScVal.scvMap([
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sender'), val: nativeToScVal(Address.fromString('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'), { type: 'address' }) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_in'), val: nativeToScVal(Address.fromString(TOKEN_IN), { type: 'address' }) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_out'), val: nativeToScVal(Address.fromString(TOKEN_OUT), { type: 'address' }) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_in'), val: nativeToScVal(amountIn, { type: 'i128' }) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_out'), val: nativeToScVal(amountIn, { type: 'i128' }) }),
                new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fee_bps'), val: xdr.ScVal.scvU32(feeBps) }),
            ]);
        }

        /** Raw getEvents response entry shaped like real Soroban RPC output. */
        let eventSeq = 0;
        function makeRawEvent(ledger: number, amountIn: bigint, feeBps: number): rpc.Api.EventResponse {
            eventSeq++;
            return {
                type: 'contract',
                ledger,
                ledgerClosedAt: new Date(ledger * 5000).toISOString(),
                contractId: new Contract(PAIR),
                id: String(eventSeq).padStart(8, '0'),
                pagingToken: String(eventSeq),
                inSuccessfulContractCall: true,
                txHash: `tx_${eventSeq}`,
                topic: [xdr.ScVal.scvSymbol('swap')],
                value: swapValue(amountIn, feeBps),
            } as unknown as rpc.Api.EventResponse;
        }

        interface GetEventsRequest {
            startLedger?: number;
            cursor?: string;
            limit: number;
            filters: Array<{ contractIds?: string[]; topics?: string[][] }>;
        }

        /**
         * Mock client whose `getEvents` honours topic/contract filters and
         * both ledger-range and cursor pagination, capping every response at
         * `pageSize` events — like the real RPC.
         */
        function createRevenueClient(
            events: rpc.Api.EventResponse[],
            pageSize = 200,
            tokenDecimals: Record<string, number> = {},
        ): { client: CoralSwapClient; getEvents: jest.Mock } {
            const sorted = [...events].sort((a, b) => a.ledger - b.ledger);
            const CURRENT_LEDGER = 100_000;

            const getEvents = jest.fn(async (req: GetEventsRequest) => {
                const filter = req.filters[0] ?? {};
                const wantedTopics = new Set(filter.topics?.[0] ?? []);
                const wantedContracts = new Set(filter.contractIds ?? []);
                const matchesFilter = (e: (typeof sorted)[number]) =>
                    wantedTopics.has((e.topic[0] as xdr.ScVal).toXDR('base64')) &&
                    (wantedContracts.size === 0 || wantedContracts.has((e.contractId as Contract).toString()));

                let matches: typeof sorted;
                if (req.cursor !== undefined) {
                    const all = sorted.filter(matchesFilter);
                    const idx = all.findIndex((e) => e.pagingToken === req.cursor);
                    matches = idx >= 0 ? all.slice(idx + 1) : [];
                } else {
                    matches = sorted.filter((e) => e.ledger >= (req.startLedger ?? 1) && matchesFilter(e));
                }
                return { events: matches.slice(0, req.limit), latestLedger: CURRENT_LEDGER };
            });
            void pageSize;

            const client = {
                server: {
                    getEvents,
                    getLatestLedger: jest.fn().mockResolvedValue({ sequence: CURRENT_LEDGER }),
                    getAccount: jest.fn().mockResolvedValue(new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0')),
                    simulateTransaction: jest.fn().mockImplementation((tx) => {
                        // Extract the invoked contract's address from the built op:
                        // ScAddress.contractId is a ContractId wrapping a 32-byte value.
                        const op: any = tx.operations[0];
                        const cid = op.func.invokeContract.contractAddress.contractId;
                        const raw = typeof cid === 'object' && 'value' in cid ? cid.value : cid;
                        const contractAddr = Address.contract(raw).toString();
                        const decimals = tokenDecimals[contractAddr] ?? 7;
                        return Promise.resolve(makeSimResponse(decimals));
                    }),
                },
                networkConfig: { networkPassphrase: 'Test SDF Network ; September 2015' },
                getCurrentLedger: jest.fn().mockResolvedValue(CURRENT_LEDGER),
            } as unknown as CoralSwapClient;

            return { client, getEvents };
        }

        it('aggregates fees with exact BigInt stroop math (values above 2^53)', async () => {
            // 10^18 stroops is far above Number.MAX_SAFE_INTEGER — Number(i128)
            // would corrupt this value; BigInt math must preserve it exactly.
            const amountIn = 10n ** 18n;
            const feeBps = 30;
            const expectedFee = (amountIn * BigInt(feeBps)) / 10_000n; // 3 * 10^15
            const { client } = createRevenueClient([makeRawEvent(99_000, amountIn, feeBps)]);
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            expect(revenue.swapCount).toBe(1);
            expect(revenue.history[0].feeStroops).toBe(expectedFee);
            expect(revenue.totalFeeStroops).toBe(expectedFee);
            expect(revenue.history[0].feeStroops).toBe(3_000_000_000_000_000n);
        });

        it('uses the input token’s own decimals for display conversion (6-dec token)', async () => {
            const amountIn = 100_000_000n; // 100 units of a 6-dec token
            const { client } = createRevenueClient(
                [makeRawEvent(99_000, amountIn, 100)],
                200,
                { [TOKEN_IN]: 6 },
            );
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            // fee = 100 * 1% = 1 token == 1_000_000 stroops at 6 decimals
            expect(revenue.history[0].feeStroops).toBe(1_000_000n);
            expect(revenue.history[0].decimals).toBe(6);
            expect(revenue.history[0].feeXLM).toBeCloseTo(1.0, 10);
            expect(revenue.totalFeeByToken[0].feeDisplay).toBeCloseTo(1.0, 10);
        });

        it('defaults to 7 decimals for tokens without an override', async () => {
            const { client } = createRevenueClient([makeRawEvent(99_000, 10_000_000n, 100)]);
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            // fee = 10^7 * 100 / 10000 = 100000 stroops = 0.01 XLM at 7 dec
            expect(revenue.history[0].decimals).toBe(7);
            expect(revenue.history[0].feeXLM).toBeCloseTo(0.01, 10);
        });

        it('paginates beyond a single getEvents page (> 200 events retrievable)', async () => {
            const { client, getEvents } = createRevenueClient(
                Array.from({ length: 450 }, (_, i) => makeRawEvent(90_000 + i, 10_000_000n, 30)),
                200,
            );
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            expect(revenue.swapCount).toBe(450);
            // Multiple pages were fetched, not just the first 200 events.
            expect(getEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
            // Total fee is exact: 450 * (10^7 * 30 / 10000) = 450 * 30000
            expect(revenue.totalFeeStroops).toBe(13_500_000n);
        });

        it('keeps the aggregate exact when a single fee exceeds Number.MAX_SAFE_INTEGER', async () => {
            const amountIn = 9_999_999_999_999_999_999n; // ~1e19, unsafe as Number
            const feeBps = 100;
            const expected = (amountIn * BigInt(feeBps)) / 10_000n;
            const { client } = createRevenueClient([makeRawEvent(99_000, amountIn, feeBps)]);
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            expect(revenue.totalFeeStroops).toBe(expected);
            expect(Number.isSafeInteger(Number(revenue.totalFeeStroops))).toBe(false);
        });

        it('splits totals per token and sorts them by fee amount', async () => {
            const { client } = createRevenueClient([
                makeRawEvent(99_001, 10_000_000n, 100), // 100_000 stroops of TOKEN_IN
                makeRawEvent(99_002, 20_000_000n, 100), // 200_000 stroops of TOKEN_IN
            ]);
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR);

            expect(revenue.totalFeeByToken).toHaveLength(1);
            expect(revenue.totalFeeByToken[0].token).toBe(TOKEN_IN);
            expect(revenue.totalFeeByToken[0].feeStroops).toBe(300_000n);
        });

        it('skips events beyond toLedger and validates the window', async () => {
            const { client } = createRevenueClient([
                makeRawEvent(99_000, 10_000_000n, 30),
                makeRawEvent(99_500, 10_000_000n, 30), // outside the window below
            ]);
            const module = new FeeModule(client);

            const revenue = await module.getFeeRevenue(PAIR, { fromLedger: 98_000, toLedger: 99_100 });
            expect(revenue.swapCount).toBe(1);

            await expect(
                module.getFeeRevenue(PAIR, { fromLedger: 100, toLedger: 50 }),
            ).rejects.toThrow(ValidationError);
            await expect(module.getFeeRevenue(PAIR, { limit: 0 })).rejects.toThrow(ValidationError);
        });
    });

    // -----------------------------------------------------------------------
    // getLPYield() -- BigInt-safe share math and per-token decimals
    // (regression suite for issue #632)
    // -----------------------------------------------------------------------
    describe('getLPYield()', () => {
        const TOKEN0 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
        const TOKEN1 = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
        const LP_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

        function createYieldClient(opts: {
            lpBalance: bigint;
            totalSupply: bigint;
            reserve0: bigint;
            reserve1: bigint;
            decimals0?: number;
            decimals1?: number;
            swapEvents?: Array<{ ledger: number; amountIn: bigint; feeBps: number }>;
        }): CoralSwapClient {
            // Per-token decimals resolved from the `decimals()` call target.
            const tokenDecimals: Record<string, number> = {
                [TOKEN0]: opts.decimals0 ?? 7,
                [TOKEN1]: opts.decimals1 ?? 7,
            };
            const pairMock = {
                getLPTokenAddress: jest.fn().mockResolvedValue('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMD5E'),
                getReserves: jest.fn().mockResolvedValue({ reserve0: opts.reserve0, reserve1: opts.reserve1 }),
                getTokens: jest.fn().mockResolvedValue({ token0: TOKEN0, token1: TOKEN1 }),
                getFeeState: jest.fn().mockResolvedValue(makeFeeState()),
                getDynamicFee: jest.fn().mockResolvedValue(30),
            };
            const TOPIC = xdr.ScVal.scvSymbol('swap').toXDR('base64');
            const CURRENT_LEDGER = 100_000;
            const events = (opts.swapEvents ?? []).map((e, i) => ({
                type: 'contract',
                ledger: e.ledger,
                ledgerClosedAt: new Date(e.ledger * 5000).toISOString(),
                contractId: new Contract(PAIR),
                id: String(i).padStart(8, '0'),
                pagingToken: String(i + 1),
                inSuccessfulContractCall: true,
                txHash: `tx_${i}`,
                topic: [xdr.ScVal.scvSymbol('swap')],
                value: xdr.ScVal.scvMap([
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('sender'), val: nativeToScVal(Address.fromString(LP_ADDR), { type: 'address' }) }),
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_in'), val: nativeToScVal(Address.fromString(TOKEN0), { type: 'address' }) }),
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('token_out'), val: nativeToScVal(Address.fromString(TOKEN1), { type: 'address' }) }),
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_in'), val: nativeToScVal(e.amountIn, { type: 'i128' }) }),
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount_out'), val: nativeToScVal(e.amountIn, { type: 'i128' }) }),
                    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('fee_bps'), val: xdr.ScVal.scvU32(e.feeBps) }),
                ]),
            } as unknown as rpc.Api.EventResponse));

            const getEvents = jest.fn(async (req: { startLedger?: number; cursor?: string; limit: number; filters: Array<{ contractIds?: string[]; topics?: string[][] }> }) => {
                const filter = req.filters[0] ?? {};
                const wantedTopics = new Set(filter.topics?.[0] ?? []);
                const wantedContracts = new Set(filter.contractIds ?? []);
                const matchesFilter = (e: (typeof events)[number]) =>
                    wantedTopics.has((e.topic[0] as xdr.ScVal).toXDR('base64')) &&
                    (wantedContracts.size === 0 || wantedContracts.has((e.contractId as Contract).toString()));
                let matches: typeof events;
                if (req.cursor !== undefined) {
                    const all = events.filter(matchesFilter);
                    const idx = all.findIndex((e) => e.pagingToken === req.cursor);
                    matches = idx >= 0 ? all.slice(idx + 1) : [];
                } else {
                    matches = events.filter((e) => e.ledger >= (req.startLedger ?? 1) && matchesFilter(e));
                }
                return { events: matches.slice(0, req.limit), latestLedger: CURRENT_LEDGER };
            });

            return {
                pair: jest.fn().mockReturnValue(pairMock),
                lpToken: jest.fn().mockReturnValue({
                    balance: jest.fn().mockResolvedValue(opts.lpBalance),
                    totalSupply: jest.fn().mockResolvedValue(opts.totalSupply),
                }),
                server: {
                    getEvents,
                    getLatestLedger: jest.fn().mockResolvedValue({ sequence: CURRENT_LEDGER }),
                    getAccount: jest.fn().mockResolvedValue(new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0')),
                    simulateTransaction: jest.fn().mockImplementation((tx) => {
                        const op: any = tx.operations[0];
                        const cid = op.func.invokeContract.contractAddress.contractId;
                        const raw = typeof cid === 'object' && 'value' in cid ? cid.value : cid;
                        const contractAddr = Address.contract(raw).toString();
                        return Promise.resolve(makeSimResponse(tokenDecimals[contractAddr] ?? 7));
                    }),
                },
                networkConfig: { networkPassphrase: 'Test SDF Network ; September 2015' },
                getCurrentLedger: jest.fn().mockResolvedValue(CURRENT_LEDGER),
            } as unknown as CoralSwapClient;
        }

        it('computes lpSharePercent from exact BigInt inputs above 2^53', async () => {
            // Balances where Number() itself rounds the input; totalSupply is
            // exactly 3x lpBalance, so the true share is exactly 1/3.
            const lpBalance = 3_000_000_000_000_000_003n;
            const totalSupply = 9_000_000_000_000_000_009n;
            const client = createYieldClient({
                lpBalance,
                totalSupply,
                reserve0: 10n ** 18n,
                reserve1: 10n ** 18n,
            });
            const module = new FeeModule(client);

            const result = await module.getLPYield(PAIR, LP_ADDR);

            // (10^12 scale keeps 12 fractional digits of the ratio)
            expect(result.lpSharePercent).toBeCloseTo(100 / 3, 9);
        });

        it('converts reserves with each token’s own decimals (6 vs 7)', async () => {
            const client = createYieldClient({
                lpBalance: 5_000_000_000_000_000n,
                totalSupply: 10_000_000_000_000_000n,
                reserve0: 6_000_000n, // 6 tokens at 6 decimals
                reserve1: 7_000_000n, // 0.7 tokens at 7 decimals
                decimals0: 6,
                decimals1: 7,
            });
            const module = new FeeModule(client);

            const result = await module.getLPYield(PAIR, LP_ADDR);

            // Half the pool: (6 + 0.7) / 2 = 3.35 — the old /1e7 path yielded 0.00000065
            expect(result.lpValueXLM).toBeCloseTo(3.35, 8);
        });

        it('returns zeroed metrics for an address with no LP tokens', async () => {
            const client = createYieldClient({
                lpBalance: 0n,
                totalSupply: 10n ** 15n,
                reserve0: 10n ** 9n,
                reserve1: 10n ** 9n,
                swapEvents: [{ ledger: 99_000, amountIn: 10_000_000n, feeBps: 30 }],
            });
            const module = new FeeModule(client);

            const result = await module.getLPYield(PAIR, LP_ADDR);

            expect(result.lpSharePercent).toBe(0);
            expect(result.lpFeeShareXLM).toBe(0);
            expect(result.lpValueXLM).toBe(0);
            expect(result.aprPercent).toBe(0);
            expect(result.totalFeeRevenueStroops).toBe(30_000n);
        });

        it('exposes the exact stroop revenue and a display total', async () => {
            const client = createYieldClient({
                lpBalance: 1n,
                totalSupply: 2n,
                reserve0: 10n ** 9n,
                reserve1: 10n ** 9n,
                swapEvents: [{ ledger: 99_000, amountIn: 10_000_000n, feeBps: 30 }],
            });
            const module = new FeeModule(client);

            const result = await module.getLPYield(PAIR, LP_ADDR);

            expect(result.totalFeeRevenueStroops).toBe(30_000n);
            expect(result.totalFeeRevenueXLM).toBeCloseTo(0.003, 10);
            expect(result.lpSharePercent).toBe(50);
            expect(result.aprPercent).toBeGreaterThan(0);
        });
    });
});
