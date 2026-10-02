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
     * @returns A Result object with transaction data or error.
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

            try {
                const status = await this.server.getTransaction(txHash);

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

                // status.status === 'NOT_FOUND' means still pending/unseen
            } catch (err) {
                this.logger?.debug('TransactionPoller: RPC error during polling', {
                    txHash,
                    attempt,
                    error: err instanceof Error ? err.message : String(err),
                });
                // Continue polling on RPC errors (e.g. transient network issue)
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

        this.logger?.error('TransactionPoller: timed out', {
            txHash,
            attempts: maxAttempts,
        });

        return {
            success: false,
            error: {
                code: 'TX_TIMEOUT',
                message: `Transaction confirmation timed out after ${maxAttempts} attempts`,
                details: { txHash, maxAttempts, strategy },
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
