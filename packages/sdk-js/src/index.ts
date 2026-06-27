/**
 * @smscode/sdk — Official TypeScript/JavaScript SDK for the SMSCode API.
 *
 * Public surface:
 * - {@link SmscodeClient} — the core HTTP client (Bearer auth, typed errors).
 * - The typed error model ({@link SmscodeError} + per-code subclasses + transport errors).
 * - The generated OpenAPI types, re-exported so consumers can type their payloads.
 *
 * Resource methods are layered on top of `client.request` in later tasks.
 */

// Core client.
export { SmscodeClient } from "./client.js";
export type {
  SmscodeClientOptions,
  RequestOptions,
  ApiResult,
  HttpMethod,
  QueryValue,
  V1Namespace,
} from "./client.js";

// `/v2` money decoding.
export { parseMoney } from "./money.js";
export type { Money, V2Money } from "./money.js";

// Money-safety: idempotency-key resolution + the retry engine.
export {
  resolveKey,
  isValidIdempotencyKey,
  IDEMPOTENCY_KEY_PATTERN,
} from "./idempotency.js";
export { withRetry } from "./retry.js";
export type { RetryPolicy } from "./retry.js";

// Read resources (the default `/v2` surface + the `/v1` namespace).
export {
  V1CatalogResource,
  V2CatalogResource,
} from "./resources/catalog.js";
export type {
  RequestFn,
  ServicesParams,
  ProductsParams,
  ExchangeRateParams,
  ProductV2,
  ProductsPageV2,
  ProductsPageV1,
} from "./resources/catalog.js";
export {
  V1BalanceResource,
  V2BalanceResource,
} from "./resources/balance.js";
export type { BalanceV2 } from "./resources/balance.js";
export {
  V1OrdersResource,
  V2OrdersResource,
} from "./resources/orders.js";
export type {
  OrdersListParams,
  OrderV2,
  OrdersListV2,
  CreateOrderOptions,
  CreatedOrderV2,
  CreateOrderResultV1,
  CreateOrderResultV2,
  CancelResultV2,
  V1CreateOrderRequest,
  V2CreateOrderRequest,
  V1CreateOrderItem,
  V2CreateOrderItem,
} from "./resources/orders.js";

// `waitForOtp` polling helper (FX-free /v1 poll).
export { waitForOtp } from "./wait.js";
export type {
  WaitForOtpOptions,
  OtpResult,
  OtpPollSnapshot,
} from "./wait.js";

// Webhook config resource (`client.webhook.*` /v2 default + `client.v1.webhook.*`).
export {
  V1WebhookResource,
  V2WebhookResource,
} from "./resources/webhook.js";
export type {
  WebhookConfig,
  UpdateWebhookBody,
  WebhookTestResult,
} from "./resources/webhook.js";

// Webhook signature verification + typed events (security surface).
export {
  verifyWebhookSignature,
  parseWebhookEvent,
  isWebhookEvent,
} from "./webhook.js";
export type { WebhookEvent, WebhookEventData } from "./webhook.js";

// Typed error model.
export {
  SmscodeError,
  // Per-code business errors.
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  ProviderError,
  NoOfferAvailableError,
  IdempotencyKeyReuseError,
  InsufficientBalanceError,
  ConflictError,
  CancelTooEarlyError,
  RequestInProgressError,
  RateLimitError,
  TempBannedError,
  ServiceUnavailableError,
  FxRateUnavailableError,
  InternalError,
  PayloadTooLargeError,
  // Transport errors.
  NetworkError,
  TimeoutError,
  AbortError,
  // SDK-side polling errors (waitForOtp).
  OrderTerminalError,
  OtpTimeoutError,
  // Mapper.
  mapError,
} from "./errors.js";
export type {
  ErrorCode,
  OrderStatus,
  ApiErrorObject,
  ApiErrorResponse,
  SmscodeErrorOptions,
} from "./errors.js";

// Generated OpenAPI contract types.
export type { paths, components, operations, webhooks } from "./types.gen.js";

/** SDK package version. Kept in sync with package.json `version`. */
export const VERSION = "1.0.0";
