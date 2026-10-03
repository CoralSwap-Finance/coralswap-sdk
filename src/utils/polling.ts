import { rpc } from '@stellar/stellar-sdk';
import { Result, Logger } from '../types/common';

/**
 * Polling strategy for transaction confirmation.
 */
export enum PollingStrategy {
    /** Fixed interval between attempts. */
    LINEAR = 'LINEAR',
    /** Doubling interval between attempts (with optional cap). */
    EXPONENTIAL = 'EXPONENTIAL',
}

/**
 * Configuration options for the TransactionPoller.
 */
export interface PollingOptions {
    /** Strategy to use (LINEAR or EXPONENTIAL). Defaults to LINEAR. */
    strategy?: PollingStrategy;
    /** Initial delay between polls in milliseconds. Defaults to 1000. */
    interval?: number;
    /** Maximum number of polling attempts. Defaults to 30. */
    maxAttempts?: number;
    /** Multiplier for exponential backoff. Defaults to 2. */
    backoffFactor?: number;
    /** Maximum delay between polls in milliseconds. Defaults to 10000. */
    maxInterval?: number;
    /**
     * Optional signal to cancel polling. Checked before each attempt and
     * interrupts the delay between attempts early -- it does not abort an
     * in-flight `getTransaction` RPC call.
     */
    signal?: AbortSignal;
}

/**
 * Robust utility for polling Soroban transaction status with customizable strategies.
 */
export class TransactionPoller {
    private server: rpc.Server;
    private logger?: Logger;

    constructor(server: rpc.Server, logger?: Logger) {
        this.server = server;
        this.logger = logger;
    }

    /**
     * Poll for transaction confirmation using the specified strategy.
     *
     * @param txHash - Hash of the transaction to poll.
     * @param options - Polling configuration.
     * @returns A Result with transaction data or an error. Exhausted
     *   NOT_FOUND responses return TX_NOT_CONFIRMED; RPC failures return
     *   TX_TIMEOUT after at most three consecutive errors.
     */
    async poll(
        txHash: string,
        options: PollingOptions = {},
    ): Promise<Result<{ txHash: string; ledger: number }>> {
        const strategy = options.strategy ?? PollingStrategy.LINEAR;
        const initialInterval = options.interval ?? 1000;
        const maxAttempts = options.maxAttempts ?? 30;
        const backoffFactor = options.backoffFactor ?? 2;
        const maxInterval = options.maxInterval ?? 10000;
        const signal = options.signal;

        let currentInterval = initialInterval;
        let attempts = 0;
        let lastOutcome: 'NOT_FOUND' | 'RPC_ERROR' | undefined;
        let lastRpcError: string | undefined;
        let consecutiveRpcErrors = 0;
        // Allow a transient RPC failure, but do not exhaust the entire polling
        // window when the endpoint is persistently unavailable.
        const maxConsecutiveRpcErrors = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (signal?.aborted) {
                return this.abortedResult(txHash, attempt);
            }

            this.logger?.debug('TransactionPoller: polling attempt', {
                txHash,
                attempt,
                strategy,
                nextInterval: currentInterval,
            });

            attempts = attempt;
            try {
                const status = await this.server.getTransaction(txHash);
                consecutiveRpcErrors = 0;

                if (status.status === 'SUCCESS') {
                    this.logger?.info('TransactionPoller: confirmed', {
                        txHash,
                        ledger: status.ledger,
                    });
                    return {
                        success: true,
                        data: {
                            txHash,
                            ledger: status.ledger ?? 0,
                        },
                        txHash,
                    };
                }

                if (status.status === 'FAILED') {
                    this.logger?.error('TransactionPoller: transaction failed on-chain', {
                        txHash,
                        ledger: status.ledger,
                        createdAt: status.createdAt,
                        applicationOrder: status.applicationOrder,
                    });
                    this.logger?.debug('TransactionPoller: full failed status', {
                        txHash,
                        status,
                    });
                    return {
                        success: false,
                        error: {
                            code: 'TX_FAILED',
                            message: 'Transaction failed on-chain',
                            details: {
                                txHash,
                                ledger: status.ledger,
                                createdAt: status.createdAt,
                                applicationOrder: status.applicationOrder,
                            },
                        },
                        txHash,
                    };
                }

                // NOT_FOUND is a successful RPC read, but not a confirmation.
                if (status.status === 'NOT_FOUND') {
                    lastOutcome = 'NOT_FOUND';
                }
            } catch (err) {
                lastOutcome = 'RPC_ERROR';
                lastRpcError = err instanceof Error ? err.message : String(err);
                consecutiveRpcErrors++;
                this.logger?.debug('TransactionPoller: RPC error during polling', {
                    txHash,
                    attempt,
                    error: lastRpcError,
                });
                // Retry transient errors, but fail early on a dead endpoint.
                if (consecutiveRpcErrors >= maxConsecutiveRpcErrors) {
                    if (signal?.aborted) {
                        return this.abortedResult(txHash, attempt);
                    }
                    break;
                }
            }

            if (attempt < maxAttempts) {
                const aborted = await this.delay(currentInterval, signal);
                if (aborted) {
                    return this.abortedResult(txHash, attempt);
                }

                // Update interval based on strategy
                if (strategy === PollingStrategy.EXPONENTIAL) {
                    currentInterval = Math.min(currentInterval * backoffFactor, maxInterval);
                }
            }
        }

        // The last observed outcome determines what the caller can infer:
        // NOT_FOUND means no confirmation was observed at the last check;
        // an RPC failure means the current confirmation status is unknown.
        const notConfirmed = lastOutcome === 'NOT_FOUND';
        this.logger?.error(
            notConfirmed ? 'TransactionPoller: not confirmed' : 'TransactionPoller: RPC timed out',
            { txHash, attempts, lastRpcError },
        );

        return {
            success: false,
            error: {
                code: notConfirmed ? 'TX_NOT_CONFIRMED' : 'TX_TIMEOUT',
                message: notConfirmed
                    ? `Transaction not confirmed after ${attempts} attempts`
                    : `Transaction confirmation timed out after ${attempts} attempts due to RPC errors`,
                details: { txHash, maxAttempts, attempts, strategy, ...(notConfirmed ? {} : { lastRpcError }) },
            },
            txHash,
        };
    }

    /**
     * Wait `ms` milliseconds, or resolve early (with `true`) if `signal`
     * fires an `abort` event first. Resolves immediately with `true` if
     * `signal` is already aborted.
     * @private
     */
    private delay(ms: number, signal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(true);
                return;
            }

            const onAbort = () => {
                clearTimeout(timer);
                resolve(true);
            };

            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve(false);
            }, ms);

            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Build the Result returned when polling is cancelled via `signal`.
     * @private
     */
    private abortedResult(
        txHash: string,
        attempt: number,
    ): Result<{ txHash: string; ledger: number }> {
        this.logger?.info('TransactionPoller: aborted', { txHash, attempt });
        return {
            success: false,
            error: {
                code: 'ABORTED',
                message: 'Transaction polling was aborted',
                details: { txHash, attempt },
            },
            txHash,
        };
    }
}
