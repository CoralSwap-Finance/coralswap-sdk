import { CoralSwapClient } from "@/client";
import {
  FlashLoanRequest,
  FlashLoanResult,
  FlashLoanFeeEstimate,
  FlashLoanExecutedEvent,
  FlashLoanFeeComparison,
  FlashLoanFailedEvent,
} from "@/types/flash-loan";
import { FlashLoanConfig } from "@/types/pool";
import { GasEstimate } from "@/types/gas";
import {
  calculateRepayment,
  validateFeeFloor,
} from "@/contracts/flash-receiver";
import { FlashLoanError } from "@/errors";
import { FeeModule } from "./fees";
import { validateAddress, validatePositiveAmount } from "@/utils/validation";
import { estimateGas } from "@/utils/gas";
import { DEFAULTS } from "@/config";
import { decodeEvents } from "@/utils/events";
import { SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * Flash Loan module -- first-class flash loan support for CoralSwap.
 *
 * Enables atomic borrow-and-repay operations within a single Soroban
 * transaction. The borrower must deploy a flash receiver contract that
 * implements the on_flash_loan callback.
 */
export class FlashLoanModule {
  private client: CoralSwapClient;

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Estimate the flash loan fee for a given amount.
   *
   * @param pairAddress - The address of the pair providing the flash loan
   * @param token - The token being borrowed
   * @param amount - The amount requested to borrow
   * @returns Estimated total fee information
   * @throws {FlashLoanError} If flash loans are locked for the pair
   * @example
   * const est = await client.flashLoans.estimateFee('C...', 'C...', 1000n);
   */
  async estimateFee(
    pairAddress: string,
    token: string,
    amount: bigint,
  ): Promise<FlashLoanFeeEstimate> {
    validateAddress(pairAddress, "pairAddress");
    validateAddress(token, "token");
    validatePositiveAmount(amount, "amount");

    const pair = this.client.pair(pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress,
        },
      );
    }

    const feeAmount = (amount * BigInt(config.flashFeeBps)) / BigInt(10000);
    const feeFloorAmount = BigInt(config.flashFeeFloor);
    const actualFee = feeAmount > feeFloorAmount ? feeAmount : feeFloorAmount;

    return {
      token,
      amount,
      feeBps: config.flashFeeBps,
      feeAmount: actualFee,
      feeFloor: Number(config.flashFeeFloor),
    };
  }

  /**
   * Compare the flash loan fee against the current dynamic swap fee for a
   * pair and amount.
   *
   * Arbitrageurs use this to decide whether borrowing via a flash loan is
   * cheaper than routing capital through a direct swap before committing to
   * a strategy. Both fees are fetched in parallel and reduced to absolute
   * token amounts using `(amount * feeBps) / 10000n`.
   *
   * @param pair - The address of the pair contract to compare fees for
   * @param amount - The notional amount the strategy would move (must be > 0)
   * @returns The two effective fees and which option is cheaper
   * @throws {ValidationError} If `pair` is invalid or `amount` is zero/negative
   * @example
   * const cmp = await client.flashLoans.compareFees('C...', 1_000_000n);
   * if (cmp.cheaperOption === 'flashLoan') {
   *   // borrow via flash loan
   * }
   */
  async compareFees(
    pair: string,
    amount: bigint,
  ): Promise<FlashLoanFeeComparison> {
    validateAddress(pair, "pair");
    validatePositiveAmount(amount, "amount");

    const fees = new FeeModule(this.client);

    // Fetch the flash loan fee (fee_bps) and the dynamic swap fee in parallel.
    const [config, swapEstimate] = await Promise.all([
      this.getConfig(pair),
      fees.estimateSwapFee(pair, amount),
    ]);

    // Reduce both fees to absolute token amounts on the same basis-points
    // formula so the comparison is apples-to-apples.
    const flashLoanFee = (amount * BigInt(config.flashFeeBps)) / 10000n;
    const swapFee = swapEstimate.feeAmount;

    let cheaperOption: FlashLoanFeeComparison["cheaperOption"];
    if (flashLoanFee < swapFee) {
      cheaperOption = "flashLoan";
    } else if (swapFee < flashLoanFee) {
      cheaperOption = "swap";
    } else {
      cheaperOption = "equal";
    }

    return { flashLoanFee, swapFee, cheaperOption };
  }

  /**
   * Execute a flash loan transaction, or estimate its fee.
   *
   * Pass `{ estimateOnly: true }` to dry-run the simulation and return a
   * {@link GasEstimate} without submitting.
   *
   * @param request - Parameters required to execute the flash loan
   * @param options.estimateOnly - When true, returns a fee estimate instead of submitting
   * @returns Receipt containing the transaction hash and flash loan details, or a GasEstimate
   * @throws {FlashLoanError} If flash loans are locked or if fee config is invalid
   * @throws {FlashLoanFailedError} If the flash loan execution fails on-chain
   * @throws {TransactionError} If the transaction submission fails
   * @example
   * const result = await client.flashLoans.execute({ pairAddress: 'C...', ... });
   * const gas = await client.flashLoans.execute({ pairAddress: 'C...', ... }, { estimateOnly: true });
   */
  async execute(
    request: FlashLoanRequest,
    options: { estimateOnly: true },
  ): Promise<GasEstimate>;
  async execute(
    request: FlashLoanRequest,
    options?: { estimateOnly?: false },
  ): Promise<FlashLoanResult>;
  async execute(
    request: FlashLoanRequest,
    options?: { estimateOnly?: boolean },
  ): Promise<FlashLoanResult | GasEstimate> {
    validateAddress(request.pairAddress, "pairAddress");
    validateAddress(request.token, "token");
    validatePositiveAmount(request.amount, "amount");
    validateAddress(request.receiverAddress, "receiverAddress");

    // Verify receiver contract implements the expected interface
    await this.verifyReceiverInterface(request.receiverAddress);

    const pair = this.client.pair(request.pairAddress);
    const config = await pair.getFlashLoanConfig();

    if (config.locked) {
      throw new FlashLoanError(
        "Flash loans are currently disabled for this pair",
        {
          pairAddress: request.pairAddress,
        },
      );
    }

    const feeFloorBps = DEFAULTS.flashFeeFloorBps;

    if (!validateFeeFloor(config.flashFeeBps, feeFloorBps)) {
      throw new FlashLoanError("Flash loan fee below protocol floor", {
        feeBps: config.flashFeeBps,
        feeFloor: config.flashFeeFloor,
      });
    }

    const feeEstimate = await this.estimateFee(
      request.pairAddress,
      request.token,
      request.amount,
    );

    // Pre-submission sanity check: verify expected repayment amount
    const expectedRepayment = calculateRepayment(
      request.amount,
      config.flashFeeBps,
    );
    const calculatedRepayment = request.amount + feeEstimate.feeAmount;

    if (calculatedRepayment < expectedRepayment) {
      throw new FlashLoanError(
        "Repayment validation failed: calculated repayment is below expected minimum",
        {
          expectedRepayment: expectedRepayment.toString(),
          calculatedRepayment: calculatedRepayment.toString(),
          amount: request.amount.toString(),
          fee: feeEstimate.feeAmount.toString(),
        },
      );
    }

    const op = pair.buildFlashLoan(
      this.client.publicKey,
      request.token,
      request.amount,
      request.receiverAddress,
      request.callbackData,
    );

    if (options?.estimateOnly) {
      return estimateGas(
        (ops) => this.client.simulateTransaction(ops, {}),
        [op],
      );
    }

    const result = await this.client.submitTransaction([op]);

    if (!result.success) {
      throw new FlashLoanError(
        `Flash loan failed: ${result.error?.message ?? "Unknown error"}`,
        undefined,
        result.txHash,
      );
    }

    // Parse events from the transaction result
    const txHash = result.txHash!;
    const ledger = result.data!.ledger;
    let event: FlashLoanExecutedEvent | undefined;

    try {
      // Fetch the full transaction result to decode events
      const txResult = await this.client.server.getTransaction(txHash);
      if (txResult.status === "SUCCESS") {
        const rawEvents = this.getRawEvents(txResult);
        const hasRawEvents =
          rawEvents.length > 0 || this.hasEventsAccessor(txResult);

        // A FlashLoanFailed event means the callback reverted; surface it as an error.
        const failedEvent = this.decodeFailedEvent(rawEvents);
        if (failedEvent) {
          throw new FlashLoanError(
            `Flash loan callback failed: ${failedEvent.reason}`,
            {
              reason: failedEvent.reason,
              token: failedEvent.token,
              borrowedAmount: failedEvent.borrowedAmount,
            },
          );
        }

        // Try decoding old-style executed event
        const executedEvent = this.decodeExecutedEvent(rawEvents);
        if (executedEvent) {
          event = executedEvent;
        } else {
          try {
            // Fall back to decodeEvents
            const events = decodeEvents(
              txResult as SorobanRpc.Api.GetSuccessfulTransactionResponse,
              {
                contractId: request.pairAddress,
              },
            );

            // Look for FlashLoanExecuted or FlashLoanFailed events
            const flashLoanEvent = events.find((e) => e.type === "flash_loan");
            if (flashLoanEvent && flashLoanEvent.type === "flash_loan") {
              event = {
                type: "FlashLoanExecuted",
                borrowedAmount: flashLoanEvent.amount,
                feePaid: flashLoanEvent.fee,
                callbackAddress: flashLoanEvent.borrower,
                token: request.token,
              };
            }
          } catch {
            // Ignore decodeEvents failures
          }

          if (!event && hasRawEvents) {
            // Fallback: raw event accessor existed (older contract) but no match;
            // synthesise an event from request values.
            event = {
              type: "FlashLoanExecuted",
              borrowedAmount: request.amount,
              feePaid: feeEstimate.feeAmount,
              callbackAddress: request.receiverAddress,
              token: request.token,
            };
          }
        }
      } else {
        // Non-SUCCESS status: provide fallback event from request values
        event = {
          type: "FlashLoanExecuted",
          borrowedAmount: request.amount,
          feePaid: feeEstimate.feeAmount,
          callbackAddress: request.receiverAddress,
          token: request.token,
        };
      }
    } catch (err) {
      if (err instanceof FlashLoanError) {
        throw err;
      }
      // Silently ignore event parsing failures to avoid breaking the happy path
      // The transaction succeeded, but we couldn't decode the events
    }

    return {
      txHash,
      token: request.token,
      amount: request.amount,
      fee: feeEstimate.feeAmount,
      ledger,
      event,
    };
  }

  /**
   * Get the flash loan configuration for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns Current setup for flash loans including floor and bps
   * @example
   * const config = await client.flashLoans.getConfig('C...');
   */
  async getConfig(pairAddress: string): Promise<FlashLoanConfig> {
    const pair = this.client.pair(pairAddress);
    return pair.getFlashLoanConfig();
  }

  /**
   * Check if flash loans are available for a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @returns True if the flash pool is unlocked
   * @example
   * const canFlash = await client.flashLoans.isAvailable('C...');
   */
  async isAvailable(pairAddress: string): Promise<boolean> {
    try {
      const config = await this.getConfig(pairAddress);
      return !config.locked;
    } catch {
      return false;
    }
  }

  /**
   * Calculate the total repayment amount (principal + fee).
   *
   * @param amount - The principal loaned amount
   * @param feeBps - The fee in basis points
   * @returns Total amount required for full repayment
   * @example
   * const totalDue = client.flashLoans.calculateRepayment(100n, 5);
   */
  calculateRepayment(amount: bigint, feeBps: number): bigint {
    return calculateRepayment(amount, feeBps);
  }

  /**
   * Get the maximum flash-borrowable amount for a token in a pair.
   *
   * @param pairAddress - The address of the pair contract
   * @param token - The address of the token to check limit for
   * @returns Maximum safe borrow limit accounting for a safety margin
   * @example
   * const maxBorrow = await client.flashLoans.getMaxBorrowable('C...', 'C...');
   */
  async getMaxBorrowable(pairAddress: string, token: string): Promise<bigint> {
    const pair = this.client.pair(pairAddress);
    const { reserve0, reserve1 } = await pair.getReserves();
    const tokens = await pair.getTokens();

    // Maximum borrowable is the full reserve minus a safety margin
    const reserve = tokens.token0 === token ? reserve0 : reserve1;
    const safetyMargin = reserve / 100n; // 1% buffer
    return reserve - safetyMargin;
  }

  private getRawEvents(txResult: any): xdr.ContractEvent[] {
    try {
      const sorobanMeta = txResult.resultMetaXdr.v3().sorobanMeta();
      return sorobanMeta?.events() ?? [];
    } catch {
      return [];
    }
  }

  private hasEventsAccessor(txResult: any): boolean {
    try {
      return (
        typeof txResult?.resultMetaXdr?.v3()?.sorobanMeta()?.events ===
        "function"
      );
    } catch {
      return false;
    }
  }

  private decodeExecutedEvent(
    events: xdr.ContractEvent[],
  ): FlashLoanExecutedEvent | null {
    for (const event of events) {
      if (event.type().name !== "contract") continue;

      const topics = event.body().v0().topics();
      if (!topics.length) continue;

      const eventName = this.topicSymbol(topics[0]);
      if (eventName !== "FlashLoanExecuted") continue;

      try {
        const data = scValToNative(event.body().v0().data()) as Record<
          string,
          unknown
        >;

        return {
          type: "FlashLoanExecuted",
          borrowedAmount: BigInt(
            String(data["amount"] ?? data["borrowed_amount"] ?? 0),
          ),
          feePaid: BigInt(String(data["fee"] ?? data["fee_paid"] ?? 0)),
          callbackAddress: String(
            data["callback"] ??
              data["callback_address"] ??
              data["receiver"] ??
              "",
          ),
          token: String(data["token"] ?? ""),
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private decodeFailedEvent(
    events: xdr.ContractEvent[],
  ): FlashLoanFailedEvent | null {
    for (const event of events) {
      if (event.type().name !== "contract") continue;

      const topics = event.body().v0().topics();
      if (!topics.length) continue;

      const eventName = this.topicSymbol(topics[0]);
      if (eventName !== "FlashLoanFailed") continue;

      try {
        const data = scValToNative(event.body().v0().data()) as Record<
          string,
          unknown
        >;

        return {
          type: "FlashLoanFailed",
          borrowedAmount: BigInt(
            String(data["amount"] ?? data["borrowed_amount"] ?? 0),
          ),
          token: String(data["token"] ?? ""),
          reason: String(
            data["reason"] ?? data["error"] ?? "callback reverted",
          ),
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private topicSymbol(topic: xdr.ScVal): string {
    try {
      return topic.sym().toString();
    } catch {
      return "";
    }
  }

  /**
   * Verify that a receiver contract implements the expected on_flash_loan interface.
   *
   * Performs a simulated call to probe for the interface presence before
   * executing the actual flash loan transaction. This prevents funds from
   * being sent to a non-compliant contract.
   *
   * @param receiverAddress - The address of the receiver contract to verify
   * @throws {FlashLoanError} If the receiver doesn't implement on_flash_loan
   * @private
   */
  private async verifyReceiverInterface(
    receiverAddress: string,
  ): Promise<void> {
    try {
      const {
        Contract: ContractClass,
        Address: AddressClass,
        nativeToScVal: toScVal,
        xdr: xdrTypes,
      } = await import("@stellar/stellar-sdk");

      const contract = new ContractClass(receiverAddress);

      // Simulate a call to on_flash_loan with dummy parameters
      // We're only checking if the function exists, not executing it
      const dummySender = new AddressClass(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      );
      const dummyToken = new AddressClass(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      );

      const op = contract.call(
        "on_flash_loan",
        dummySender.toScVal(),
        dummyToken.toScVal(),
        toScVal(0n, { type: "i128" }),
        toScVal(0n, { type: "i128" }),
        xdrTypes.ScVal.scvBytes(Buffer.from([])),
      );

      const sim = await this.client.simulateTransaction([op], {});

      // If simulation returns an error specifically about missing function,
      // that means the interface isn't implemented
      if (!sim.success && sim.error) {
        const errorMsg = sim.error || "";
        if (
          errorMsg.includes("unknown function") ||
          errorMsg.includes("function not found") ||
          errorMsg.includes("on_flash_loan")
        ) {
          throw new FlashLoanError(
            `Receiver contract at ${receiverAddress} does not implement the on_flash_loan interface`,
            {
              receiverAddress,
              reason: "missing_interface",
            },
          );
        }
      }

      // If we got here, either the simulation succeeded (function exists)
      // or failed for a different reason (which we'll catch during actual execution)
    } catch (err) {
      if (err instanceof FlashLoanError) {
        throw err;
      }
      // Other errors during verification are non-fatal; we'll let the actual
      // execution fail with a more specific on-chain error if needed
    }
  }
}
