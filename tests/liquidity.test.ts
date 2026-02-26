import { LiquidityModule } from "../src/modules/liquidity";
import { CoralSwapClient } from "../src/client";
import { PairClient } from "../src/contracts/pair";
import { PRECISION } from "../src/config";
import { ValidationError, TransactionError } from "../src/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock CoralSwapClient with overridable factory methods.
 *
 * By default `getPairAddress` returns `null` (simulating "first LP" scenario).
 * Pass overrides to configure reserves, tokens, and LP total supply.
 */
function createMockClient(
  overrides: {
    pairAddress?: string | null;
    reserve0?: bigint;
    reserve1?: bigint;
    token0?: string;
    token1?: string;
    totalSupply?: bigint;
  } = {},
): CoralSwapClient {
  const {
    pairAddress = null,
    reserve0 = 0n,
    reserve1 = 0n,
    token0 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    token1 = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
    totalSupply = 0n,
  } = overrides;

  return {
    getPairAddress: jest.fn().mockResolvedValue(pairAddress),
    pair: jest.fn().mockReturnValue({
      getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      getTokens: jest.fn().mockResolvedValue({ token0, token1 }),
    }),
    lpToken: jest.fn().mockReturnValue({
      totalSupply: jest.fn().mockResolvedValue(totalSupply),
      balance: jest.fn().mockResolvedValue(0n),
    }),
  } as unknown as CoralSwapClient;
}

/**
 * Access the private `sqrt` method via type coercion.
 */
function sqrtOf(module: LiquidityModule, value: bigint): bigint {
  return (module as any).sqrt(value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LiquidityModule", () => {
  // -----------------------------------------------------------------------
  // sqrt() — Babylonian integer square root
  // -----------------------------------------------------------------------
  describe("sqrt()", () => {
    let module: LiquidityModule;

    beforeEach(() => {
      module = new LiquidityModule(createMockClient());
    });

    it("sqrt(0n) returns 0n", () => {
      expect(sqrtOf(module, 0n)).toBe(0n);
    });

    it("sqrt(1n) returns 1n", () => {
      expect(sqrtOf(module, 1n)).toBe(1n);
    });

    it("sqrt(4n) returns 2n", () => {
      expect(sqrtOf(module, 4n)).toBe(2n);
    });

    it("sqrt(9n) returns 3n", () => {
      expect(sqrtOf(module, 9n)).toBe(3n);
    });

    it("sqrt(16n) returns 4n", () => {
      expect(sqrtOf(module, 16n)).toBe(4n);
    });

    it("sqrt(25n) returns 5n", () => {
      expect(sqrtOf(module, 25n)).toBe(5n);
    });

    it("handles large perfect square: sqrt(10n ** 36n) returns 10n ** 18n", () => {
      expect(sqrtOf(module, 10n ** 36n)).toBe(10n ** 18n);
    });

    it("floors non-perfect square: sqrt(2n) returns 1n", () => {
      expect(sqrtOf(module, 2n)).toBe(1n);
    });

    it("floors non-perfect square: sqrt(3n) returns 1n", () => {
      expect(sqrtOf(module, 3n)).toBe(1n);
    });

    it("floors non-perfect square: sqrt(8n) returns 2n", () => {
      expect(sqrtOf(module, 8n)).toBe(2n);
    });

    it("floors non-perfect square: sqrt(10n) returns 3n", () => {
      expect(sqrtOf(module, 10n)).toBe(3n);
    });

    it("throws ValidationError for negative input", () => {
      expect(() => sqrtOf(module, -1n)).toThrow(ValidationError);
      expect(() => sqrtOf(module, -1n)).toThrow(
        "Square root of negative number",
      );
    });

    it("throws ValidationError for large negative input", () => {
      expect(() => sqrtOf(module, -(10n ** 18n))).toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // getAddLiquidityQuote()
  // -----------------------------------------------------------------------
  describe("getAddLiquidityQuote()", () => {
    const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
    const PAIR_ADDRESS =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";

    // -- First liquidity provider (no existing pair) ----------------------

    describe("first liquidity provider (no pair exists)", () => {
      it("returns desired amounts as-is for both tokens", async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n;

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          amount,
        );

        expect(quote.amountA).toBe(amount);
        expect(quote.amountB).toBe(amount);
      });

      it("returns sqrt(amountA * amountB) - MIN_LIQUIDITY as estimated LP tokens", async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);
        const amount = 1_000_000n;

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          amount,
        );

        // For first LP: amountA == amountB == amount, so sqrt(amount * amount) == amount
        const expectedLP = amount - PRECISION.MIN_LIQUIDITY;
        expect(quote.estimatedLPTokens).toBe(expectedLP);
      });

      it("returns 100% share of pool", async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          1_000_000n,
        );

        expect(quote.shareOfPool).toBe(1.0);
      });

      it("returns 1:1 price ratio", async () => {
        const client = createMockClient({ pairAddress: null });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          1_000_000n,
        );

        expect(quote.priceAPerB).toBe(PRECISION.PRICE_SCALE);
        expect(quote.priceBPerA).toBe(PRECISION.PRICE_SCALE);
      });
    });

    // -- Proportional deposit (existing pair with reserves) ---------------

    describe("proportional deposit (existing pair)", () => {
      it("calculates optimal amountB based on reserve ratio", async () => {
        // Pool has 1000 A : 2000 B (1:2 ratio)
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 1000n,
          reserve1: 2000n,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 100n);

        // amountB = (100 * 2000) / 1000 = 200
        expect(quote.amountB).toBe(200n);
        expect(quote.amountA).toBe(100n);
      });

      it("calculates LP tokens proportionally to total supply", async () => {
        const reserveA = 10_000n;
        const reserveB = 20_000n;
        const totalSupply = 5_000n;
        const amountA = 1_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          amountA,
        );

        // estimatedLP = (amountA * totalSupply) / reserveA = (1000 * 5000) / 10000 = 500
        const expectedLP = (amountA * totalSupply) / reserveA;
        expect(quote.estimatedLPTokens).toBe(expectedLP);
      });

      it("computes correct fractional share of pool", async () => {
        const totalSupply = 10_000n;
        const reserveA = 100_000n;
        const reserveB = 200_000n;
        const amountA = 10_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          amountA,
        );

        // estimatedLP = (10000 * 10000) / 100000 = 1000
        // share = 1000 * 10000 / (10000 + 1000) / 10000
        const estimatedLP = (amountA * totalSupply) / reserveA;
        const expectedShare =
          Number((estimatedLP * 10000n) / (totalSupply + estimatedLP)) / 10000;

        expect(quote.shareOfPool).toBe(expectedShare);
        expect(quote.shareOfPool).toBeGreaterThan(0);
        expect(quote.shareOfPool).toBeLessThan(1);
      });

      it("computes correct price ratios using PRICE_SCALE", async () => {
        const reserveA = 1_000_000n;
        const reserveB = 2_000_000n;

        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserveA,
          reserve1: reserveB,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 100n);

        // priceAPerB = (reserveB * PRICE_SCALE) / reserveA = 2 * PRICE_SCALE
        expect(quote.priceAPerB).toBe(
          (reserveB * PRECISION.PRICE_SCALE) / reserveA,
        );
        // priceBPerA = (reserveA * PRICE_SCALE) / reserveB = 0.5 * PRICE_SCALE
        expect(quote.priceBPerA).toBe(
          (reserveA * PRECISION.PRICE_SCALE) / reserveB,
        );
      });

      it("handles token ordering when tokenA is token1", async () => {
        // tokenA is actually token1 in the pair, so reserveA = reserve1
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 5000n,
          reserve1: 10000n,
          token0: TOKEN_B, // tokenB is token0
          token1: TOKEN_A, // tokenA is token1
          totalSupply: 2000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          1000n,
        );

        // reserveA = reserve1 = 10000, reserveB = reserve0 = 5000
        // amountB = (1000 * 5000) / 10000 = 500
        expect(quote.amountB).toBe(500n);

        // estimatedLP = (1000 * 2000) / 10000 = 200
        expect(quote.estimatedLPTokens).toBe(200n);
      });
    });

    // -- Edge cases -------------------------------------------------------

    describe("edge cases", () => {
      it("equal reserves yield 1:1 deposit ratio", async () => {
        const reserve = 1_000_000n;
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: reserve,
          reserve1: reserve,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 1000n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(TOKEN_A, TOKEN_B, 500n);

        expect(quote.amountA).toBe(500n);
        expect(quote.amountB).toBe(500n);
      });

      it("small deposit into large pool yields small share", async () => {
        const client = createMockClient({
          pairAddress: PAIR_ADDRESS,
          reserve0: 10n ** 18n,
          reserve1: 10n ** 18n,
          token0: TOKEN_A,
          token1: TOKEN_B,
          totalSupply: 10n ** 15n,
        });
        const module = new LiquidityModule(client);

        const quote = await module.getAddLiquidityQuote(
          TOKEN_A,
          TOKEN_B,
          1000n,
        );

        expect(quote.shareOfPool).toBeLessThan(0.001);
        expect(quote.estimatedLPTokens).toBeGreaterThan(0n);
      });
    });
  });

  // -----------------------------------------------------------------------
  // getPosition() — LP token address resolution
  // -----------------------------------------------------------------------
  describe("getPosition", () => {
    let module: LiquidityModule;
    let mockClient: jest.Mocked<CoralSwapClient>;
    let mockPairClient: jest.Mocked<PairClient>;
    let mockLPClient: any;

    beforeEach(() => {
      mockPairClient = {
        getReserves: jest
          .fn()
          .mockResolvedValue({ reserve0: 1000n, reserve1: 2000n }),
        getTokens: jest.fn().mockResolvedValue({
          token0: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
          token1: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
        }),
        getLPTokenAddress: jest
          .fn()
          .mockResolvedValue(
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
          ),
      } as any;

      mockLPClient = {
        balance: jest.fn().mockResolvedValue(500n),
        totalSupply: jest.fn().mockResolvedValue(10000n),
      };

      mockClient = {
        pair: jest.fn().mockReturnValue(mockPairClient),
        lpToken: jest.fn().mockReturnValue(mockLPClient),
      } as any;

      module = new LiquidityModule(mockClient);
    });

    it("fetches LP token address from pair contract and correctly calculates position", async () => {
      const position = await module.getPosition(
        "PAIR_ADDRESS",
        "OWNER_ADDRESS",
      );

      expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
      expect(mockClient.lpToken).toHaveBeenCalledWith(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
      );
      expect(position.lpTokenAddress).toBe(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
      );
      expect(position.balance).toBe(500n);
      expect(position.share).toBe(0.05); // 500 / 10000
    });

    it("caches the LP token address to avoid redundant calls", async () => {
      await module.getPosition("PAIR_ADDRESS", "OWNER_ADDRESS");
      await module.getPosition("PAIR_ADDRESS", "OTHER_OWNER");

      // Should only be called once due to caching
      expect(mockPairClient.getLPTokenAddress).toHaveBeenCalledTimes(1);
      expect(mockClient.lpToken).toHaveBeenCalledWith(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4",
      );
      expect(mockClient.lpToken).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // addLiquidity() — Execute add liquidity transaction
  // -----------------------------------------------------------------------
  describe("addLiquidity()", () => {
    const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
    const TO_ADDRESS =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";

    let module: LiquidityModule;
    let mockClient: jest.Mocked<CoralSwapClient>;
    let mockRouter: any;

    beforeEach(() => {
      mockRouter = {
        buildAddLiquidity: jest.fn().mockReturnValue({} as any),
      };

      mockClient = {
        router: mockRouter,
        submitTransaction: jest.fn().mockResolvedValue({
          success: true,
          txHash: "test-tx-hash",
          data: { ledger: 12345 },
        }),
        getDeadline: jest.fn().mockReturnValue(1234567890),
      } as any;

      module = new LiquidityModule(mockClient);
    });

    it("successfully adds liquidity with valid request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      const result = await module.addLiquidity(request);

      expect(mockRouter.buildAddLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        1000n,
        2000n,
        900n,
        1800n,
        1234567890, // deadline should be from client since we didn't provide one
      );
      expect(mockClient.submitTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        txHash: "test-tx-hash",
        amountA: 1000n,
        amountB: 2000n,
        liquidity: 0n,
        ledger: 12345,
      });
    });

    it("uses client deadline when not provided in request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await module.addLiquidity(request);

      expect(mockRouter.buildAddLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        1000n,
        2000n,
        900n,
        1800n,
        1234567890, // deadline from client
      );
    });

    it("uses provided deadline when specified in request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
        deadline: 9999999999,
      };

      await module.addLiquidity(request);

      expect(mockRouter.buildAddLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        1000n,
        2000n,
        900n,
        1800n,
        9999999999, // provided deadline
      );
    });

    it("throws TransactionError when transaction fails", async () => {
      mockClient.submitTransaction.mockResolvedValue({
        success: false,
        error: {
          code: "INSUFFICIENT_BALANCE",
          message: "Insufficient balance",
        },
        txHash: "failed-tx-hash",
      });

      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        TransactionError,
      );
      await expect(module.addLiquidity(request)).rejects.toThrow(
        "Add liquidity failed: Insufficient balance",
      );
    });

    it("throws ValidationError when amountAMin exceeds amountADesired", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 1100n, // More than desired
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
      await expect(module.addLiquidity(request)).rejects.toThrow(
        "amountAMin must not exceed amountADesired",
      );
    });

    it("throws ValidationError when amountBMin exceeds amountBDesired", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 2100n, // More than desired
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
      await expect(module.addLiquidity(request)).rejects.toThrow(
        "amountBMin must not exceed amountBDesired",
      );
    });

    it("throws ValidationError for invalid token addresses", async () => {
      const request = {
        tokenA: "invalid-address",
        tokenB: TOKEN_B,
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });

    it("throws ValidationError for identical tokens", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_A, // Same as tokenA
        amountADesired: 1000n,
        amountBDesired: 2000n,
        amountAMin: 900n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });

    it("throws ValidationError for zero amounts", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        amountADesired: 0n, // Zero amount
        amountBDesired: 2000n,
        amountAMin: 0n,
        amountBMin: 1800n,
        to: TO_ADDRESS,
      };

      await expect(module.addLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // removeLiquidity() — Execute remove liquidity transaction
  // -----------------------------------------------------------------------
  describe("removeLiquidity()", () => {
    const TOKEN_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const TOKEN_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
    const TO_ADDRESS =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM";

    let module: LiquidityModule;
    let mockClient: jest.Mocked<CoralSwapClient>;
    let mockRouter: any;

    beforeEach(() => {
      mockRouter = {
        buildRemoveLiquidity: jest.fn().mockReturnValue({} as any),
      };

      mockClient = {
        router: mockRouter,
        submitTransaction: jest.fn().mockResolvedValue({
          success: true,
          txHash: "test-tx-hash",
          data: { ledger: 12345 },
        }),
        getDeadline: jest.fn().mockReturnValue(1234567890),
      } as any;

      module = new LiquidityModule(mockClient);
    });

    it("successfully removes liquidity with valid request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      const result = await module.removeLiquidity(request);

      expect(mockRouter.buildRemoveLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        500n,
        400n,
        800n,
        1234567890, // deadline should be from client since we didn't provide one
      );
      expect(mockClient.submitTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        txHash: "test-tx-hash",
        amountA: 400n,
        amountB: 800n,
        liquidity: 500n,
        ledger: 12345,
      });
    });

    it("uses client deadline when not provided in request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      await module.removeLiquidity(request);

      expect(mockRouter.buildRemoveLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        500n,
        400n,
        800n,
        1234567890, // deadline from client
      );
    });

    it("uses provided deadline when specified in request", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
        deadline: 9999999999,
      };

      await module.removeLiquidity(request);

      expect(mockRouter.buildRemoveLiquidity).toHaveBeenCalledWith(
        TO_ADDRESS,
        TOKEN_A,
        TOKEN_B,
        500n,
        400n,
        800n,
        9999999999, // provided deadline
      );
    });

    it("throws TransactionError when transaction fails", async () => {
      mockClient.submitTransaction.mockResolvedValue({
        success: false,
        error: {
          code: "INSUFFICIENT_LP_BALANCE",
          message: "Insufficient LP balance",
        },
        txHash: "failed-tx-hash",
      });

      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      await expect(module.removeLiquidity(request)).rejects.toThrow(
        TransactionError,
      );
      await expect(module.removeLiquidity(request)).rejects.toThrow(
        "Remove liquidity failed: Insufficient LP balance",
      );
    });

    it("throws ValidationError for invalid token addresses", async () => {
      const request = {
        tokenA: "invalid-address",
        tokenB: TOKEN_B,
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      await expect(module.removeLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });

    it("throws ValidationError for identical tokens", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_A, // Same as tokenA
        liquidity: 500n,
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      await expect(module.removeLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });

    it("throws ValidationError for zero liquidity", async () => {
      const request = {
        tokenA: TOKEN_A,
        tokenB: TOKEN_B,
        liquidity: 0n, // Zero liquidity
        amountAMin: 400n,
        amountBMin: 800n,
        to: TO_ADDRESS,
      };

      await expect(module.removeLiquidity(request)).rejects.toThrow(
        ValidationError,
      );
    });
  });

  // -----------------------------------------------------------------------
  // getAllPositions() — Get all LP positions for an address
  // -----------------------------------------------------------------------
  describe("getAllPositions()", () => {
    let module: LiquidityModule;
    let mockClient: jest.Mocked<CoralSwapClient>;
    let mockFactory: any;
    let mockPairClient1: any;
    let mockPairClient2: any;
    let mockPairClient3: any;
    let mockLPClient1: any;
    let mockLPClient2: any;
    let mockLPClient3: any;

    beforeEach(() => {
      mockLPClient1 = {
        balance: jest.fn().mockResolvedValue(1000n),
        totalSupply: jest.fn().mockResolvedValue(10000n),
      };

      mockLPClient2 = {
        balance: jest.fn().mockResolvedValue(0n), // No position
        totalSupply: jest.fn().mockResolvedValue(20000n),
      };

      mockLPClient3 = {
        balance: jest.fn().mockResolvedValue(500n),
        totalSupply: jest.fn().mockResolvedValue(5000n),
      };

      mockPairClient1 = {
        getReserves: jest
          .fn()
          .mockResolvedValue({ reserve0: 1000n, reserve1: 2000n }),
        getTokens: jest.fn().mockResolvedValue({
          token0: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
          token1: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
        }),
        getLPTokenAddress: jest.fn().mockResolvedValue("LP_TOKEN_1"),
      };

      mockPairClient2 = {
        getReserves: jest
          .fn()
          .mockResolvedValue({ reserve0: 3000n, reserve1: 4000n }),
        getTokens: jest.fn().mockResolvedValue({
          token0: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
          token1: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGA3U",
        }),
        getLPTokenAddress: jest.fn().mockResolvedValue("LP_TOKEN_2"),
      };

      mockPairClient3 = {
        getReserves: jest
          .fn()
          .mockResolvedValue({ reserve0: 5000n, reserve1: 6000n }),
        getTokens: jest.fn().mockResolvedValue({
          token0: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGA3U",
          token1: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHCV4",
        }),
        getLPTokenAddress: jest.fn().mockResolvedValue("LP_TOKEN_3"),
      };

      mockFactory = {
        getAllPairs: jest
          .fn()
          .mockResolvedValue(["PAIR_1", "PAIR_2", "PAIR_3"]),
      };

      mockClient = {
        factory: mockFactory,
        pair: jest
          .fn()
          .mockReturnValueOnce(mockPairClient1)
          .mockReturnValueOnce(mockPairClient2)
          .mockReturnValueOnce(mockPairClient3),
        lpToken: jest
          .fn()
          .mockReturnValueOnce(mockLPClient1)
          .mockReturnValueOnce(mockLPClient2)
          .mockReturnValueOnce(mockLPClient3),
      } as any;

      module = new LiquidityModule(mockClient);
    });

    it("returns only positions with non-zero balances", async () => {
      const positions = await module.getAllPositions("OWNER_ADDRESS");

      expect(positions).toHaveLength(2); // Only 2 positions have non-zero balances
      expect(positions[0].balance).toBe(1000n);
      expect(positions[1].balance).toBe(500n);
    });

    it("calculates correct share and token amounts for each position", async () => {
      const positions = await module.getAllPositions("OWNER_ADDRESS");

      // First position
      expect(positions[0].share).toBe(0.1); // 1000 / 10000
      expect(positions[0].token0Amount).toBe(100n); // (1000 * 1000) / 10000
      expect(positions[0].token1Amount).toBe(200n); // (1000 * 2000) / 10000

      // Second position
      expect(positions[1].share).toBe(0.1); // 500 / 5000
      expect(positions[1].token0Amount).toBe(500n); // (500 * 5000) / 5000
      expect(positions[1].token1Amount).toBe(600n); // (500 * 6000) / 5000
    });

    it("handles empty pair list", async () => {
      mockFactory.getAllPairs.mockResolvedValue([]);

      const positions = await module.getAllPositions("OWNER_ADDRESS");

      expect(positions).toHaveLength(0);
    });

    it("handles all zero balances", async () => {
      mockLPClient1.balance.mockResolvedValue(0n);
      mockLPClient3.balance.mockResolvedValue(0n);

      const positions = await module.getAllPositions("OWNER_ADDRESS");

      expect(positions).toHaveLength(0);
    });

    it("handles zero total supply", async () => {
      mockLPClient1.totalSupply.mockResolvedValue(0n);
      mockLPClient3.totalSupply.mockResolvedValue(0n);

      const positions = await module.getAllPositions("OWNER_ADDRESS");

      // Positions should still be returned if balance > 0
      expect(positions).toHaveLength(2);
      expect(positions[0].share).toBe(0);
      expect(positions[0].token0Amount).toBe(0n);
      expect(positions[0].token1Amount).toBe(0n);
    });
  });
});
