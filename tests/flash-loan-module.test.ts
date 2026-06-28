import { CoralSwapClient } from "../src/client";
import { FlashLoanModule } from "../src/modules/flash-loan";
import { PairClient } from "../src/contracts/pair";
import { FlashLoanError, TransactionError, FlashLoanFailedError, ValidationError } from "../src/errors";
import { Network } from "../src/types/common";
import { FlashLoanConfig } from "../src/types/pool";
import { xdr, Address, nativeToScVal, SorobanRpc } from "@stellar/stellar-sdk";
import { EventParser, EVENT_TOPICS } from "../src/utils/events";

/**
 * Tests for FlashLoanModule.
 *
 * Covers fee estimation, availability checks, max borrowable calculation,
 * repayment calculation, and flash loan execution flow.
 */
describe("FlashLoanModule", () => {
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

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    flashLoanModule = new FlashLoanModule(client);

    // Create mock PairClient
    mockPairClient = {
      getFlashLoanConfig: jest.fn(),
      getReserves: jest.fn(),
      getTokens: jest.fn(),
      buildFlashLoan: jest.fn(),
    } as unknown as jest.Mocked<PairClient>;

    // Mock the client.pair() method to return our mock
    jest.spyOn(client, "pair").mockReturnValue(mockPairClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("calculateRepayment()", () => {
    it("calculates repayment with 9 bps fee correctly", () => {
      const amount = 1000n;
      const feeBps = 9;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      // 1000 + (1000 * 9 / 10000) = 1000 + 0 (floor) = 1000
      // But actually: (1000 * 9) / 10000 = 9000 / 10000 = 0 (integer division)
      // So repayment = 1000 + 0 = 1000
      expect(repayment).toBe(1000n);
    });

    it("calculates repayment with larger amount and 9 bps fee", () => {
      const amount = 100000n;
      const feeBps = 9;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      // 100000 + (100000 * 9 / 10000) = 100000 + 90 = 100090
      const expectedFee = (amount * BigInt(feeBps)) / 10000n;
      expect(repayment).toBe(amount + expectedFee);
      expect(repayment).toBe(100090n);
    });

    it("handles large amounts without overflow", () => {
      const amount = 1000000000000n; // 1 trillion
      const feeBps = 9;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      const expectedFee = (amount * BigInt(feeBps)) / 10000n;
      expect(repayment).toBe(amount + expectedFee);
      expect(repayment).toBe(1000900000000n);
    });

    it("returns principal unchanged when fee is zero", () => {
      const amount = 50000n;
      const feeBps = 0;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      expect(repayment).toBe(amount);
      expect(repayment).toBe(50000n);
    });

    it("calculates repayment with 30 bps fee", () => {
      const amount = 10000n;
      const feeBps = 30;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      // 10000 + (10000 * 30 / 10000) = 10000 + 30 = 10030
      expect(repayment).toBe(10030n);
    });

    it("handles minimum amounts correctly", () => {
      const amount = 1n;
      const feeBps = 9;
      const repayment = flashLoanModule.calculateRepayment(amount, feeBps);

      // 1 + (1 * 9 / 10000) = 1 + 0 (floor) = 1
      expect(repayment).toBe(1n);
    });
  });

  describe("estimateFee()", () => {
    const mockConfig: FlashLoanConfig = {
      flashFeeBps: 9,
      locked: false,
      flashFeeFloor: 100n,
    };

    it("returns fee based on flashFeeBps when fee > floor", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const amount = 1000000n;
      const estimate = await flashLoanModule.estimateFee(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
        amount,
      );

      // Fee = (1000000 * 9) / 10000 = 900
      // Floor = 100
      // Actual fee = max(900, 100) = 900
      expect(estimate.token).toBe(TEST_TOKEN_ADDRESS);
      expect(estimate.amount).toBe(amount);
      expect(estimate.feeBps).toBe(9);
      expect(estimate.feeAmount).toBe(900n);
      expect(estimate.feeFloor).toBe(100);
    });

    it("returns flashFeeFloor when calculated fee < floor", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const amount = 1000n; // Small amount
      const estimate = await flashLoanModule.estimateFee(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
        amount,
      );

      // Fee = (1000 * 9) / 10000 = 0 (floor)
      // Floor = 100
      // Actual fee = max(0, 100) = 100
      expect(estimate.feeAmount).toBe(100n);
      expect(estimate.feeFloor).toBe(100);
    });

    it("throws when config.locked is true", async () => {
      const lockedConfig: FlashLoanConfig = {
        ...mockConfig,
        locked: true,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(lockedConfig);

      await expect(
        flashLoanModule.estimateFee(
          TEST_PAIR_ADDRESS,
          TEST_TOKEN_ADDRESS,
          10000n,
        ),
      ).rejects.toThrow(FlashLoanError);

      await expect(
        flashLoanModule.estimateFee(
          TEST_PAIR_ADDRESS,
          TEST_TOKEN_ADDRESS,
          10000n,
        ),
      ).rejects.toThrow("Flash loans are currently disabled for this pair");
    });

    it("handles zero amount correctly", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      await expect(
        flashLoanModule.estimateFee(
          TEST_PAIR_ADDRESS,
          TEST_TOKEN_ADDRESS,
          0n,
        ),
      ).rejects.toThrow("amount must be greater than 0");
    });

    it("handles high fee bps correctly", async () => {
      const highFeeConfig: FlashLoanConfig = {
        flashFeeBps: 100, // 1%
        locked: false,
        flashFeeFloor: 10n,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(highFeeConfig);

      const amount = 100000n;
      const estimate = await flashLoanModule.estimateFee(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
        amount,
      );

      // Fee = (100000 * 100) / 10000 = 1000
      expect(estimate.feeAmount).toBe(1000n);
      expect(estimate.feeBps).toBe(100);
    });
  });

  describe("isAvailable()", () => {
    it("returns true when locked is false", async () => {
      const config: FlashLoanConfig = {
        flashFeeBps: 9,
        locked: false,
        flashFeeFloor: 100n,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(config);

      const available = await flashLoanModule.isAvailable(TEST_PAIR_ADDRESS);

      expect(available).toBe(true);
      expect(mockPairClient.getFlashLoanConfig).toHaveBeenCalledTimes(1);
    });

    it("returns false when locked is true", async () => {
      const config: FlashLoanConfig = {
        flashFeeBps: 9,
        locked: true,
        flashFeeFloor: 100n,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(config);

      const available = await flashLoanModule.isAvailable(TEST_PAIR_ADDRESS);

      expect(available).toBe(false);
    });

    it("returns false when config read throws", async () => {
      mockPairClient.getFlashLoanConfig.mockRejectedValue(
        new Error("Network error"),
      );

      const available = await flashLoanModule.isAvailable(TEST_PAIR_ADDRESS);

      expect(available).toBe(false);
    });

    it("returns false when pair does not exist", async () => {
      mockPairClient.getFlashLoanConfig.mockRejectedValue(
        new Error("Contract not found"),
      );

      const available = await flashLoanModule.isAvailable(TEST_PAIR_ADDRESS);

      expect(available).toBe(false);
    });
  });

  describe("getMaxBorrowable()", () => {
    const mockTokens = {
      token0: TEST_TOKEN_ADDRESS,
      token1: "CTOKEN1ADDRESSFORTEST1234567890ABCDEFGHIJKLMNOPQRST",
    };

    it("returns reserve - 1% margin for token0", async () => {
      const reserve0 = 1000000n;
      const reserve1 = 500000n;

      mockPairClient.getReserves.mockResolvedValue({
        reserve0,
        reserve1,
      });
      mockPairClient.getTokens.mockResolvedValue(mockTokens);

      const maxBorrowable = await flashLoanModule.getMaxBorrowable(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
      );

      // Max = 1000000 - (1000000 / 100) = 1000000 - 10000 = 990000
      const expectedMax = reserve0 - reserve0 / 100n;
      expect(maxBorrowable).toBe(expectedMax);
      expect(maxBorrowable).toBe(990000n);
    });

    it("returns reserve - 1% margin for token1", async () => {
      const reserve0 = 1000000n;
      const reserve1 = 500000n;

      mockPairClient.getReserves.mockResolvedValue({
        reserve0,
        reserve1,
      });
      mockPairClient.getTokens.mockResolvedValue(mockTokens);

      const maxBorrowable = await flashLoanModule.getMaxBorrowable(
        TEST_PAIR_ADDRESS,
        mockTokens.token1,
      );

      // Max = 500000 - (500000 / 100) = 500000 - 5000 = 495000
      const expectedMax = reserve1 - reserve1 / 100n;
      expect(maxBorrowable).toBe(expectedMax);
      expect(maxBorrowable).toBe(495000n);
    });

    it("handles zero reserves", async () => {
      mockPairClient.getReserves.mockResolvedValue({
        reserve0: 0n,
        reserve1: 0n,
      });
      mockPairClient.getTokens.mockResolvedValue(mockTokens);

      const maxBorrowable = await flashLoanModule.getMaxBorrowable(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
      );

      // Max = 0 - (0 / 100) = 0 - 0 = 0
      expect(maxBorrowable).toBe(0n);
    });

    it("handles very small reserves", async () => {
      mockPairClient.getReserves.mockResolvedValue({
        reserve0: 50n,
        reserve1: 100n,
      });
      mockPairClient.getTokens.mockResolvedValue(mockTokens);

      const maxBorrowable = await flashLoanModule.getMaxBorrowable(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
      );

      // Max = 50 - (50 / 100) = 50 - 0 (floor) = 50
      expect(maxBorrowable).toBe(50n);
    });

    it("handles large reserves", async () => {
      const largeReserve = 1000000000000n; // 1 trillion
      mockPairClient.getReserves.mockResolvedValue({
        reserve0: largeReserve,
        reserve1: largeReserve / 2n,
      });
      mockPairClient.getTokens.mockResolvedValue(mockTokens);

      const maxBorrowable = await flashLoanModule.getMaxBorrowable(
        TEST_PAIR_ADDRESS,
        TEST_TOKEN_ADDRESS,
      );

      // Max = 1000000000000 - (1000000000000 / 100) = 1000000000000 - 10000000000 = 990000000000
      const expectedMax = largeReserve - largeReserve / 100n;
      expect(maxBorrowable).toBe(expectedMax);
      expect(maxBorrowable).toBe(990000000000n);
    });
  });

  describe("getConfig()", () => {
    it("returns flash loan config from pair", async () => {
      const config: FlashLoanConfig = {
        flashFeeBps: 9,
        locked: false,
        flashFeeFloor: 100n,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(config);

      const result = await flashLoanModule.getConfig(TEST_PAIR_ADDRESS);

      expect(result).toEqual(config);
      expect(mockPairClient.getFlashLoanConfig).toHaveBeenCalledTimes(1);
    });

    it("propagates errors from pair client", async () => {
      mockPairClient.getFlashLoanConfig.mockRejectedValue(
        new Error("RPC error"),
      );

      await expect(
        flashLoanModule.getConfig(TEST_PAIR_ADDRESS),
      ).rejects.toThrow("RPC error");
    });
  });

  describe("execute()", () => {
    const mockConfig: FlashLoanConfig = {
      flashFeeBps: 9,
      locked: false,
      flashFeeFloor: 5n,
    };

    const mockOperation = {} as xdr.Operation;

    beforeEach(() => {
      mockPairClient.buildFlashLoan.mockReturnValue(mockOperation);
    });

    it("throws when locked", async () => {
      const lockedConfig: FlashLoanConfig = {
        ...mockConfig,
        locked: true,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(lockedConfig);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        FlashLoanError,
      );
      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        "Flash loans are currently disabled for this pair",
      );
    });

    it("throws when fee below floor", async () => {
      const badConfig: FlashLoanConfig = {
        flashFeeBps: 3, // Below floor of 5
        locked: false,
        flashFeeFloor: 5n,
      };
      mockPairClient.getFlashLoanConfig.mockResolvedValue(badConfig);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        FlashLoanError,
      );
      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        "Flash loan fee below protocol floor",
      );
    });

    it("returns correct FlashLoanResult on success", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const mockSubmitResult = {
        success: true,
        txHash: "test-tx-hash-123",
        data: {
          txHash: "test-tx-hash-123",
          ledger: 12345,
        },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      expect(result.txHash).toBe("test-tx-hash-123");
      expect(result.token).toBe(TEST_TOKEN_ADDRESS);
      expect(result.amount).toBe(100000n);
      expect(result.fee).toBe(90n); // (100000 * 9) / 10000 = 90
      expect(result.ledger).toBe(12345);

      expect(mockPairClient.buildFlashLoan).toHaveBeenCalledWith(
        client.publicKey,
        TEST_TOKEN_ADDRESS,
        100000n,
        TEST_RECEIVER_ADDRESS,
        Buffer.from("test-data"),
      );
    });

    it("throws TransactionError when submission fails", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const mockSubmitResult = {
        success: false,
        error: {
          code: "SIMULATION_FAILED",
          message: "Simulation failed",
        },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        TransactionError,
      );
      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        "Flash loan failed: Simulation failed",
      );
    });

    it("handles transaction with no error message", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const mockSubmitResult = {
        success: false,
        error: undefined,
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test"),
      };

      await expect(flashLoanModule.execute(request)).rejects.toThrow(
        "Flash loan failed: Unknown error",
      );
    });

    it("builds flash loan operation with correct parameters", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const mockSubmitResult = {
        success: true,
        txHash: "test-tx-hash",
        data: {
          txHash: "test-tx-hash",
          ledger: 12345,
        },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const callbackData = Buffer.from(JSON.stringify({ action: "arbitrage" }));
      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 500000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData,
      };

      await flashLoanModule.execute(request);

      expect(mockPairClient.buildFlashLoan).toHaveBeenCalledWith(
        client.publicKey,
        TEST_TOKEN_ADDRESS,
        500000n,
        TEST_RECEIVER_ADDRESS,
        callbackData,
      );

      expect(client.submitTransaction).toHaveBeenCalledWith([mockOperation]);
    });
  });
});

// ---------------------------------------------------------------------------
// Flash Loan Event Parsing Tests
// ---------------------------------------------------------------------------

/**
 * Helper to build mock ScVal structures for event testing.
 */
function symbolVal(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

function i128Val(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function scMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  const mapEntries = entries.map(
    ([key, val]) => new xdr.ScMapEntry({ key: symbolVal(key), val }),
  );
  return xdr.ScVal.scvMap(mapEntries);
}

/**
 * Build a mock xdr.DiagnosticEvent with the given topic and data.
 */
function makeDiagnosticEvent(
  topic: string,
  data: xdr.ScVal,
  contractAddr: string,
): xdr.DiagnosticEvent {
  const contractBuf = Address.fromString(contractAddr).toBuffer();
  const topics = [symbolVal(topic)];
  const bodyV0 = new xdr.ContractEventV0({ topics, data });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = new (xdr.ContractEventBody as any)(0, bodyV0) as xdr.ContractEventBody;

  const contractEvent = new xdr.ContractEvent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ext: new (xdr.ExtensionPoint as any)(0) as xdr.ExtensionPoint,
    contractId: contractBuf,
    type: xdr.ContractEventType.contract(),
    body,
  });

  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: contractEvent,
  });
}

describe("FlashLoanModule - Event Parsing", () => {
  const TEST_SECRET =
    "SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU";
  const TEST_PAIR_ADDRESS =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_TOKEN_ADDRESS =
    "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
  const TEST_RECEIVER_ADDRESS =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_BORROWER_ADDRESS =
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  let client: CoralSwapClient;
  let flashLoanModule: FlashLoanModule;
  let mockPairClient: jest.Mocked<PairClient>;

  beforeEach(() => {
    client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
    });

    flashLoanModule = new FlashLoanModule(client);

    // Create mock PairClient
    mockPairClient = {
      getFlashLoanConfig: jest.fn(),
      getReserves: jest.fn(),
      getTokens: jest.fn(),
      buildFlashLoan: jest.fn(),
    } as unknown as jest.Mocked<PairClient>;

    // Mock the client.pair() method to return our mock
    jest.spyOn(client, "pair").mockReturnValue(mockPairClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("execute() with event parsing", () => {
    const mockConfig: FlashLoanConfig = {
      flashFeeBps: 9,
      locked: false,
      flashFeeFloor: 5n,
    };

    const mockOperation = {} as xdr.Operation;

    beforeEach(() => {
      mockPairClient.buildFlashLoan.mockReturnValue(mockOperation);
    });

    it("includes decoded flash loan event in result on success", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-hash-123";
      const ledger = 12345;

      // Create a mock flash loan event
      const flashLoanEventData = scMap([
        ["borrower", addressVal(TEST_BORROWER_ADDRESS)],
        ["token", addressVal(TEST_TOKEN_ADDRESS)],
        ["amount", i128Val(100000n)],
        ["fee", i128Val(90n)],
      ]);

      const diagnosticEvent = makeDiagnosticEvent(
        EVENT_TOPICS.FLASH_LOAN,
        flashLoanEventData,
        TEST_PAIR_ADDRESS,
      );

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      // Mock getTransaction to return a response with the diagnostic event
      const mockTxResponse = {
        status: "SUCCESS",
        ledger,
        resultMetaXdr: {
          v3: () => ({
            sorobanMeta: () => ({
              diagnosticEvents: () => [diagnosticEvent],
            }),
          }),
        },
      } as unknown as SorobanRpc.Api.GetTransactionResponse;

      jest
        .spyOn(client.server, "getTransaction")
        .mockResolvedValue(mockTxResponse);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      expect(result.txHash).toBe(txHash);
      expect(result.token).toBe(TEST_TOKEN_ADDRESS);
      expect(result.amount).toBe(100000n);
      expect(result.fee).toBe(90n);
      expect(result.ledger).toBe(ledger);

      // Verify event was decoded
      expect(result.event).toBeDefined();
      expect(result.event?.type).toBe("FlashLoanExecuted");
      expect(result.event?.borrowedAmount).toBe(100000n);
      expect(result.event?.feePaid).toBe(90n);
      expect(result.event?.callbackAddress).toBe(TEST_BORROWER_ADDRESS);
    });

    it("returns result without event if event parsing fails gracefully", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-hash-456";
      const ledger = 12346;

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      // Mock getTransaction to throw an error
      jest
        .spyOn(client.server, "getTransaction")
        .mockRejectedValue(new Error("RPC error"));

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      // Should not throw, but return result without event
      const result = await flashLoanModule.execute(request);

      expect(result.txHash).toBe(txHash);
      expect(result.event).toBeUndefined();
    });

    it("handles transaction with no flash loan events", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-hash-789";
      const ledger = 12347;

      // Create a different event (not flash loan)
      const swapEventData = scMap([
        ["sender", addressVal(TEST_BORROWER_ADDRESS)],
        ["token_in", addressVal(TEST_TOKEN_ADDRESS)],
        ["token_out", addressVal(TEST_TOKEN_ADDRESS)],
        ["amount_in", i128Val(100000n)],
        ["amount_out", i128Val(99000n)],
        ["fee_bps", nativeToScVal(30, { type: "u32" })],
      ]);

      const diagnosticEvent = makeDiagnosticEvent(
        EVENT_TOPICS.SWAP,
        swapEventData,
        TEST_PAIR_ADDRESS,
      );

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const mockTxResponse = {
        status: "SUCCESS",
        ledger,
        resultMetaXdr: {
          v3: () => ({
            sorobanMeta: () => ({
              diagnosticEvents: () => [diagnosticEvent],
            }),
          }),
        },
      } as unknown as SorobanRpc.Api.GetTransactionResponse;

      jest
        .spyOn(client.server, "getTransaction")
        .mockResolvedValue(mockTxResponse);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      expect(result.txHash).toBe(txHash);
      expect(result.event).toBeUndefined();
    });

    it("extracts borrowedAmount and feePaid from decoded event", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-hash-event-fields";
      const ledger = 12348;
      const borrowedAmount = 500000n;
      const feePaid = 450n;

      const flashLoanEventData = scMap([
        ["borrower", addressVal(TEST_BORROWER_ADDRESS)],
        ["token", addressVal(TEST_TOKEN_ADDRESS)],
        ["amount", i128Val(borrowedAmount)],
        ["fee", i128Val(feePaid)],
      ]);

      const diagnosticEvent = makeDiagnosticEvent(
        EVENT_TOPICS.FLASH_LOAN,
        flashLoanEventData,
        TEST_PAIR_ADDRESS,
      );

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const mockTxResponse = {
        status: "SUCCESS",
        ledger,
        resultMetaXdr: {
          v3: () => ({
            sorobanMeta: () => ({
              diagnosticEvents: () => [diagnosticEvent],
            }),
          }),
        },
      } as unknown as SorobanRpc.Api.GetTransactionResponse;

      jest
        .spyOn(client.server, "getTransaction")
        .mockResolvedValue(mockTxResponse);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: borrowedAmount,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      // Verify event fields are accessible
      expect(result.event?.borrowedAmount).toBe(borrowedAmount);
      expect(result.event?.feePaid).toBe(feePaid);
      expect(result.event?.callbackAddress).toBe(TEST_BORROWER_ADDRESS);
    });

    it("handles multiple events and finds flash loan event", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-hash-multi-events";
      const ledger = 12349;

      // Create multiple events
      const syncEventData = scMap([
        ["reserve0", i128Val(1000000n)],
        ["reserve1", i128Val(2000000n)],
      ]);

      const flashLoanEventData = scMap([
        ["borrower", addressVal(TEST_BORROWER_ADDRESS)],
        ["token", addressVal(TEST_TOKEN_ADDRESS)],
        ["amount", i128Val(100000n)],
        ["fee", i128Val(90n)],
      ]);

      const syncEvent = makeDiagnosticEvent(
        EVENT_TOPICS.SYNC,
        syncEventData,
        TEST_PAIR_ADDRESS,
      );

      const flashLoanEvent = makeDiagnosticEvent(
        EVENT_TOPICS.FLASH_LOAN,
        flashLoanEventData,
        TEST_PAIR_ADDRESS,
      );

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const mockTxResponse = {
        status: "SUCCESS",
        ledger,
        resultMetaXdr: {
          v3: () => ({
            sorobanMeta: () => ({
              diagnosticEvents: () => [syncEvent, flashLoanEvent],
            }),
          }),
        },
      } as unknown as SorobanRpc.Api.GetTransactionResponse;

      jest
        .spyOn(client.server, "getTransaction")
        .mockResolvedValue(mockTxResponse);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 100000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      // Should find the flash loan event among multiple events
      expect(result.event).toBeDefined();
      expect(result.event?.type).toBe("FlashLoanExecuted");
      expect(result.event?.borrowedAmount).toBe(100000n);
    });

    it("returns result with event when transaction succeeds", async () => {
      mockPairClient.getFlashLoanConfig.mockResolvedValue(mockConfig);

      const txHash = "test-tx-success-with-event";
      const ledger = 12350;

      const flashLoanEventData = scMap([
        ["borrower", addressVal(TEST_BORROWER_ADDRESS)],
        ["token", addressVal(TEST_TOKEN_ADDRESS)],
        ["amount", i128Val(250000n)],
        ["fee", i128Val(225n)],
      ]);

      const diagnosticEvent = makeDiagnosticEvent(
        EVENT_TOPICS.FLASH_LOAN,
        flashLoanEventData,
        TEST_PAIR_ADDRESS,
      );

      const mockSubmitResult = {
        success: true,
        txHash,
        data: { txHash, ledger },
      };

      jest
        .spyOn(client, "submitTransaction")
        .mockResolvedValue(mockSubmitResult);

      const mockTxResponse = {
        status: "SUCCESS",
        ledger,
        resultMetaXdr: {
          v3: () => ({
            sorobanMeta: () => ({
              diagnosticEvents: () => [diagnosticEvent],
            }),
          }),
        },
      } as unknown as SorobanRpc.Api.GetTransactionResponse;

      jest
        .spyOn(client.server, "getTransaction")
        .mockResolvedValue(mockTxResponse);

      const request = {
        pairAddress: TEST_PAIR_ADDRESS,
        token: TEST_TOKEN_ADDRESS,
        amount: 250000n,
        receiverAddress: TEST_RECEIVER_ADDRESS,
        callbackData: Buffer.from("test-data"),
      };

      const result = await flashLoanModule.execute(request);

      // Verify complete result structure
      expect(result).toMatchObject({
        txHash,
        token: TEST_TOKEN_ADDRESS,
        amount: 250000n,
        fee: 225n,
        ledger,
      });

      expect(result.event).toMatchObject({
        type: "FlashLoanExecuted",
        borrowedAmount: 250000n,
        feePaid: 225n,
        callbackAddress: TEST_BORROWER_ADDRESS,
      });
    });
  });

  describe("compareFees()", () => {
    const AMOUNT = 1_000_000n;

    /** Configure the mocked pair to report a given flash and swap fee (bps). */
    function mockFees(flashFeeBps: number, swapFeeBps: number): void {
      mockPairClient.getFlashLoanConfig.mockResolvedValue({
        flashFeeBps,
        locked: false,
        flashFeeFloor: 0n,
      });
      mockPairClient.getDynamicFee = jest.fn().mockResolvedValue(swapFeeBps);
    }

    it("reports 'flashLoan' when the flash loan fee is cheaper", async () => {
      mockFees(9, 30);

      const result = await flashLoanModule.compareFees(TEST_PAIR_ADDRESS, AMOUNT);

      // flash = 1_000_000 * 9 / 10000 = 900; swap = 1_000_000 * 30 / 10000 = 3000
      expect(result.flashLoanFee).toBe(900n);
      expect(result.swapFee).toBe(3000n);
      expect(result.cheaperOption).toBe("flashLoan");
    });

    it("reports 'swap' when the swap fee is cheaper", async () => {
      mockFees(50, 10);

      const result = await flashLoanModule.compareFees(TEST_PAIR_ADDRESS, AMOUNT);

      // flash = 5000; swap = 1000
      expect(result.flashLoanFee).toBe(5000n);
      expect(result.swapFee).toBe(1000n);
      expect(result.cheaperOption).toBe("swap");
    });

    it("reports 'equal' when both fees match", async () => {
      mockFees(30, 30);

      const result = await flashLoanModule.compareFees(TEST_PAIR_ADDRESS, AMOUNT);

      expect(result.flashLoanFee).toBe(result.swapFee);
      expect(result.cheaperOption).toBe("equal");
    });

    it("fetches both fees in parallel", async () => {
      mockFees(9, 30);

      await flashLoanModule.compareFees(TEST_PAIR_ADDRESS, AMOUNT);

      expect(mockPairClient.getFlashLoanConfig).toHaveBeenCalledTimes(1);
      expect(mockPairClient.getDynamicFee).toHaveBeenCalledTimes(1);
    });

    it("throws ValidationError when the amount is zero", async () => {
      mockFees(9, 30);

      await expect(
        flashLoanModule.compareFees(TEST_PAIR_ADDRESS, 0n),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when the amount is negative", async () => {
      mockFees(9, 30);

      await expect(
        flashLoanModule.compareFees(TEST_PAIR_ADDRESS, -5n),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an invalid pair address", async () => {
      await expect(
        flashLoanModule.compareFees("not-an-address", AMOUNT),
      ).rejects.toThrow(ValidationError);
    });
  });
});

