# Changelog

All notable changes to the `smscode` Python SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-10-28

### Added

- `/v2` order reads (`client.orders.get`, `client.orders.list`) carry
  `resend_mode`, exposed as `OrderCapabilities.resend_mode`. `"auto"` means
  the provider delivers further SMS by itself: `can_resend` is then always false
  and a resend returns `resent: false`. `"manual"` means an eligible order can
  request another SMS through resend. The value is `None` when a response does
  not carry it, as on `/v1`. `can_resend` stays the current permission.

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
- `wait_for_otp` accepts `after_revision` alongside `after_code`, allowing
  resend waits to observe identical-code and text/link-only follow-up SMS deliveries.

### Changed

- Existing nullable `otp_code` / `otp_message` response fields remain optional
  for compatibility. `sms_revision` is required on order-read response types
  because the API always emits it. Hand-built response mocks may need the new
  field when upgrading.

## [1.1.0] — 2026-07-09

### Added

- **`orders.reactivate()` / `orders.reactivate_options()`** (also under `client.v1.orders.*`) — reactivate a completed number for another OTP on the same number; `reactivate_options()` previews the reactivation cost before you commit.
- **Operator (carrier) selection** — `catalog.operators(country_id=..., platform_id=...)` lists the carriers available for a country + platform. Pass `operator_id` to `orders.create()` to route an order to a specific carrier (omit it for the `any` coordinate); `operator_id` / `operator_name` now appear on order and product responses.

### Changed

- Insufficient balance now surfaces as HTTP **409 Conflict** (previously 402), aligning the SDK's typed-error status mapping with the API. The typed error code (`INSUFFICIENT_BALANCE`) is unchanged — branch on the code, not the raw status.

## [1.0.0] — 2026-06-27

Initial stable release of the SMSCode Python SDK.
