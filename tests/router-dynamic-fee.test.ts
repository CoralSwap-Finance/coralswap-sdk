import { Account, rpc, xdr } from "@stellar/stellar-sdk";
import { RouterClient } from "../src/contracts/router";
import { FeeModule } from "../src/modules/fees";
import { CoralSwapClient } from "../src/client";
import {
  CoralSwapSDKError,
  DecodeError,
  NetworkError,
  SimulationError,
  ValidationError,
} from "../src/errors";
import { RetryOptions } from "../src/utils/retry";

const ROUTER_ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const ZERO_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const FAST_RETRY: RetryOptions = {
  maxRetries: 0,
  baseDelayMs: 1,
  maxDelayMs: 5,
};

function makeSuccessSimulation(retval?: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return {
    id: "sim-1",
    latestLedger: 12345,
    events: [],
    transactionData: new xdr.SorobanTransactionData({
      ext: xdr.SorobanTransactionDataExt.v0() as xdr.SorobanTransactionDataExt,
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 100,
        diskReadBytes: 0,
        writeBytes: 0,
      }),
      resourceFee: 0n,
    }),
    minResourceFee: "100",
    ...(retval !== undefined ? { result: { auth: [], retval } } : {}),
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function makeErrorSimulation(errorMessage: string): rpc.Api.SimulateTransactionResponse {
  return {
    id: "sim-err-1",
    latestLedger: 12345,
    error: errorMessage,
    events: [],
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function buildRouter(
  simulateImpl: jest.Mock,
): { router: RouterClient; server: rpc.Server } {
  const server = {
    getAccount: jest
      .fn()
      .mockResolvedValue(new Account(ZERO_SOURCE, "0")),
    simulateTransaction: simulateImpl,
  } as unknown as rpc.Server;

  const router = new RouterClient(
    ROUTER_ADDR,
    server,
    TESTNET_PASSPHRASE,
    FAST_RETRY,
  );
  return { router, server };
}

describe("RouterClient.getDynamicFee — fail-closed behavior (#622)", () => {
  describe("happy path", () => {
    it("returns the exact on-chain dynamic fee in basis points on scvU32 success", async () => {
      const simMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(xdr.ScVal.scvU32(45)));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).resolves.toBe(45);
    });

    it("supports boundary fee values 0 bps and 10_000 bps without fallback", async () => {
      const zeroMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(xdr.ScVal.scvU32(0)));
      const maxMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(xdr.ScVal.scvU32(10_000)));

      await expect(buildRouter(zeroMock).router.getDynamicFee(TOKEN_A, TOKEN_B)).resolves.toBe(0);
      await expect(buildRouter(maxMock).router.getDynamicFee(TOKEN_A, TOKEN_B)).resolves.toBe(
        10_000,
      );
    });

    it("decodes accessor-function ScVal doubles (switch/u32 methods)", async () => {
      const accessorScVal = {
        switch: () => ({ name: "scvU32" }),
        u32: () => 75,
      } as unknown as xdr.ScVal;
      const simMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(accessorScVal));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).resolves.toBe(75);
    });
  });

  describe("fail-closed simulation errors (no silent 30 bps fallback)", () => {
    it("throws SimulationError when simulateTransaction returns an RPC/contract simulation error", async () => {
      const simMock = jest
        .fn()
        .mockResolvedValue(makeErrorSimulation("HostError: Error(Contract, #201)"));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        SimulationError,
      );
      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        CoralSwapSDKError,
      );

      try {
        await router.getDynamicFee(TOKEN_A, TOKEN_B);
        throw new Error("Expected getDynamicFee to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(SimulationError);
        const simErr = err as SimulationError;
        expect(simErr.code).toBe("SIMULATION_ERROR");
        expect(simErr.message).toContain("HostError: Error(Contract, #201)");
        expect(simErr.details).toMatchObject({
          method: "get_dynamic_fee",
          tokenA: TOKEN_A,
          tokenB: TOKEN_B,
          simulationError: "HostError: Error(Contract, #201)",
        });
      }
    });

    it("throws SimulationError when simulation succeeds without a result/retval", async () => {
      const simMock = jest.fn().mockResolvedValue(makeSuccessSimulation(undefined));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        SimulationError,
      );
    });

    it("throws SimulationError if a custom/mocked simulateRead returns null", async () => {
      const simMock = jest.fn();
      const { router } = buildRouter(simMock);
      (router as unknown as { simulateRead: jest.Mock }).simulateRead = jest
        .fn()
        .mockResolvedValue(null);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        SimulationError,
      );
    });

    it("propagates transport/RPC errors rather than returning 30 bps", async () => {
      const simMock = jest
        .fn()
        .mockRejectedValue(new NetworkError("ECONNRESET talking to Soroban RPC"));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        NetworkError,
      );
    });
  });

  describe("fail-closed ScVal decode & input validation errors", () => {
    it("throws DecodeError when contract returns a non-scvU32 ScVal (e.g. scvVoid)", async () => {
      const simMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(xdr.ScVal.scvVoid()));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        DecodeError,
      );
      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        CoralSwapSDKError,
      );
    });

    it("throws DecodeError when decoded u32 exceeds 10_000 bps", async () => {
      const simMock = jest
        .fn()
        .mockResolvedValue(makeSuccessSimulation(xdr.ScVal.scvU32(10_001)));
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        DecodeError,
      );
    });

    it("throws ValidationError on empty or malformed token addresses", async () => {
      const simMock = jest.fn();
      const { router } = buildRouter(simMock);

      await expect(router.getDynamicFee("", TOKEN_B)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(router.getDynamicFee("not-an-address", TOKEN_B)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(router.getDynamicFee(TOKEN_A, "invalid")).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(simMock).not.toHaveBeenCalled();
    });
  });

  describe("FeeModule.getFeeForPair integration", () => {
    it("propagates SimulationError from RouterClient.getDynamicFee instead of returning 30 bps", async () => {
      const simMock = jest
        .fn()
        .mockResolvedValue(makeErrorSimulation("pair not initialized"));
      const { router } = buildRouter(simMock);
      const client = { router } as unknown as CoralSwapClient;
      const fees = new FeeModule(client);

      await expect(fees.getFeeForPair(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(
        SimulationError,
      );
    });
  });

  describe("additional RouterClient branches & builders", () => {
    it("covers overridden simulateRead success, string switch ScVal, unknown ScVal shape, and empty simulation error", async () => {
      const { router } = buildRouter(jest.fn());
      (router as unknown as { simulateRead: jest.Mock }).simulateRead = jest
        .fn()
        .mockResolvedValueOnce({ switch: () => "scvU32", u32: () => 25 } as unknown as xdr.ScVal)
        .mockResolvedValueOnce({} as unknown as xdr.ScVal);

      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).resolves.toBe(25);
      await expect(router.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toBeInstanceOf(DecodeError);

      const emptyErrSim = buildRouter(jest.fn().mockResolvedValue(makeErrorSimulation(""))).router;
      await expect(emptyErrSim.getDynamicFee(TOKEN_A, TOKEN_B)).rejects.toThrow(
        "Simulation failed",
      );
    });

    it("covers quote() success and failure plus swap/liquidity operation builders", async () => {
      const quoteSuccess = buildRouter(
        jest
          .fn()
          .mockResolvedValue(
            makeSuccessSimulation(
              xdr.ScVal.scvI128(
                new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("995") }),
              ),
            ),
          ),
      ).router;
      await expect(quoteSuccess.quote(TOKEN_A, TOKEN_B, 1000n)).resolves.toBe(995n);

      const quoteFail = buildRouter(jest.fn().mockResolvedValue(makeErrorSimulation("no pair")))
        .router;
      await expect(quoteFail.quote(TOKEN_A, TOKEN_B, 1000n)).rejects.toThrow(
        "Failed to get quote",
      );

      expect(
        quoteSuccess.buildSwapExactIn(ZERO_SOURCE, TOKEN_A, TOKEN_B, 1000n, 900n, 999999),
      ).toBeDefined();
      expect(
        quoteSuccess.buildSwapExactOut(ZERO_SOURCE, TOKEN_A, TOKEN_B, 900n, 1000n, 999999),
      ).toBeDefined();
      expect(
        quoteSuccess.buildSwapExactTokensForTokens(
          ZERO_SOURCE,
          [TOKEN_A, TOKEN_B],
          1000n,
          900n,
          999999,
        ),
      ).toBeDefined();
      expect(
        quoteSuccess.buildAddLiquidity(
          ZERO_SOURCE,
          TOKEN_A,
          TOKEN_B,
          1000n,
          1000n,
          900n,
          900n,
          999999,
        ),
      ).toBeDefined();
      expect(
        quoteSuccess.buildRemoveLiquidity(
          ZERO_SOURCE,
          TOKEN_A,
          TOKEN_B,
          500n,
          400n,
          400n,
          999999,
        ),
      ).toBeDefined();
      expect(() =>
        quoteSuccess.buildSwapExactIn(ZERO_SOURCE, TOKEN_A, TOKEN_B, 1000n, 0n, 999999),
      ).toThrow("amountOutMin must be > 0");
    });
  });
});
