import { Logger } from "@/types/common";

import { DEFAULTS } from "@/config";



export class CircuitOpenError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(`Circuit is open for operation ${label}`);
    this.name = "CircuitOpenError";
    this.label = label;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DeadlineError extends Error {
  readonly deadlineMs: number;
  readonly nowMs: number;
  readonly pastDeadlineMs: number;
  constructor(deadlineMs: number, nowMs: number = Date.now()) {
    const pastDeadlineMs = Math.max(0, nowMs - deadlineMs);
    super(`Retry deadline exceeded by ${pastDeadlineMs}ms`);
    this.name = "DeadlineError";
    this.deadlineMs = deadlineMs;
    this.nowMs = nowMs;
    this.pastDeadlineMs = pastDeadlineMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export class CircuitBreaker {
  private readonly label: string;
  private failureThreshold: number;
  private cooldownMs: number;
  private consecutiveFailures: number = 0;
  private openedAtMs: number | null = null;
  private halfOpenInFlight: boolean = false;

  constructor(label: string, options?: CircuitBreakerOptions) {
    this.label = label;
    this.failureThreshold = options?.failureThreshold ?? 5;
    this.cooldownMs = options?.cooldownMs ?? 30_000;
  }

  setOptions(options?: CircuitBreakerOptions): void {
    if (!options) return;
    if (typeof options.failureThreshold === "number") this.failureThreshold = options.failureThreshold;
    if (typeof options.cooldownMs === "number") this.cooldownMs = options.cooldownMs;
  }

  getState(nowMs: number = Date.now()): CircuitState {
    if (this.openedAtMs === null) return "closed";
    if (nowMs - this.openedAtMs >= this.cooldownMs) return "half-open";
    return "open";
  }

  beforeRequest(nowMs: number = Date.now()): void {
    const state = this.getState(nowMs);
    if (state === "open") throw new CircuitOpenError(this.label);
    if (state === "half-open") {
      if (this.halfOpenInFlight) throw new CircuitOpenError(this.label);
      this.halfOpenInFlight = true;
    }
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
    this.halfOpenInFlight = false;
  }

  onFailure(nowMs: number = Date.now()): void {
    this.halfOpenInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.openedAtMs = nowMs;
  }
}

const circuitBreakersByLabel = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(label: string, options?: CircuitBreakerOptions): CircuitBreaker {
  const existing = circuitBreakersByLabel.get(label);
  if (existing) { existing.setOptions(options); return existing; }
  const created = new CircuitBreaker(label, options);
  circuitBreakersByLabel.set(label, created);
  return created;
}

export function resetCircuitBreakers(): void {
  circuitBreakersByLabel.clear();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 429 || status === 503) return true;
  const code = (err as { code?: string })?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;
  const message = ((err as { message?: string })?.message ?? String(err ?? "")).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("socket hang up") ||
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("503") ||
    message.includes("service unavailable") ||
    message.includes("econnreset") ||
    message.includes("enotfound")
  );
}

export interface RetryOptions {
  maxRetries: number;
  /** Primary delay field (used by tests) */
  baseDelayMs?: number;
  /** Legacy alias for baseDelayMs */
  retryDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  /** Legacy alias for maxDelayMs */
  maxRetryDelayMs?: number;
  deadlineMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  circuitBreaker?: CircuitBreakerOptions;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: DEFAULTS.maxRetryDelayMs,
};

function normalizeRetryConfig(options: RetryOptions): RetryConfig {
  return {
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs ?? options.retryDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
    backoffMultiplier: options.backoffMultiplier ?? 2,
    maxDelayMs: options.maxDelayMs ?? options.maxRetryDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    circuitBreaker: options.circuitBreaker,
  };
}

/**
 * Helper to execute an async function with exponential backoff retry.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @param logger - Optional logger for instrumentation
 * @param label - A label for logging purposes
 * @returns The result of the function
 */

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  logger?: Logger,
  label: string = "RPC",
): Promise<T> {
  const config = normalizeRetryConfig(options);
  const breaker = getCircuitBreaker(label, config.circuitBreaker);
  const breakerStateAtStart = breaker.getState();
  const maxRetries = breakerStateAtStart === "half-open" ? 0 : config.maxRetries;

  breaker.beforeRequest();
  let lastError: unknown;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (typeof options.deadlineMs === "number" && Date.now() >= options.deadlineMs) {
        throw new DeadlineError(options.deadlineMs);
      }
      try {
        const result = await fn();
        breaker.onSuccess();
        return result;
      } catch (err: unknown) {
        lastError = err;
        if (!isRetryable(err) || attempt === maxRetries) throw err;

        const rawBackoff = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
        const delay = Math.min(config.maxDelayMs, rawBackoff);

        logger?.debug(`${label}: retrying after ${Math.round(delay)}ms`, {
          attempt: attempt + 1,
          maxRetries,
          error: (err as Error).message,
        });

        await sleep(delay);
      }
    }
  } catch (err: unknown) {
    breaker.onFailure();
    throw err;
  }

  breaker.onFailure();
  throw lastError;
}
