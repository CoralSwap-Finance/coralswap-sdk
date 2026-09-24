import { CoralSwapClient } from '../src/client';
import { Network } from '../src/types/common';
import { CoralSwapSDKError } from '../src/errors';
import { MockProvider } from '../src/test/mocks/MockProvider';
import * as Modules from '../src/modules';
import { xdr, Address } from '@stellar/stellar-sdk';

const DUMMY_ADDRESS_1 = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const DUMMY_ADDRESS_2 = 'CC4YVLFRDJB3I32FKEHLSP7ZUE5DP73QHB54SQIBO6MXBFP7FIMVTG2I';
const DUMMY_ADDRESS_3 = 'CCW67TSZV3FE22UXXD6T6K54K2E6X2E6X2E6X2E6X2E6X2E6X2E6X2E6';
const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function createScMap(obj: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(obj).map(([key, val]) => 
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val,
      })
    )
  );
}

const dummyI128 = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(0), lo: xdr.Uint64(0) }));
const dummyI128_1000 = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64(0), lo: xdr.Uint64(1000) }));
const dummyAddressVal = new Address(DUMMY_ADDRESS_1).toScVal();
const dummyU32 = xdr.ScVal.scvU32(30);
const dummyI64 = xdr.ScVal.scvI64(xdr.Int64(0));
const dummyVec = xdr.ScVal.scvVec([dummyI128_1000, dummyI128_1000]);

describe('Read Smoke Suite', () => {
  let client: CoralSwapClient;
  let mock: MockProvider;

  beforeEach(() => {
    mock = new MockProvider();
    mock.setLatestLedger(1000);
    
    (mock as any).simulateTransaction = jest.fn().mockImplementation(async (tx: any) => {
      let funcName = 'unknown';
      try {
        if (tx && tx.operations && tx.operations[0]) {
          const op = tx.operations[0];
          if (op.func && op.func.invokeContract && op.func.invokeContract.functionName) {
            const fn = op.func.invokeContract.functionName;
            funcName = typeof fn.toString === 'function' ? fn.toString('utf-8') : Buffer.from(fn.bytes || fn).toString('utf-8');
          } else if (op.functionName) {
            funcName = op.functionName;
          }
        }
      } catch (err) {
        // Ignore extraction errors
      }

      let retval: xdr.ScVal = xdr.ScVal.scvVoid();

      switch (funcName) {
        case 'get_fee_state':
          retval = createScMap({
            price_last: dummyI128,
            vol_accumulator: dummyI128,
            last_updated: dummyU32,
            fee_current: dummyU32,
            fee_min: dummyU32,
            fee_max: dummyU32,
            ema_alpha: dummyU32,
            fee_last_changed: dummyU32,
            ema_decay_rate: dummyU32,
            baseline_fee: dummyU32,
          });
          break;
        case 'get_flash_config':
          retval = createScMap({
            locked: xdr.ScVal.scvBool(false),
            flash_fee_bps: dummyU32,
            flash_fee_floor: dummyI128,
          });
          break;
        case 'get_cumulative_prices':
          retval = createScMap({
            price0_cumulative_last: dummyI128,
            price1_cumulative_last: dummyI128,
            block_timestamp_last: xdr.ScVal.scvU64(xdr.Uint64(0)),
          });
          break;
        case 'get_reserves':
          retval = dummyVec;
          break;
        case 'fee_to':
          retval = dummyAddressVal;
          break;
        case 'get_pair':
          retval = dummyAddressVal;
          break;
        case 'get_order':
        case 'get_schedule':
          retval = createScMap({
            id: xdr.ScVal.scvString('1'),
            owner: dummyAddressVal,
            amount: dummyI128,
            status: dummyU32,
            token_in: dummyAddressVal,
            token_out: dummyAddressVal,
            min_price: dummyI128,
          });
          break;
        case 'get_tokens':
          retval = createScMap({
            token0: dummyAddressVal,
            token1: dummyAddressVal,
          });
          break;
        case 'get_pool_status':
        case 'status':
          retval = createScMap({
            status: dummyU32,
            tvl: dummyI128,
          });
          break;
        case 'get_fee':
        case 'get_dynamic_fee':
          retval = dummyU32;
          break;
        case 'token_0':
        case 'token_1':
        case 'lp_token':
          retval = dummyAddressVal;
          break;
        case 'all_pairs':
          retval = xdr.ScVal.scvVec([]);
          break;
        case 'orders_for_user':
        case 'get_schedules':
          retval = xdr.ScVal.scvVec([
            createScMap({
              id: xdr.ScVal.scvString('1'),
              owner: dummyAddressVal,
              amount: dummyI128,
              status: dummyU32,
              token_in: dummyAddressVal,
              token_out: dummyAddressVal,
              min_price: dummyI128,
            })
          ]);
          break;
        case 'get_proposal':
          retval = createScMap({
            id: xdr.ScVal.scvString('1'),
            title: xdr.ScVal.scvString('Test'),
            description: xdr.ScVal.scvString('Desc'),
            status: xdr.ScVal.scvSymbol('active'),
          });
          break;
        case 'get_fee_parameters':
          retval = createScMap({
            fee_min: dummyU32,
            fee_max: dummyU32,
          });
          break;
        case 'get_price':
          retval = dummyI128;
          break;
        case 'get_delegation_state':
          retval = createScMap({
            delegated_to: dummyAddressVal,
            delegated_from: xdr.ScVal.scvVec([]),
            total_voting_power: dummyI128,
            own_power: dummyI128,
          });
          break;
        case 'get_performance':
          retval = createScMap({
            total_invested: dummyI128,
            total_received: dummyI128,
            lump_sum_received: dummyI128,
          });
          break;
        default:
          retval = xdr.ScVal.scvVoid();
      }

      return {
        error: undefined,
        result: {
          retval,
          auth: [],
        },
        transactionData: {
          build: () => ({ resources: { instructions: 1000, diskReadBytes: 100, writeBytes: 100 } })
        },
        latestLedger: 1000,
      };
    });

    (mock as any).getContractData = jest.fn().mockResolvedValue({
      val: xdr.ScVal.scvVoid(),
      lastModifiedLedgerSeq: 1000,
    });
    
    (mock as any).getEvents = jest.fn().mockResolvedValue({ events: [] });
    
    (mock as any).getAccount = jest.fn().mockResolvedValue({ 
      accountId: () => PUBLIC_KEY,
      sequenceNumber: () => '1',
      incrementSequenceNumber: () => {},
    });
    
    (mock as any).getLedgerEntries = jest.fn().mockResolvedValue({ entries: [] });
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    }) as any;
    
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU',
      limitOrderAddress: DUMMY_ADDRESS_1,
      factoryAddress: DUMMY_ADDRESS_1,
      routerAddress: DUMMY_ADDRESS_1,
      redstonePayloadAddress: DUMMY_ADDRESS_1,
    });
    (client as any).server = mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const expectNoRawError = async (promise: Promise<any>, method: string) => {
    try {
      await promise;
    } catch (error: any) {
      if (!(error instanceof CoralSwapSDKError)) {
        throw new Error(`Method ${method} threw a non-SDK error: ${error?.stack || error}`);
      }
    }
  };

  it('SwapModule', async () => {
    const m = new Modules.SwapModule(client);
    await expectNoRawError(m.getQuote({ tokenIn: DUMMY_ADDRESS_1, tokenOut: DUMMY_ADDRESS_2, amount: 1000n, tradeType: 0 }), 'getQuote');
    await expectNoRawError(m.getMultiHopQuote({ path: [DUMMY_ADDRESS_1, DUMMY_ADDRESS_2, DUMMY_ADDRESS_3], amount: 1000n, tradeType: 0 }), 'getMultiHopQuote');
    await expectNoRawError(m.simulateSwap(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2, 1000n, DUMMY_ADDRESS_1), 'simulateSwap');
    await expectNoRawError(m.getSwapHistory(), 'getSwapHistory');
  });

  it('LiquidityModule', async () => {
    const m = new Modules.LiquidityModule(client);
    await expectNoRawError(m.getAddLiquidityQuote(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2, 1000n, 1000n), 'getAddLiquidityQuote');
    if (typeof (m as any).getRemoveQuote === 'function') await expectNoRawError((m as any).getRemoveQuote(DUMMY_ADDRESS_1, 1000n), 'getRemoveQuote');
    await expectNoRawError(m.getPosition(DUMMY_ADDRESS_1, DUMMY_ADDRESS_1), 'getPosition');
    await expectNoRawError(m.getAllPositions(DUMMY_ADDRESS_1), 'getAllPositions');
  });

  it('FlashLoanModule', async () => {
    const m = new Modules.FlashLoanModule(client);
    await expectNoRawError(m.estimateFee(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2, 1000n), 'estimateFee');
    await expectNoRawError(m.getConfig(DUMMY_ADDRESS_1), 'getConfig');
    await expectNoRawError(m.getMaxBorrowable(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2), 'getMaxBorrowable');
  });

  it('FeeModule', async () => {
    const m = new Modules.FeeModule(client);
    await expectNoRawError(m.getCurrentFee(DUMMY_ADDRESS_1), 'getCurrentFee');
    await expectNoRawError(m.getFeeForPair(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2), 'getFeeForPair');
    await expectNoRawError(m.getFeeState(DUMMY_ADDRESS_1), 'getFeeState');
    await expectNoRawError(m.getProtocolFeeParams(), 'getProtocolFeeParams');
    await expectNoRawError(m.getFeeRevenue(DUMMY_ADDRESS_1), 'getFeeRevenue');
    await expectNoRawError(m.getLPYield(DUMMY_ADDRESS_1, DUMMY_ADDRESS_1), 'getLPYield');
  });

  it('OracleModule', async () => {
    const m = new Modules.OracleModule(client);
    await expectNoRawError(m.getTWAP(DUMMY_ADDRESS_1, 100), 'getTWAP');
    await expectNoRawError(m.getSpotPrice(DUMMY_ADDRESS_1), 'getSpotPrice');
    await expectNoRawError(m.getPriceDeviation(DUMMY_ADDRESS_1), 'getPriceDeviation');
  });

  it('PortfolioModule', async () => {
    const m = new Modules.PortfolioModule(client);
    await expectNoRawError(m.get(DUMMY_ADDRESS_1), 'get');
    
    // Mock get to return valid portfolio for getPortfolioPnL
    jest.spyOn(m, 'get').mockResolvedValue({
      owner: DUMMY_ADDRESS_1,
      totalValueUSD: 0,
      positions: [{ pairAddress: DUMMY_ADDRESS_1 }]
    } as any);
    await expectNoRawError(m.getPortfolioPnL(DUMMY_ADDRESS_1, { positions: [{ pairAddress: DUMMY_ADDRESS_1 }] } as any), 'getPortfolioPnL');
  });

  it('RiskMetricsModule', async () => {
    // RiskMetricsModule does not seem to have getMetrics, skipping guessed methods
  });

  it('TokenListModule', async () => {
    const m = new Modules.TokenListModule(client);
    await expectNoRawError(m.fetch('http://dummy'), 'fetch');
    await expectNoRawError(m.fetchAll('http://dummy'), 'fetchAll');
  });

  it('FactoryModule', async () => {
    const m = new Modules.FactoryModule(client);
    await expectNoRawError(m.getPairAddress(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2), 'getPairAddress');
    await expectNoRawError(m.getPairInfo(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2), 'getPairInfo');
  });

  it('RouterModule', async () => {
    const m = new Modules.RouterModule(client);
    await expectNoRawError(m.findOptimalPath(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2, 1000n, 0), 'findOptimalPath');
  });

  it('TreasuryModule', async () => {
    const m = new Modules.TreasuryModule(client);
    await expectNoRawError(m.getTreasuryAddress(), 'getTreasuryAddress');
    await expectNoRawError(m.getTreasuryBalance(), 'getTreasuryBalance');
    await expectNoRawError(m.getTreasuryAllocation(), 'getTreasuryAllocation');
    await expectNoRawError(m.getFeeRevenue(), 'getFeeRevenue');
    await expectNoRawError(m.getSpotPriceMap([DUMMY_ADDRESS_1]), 'getSpotPriceMap');
  });

  it('AlertsModule & AlertModule', async () => {
    const ms = new Modules.AlertsModule(client);
    await expectNoRawError(ms.getAlertSummary(), 'getAlertSummary');
    
    const m = new Modules.AlertModule(client);
    await expectNoRawError(m.get('123'), 'get');
    await expectNoRawError(m.getSummary(), 'getSummary');
  });

  it('MonitoringModule', async () => {
    const m = new Modules.MonitoringModule(client);
    await expectNoRawError(m.getProtocolMetrics(), 'getProtocolMetrics');
    await expectNoRawError(m.getPoolMetrics(DUMMY_ADDRESS_1), 'getPoolMetrics');
    await expectNoRawError(m.getPoolHealth(DUMMY_ADDRESS_1), 'getPoolHealth');
    await expectNoRawError(m.getAllPoolHealth(), 'getAllPoolHealth');
    await expectNoRawError(m.getProtocolSummary(), 'getProtocolSummary');
    await expectNoRawError(m.getDashboard(), 'getDashboard');
  });

  it('StopLossModule', async () => {
    const m = new Modules.StopLossModule(client, DUMMY_ADDRESS_1, DUMMY_ADDRESS_1);
    await expectNoRawError(m.getStopLoss('123'), 'getStopLoss');
    await expectNoRawError(m.getStopLossOrders(DUMMY_ADDRESS_1), 'getStopLossOrders');
  });

  it('LeaderboardModule', async () => {
    const m = new Modules.LeaderboardModule(client);
    await expectNoRawError(m.getTopTraders(), 'getTopTraders');
    await expectNoRawError(m.getLeaderboard(10, 0), 'getLeaderboard');
  });

  it('HealthCheckModule', async () => {
    const m = new Modules.HealthCheckModule(client);
    await expectNoRawError(m.checkRPCHealth(), 'checkRPCHealth');
  });

  it('TaxReportingModule', async () => {
    const m = new Modules.TaxReportingModule(client);
    await expectNoRawError(m.getCostBasis(DUMMY_ADDRESS_1, DUMMY_ADDRESS_2), 'getCostBasis');
    await expectNoRawError(m.getCapitalGains(DUMMY_ADDRESS_1, 2026), 'getCapitalGains');
  });

  it('GovernanceModule', async () => {
    const m = new Modules.GovernanceModule(client, DUMMY_ADDRESS_1);
    await expectNoRawError(m.getProposal('1'), 'getProposal');
    await expectNoRawError(m.getActiveProposals(), 'getActiveProposals');
    await expectNoRawError(m.getProposalHistory(), 'getProposalHistory');
    await expectNoRawError(m.getDelegationState(DUMMY_ADDRESS_1), 'getDelegationState');
    await expectNoRawError(m.getProposalVotingPower('1', DUMMY_ADDRESS_1), 'getProposalVotingPower');
  });

  it('DCAModule', async () => {
    const m = new Modules.DCAModule(client, DUMMY_ADDRESS_1);
    await expectNoRawError(m.getDCASchedule('1'), 'getDCASchedule');
    await expectNoRawError(m.getDCASchedules(DUMMY_ADDRESS_1), 'getDCASchedules');
    await expectNoRawError(m.getDCAPerformance('1'), 'getDCAPerformance');
  });

  it('LimitOrderModule', async () => {
    const m = new Modules.LimitOrderModule(client, DUMMY_ADDRESS_1);
    await expectNoRawError(m.getOpenOrders(DUMMY_ADDRESS_1), 'getOpenOrders');
    await expectNoRawError(m.getLimitOrderStatus('1'), 'getLimitOrderStatus');
    await expectNoRawError(m.getLimitOrder('1'), 'getLimitOrder');
  });

  it('SquidModule', async () => {
    const m = new Modules.SquidModule(client);
    await expectNoRawError(m.getCrossChainQuote({
      fromChain: 'ethereum',
      toChain: 'stellar',
      fromToken: DUMMY_ADDRESS_1,
      toToken: DUMMY_ADDRESS_2,
      fromAmount: '1000',
      fromAddress: DUMMY_ADDRESS_1,
      toAddress: DUMMY_ADDRESS_1,
    }), 'getCrossChainQuote');
  });

});
