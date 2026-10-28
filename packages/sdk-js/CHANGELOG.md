# Changelog

All notable changes to `@smscode/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the first stable release. The public surface follows Semantic
Versioning: a breaking change bumps the major version. `1.0.0` publishes under
the npm `latest` dist-tag.

## [1.3.0] — 2026-10-28

### Added

- `/v2` order reads (`client.orders.get`, `client.orders.list`) carry
  `resend_mode`. `auto` means the provider delivers further SMS by itself:
  `can_resend` is then always false and a resend returns `resent: false`.
  `manual` means an eligible order can request another SMS through resend.
  `can_resend` stays the current permission.

### Compatibility

- The API now states its compatibility policy: responses and webhook event
  payloads may gain new fields at any time, without a version change. Ignore
  fields you do not recognize. Request bodies stay strict: send only the
  documented fields.
- The SDK already parses responses leniently, so you need no code change to
  stay compatible.

## [1.2.0] — 2026-07-31

### Added

- Order reads and SMS webhooks expose `otp_message` plus the monotonic
  `sms_revision`, so clients can retain code-less SMS deliveries and reject an
  older aggregate SMS snapshot.
- `waitForOtp` accepts `afterRevision` alongside `afterCode`, allowing resend
  waits to observe identical-code and text/link-only follow-up SMS deliveries.

### Changed

- Existing nullable `otp_code` / `otp_message` response fields remain optional
  for source compatibility. `sms_revision` is required on order-read response
  types because the API always emits it. Hand-built response mocks may need the
  new field when upgrading.

## [1.1.0] — 2026-07-09

### Added

- **`orders.reactivate()` / `orders.reactivateOptions()`** (also under `client.v1.orders.*`) — reactivate a completed number for another OTP on the same number; `reactivateOptions()` previews the reactivation cost before you commit.
- **Operator (carrier) selection** — `catalog.operators({ country_id, platform_id })` lists the carriers available for a country + platform. Pass `operator_id` to `orders.create()` to route an order to a specific carrier (omit it for the `any` coordinate); `operator_id` / `operator_name` now appear on order and product responses.

### Changed

- Insufficient balance now surfaces as HTTP **409 Conflict** (previously 402), aligning the SDK's typed-error status mapping with the API. The typed error code (`INSUFFICIENT_BALANCE`) is unchanged — branch on the code, not the raw status.

## [1.0.0] — 2026-06-27

Initial stable release of the SMSCode SDK. Isomorphic, zero runtime
dependencies — runs on Node 18+, Bun, Deno, and browsers (anything with `fetch`
+ Web Crypto `crypto.subtle`).

### Added

- **`SmscodeClient`** — the core HTTP client with Bearer-token auth, configurable
  base URL / timeout / retry policy, and a typed `client.request` transport.
- **USD-native `/v2` surface (default)** + a **legacy IDR `/v1` namespace** under
  `client.v1.*`:
  - `client.catalog.*` / `client.v1.catalog.*` — services, products, exchange rate.
  - `client.balance.*` / `client.v1.balance.*` — account balance.
  - `client.orders.*` / `client.v1.orders.*` — list, create, cancel.
  - `client.webhook.*` / `client.v1.webhook.*` — read/update/test the webhook config.
- **Money-safe order creation** — every `orders.create` carries an idempotency key,
  is retried only on transient failures with the **same** key, and stamps the key
  onto every thrown error (`SmscodeError.idempotencyKey`) so a manual retry is always
  safe. Helpers: `resolveKey`, `isValidIdempotencyKey`, `IDEMPOTENCY_KEY_PATTERN`,
  `withRetry` (`RetryPolicy`).
- **`/v2` money decoding** — `parseMoney` + `Money` / `V2Money` types, with a
  safe-integer guard and access to the raw canonical (IDR) amount + FX receipt.
- **`waitForOtp`** — polls an order to completion for the received OTP. Polls the
  FX-free `/v1` order endpoint so it survives a `/v2` FX-rate `503`
  (`FxRateUnavailableError`); throws `OtpTimeoutError` / `OrderTerminalError` on
  timeout or a terminal non-completed state.
- **`verifyWebhookSignature`** — constant-time HMAC-SHA256 verification over the
  **raw** request body (Web Crypto), plus `parseWebhookEvent` / `isWebhookEvent` and
  typed `WebhookEvent` / `WebhookEventData`.
- **Typed error model** — branch on `instanceof` (or `err.code`), never on
  `err.message`. `SmscodeError` base + per-code subclasses (`UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ValidationError`, `ProviderError`,
  `NoOfferAvailableError`, `IdempotencyKeyReuseError`, `InsufficientBalanceError`,
  `ConflictError`, `CancelTooEarlyError`, `RequestInProgressError`, `RateLimitError`,
  `TempBannedError`, `ServiceUnavailableError`, `FxRateUnavailableError`,
  `InternalError`, `PayloadTooLargeError`) + transport errors (`NetworkError`,
  `TimeoutError`, `AbortError`) + the `mapError` mapper.
- **Generated OpenAPI types** re-exported (`paths`, `components`, `operations`,
  `webhooks`) so consumers can type their own payloads against the contract.
- Dual ESM + CJS build with `.d.ts` / `.d.cts` typings; `sideEffects: false`.
- AI-agent integration docs (`docs/ai.md`, `docs/llms.txt`) and a runnable README.

### Notes

- **Distribution:** published from the public [`smscode-gg/sdks`](https://github.com/smscode-gg/sdks)
  repo. The npm package is live as `@smscode/sdk@1.0.0` under the default **`latest`** dist-tag.
- **License:** MIT (a `LICENSE` file is included in the published tarball).

[1.2.0]: https://github.com/smscode-gg/sdks/releases/tag/v1.2.0
[1.1.0]: https://github.com/smscode-gg/sdks/releases/tag/v1.1.0
[1.0.0]: https://github.com/smscode-gg/sdks/releases/tag/v1.0.0
