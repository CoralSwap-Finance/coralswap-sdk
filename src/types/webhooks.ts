export type WebhookMethod = 'POST' | 'PUT' | 'PATCH';

export type WebhookPayloadFormat = 'json' | 'form';

export type WebhookDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'success'
  | 'failed'
  | 'exhausted';

export interface WebhookConfig {
  url: string;
  method?: WebhookMethod;
  payloadFormat?: WebhookPayloadFormat;
  headers?: Record<string, string>;
  secret?: string;
  label?: string;
  alertFilter?: string[];
  enabled?: boolean;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  alertId: string;
  status: WebhookDeliveryStatus;
  httpStatus?: number;
  sentAt: number;
  completedAt?: number;
  retryCount: number;
  errorMessage?: string;
}

export interface WebhookEndpointHealth {
  webhookId: string;
  url: string;
  enabled: boolean;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  successRate: number;
  averageResponseTimeMs: number;
  lastDeliveryAt?: number;
}

export type WebhookDeliveryStatusLegacy = 'pending' | 'delivering' | 'success' | 'failed' | 'exhausted';

export interface WebhookConfigLegacy {
  url: string;
  method?: WebhookMethod;
  payloadFormat?: WebhookPayloadFormat;
  headers?: Record<string, string>;
  secret?: string;
  label?: string;
  alertFilter?: string[];
  enabled?: boolean;
}

export interface WebhookDeliveryLegacy {
  id: string;
  webhookId: string;
  alertId: string;
  status: WebhookDeliveryStatusLegacy;
  httpStatus?: number;
  sentAt: number;
  completedAt?: number;
  retryCount: number;
  errorMessage?: string;
}

export interface WebhookEndpointHealthLegacy {
  webhookId: string;
  url: string;
  enabled: boolean;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  successRate: number;
  averageResponseTimeMs: number;
  lastDeliveryAt?: number;
}

export type WebhookEventName = string;

export interface WebhookConfigV2 {
  url: string;
  events: WebhookEventName[];
  secret?: string;
}

export type WebhookPayload<T = Record<string, unknown>> = T;

export interface WebhookEnvelope<T = Record<string, unknown>> {
  id: string;
  timestamp: number;
  event?: WebhookEventName;
  data: T;
}

export interface WebhookDeliveryResult {
  statusCode: number;
  delivered: boolean;
  retryCount: number;
}

export interface WebhookOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface StoredWebhook extends WebhookConfigV2 {
  id: string;
  createdAt: number;
}

export const WEBHOOK_SIGNATURE_HEADER = 'X-Signature';
export const WEBHOOK_SIGNATURE_ALGORITHM = 'sha256';
export const WEBHOOK_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  timeoutMs: 10_000,
} as const;

export const WEBHOOK_DISABLE_FAILURE_THRESHOLD = 5;
export const WEBHOOK_HISTORY_CAPACITY = 500;
export const WEBHOOK_VERIFY_PAYLOAD_TYPE = 'webhook.verify' as const;

export interface WebhookVerifyResult {
  verified: boolean;
  statusCode: number;
  latencyMs: number;
  challenge: string;
  error?: string;
}

export interface WebhookVerifyOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WebhookHistoryEntry {
  deliveryId: string;
  timestamp: number;
  statusCode: number;
  delivered: boolean;
  attempts: number;
  retryCount: number;
  outcome: 'success' | 'network' | 'client' | 'server';
  errorMessage?: string;
}

export interface WebhookHistoryQuery {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface WebhookHistoryPage {
  items: WebhookHistoryEntry[];
  nextCursor: string | null;
  total: number;
}
