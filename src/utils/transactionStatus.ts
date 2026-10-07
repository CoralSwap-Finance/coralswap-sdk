import { Server } from "@stellar/stellar-sdk/rpc"; // CHECK: exact import path used elsewhere in this SDK
import { isRetryable } from "./retry";

export type TxLandedStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

export interface TransactionStatusResult {
  status: TxLandedStatus;
  hash: string;
  ledger?: number;
}

/**
 * Looks up whether a submitted transaction actually landed on-chain,
 * independent of whether the client received a response for it.
 *
 * This is the safety check that must run before ANY retry/resubmit of a
 * state-changing call — a client-side timeout does not mean the
 * transaction failed; it may have already been included in a ledger.
 */
export async function getTransactionStatus(
  server: Server, // CHECK: real type name used by CoralSwapClient's RPC accessor
  hash: string
): Promise<TransactionStatusResult> {
  const response = await server.getTransaction(hash);

  switch (response.status) {
    case "SUCCESS":
      return { status: "SUCCESS", hash, ledger: response.ledger };
    case "FAILED":
      return { status: "FAILED", hash, ledger: response.ledger };
    case "NOT_FOUND":
    default:
      return { status: "NOT_FOUND", hash };
  }
}

/**
 * Submits a transaction and, if the submission itself fails with a
 * retryable error (timeout, connection abort), checks the REAL on-chain
 * status before ever rebuilding/resubmitting.
 *
 * - If the original tx landed (SUCCESS or FAILED on-chain), this returns
 *   that real result instead of blindly resubmitting — resubmitting a
 *   transaction that already succeeded would double-execute it.
 * - If the original tx genuinely never landed (NOT_FOUND after the retry
 *   window), it's safe to rebuild with a fresh sequence number and
 *   resubmit.
 *
 * `buildTx` must build a NEW transaction envelope each call (fresh
 * sequence number) — do not reuse a stale envelope across attempts.
 */
export async function submitIdempotent<T>(
  server: Server,
  buildTx: () => Promise<{ hash: string; envelope: T }>,
  submit: (envelope: T) => Promise<{ hash: string }>,
  options: { maxAttempts?: number; statusCheckDelayMs?: number } = {}
): Promise<TransactionStatusResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const statusCheckDelayMs = options.statusCheckDelayMs ?? 2000;

  let lastHash: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { hash, envelope } = await buildTx();
    lastHash = hash;

    try {
      await submit(envelope);
      // Submission accepted — confirm final on-chain status.
      return await pollUntilFinal(server, hash, statusCheckDelayMs);
    } catch (err) {
      if (!isRetryable(err)) {
        throw err;
      }

      // Do NOT blindly resubmit. Check whether the tx that just timed
      // out actually landed before deciding to retry.
      const realStatus = await getTransactionStatus(server, hash);

      if (realStatus.status === "SUCCESS" || realStatus.status === "FAILED") {
        // It landed despite the client-side error — return the real
        // result instead of resubmitting and risking double-execution.
        return realStatus;
      }

      // NOT_FOUND: genuinely never landed, safe to loop and rebuild
      // with a fresh sequence number on the next iteration.
      continue;
    }
  }

  throw new Error(
    `submitIdempotent: exhausted ${maxAttempts} attempts, last hash: ${lastHash}`
  );
}

async function pollUntilFinal(
  server: Server,
  hash: string,
  delayMs: number,
  maxPolls = 10
): Promise<TransactionStatusResult> {
  for (let i = 0; i < maxPolls; i++) {
    const result = await getTransactionStatus(server, hash);
    if (result.status !== "NOT_FOUND") return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { status: "NOT_FOUND", hash };
}