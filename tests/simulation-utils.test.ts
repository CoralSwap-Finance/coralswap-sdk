import { SorobanRpc } from '@stellar/stellar-sdk';
import {
  exceedsBudget,
  getResourceEstimate,
  getSimulationReturnValue,
  isSimulationSuccess,
} from '../src/utils/simulation';

type SimResponse = SorobanRpc.Api.SimulateTransactionResponse;

describe('Simulation Utilities', () => {
  let simulationSuccessSpy: jest.SpiedFunction<
    typeof SorobanRpc.Api.isSimulationSuccess
  >;

  beforeEach(() => {
    simulationSuccessSpy = jest.spyOn(SorobanRpc.Api, 'isSimulationSuccess');
  });

  afterEach(() => {
    simulationSuccessSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('returns standardized success result for isSimulationSuccess', () => {
    simulationSuccessSpy.mockReturnValue(true);

    const sim = {} as SimResponse;
    const result = isSimulationSuccess(sim);

    expect(result).toEqual({
      success: true,
      data: true,
    });
  });

  it('returns standardized failure result for isSimulationSuccess', () => {
    simulationSuccessSpy.mockReturnValue(false);

    const sim = {} as SimResponse;
    const result = isSimulationSuccess(sim);

    expect(result).toEqual({
      success: false,
      data: false,
      error: 'Simulation failed',
    });
  });

  it('returns simulation return value with standardized shape', () => {
    simulationSuccessSpy.mockReturnValue(true);

    const retval = { _arm: 'i128' } as unknown;
    const sim = {
      result: { retval },
    } as SimResponse;

    const result = getSimulationReturnValue(sim);

    expect(result.success).toBe(true);
    expect(result.data).toBe(retval);
    expect(result.error).toBeUndefined();
  });

  it('returns failure shape from getSimulationReturnValue when simulation fails', () => {
    simulationSuccessSpy.mockReturnValue(false);

    const result = getSimulationReturnValue({} as SimResponse);

    expect(result).toEqual({
      success: false,
      data: null,
      error: 'Simulation failed',
    });
  });

  it('returns typed resource estimate in standardized shape', () => {
    simulationSuccessSpy.mockReturnValue(true);

    const sim = {
      cost: {
        cpuInsns: '12345',
        memBytes: '67890',
      },
    } as SimResponse;

    const result = getResourceEstimate(sim);

    expect(result).toEqual({
      success: true,
      data: {
        cpuInstructions: 12345,
        memoryBytes: 67890,
        readBytes: 0,
        writeBytes: 0,
      },
    });
  });

  it('returns standardized failure from getResourceEstimate on failed simulation', () => {
    simulationSuccessSpy.mockReturnValue(false);

    const result = getResourceEstimate({} as SimResponse);

    expect(result).toEqual({
      success: false,
      data: null,
      error: 'Simulation failed',
    });
  });

  it('returns standardized budget evaluation result', () => {
    simulationSuccessSpy.mockReturnValue(true);

    const sim = {
      cost: {
        cpuInsns: '200000000',
        memBytes: '500',
      },
    } as SimResponse;

    const result = exceedsBudget(sim, 100_000_000);

    expect(result).toEqual({
      success: true,
      data: true,
    });
  });

  it('returns failure shape with conservative budget breach on failed simulation', () => {
    simulationSuccessSpy.mockReturnValue(false);

    const result = exceedsBudget({} as SimResponse, 100_000_000);

    expect(result).toEqual({
      success: false,
      data: true,
      error: 'Simulation failed',
    });
  });
});
