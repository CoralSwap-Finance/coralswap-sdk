import { getTransactionStatus, submitIdempotent } from "../../src/utils/transactionStatus";
import { MockProvider } from "../mocks/MockProvider"; // CHECK: real import path

describe("getTransactionStatus", () => {
  it("reports SUCCESS when the transaction landed on-chain", async () => {
    const mock = new MockProvider();
    mock.setTransactionResult("abc123", { status: "SUCCESS", ledger: 100 });

    const result = await getTransactionStatus(mock as any, "abc123");
    expect(result.status).toBe("SUCCESS");
  });

  it("reports NOT_FOUND when the transaction never landed", async () => {
    const mock = new MockProvider();
    mock.setTransactionResult("abc123", { status: "NOT_FOUND" });

    const result = await getTransactionStatus(mock as any, "abc123");
    expect(result.status).toBe("NOT_FOUND");
  });
});

describe("submitIdempotent", () => {
  it("does NOT resubmit when a timed-out submission actually landed", async () => {
    const mock = new MockProvider();
    let buildCalls = 0;

    const buildTx = async () => {
      buildCalls++;
      return { hash: "tx-1", envelope: {} as any };
    };
    const submit = async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    };

    mock.setTransactionResult("tx-1", { status: "SUCCESS", ledger: 42 });

    const result = await submitIdempotent(mock as any, buildTx, submit, {
      statusCheckDelayMs: 0,
    });

    expect(result.status).toBe("SUCCESS");
    expect(buildCalls).toBe(1); // must NOT have rebuilt/resubmitted
  });

  it("rebuilds and resubmits when the transaction genuinely never landed", async () => {
    const mock = new MockProvider();
    let buildCalls = 0;
    let submitCalls = 0;

    const buildTx = async () => {
      buildCalls++;
      return { hash: `tx-${buildCalls}`, envelope: {} as any };
    };
    const submit = async (_envelope: any) => {
      submitCalls++;
      if (submitCalls === 1) {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      return { hash: `tx-${buildCalls}` };
    };

    mock.setTransactionResult("tx-1", { status: "NOT_FOUND" });
    mock.setTransactionResult("tx-2", { status: "SUCCESS", ledger: 50 });

    const result = await submitIdempotent(mock as any, buildTx, submit, {
      statusCheckDelayMs: 0,
    });

    expect(result.status).toBe("SUCCESS");
    expect(buildCalls).toBe(2); // rebuilt with fresh sequence number
  });

  it("throws non-retryable errors immediately without checking status", async () => {
    const mock = new MockProvider();
    const buildTx = async () => ({ hash: "tx-1", envelope: {} as any });
    const submit = async () => {
      throw new Error("insufficient balance"); // not retryable
    };

    await expect(
      submitIdempotent(mock as any, buildTx, submit)
    ).rejects.toThrow("insufficient balance");
  });
});