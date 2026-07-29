import { CoralSwapClient } from "../src/client";
import { FlashLoanModule } from "../src/modules/flash-loan";
import { PairClient } from "../src/contracts/pair";
import { FlashLoanError } from "../src/errors";
import { Network } from "../src/types/common";
import { FlashLoanConfig } from "../src/types/pool";
import { xdr, SorobanRpc } from "@stellar/stellar-sdk";

const mockGetTransactionStatus = jest.fn();

jest.mock('../src/utils/idempotent-resubmission', () => {
  const actual = jest.requireActual('../src/utils/idempotent-resubmission');
  return {
    ...actual,
    getTransactionStatus: (...args: unknown[]) => mockGetTransactionStatus(...args),
  };
});

describe("FlashLoanModule - Idempotent Resubmission", () => {
  const TEST_SECRET =
    "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";
  const TEST_PAIR_ADDRESS =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";
  const TEST_TOKEN_ADDRESS =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TEST_RECEIVER_ADDRESS =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

  let client: CoralSwapClient;
  let flashLoanModule: FlashLoanModule;
  let mockPairClient: jest.Mocked<PairClient>;

  const mockConfig: FlashLoanConfig = {
    flashFeeBps: 9,
    locked: false,
    flashFeeFloor: 5n,
  };

  const mockOperation = {} as xdr.Operation;

  beforeEach(() => {
    jest.clearAllMocks();

    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    flashLoanModule = new FlashLoanModule(client);

    mockPairClient = {
      getFlashLoanConfig: jest.fn(),
      getReserves: jest.fn(),
      getTokens: jest.fn(),
      buildFlashLoan: jest.fn(),
    } as unknown as jest.Mocked<PairClient>;

    jest.spyOn(client, "pair").mockReturnValue(mockPairClient);
    mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);
    mockPairClient.buildFlashLoan.mockReturnValue(mockOperation);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("timeout-but-landed detection", () => {
    it("recovers when submitTransaction times out but tx already succeeded", async () => {
      const txHash = "timed-out-tx-hash";
      const ledger = 54321;

      jest.spyOn(client, "submitTransaction").mockResolvedValue({
        success: false,
        error: {
          code: "TX_TIMEOUT",
          message: "Transaction confirmation timed out",
        },
        txHash,
      });

      mockGetTransactionStatus.mockResolvedValue({
        status: "SUCCESS",
        ledger,
        txHash,
      });

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      expect(result.txHash).toBe(txHash);
      expect(result.ledger).toBe(ledger);
      expect(result.token).toBe(TEST_TOKEN_ADDRESS);
      expect(result.amount).toBe(100000n);
      expect(result.fee).toBe(90n);

      expect(mockGetTransactionStatus).toHaveBeenCalledWith(
        client.server,
        txHash,
      );
    });

    it("throws when submitTransaction times out but tx already failed", async () => {
      const txHash = "timed-out-failed-tx";

      jest.spyOn(client, "submitTransaction").mockResolvedValue({
        success: false,
        error: {
          code: "TX_TIMEOUT",
          message: "Transaction confirmation timed out",
        },
        txHash,
      });

      mockGetTransactionStatus.mockResolvedValue({
        status: "FAILED",
        ledger: 54321,
      });

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        FlashLoanError,
      );
    });

    it("throws normally when no txHash in failed submission", async () => {
      jest.spyOn(client, "submitTransaction").mockResolvedValue({
        success: false,
        error: {
          code: "SIMULATION_FAILED",
          message: "Simulation failed",
        },
      });

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        FlashLoanError,
      );

      expect(mockGetTransactionStatus).not.toHaveBeenCalled();
    });

    it("retries when transaction was not found on-chain after timeout", async () => {
      const txHash = "not-found-tx";

      jest.spyOn(client, "submitTransaction").mockResolvedValue({
        success: false,
        error: {
          code: "TX_TIMEOUT",
          message: "Transaction confirmation timed out",
        },
        txHash,
      });

      mockGetTransactionStatus.mockResolvedValue({
        status: "NOT_FOUND",
      });

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        FlashLoanError,
      );
      expect(mockGetTransactionStatus).toHaveBeenCalledWith(
        client.server,
        txHash,
      );
    });
  });
});
