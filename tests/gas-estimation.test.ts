import { estimateGas, parseStroops, formatStroopsAsXLM } from '../src/utils/gas';
import { SimulationError } from '../src/errors';
import { SwapModule } from '../src/modules/swap';
import { LiquidityModule } from '../src/modules/liquidity';
import { FlashLoanModule } from '../src/modules/flash-loan';
import { TradeType } from '../src/types/common';
import { CoralSwapClient } from '../src/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const TOKEN_B = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4';
const PAIR_ADDR = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const USER_ADDR = TOKEN_A;

function makeSuccessSimResult(minResourceFee = '100') {
  return {
    success: true,
    returnValue: null,
    auth: [],
    minResourceFee,
    cost: null,
    transactionData: null,
    latestLedger: 1,
    events: [],
    error: null,
    raw: {} as any,
  };
}

function makeFailSimResult(error = 'contract trapped') {
  return {
    success: false,
    returnValue: null,
    auth: [],
    minResourceFee: '',
    cost: null,
    transactionData: null,
    latestLedger: 1,
    events: [],
    error,
    raw: {} as any,
  };
}

// ---------------------------------------------------------------------------
// estimateGas utility
// ---------------------------------------------------------------------------

describe('estimateGas()', () => {
  it('returns fee and feeXLM from a successful simulation', async () => {
    const simulate = jest.fn().mockResolvedValue(makeSuccessSimResult('100'));
    const result = await estimateGas(simulate, []);
    expect(result.fee).toBe(100n);
    expect(result.feeXLM).toBe('0.00001 XLM');
    expect(result.feeUSD).toBeUndefined();
  });

  it('converts stroops to XLM correctly (7 decimal places)', async () => {
    const simulate = jest.fn().mockResolvedValue(makeSuccessSimResult('10000000'));
    const result = await estimateGas(simulate, []);
    expect(result.fee).toBe(10_000_000n);
    expect(result.feeXLM).toBe('1.00000 XLM');
  });

  it('handles fee of zero', async () => {
    const simulate = jest.fn().mockResolvedValue(makeSuccessSimResult('0'));
    const result = await estimateGas(simulate, []);
    expect(result.fee).toBe(0n);
    expect(result.feeXLM).toBe('0.00000 XLM');
  });

  it('throws SimulationError when simulation fails', async () => {
    const simulate = jest.fn().mockResolvedValue(makeFailSimResult('contract trapped'));
    await expect(estimateGas(simulate, [])).rejects.toBeInstanceOf(SimulationError);
  });

  it('SimulationError contains the RPC error message', async () => {
    const simulate = jest.fn().mockResolvedValue(makeFailSimResult('out of budget'));
    await expect(estimateGas(simulate, [])).rejects.toMatchObject({
      message: 'out of budget',
    });
  });

  it('calls simulate with the provided operations', async () => {
    const op = { type: 'invokeHostFunction' } as any;
    const simulate = jest.fn().mockResolvedValue(makeSuccessSimResult('50'));
    await estimateGas(simulate, [op]);
    expect(simulate).toHaveBeenCalledWith([op]);
  });
});

// ---------------------------------------------------------------------------
// SwapModule – estimateOnly
// ---------------------------------------------------------------------------

function createSwapClient(simResult = makeSuccessSimResult('200')): CoralSwapClient {
  return {
    networkConfig: { networkPassphrase: 'Test SDF Network ; September 2015' },
    config: {},
    publicKey: USER_ADDR,
    getPairAddress: jest.fn().mockResolvedValue(PAIR_ADDR),
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_000_000n, reserve1: 1_000_000_000n }),
      getDynamicFee: jest.fn().mockResolvedValue(30),
      getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_A, token1: TOKEN_B }),
    }),
    router: {
      buildSwapExactIn: jest.fn().mockReturnValue({ type: 'swapExactIn' }),
      buildSwapExactOut: jest.fn().mockReturnValue({ type: 'swapExactOut' }),
      buildSwapExactTokensForTokens: jest.fn().mockReturnValue({ type: 'multiHop' }),
    },
    simulateTransaction: jest.fn().mockResolvedValue(simResult),
    getDeadline: jest.fn().mockReturnValue(9999999999),
  } as unknown as CoralSwapClient;
}

describe('SwapModule.execute({ estimateOnly: true })', () => {
  it('returns GasEstimate without submitting', async () => {
    const client = createSwapClient(makeSuccessSimResult('200'));
    const mod = new SwapModule(client);
    const gas = await mod.execute(
      { tokenIn: TOKEN_A, tokenOut: TOKEN_B, amount: 1_000_000n, tradeType: TradeType.EXACT_IN },
      { estimateOnly: true },
    );
    expect(gas.fee).toBe(200n);
    expect(gas.feeXLM).toBe('0.00002 XLM');
    expect((client.simulateTransaction as jest.Mock)).toHaveBeenCalled();
  });

  it('throws SimulationError when swap dry-run fails', async () => {
    const client = createSwapClient(makeFailSimResult('trap'));
    const mod = new SwapModule(client);
    await expect(
      mod.execute(
        { tokenIn: TOKEN_A, tokenOut: TOKEN_B, amount: 1_000_000n, tradeType: TradeType.EXACT_IN },
        { estimateOnly: true },
      ),
    ).rejects.toBeInstanceOf(SimulationError);
  });
});

// ---------------------------------------------------------------------------
// LiquidityModule – estimateOnly (addLiquidity / removeLiquidity)
// ---------------------------------------------------------------------------

function createLiquidityClient(simResult = makeSuccessSimResult('300')): CoralSwapClient {
  return {
    networkConfig: {},
    config: {},
    publicKey: USER_ADDR,
    getPairAddress: jest.fn().mockResolvedValue(PAIR_ADDR),
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({ reserve0: 1_000_000n, reserve1: 1_000_000n }),
      getTokens: jest.fn().mockResolvedValue({ token0: TOKEN_A, token1: TOKEN_B }),
      getLPTokenAddress: jest.fn().mockResolvedValue(PAIR_ADDR),
    }),
    lpToken: jest.fn().mockReturnValue({
      totalSupply: jest.fn().mockResolvedValue(1_000_000n),
    }),
    router: {
      buildAddLiquidity: jest.fn().mockReturnValue({ type: 'addLiquidity' }),
      buildRemoveLiquidity: jest.fn().mockReturnValue({ type: 'removeLiquidity' }),
    },
    simulateTransaction: jest.fn().mockResolvedValue(simResult),
    getDeadline: jest.fn().mockReturnValue(9999999999),
  } as unknown as CoralSwapClient;
}

describe('LiquidityModule.addLiquidity({ estimateOnly: true })', () => {
  it('returns GasEstimate without submitting', async () => {
    const client = createLiquidityClient(makeSuccessSimResult('300'));
    const mod = new LiquidityModule(client);
    const gas = await mod.addLiquidity(
      {
        tokenA: TOKEN_A, tokenB: TOKEN_B,
        amountADesired: 100_000n, amountBDesired: 100_000n,
        amountAMin: 99_000n, amountBMin: 99_000n,
        to: USER_ADDR,
      },
      { estimateOnly: true },
    );
    expect(gas.fee).toBe(300n);
    expect(gas.feeXLM).toBe('0.00003 XLM');
  });

  it('throws SimulationError on failed dry-run', async () => {
    const client = createLiquidityClient(makeFailSimResult('contract error'));
    const mod = new LiquidityModule(client);
    await expect(
      mod.addLiquidity(
        {
          tokenA: TOKEN_A, tokenB: TOKEN_B,
          amountADesired: 100_000n, amountBDesired: 100_000n,
          amountAMin: 99_000n, amountBMin: 99_000n,
          to: USER_ADDR,
        },
        { estimateOnly: true },
      ),
    ).rejects.toBeInstanceOf(SimulationError);
  });
});

describe('LiquidityModule.removeLiquidity({ estimateOnly: true })', () => {
  it('returns GasEstimate without submitting', async () => {
    const client = createLiquidityClient(makeSuccessSimResult('150'));
    const mod = new LiquidityModule(client);
    const gas = await mod.removeLiquidity(
      {
        tokenA: TOKEN_A, tokenB: TOKEN_B,
        liquidity: 50_000n,
        amountAMin: 49_000n, amountBMin: 49_000n,
        to: USER_ADDR,
      },
      { estimateOnly: true },
    );
    expect(gas.fee).toBe(150n);
    expect(gas.feeXLM).toBe('0.00002 XLM');
  });
});

// ---------------------------------------------------------------------------
// FlashLoanModule – estimateOnly
// ---------------------------------------------------------------------------

function createFlashLoanClient(simResult = makeSuccessSimResult('400')): CoralSwapClient {
  return {
    networkConfig: {},
    config: {},
    publicKey: USER_ADDR,
    pair: jest.fn().mockReturnValue({
      getFlashLoanConfig: jest.fn().mockResolvedValue({
        locked: false,
        flashFeeBps: 10,
        flashFeeFloor: 5n,
      }),
      buildFlashLoan: jest.fn().mockReturnValue({ type: 'flashLoan' }),
    }),
    simulateTransaction: jest.fn().mockResolvedValue(simResult),
  } as unknown as CoralSwapClient;
}

describe('FlashLoanModule.execute({ estimateOnly: true })', () => {
  it('returns GasEstimate without submitting', async () => {
    const client = createFlashLoanClient(makeSuccessSimResult('400'));
    const mod = new FlashLoanModule(client);
    const gas = await mod.execute(
      {
        pairAddress: PAIR_ADDR,
        token: TOKEN_A,
        amount: 1_000_000n,
        receiverAddress: USER_ADDR,
        callbackData: Buffer.from(''),
      },
      { estimateOnly: true },
    );
    expect(gas.fee).toBe(400n);
    expect(gas.feeXLM).toBe('0.00004 XLM');
  });

  it('throws SimulationError when flash loan dry-run fails', async () => {
    const client = createFlashLoanClient(makeFailSimResult('insufficient funds'));
    const mod = new FlashLoanModule(client);
    await expect(
      mod.execute(
        {
          pairAddress: PAIR_ADDR,
          token: TOKEN_A,
          amount: 1_000_000n,
          receiverAddress: USER_ADDR,
          callbackData: Buffer.from(''),
        },
        { estimateOnly: true },
      ),
    ).rejects.toBeInstanceOf(SimulationError);
  });
});

describe('estimateGas() precision', () => {
  it('preserves fees above 2^53 exactly', async () => {
    const huge = '9007199254740993123'; // > Number.MAX_SAFE_INTEGER
    const simulate = jest.fn().mockResolvedValue(makeSuccessSimResult(huge));
    const result = await estimateGas(simulate, []);
    expect(result.fee).toBe(BigInt(huge));
    expect(result.feeRaw).toBe(huge);
    expect(BigInt(result.feeRaw)).toBe(result.fee);
    expect(result.feeXLM).toBe('900719925474.09931 XLM');
  });
});

describe('parseStroops / formatStroopsAsXLM', () => {
  it('parses stroop strings without Number conversion', () => {
    expect(parseStroops('12345678901234567890')).toBe(12345678901234567890n);
    expect(parseStroops('')).toBe(0n);
    expect(parseStroops('abc')).toBe(0n);
  });

  it('formats with 5 decimal places, rounding half-up', () => {
    expect(formatStroopsAsXLM(100n)).toBe('0.00001 XLM');
    expect(formatStroopsAsXLM(250n)).toBe('0.00003 XLM');
    expect(formatStroopsAsXLM(10_000_000n)).toBe('1.00000 XLM');
    expect(formatStroopsAsXLM(0n)).toBe('0.00000 XLM');
  });
});
