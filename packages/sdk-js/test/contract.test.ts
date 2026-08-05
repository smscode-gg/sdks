/**
 * Contract tests — REAL API responses vs the hand-authored OpenAPI schema
 * This is the anti-drift gate: it drives the live
 * SMSCode API through the SDK and validates every response envelope
 * against `docs/openapi/openapi.yaml` with `ajv`.
 *
 * Dialect: OpenAPI 3.1 schemas are JSON-Schema **2020-12**, so we compile with
 * `Ajv2020` (`ajv/dist/2020`) + `ajv-formats`. `$ref`/`components` resolution is
 * handled by registering the ENTIRE document under a base `$id` and compiling a
 * wrapper `$ref` that points (via an escaped JSON pointer) at each endpoint's
 * `200` response schema — so internal `#/components/schemas/...` refs resolve.
 *
 * Credentials come from ENV ONLY:
 *   - SMSCODE_E2E_API_TOKEN  — bearer token (REQUIRED to run; suite SKIPS if unset).
 *   - SMSCODE_E2E_API_BASE   — base URL (REQUIRED to run the live suite).
 *   - SMSCODE_E2E_FUNDED=1   — opt in to a POSITIVE order create (places a real
 *                              order / consumes balance). Default OFF.
 *
 * Credentials come from the environment ONLY; never hardcode a token. With no token the whole
 * network suite is skipped (clean exit 0) — the live suite runs the authenticated
 * drift-check. A small ajv-harness unit test runs UNCONDITIONALLY so the
 * validation logic itself is proven offline (known-good + known-bad fixtures).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import yaml from "js-yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SmscodeClient } from "../src/client.js";
import {
  SmscodeError,
  UnauthorizedError,
  ValidationError,
} from "../src/errors.js";

// ───────────────────────────── ENV gate ─────────────────────────────

const TOKEN = process.env.SMSCODE_E2E_API_TOKEN;
const BASE_URL = process.env.SMSCODE_E2E_API_BASE;
const RUN_LIVE = Boolean(TOKEN && BASE_URL);
const RUN_FUNDED = process.env.SMSCODE_E2E_FUNDED === "1";

if (!RUN_LIVE) {
  // A clear, non-failing signal. The suite below is gated with `skipIf`, so this
  // is informational only — the run still exits 0.
  console.info(
    "[contract.test] SMSCODE_E2E_API_TOKEN is unset — SKIPPING the live API " +
      "contract suite (the offline ajv-harness unit test still runs). Set " +
      "SMSCODE_E2E_API_TOKEN=… (optionally SMSCODE_E2E_API_BASE / SMSCODE_E2E_FUNDED=1) " +
      "to run the real anti-drift check against the live API.",
  );
}

// ───────────────────────── ajv contract harness ─────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** Path to the single source of contract truth. */
const OPENAPI_PATH = resolve(HERE, "../../../docs/openapi/openapi.yaml");
/** A synthetic base `$id` the whole document is registered under. */
const OPENAPI_BASE_ID = "https://smscode.gg/openapi.json";

/** HTTP method keys we address in the OpenAPI `paths` object. */
type OpenApiMethod = "get" | "post" | "put" | "patch" | "delete";

/** Escape a JSON Pointer reference token (RFC 6901): `~`→`~0`, `/`→`~1`. */
function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Build, configure, and seed an {@link Ajv2020} instance from the OpenAPI doc.
 *
 * The whole document is registered under {@link OPENAPI_BASE_ID} so that every
 * internal `#/components/schemas/...` `$ref` resolves. Compilation helpers then
 * target a specific node by `$ref`. Pure + offline — see the unit test below.
 */
export function buildContractHarness(openapiYaml: string): {
  /** Compile the `application/json` schema for a `{status}` response of an operation. */
  responseValidator: (
    path: string,
    method: OpenApiMethod,
    status?: string,
  ) => ValidateFunction;
  /** Compile a validator for a top-level `components.schemas.{name}`. */
  schemaValidator: (name: string) => ValidateFunction;
  /** Compile a validator for any schema node addressed from the document root. */
  documentValidator: (pointer: readonly string[]) => ValidateFunction;
  /** Format ajv errors into a single readable line for assertion messages. */
  formatErrors: (validate: ValidateFunction) => string;
} {
  // Parse with the JSON-only schema: no custom/`!!js/*` type tags are
  // constructed, so this is a pure data load (js-yaml v4's `load` is already
  // safe — `safeLoad`/the unsafe loader was removed in v4 — and `JSON_SCHEMA`
  // makes that explicit). The input is the in-repo OpenAPI doc regardless.
  const doc = yaml.load(openapiYaml, {
    schema: yaml.JSON_SCHEMA,
  }) as Record<string, unknown>;

  const ajv = new Ajv2020({
    // OpenAPI 3.1 schemas carry annotations ajv's strict mode would reject
    // (e.g. `example`/`examples`, `discriminator`, sibling keywords). They are
    // documentation-only here; we validate structure, so strict is off.
    strict: false,
    allErrors: true,
    // 3.1 nullables are union types: `type: [string, 'null']`.
    allowUnionTypes: true,
    // `format` is annotation-only in 2020-12 until ajv-formats is attached.
    validateFormats: true,
  });
  addFormats(ajv);
  // OpenAPI `int32`/`int64` are not ajv-formats; register them as no-op
  // annotations so a referenced schema using them compiles cleanly.
  ajv.addFormat("int32", true);
  ajv.addFormat("int64", true);

  ajv.addSchema(doc, OPENAPI_BASE_ID);

  const responseRef = (
    path: string,
    method: OpenApiMethod,
    status: string,
  ): string =>
    `${OPENAPI_BASE_ID}#/paths/${escapePointer(path)}/${method}/responses/${escapePointer(
      status,
    )}/content/${escapePointer("application/json")}/schema`;

  return {
    responseValidator(path, method, status = "200") {
      return ajv.compile({ $ref: responseRef(path, method, status) });
    },
    schemaValidator(name) {
      return ajv.compile({
        $ref: `${OPENAPI_BASE_ID}#/components/schemas/${escapePointer(name)}`,
      });
    },
    documentValidator(pointer) {
      return ajv.compile({
        $ref: `${OPENAPI_BASE_ID}#/${pointer.map(escapePointer).join("/")}`,
      });
    },
    formatErrors(validate) {
      return (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
        .join("; ");
    },
  };
}

// ───── every published media example validates against its adjacent schema ─────
// OpenAPI examples are executable contract fixtures, not illustrative prose. Walk
// the whole document so a newly-added path, response, request body, or webhook is
// guarded without adding another endpoint-specific test.
describe("every published OpenAPI media example validates against its schema", () => {
  const yamlText = readFileSync(OPENAPI_PATH, "utf8");
  const doc = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA }) as Record<
    string,
    unknown
  >;
  const harness = buildContractHarness(yamlText);

  type PublishedExample = {
    name: string;
    schemaPointer: string[];
    value: unknown;
  };

  const published: PublishedExample[] = [];

  function collectMediaExamples(node: unknown, pointer: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((value, index) =>
        collectMediaExamples(value, [...pointer, String(index)]),
      );
      return;
    }
    if (node === null || typeof node !== "object") return;

    const object = node as Record<string, unknown>;
    if (
      object.schema !== null &&
      typeof object.schema === "object" &&
      object.examples !== null &&
      typeof object.examples === "object" &&
      !Array.isArray(object.examples)
    ) {
      for (const [exampleName, rawExample] of Object.entries(
        object.examples as Record<string, unknown>,
      )) {
        if (
          rawExample !== null &&
          typeof rawExample === "object" &&
          Object.hasOwn(rawExample, "value")
        ) {
          published.push({
            name: `${pointer.join(".")}.examples.${exampleName}`,
            schemaPointer: [...pointer, "schema"],
            value: (rawExample as { value: unknown }).value,
          });
        }
      }
    }

    for (const [key, value] of Object.entries(object)) {
      collectMediaExamples(value, [...pointer, key]);
    }
  }

  collectMediaExamples(doc, []);

  it("discovers published examples instead of passing vacuously", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  for (const example of published) {
    it(example.name, () => {
      const validate = harness.documentValidator(example.schemaPointer);
      const ok = validate(example.value);
      expect(ok, harness.formatErrors(validate)).toBe(true);
    });
  }
});

// ───────────────────── offline ajv-harness unit test ─────────────────────
// Runs ALWAYS (no token needed): proves the validation logic with fixtures so a
// green/red here is meaningful even when the network suite is skipped.

describe("contract harness (offline, fixture-driven)", () => {
  const yamlText = readFileSync(OPENAPI_PATH, "utf8");
  const harness = buildContractHarness(yamlText);

  it("ACCEPTS a spec-shaped /v1 countries envelope", () => {
    const validate = harness.responseValidator("/v1/catalog/countries", "get");
    const ok = validate({
      success: true,
      data: [
        {
          id: 6,
          code: "id",
          name: "Indonesia",
          dial_code: "62",
          emoji: "🇮🇩",
          active: true,
        },
      ],
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("ACCEPTS a spec-shaped /v2 balance envelope (data + meta.fx)", () => {
    const validate = harness.responseValidator("/v2/balance", "get");
    const ok = validate({
      success: true,
      data: {
        balance: {
          amount: "78.13",
          currency: "USD",
          canonical_amount: 1250000,
          canonical_currency: "IDR",
        },
      },
      meta: {
        fx: {
          pair: "USD/IDR",
          rate: 16000,
          rate_as_of: "2026-05-11T09:00:00+00:00",
        },
      },
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("REJECTS a /v2 balance envelope missing the required meta", () => {
    const validate = harness.responseValidator("/v2/balance", "get");
    const bad = validate({
      success: true,
      data: {
        balance: {
          amount: "78.13",
          currency: "USD",
          canonical_amount: 1250000,
          canonical_currency: "IDR",
        },
      },
    });
    expect(bad).toBe(false);
  });

  it("ACCEPTS a well-formed ErrorResponse envelope", () => {
    const validate = harness.schemaValidator("ErrorResponse");
    const ok = validate({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("ACCEPTS the actual v1 create-item shape without read-only SMS fields", () => {
    const validate = harness.schemaValidator("V1CreateOrderItem");
    const ok = validate({
      id: 90210,
      status: "ACTIVE",
      phone_number: "+6281234567890",
      otp_code: null,
      otp_received_at: null,
      expires_at: "2026-07-31T02:20:00Z",
      failed_reason: null,
      product_id: 1024,
      catalog_product_id: 88,
      operator_id: 42,
      operator_name: "Telkomsel",
      amount: 750000,
      can_finish: false,
      can_resend: false,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: "2026-07-31T02:02:00Z",
      replace_available_at: "2026-07-31T02:02:00Z",
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("REJECTS an ErrorResponse with an unknown error code", () => {
    const validate = harness.schemaValidator("ErrorResponse");
    const bad = validate({
      success: false,
      error: { code: "NOT_A_REAL_CODE", message: "x" },
    });
    expect(bad).toBe(false);
  });

  // Webhook anti-drift fixtures. These prove the webhook
  // contract validators work offline, so the live webhook assertions below are
  // meaningful even when the network suite is skipped.

  it("ACCEPTS the 'no webhook configured' /v1/webhook envelope (all-null config)", () => {
    // This is the real account shape: an unset webhook → every field null
    // except the failure count. If the API ever renamed a field or dropped a
    // nullable, this exact envelope would FAIL the live check — the catch.
    const validate = harness.responseValidator("/v1/webhook", "get");
    const ok = validate({
      success: true,
      data: {
        webhook_url: null,
        webhook_secret: null,
        webhook_disabled_at: null,
        webhook_disabled_reason: null,
        webhook_consecutive_failures: 0,
      },
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("REJECTS a /v2/webhook envelope missing a required WebhookConfig field", () => {
    // WebhookConfig is `required: [...all 5...]` + `additionalProperties:false`.
    // Drop `webhook_consecutive_failures` → must fail (drift would surface here).
    const validate = harness.responseValidator("/v2/webhook", "get");
    const bad = validate({
      success: true,
      data: {
        webhook_url: null,
        webhook_secret: null,
        webhook_disabled_at: null,
        webhook_disabled_reason: null,
      },
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookConfig with an unexpected extra field (additionalProperties:false)", () => {
    const validate = harness.schemaValidator("WebhookConfig");
    const bad = validate({
      webhook_url: null,
      webhook_secret: null,
      webhook_disabled_at: null,
      webhook_disabled_reason: null,
      webhook_consecutive_failures: 0,
      surprise_field: "drift",
    });
    expect(bad).toBe(false);
  });

  it("ACCEPTS a WebhookTestResult fixture (status_code)", () => {
    const validate = harness.schemaValidator("WebhookTestResult");
    const ok = validate({ status_code: 200 });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  // the outbound webhook `data` ALWAYS emits the 7 capability fields AND the
  // operator dimension (operator_id/operator_name) AND the SMS revision + 6 core
  // fields (phone_number, otp_code, otp_message, catalog_product_id, country, platform)
  // — webhook_notifier::webhook_data_payload. EVERY key is `required`, so a
  // caps-less OR operator-less OR core-field-less payload MUST fail; a full
  // payload MUST pass. These fixtures pair with the Rust producer unit test to
  // lock Finding 2 + the #394C R2 operator drift + the R3 6-field looseness
  // end-to-end. The 6 core fields + operator_id/operator_name + the *_available_at
  // timestamps are required-but-nullable: the producer emits every key for EVERY
  // order (a JSON `null` on `any`-operator orders or when unset, values
  // otherwise), so both the non-null and the null any-path shape MUST validate.
  it("ACCEPTS a WebhookEventData payload with a non-null operator (operator-routed order)", () => {
    const validate = harness.schemaValidator("WebhookEventData");
    const ok = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("ACCEPTS a WebhookEventData payload with null operator fields (any-path order)", () => {
    // The producer emits operator_id/operator_name as present-but-null for an
    // `any`-operator order. required-but-nullable → this MUST still validate.
    const validate = harness.schemaValidator("WebhookEventData");
    const ok = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: null,
      operator_name: null,
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(ok, harness.formatErrors(validate)).toBe(true);
  });

  it("REJECTS a WebhookEventData payload missing the required SMS revision", () => {
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload missing the required operator fields", () => {
    // The producer ALWAYS emits operator_id + operator_name (null for `any`), so a
    // payload omitting the keys entirely is drift (matches the runtime contract).
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload with an unknown field (additionalProperties:false lock)", () => {
    // WebhookEventData is `additionalProperties: false`, so a strict consumer
    // generated from the published schema REJECTS unknown keys. This proves the
    // lock the #394C R2 finding was about: the schema now matches the
    // runtime payload EXACTLY — no more, no less.
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
      surprise_field: "drift",
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload missing the required capability booleans", () => {
    // The producer always emits the 4 booleans → a caps-less `data` is drift.
    // Operator fields present (non-null) so the ONLY missing thing is the booleans.
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload missing the required can_reactivate flag (wire-parity)", () => {
    // Reactivation added `can_reactivate` to the flattened OrderCapabilities the
    // producer emits, so it is now `required` alongside the other 4 booleans. This
    // payload is otherwise COMPLETE (it WOULD HAVE validated before the field
    // existed) — its rejection is the proof the new field is wire-required, not optional.
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      // can_reactivate dropped — a field the producer always emits.
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload missing the required capability timestamps", () => {
    // The producer (webhook_notifier::webhook_data_payload) ALWAYS emits the 3
    // *_available_at keys (null when not set). They're now `required` too, so a
    // payload with the booleans but no timestamps is drift. Operator fields
    // present (non-null) so the ONLY missing thing is the timestamps.
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      country: "Indonesia",
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
    });
    expect(bad).toBe(false);
  });

  it("REJECTS a WebhookEventData payload missing one of the 6 always-emitted core fields (#394C R3)", () => {
    // #394C R3: phone_number, otp_code, otp_message, catalog_product_id, country,
    // platform are ALL emitted present-as-key for every event (Option<_> in the
    // producer's OrderDetail → a JSON value or `null`, never an absent key), so
    // they're now `required` (required-but-nullable) alongside operator + caps.
    // This payload is complete EXCEPT it drops `country` — it WOULD HAVE validated
    // under the pre-tightening schema (country optional), so its rejection is the
    // proof the R3 tightening bites.
    const validate = harness.schemaValidator("WebhookEventData");
    const bad = validate({
      order_id: 90210,
      phone_number: "+6281234567890",
      otp_code: "123456",
      otp_message: "Your code is 123456",
      sms_revision: 1,
      product_id: 1024,
      catalog_product_id: 88,
      // country dropped — a present-as-key field the producer always emits.
      platform: "WhatsApp",
      operator_id: 42,
      operator_name: "Telkomsel",
      can_finish: true,
      can_resend: true,
      can_cancel: false,
      can_replace: false,
      can_reactivate: false,
      resend_available_at: null,
      cancel_available_at: null,
      replace_available_at: null,
    });
    expect(bad).toBe(false);
  });
});

// ───── published webhooks.orderEvent examples validate vs WebhookEvent (#394C R3) ─────
// The `webhooks.orderEvent` request-body examples are the copy-paste payloads a
// customer builds their webhook consumer against. `WebhookEventData` REQUIRES the
// operator dimension (operator_id/operator_name) + the 7 capability fields, so an
// example that stops at `platform` would NOT validate against the published
// schema — a customer generating a strict consumer from that example would then
// REJECT the real delivery. This reads each example straight from the OpenAPI doc
// (not a hand-copied fixture) and validates it against `WebhookEvent` (which
// `$ref`s `WebhookEventData`), so a future example that drifts from its own schema
// fails HERE (offline, no token) instead of shipping stale to customers.
describe("published webhooks.orderEvent examples validate vs WebhookEvent (#394C R3)", () => {
  const yamlText = readFileSync(OPENAPI_PATH, "utf8");
  const doc = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA }) as {
    webhooks?: Record<
      string,
      {
        post?: {
          requestBody?: {
            content?: Record<
              string,
              { examples?: Record<string, { value?: unknown }> }
            >;
          };
        };
      }
    >;
  };
  const harness = buildContractHarness(yamlText);

  const examples =
    doc.webhooks?.orderEvent?.post?.requestBody?.content?.["application/json"]
      ?.examples ?? {};
  const names = Object.keys(examples);

  it("the doc actually carries orderEvent example(s) to guard", () => {
    // Guard the guard: if the examples are moved/renamed away, fail loudly rather
    // than validating nothing (an empty `for` loop would pass vacuously).
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`example '${name}' validates against WebhookEvent`, () => {
      const validate = harness.schemaValidator("WebhookEvent");
      const ok = validate(examples[name]!.value);
      expect(ok, harness.formatErrors(validate)).toBe(true);
    });
  }
});

// ──────────── operator-selector coordinate contract (#394C M005) ────────────
// The Rust `OperatorQuery` for `/v{1,2}/catalog/operators` takes NON-optional
// `country_id` + `platform_id` (omitting either is a deserialize/422 error). The
// OpenAPI spec must mark BOTH `required: true` so codegen'd clients — including
// the committed `src/types.gen.ts` — surface them as required and can't omit a
// coordinate that only fails at runtime. The products/services listings keep the
// same coordinates OPTIONAL (absent → the `any`/all coordinate), so this locks
// the ASYMMETRY, not a blanket flip. Paired with `check:types` (spec↔types
// freshness), it transitively guarantees the generated types stay required.
describe("operator selector requires both coordinates (#394C M005)", () => {
  type SpecParam = { $ref?: string; name?: string; required?: boolean };
  const doc = yaml.load(readFileSync(OPENAPI_PATH, "utf8"), {
    schema: yaml.JSON_SCHEMA,
  }) as {
    paths: Record<string, Record<string, { parameters?: SpecParam[] }>>;
    components: { parameters: Record<string, SpecParam> };
  };

  /** Resolve a GET operation's query param (following a `$ref`) by its `name`. */
  function queryParam(path: string, name: string): SpecParam {
    const params = doc.paths[path]?.get?.parameters ?? [];
    for (const p of params) {
      const resolved = p.$ref
        ? doc.components.parameters[p.$ref.split("/").pop() as string]
        : p;
      if (resolved?.name === name) return resolved;
    }
    throw new Error(`no query param '${name}' on GET ${path}`);
  }

  for (const path of ["/v1/catalog/operators", "/v2/catalog/operators"]) {
    it(`GET ${path} requires country_id AND platform_id`, () => {
      expect(queryParam(path, "country_id").required).toBe(true);
      expect(queryParam(path, "platform_id").required).toBe(true);
    });
  }

  // Guard against over-correction: the product listing's coordinates stay OPTIONAL.
  for (const path of ["/v1/catalog/products", "/v2/catalog/products"]) {
    it(`GET ${path} keeps country_id/platform_id OPTIONAL`, () => {
      expect(queryParam(path, "country_id").required ?? false).toBe(false);
      expect(queryParam(path, "platform_id").required ?? false).toBe(false);
    });
  }
});

describe("SMS snapshot response type compatibility (#436)", () => {
  const doc = yaml.load(readFileSync(OPENAPI_PATH, "utf8"), {
    schema: yaml.JSON_SCHEMA,
  }) as {
    components: {
      schemas: Record<
        string,
        { required?: string[]; properties?: Record<string, unknown> }
      >;
    };
  };

  for (const schemaName of [
    "V1OrderSummary",
    "V1OrderStatus",
    "V2OrderSummary",
  ]) {
    it(`${schemaName} requires every always-emitted SMS snapshot field`, () => {
      const required = doc.components.schemas[schemaName]?.required ?? [];
      expect(required).toContain("sms_revision");
      expect(required).toContain("otp_code");
      expect(required).toContain("otp_message");
      expect([...required].sort()).toEqual(
        Object.keys(doc.components.schemas[schemaName]?.properties ?? {}).sort(),
      );
    });
  }

  it("keeps v1/v2 create-item otp_code required in parity", () => {
    for (const schemaName of ["V1CreateOrderItem", "V2CreateOrderItem"]) {
      expect(doc.components.schemas[schemaName]?.required ?? []).toContain(
        "otp_code",
      );
    }
  });
});

// ─────────────────── live API contract suite (gated) ───────────────────

describe.skipIf(!RUN_LIVE)("contract: live API vs OpenAPI", () => {
  let harness: ReturnType<typeof buildContractHarness>;
  let client: SmscodeClient;

  /** Assert a parsed envelope validates against an operation's 200 response. */
  function expectResponseValid(
    envelope: unknown,
    path: string,
    method: OpenApiMethod,
  ): void {
    const validate = harness.responseValidator(path, method);
    const ok = validate(envelope);
    expect(
      ok,
      `${method.toUpperCase()} ${path} drifted from OpenAPI: ${harness.formatErrors(
        validate,
      )}`,
    ).toBe(true);
  }

  /**
   * Re-fetch the raw envelope for an endpoint so we validate the WIRE shape (the
   * SDK decodes `/v2` money into `Money` objects, which is NOT the wire schema).
   * Uses the same token + base URL the SDK uses, so a 200 here mirrors the SDK call.
   */
  async function rawGet(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL((BASE_URL as string).replace(/\/+$/, "") + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN as string}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  /** Raw POST with optional `idempotency-key` (for wire-shape validation). */
  async function rawPost(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL((BASE_URL as string).replace(/\/+$/, "") + path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN as string}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  /** Raw PATCH (for the empty-body 422 webhook contract — non-mutating). */
  async function rawPatch(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL((BASE_URL as string).replace(/\/+$/, "") + path);
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TOKEN as string}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeAll(() => {
    harness = buildContractHarness(readFileSync(OPENAPI_PATH, "utf8"));
    client = new SmscodeClient({ token: TOKEN as string, baseUrl: BASE_URL as string });
  });

  // ── Step 1: POSITIVE reads (/v1 + /v2 catalog, balance, orders read) ──

  describe("positive reads — /v1", () => {
    it("GET /v1/catalog/countries", async () => {
      // Exercise the SDK (so the SDK path is proven), THEN validate the wire body.
      const countries = await client.v1.catalog.countries();
      expect(Array.isArray(countries)).toBe(true);
      const raw = await rawGet("/v1/catalog/countries");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/catalog/countries", "get");
    });

    it("GET /v1/catalog/services", async () => {
      await client.v1.catalog.services();
      const raw = await rawGet("/v1/catalog/services");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/catalog/services", "get");
    });

    it("GET /v1/catalog/products", async () => {
      await client.v1.catalog.products({ limit: 5 });
      const raw = await rawGet("/v1/catalog/products", { limit: 5 });
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/catalog/products", "get");
    });

    it("GET /v1/balance", async () => {
      await client.v1.balance.get();
      const raw = await rawGet("/v1/balance");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/balance", "get");
    });

    it("GET /v1/orders", async () => {
      await client.v1.orders.list({ limit: 5 });
      const raw = await rawGet("/v1/orders", { limit: 5 });
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/orders", "get");
    });

    it("GET /v1/orders/active", async () => {
      await client.v1.orders.active();
      const raw = await rawGet("/v1/orders/active");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/orders/active", "get");
    });
  });

  describe("positive reads — /v2", () => {
    it("GET /v2/catalog/countries", async () => {
      await client.catalog.countries();
      const raw = await rawGet("/v2/catalog/countries");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/catalog/countries", "get");
    });

    it("GET /v2/catalog/services", async () => {
      await client.catalog.services();
      const raw = await rawGet("/v2/catalog/services");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/catalog/services", "get");
    });

    it("GET /v2/catalog/products", async () => {
      await client.catalog.products({ limit: 5 });
      const raw = await rawGet("/v2/catalog/products", { limit: 5 });
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/catalog/products", "get");
    });

    it("GET /v2/balance", async () => {
      await client.balance.get();
      const raw = await rawGet("/v2/balance");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/balance", "get");
    });

    it("GET /v2/orders", async () => {
      await client.orders.list({ limit: 5 });
      const raw = await rawGet("/v2/orders", { limit: 5 });
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/orders", "get");
    });

    it("GET /v2/orders/active", async () => {
      await client.orders.active();
      const raw = await rawGet("/v2/orders/active");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/orders/active", "get");
    });
  });

  // Conditionally cover GET /{v}/orders/{id} only if the account has an order.
  describe("positive read — orders/{id} (only if an order exists)", () => {
    it("GET /v1/orders/{id} + GET /v2/orders/{id}", async () => {
      const list = await rawGet("/v1/orders", { limit: 1 });
      expect(list.status).toBe(200);
      const data = (list.body as { data?: Array<{ id: number }> }).data ?? [];
      if (data.length === 0) {
        // No orders on this account — nothing to validate. Not a failure.
        console.info("[contract.test] no orders on account — skipping orders/{id}.");
        return;
      }
      const id = data[0]!.id;
      const rawV1 = await rawGet(`/v1/orders/${id}`);
      expect(rawV1.status).toBe(200);
      expectResponseValid(rawV1.body, "/v1/orders/{id}", "get");

      const rawV2 = await rawGet(`/v2/orders/${id}`);
      expect(rawV2.status).toBe(200);
      expectResponseValid(rawV2.body, "/v2/orders/{id}", "get");
    });
  });

  // ── Step 2: NEGATIVE / error contracts ──

  describe("negative — auth + validation error envelopes", () => {
    it("missing Bearer → 401 UNAUTHORIZED envelope (validates vs ErrorResponse)", async () => {
      // The SDK ALWAYS sends `Authorization`, so a no-auth request is a direct
      // fetch — this proves the API's anonymous 401 contract.
      const res = await fetch(
        new URL((BASE_URL as string).replace(/\/+$/, "") + "/v1/balance"),
        { headers: { Accept: "application/json" } },
      );
      const body = JSON.parse(await res.text()) as {
        error?: { code?: string };
      };
      expect(res.status).toBe(401);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(body), harness.formatErrors(validate)).toBe(true);
      expect(body.error?.code).toBe("UNAUTHORIZED");
    });

    it("invalid Bearer → 401 (SDK throws UnauthorizedError)", async () => {
      const bad = new SmscodeClient({
        token: "definitely-not-a-valid-token",
        baseUrl: BASE_URL,
      });
      const err = await bad.v1.balance.get().then(
        () => {
          throw new Error("expected the invalid-token read to reject");
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as SmscodeError).httpStatus).toBe(401);
      expect((err as SmscodeError).code).toBe("UNAUTHORIZED");
    });

    it("idempotency-key 'bad key!' → 422 VALIDATION_ERROR (rejected client-side, never placed)", async () => {
      // The SDK validates the key up front and throws BEFORE any request — so no
      // order is ever placed. This proves the contract: a malformed key is a
      // VALIDATION_ERROR (the same shape the server returns for a bad key).
      const thrown = await client.orders
        .create(
          { catalog_product_id: 88, max_price: "0.50", quantity: 1 },
          { idempotencyKey: "bad key!" },
        )
        .then(
          () => {
            throw new Error("expected a bad idempotency-key to reject");
          },
          (e: unknown) => e,
        );
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as SmscodeError).code).toBe("VALIDATION_ERROR");
    });

    it("/v2 orders.create maxPrice '0' → 422 (no order placed)", async () => {
      // A zero/invalid max_price is rejected by the server with 422 BEFORE any
      // provider purchase — safe to assert without funding (no order is placed).
      // The hard contract from the brief is the 422 status; the body is an
      // `ErrorResponse`. `VALIDATION_ERROR` is the expected code, but a 0-IDR
      // price guard could also legitimately yield `NO_OFFER_AVAILABLE` — both
      // are documented 422 codes, so we accept the 422 family to avoid a brittle
      // false-drift on the exact sub-code (the live suite confirms the precise code).
      const thrown = await client.orders
        .create({ catalog_product_id: 88, max_price: "0", quantity: 1 })
        .then(
          () => {
            throw new Error("expected max_price '0' to reject");
          },
          (e: unknown) => e,
        );
      expect(thrown).toBeInstanceOf(SmscodeError);
      const err = thrown as SmscodeError;
      expect(err.httpStatus).toBe(422);
      // The 422 family per the OpenAPI `UnprocessableEntity` response.
      expect([
        "VALIDATION_ERROR",
        "NO_OFFER_AVAILABLE",
        "PROVIDER_ERROR",
        "IDEMPOTENCY_KEY_REUSED",
      ]).toContain(err.code);
    });

    it("GET /v2/orders?status=BOGUS → 422 (validates vs ErrorResponse)", async () => {
      const raw = await rawGet("/v2/orders", { status: "BOGUS" });
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
      expect((raw.body as { error?: { code?: string } }).error?.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("captures a real app-error envelope and validates it vs ErrorResponse", async () => {
      // Any concrete failure envelope from the API must satisfy ErrorResponse.
      // Reuse the status=BOGUS 422 as the representative real app-error.
      const raw = await rawGet("/v1/orders", { status: "BOGUS" });
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
    });
  });

  // ── Step 2b: WEBHOOK endpoints — anti-drift ──
  // The live drift-suite covered catalog/balance/orders + negative auth, but the
  // webhook surface (`/v{1,2}/webhook`, `/v{1,2}/webhook/test`) was never driven
  // live. webhook.test.ts is MOCK-fetch, so it can't catch live API↔OpenAPI
  // webhook drift. These tests close that gap WITHOUT mutating the test account's
  // config: GET (read), PATCH `{}` (rejected → no write), /webhook/test (no URL
  // configured → safe 422, NO outbound delivery — grounded in `send_test`, which
  // returns `Err("No webhook URL configured")` BEFORE any HTTP POST).

  describe("webhook — config read (GET /v{1,2}/webhook)", () => {
    it("GET /v1/webhook → 200 WebhookConfig envelope (validates vs OpenAPI)", async () => {
      // Exercise the SDK path (proves `client.v1.webhook.get()` works), then
      // validate the raw WIRE body against the contract's WebhookConfig 200.
      const cfg = await client.v1.webhook.get();
      expect(cfg).toBeTypeOf("object");
      const raw = await rawGet("/v1/webhook");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v1/webhook", "get");
    });

    it("GET /v2/webhook → 200 WebhookConfig envelope (validates vs OpenAPI)", async () => {
      const cfg = await client.webhook.get(); // default surface is /v2
      expect(cfg).toBeTypeOf("object");
      const raw = await rawGet("/v2/webhook");
      expect(raw.status).toBe(200);
      expectResponseValid(raw.body, "/v2/webhook", "get");
    });
  });

  describe("webhook — empty-body PATCH rejected (no mutation)", () => {
    // PATCH with `{}` violates `minProperties: 1` → 422 VALIDATION_ERROR. The API
    // rejects it BEFORE any write, so the config is unchanged (safe + non-mutating).
    it("PATCH /v1/webhook {} → 422 VALIDATION_ERROR (validates vs ErrorResponse)", async () => {
      const raw = await rawPatch("/v1/webhook", {});
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
      expect((raw.body as { error?: { code?: string } }).error?.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("PATCH /v2/webhook {} → 422 VALIDATION_ERROR (validates vs ErrorResponse)", async () => {
      const raw = await rawPatch("/v2/webhook", {});
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
      expect((raw.body as { error?: { code?: string } }).error?.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("SDK update({}) → ValidationError (422), placing no config change", async () => {
      // Mirror the negative-auth pattern: prove the SDK surfaces the typed error.
      // `UpdateWebhookBody` makes both fields optional, so `{}` typechecks — the
      // `minProperties: 1` rule is enforced SERVER-side (the contract under test).
      const thrown = await client.v1.webhook
        .update({})
        .then(
          () => {
            throw new Error("expected an empty webhook PATCH to reject");
          },
          (e: unknown) => e,
        );
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as SmscodeError).httpStatus).toBe(422);
      expect((thrown as SmscodeError).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("webhook — /webhook/test with no URL configured (safe 422)", () => {
    // GROUNDING: `webhook_notifier::send_test` early-returns
    // `Err("No webhook URL configured")` when `webhook_url` is null/empty —
    // BEFORE constructing or sending the outbound POST. The handler maps that to
    // `AppError::Validation` → 422 VALIDATION_ERROR. So when the test account has
    // no webhook URL, this sends NO outbound delivery and is safe to run by
    // default. (If a URL WERE configured, this would deliver — that positive
    // path is gated behind SMSCODE_E2E_FUNDED below.)
    //
    // SAFETY GUARD: the 422 above is reached only because the test account has no
    // `webhook_url`. We do NOT rely on that account state — before each default
    // POST we read the (read-only) config and SKIP if a URL is configured, so a
    // default run can NEVER send a real outbound delivery (the FUNDED positive
    // path below covers the with-URL case). This mirrors that positive guard.
    async function skipIfWebhookUrlConfigured(): Promise<boolean> {
      const cfg = await client.webhook.get();
      if (cfg.webhook_url) {
        console.info(
          "[contract.test] test account HAS a webhook_url configured — skipping the " +
            "default /webhook/test negative coverage to avoid a real outbound delivery " +
            "(the funded positive path covers the with-URL case).",
        );
        return true;
      }
      return false;
    }

    it("POST /v1/webhook/test (no URL) → 422 VALIDATION_ERROR (validates vs ErrorResponse)", async () => {
      if (await skipIfWebhookUrlConfigured()) return;
      const raw = await rawPost("/v1/webhook/test", undefined);
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
      expect((raw.body as { error?: { code?: string } }).error?.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("POST /v2/webhook/test (no URL) → 422 VALIDATION_ERROR (validates vs ErrorResponse)", async () => {
      if (await skipIfWebhookUrlConfigured()) return;
      const raw = await rawPost("/v2/webhook/test", undefined);
      expect(raw.status).toBe(422);
      const validate = harness.schemaValidator("ErrorResponse");
      expect(validate(raw.body), harness.formatErrors(validate)).toBe(true);
      expect((raw.body as { error?: { code?: string } }).error?.code).toBe(
        "VALIDATION_ERROR",
      );
    });

    it("SDK test() (no URL) → ValidationError (422)", async () => {
      if (await skipIfWebhookUrlConfigured()) return;
      const thrown = await client.v1.webhook.test().then(
        () => {
          throw new Error(
            "expected /webhook/test with no configured URL to reject — " +
              "if this resolved, the test account HAS a webhook URL configured " +
              "(would have sent a real outbound delivery); see the FUNDED note.",
          );
        },
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(ValidationError);
      expect((thrown as SmscodeError).httpStatus).toBe(422);
      expect((thrown as SmscodeError).code).toBe("VALIDATION_ERROR");
    });
  });

  // ── Step 3: CREATE coverage — DEFAULT places NO order ──

  describe.skipIf(!RUN_FUNDED)(
    "positive create — FUNDED only (SMSCODE_E2E_FUNDED=1)",
    () => {
      it("create success + idempotent-replay envelopes validate vs the OpenAPI schema", async () => {
        // Funded-gated: this consumes balance and places a real order.
        const key = `contract-${Date.now()}`;
        const body = { catalog_product_id: 88, max_price: "5.00", quantity: 1 };

        // (a) Place the order via the SDK (exercises the money-safety create path).
        const first = await client.orders.create(body, { idempotencyKey: key });
        expect(first.idempotencyKey).toBe(key);
        expect(first.orders.length).toBeGreaterThan(0);
        expect(first.fx.pair).toBe("USD/IDR");
        const createdIds = first.orders.map((o) => o.id).sort();

        // (b) Validate the WIRE create envelope: re-issue the SAME key + body as a
        // raw POST. The server dedups on the idempotency key, so this returns the
        // ALREADY-created order (no second order placed) — a safe way to capture
        // the real success envelope and validate it against the 200 schema.
        const replay = await rawPost("/v2/orders/create", body, key);
        expect(replay.status).toBe(200);
        expectResponseValid(replay.body, "/v2/orders/create", "post");

        // The replay must be the SAME order set (idempotent — at most once).
        const replayIds = (
          (replay.body as { data?: { orders?: Array<{ id: number }> } }).data
            ?.orders ?? []
        )
          .map((o) => o.id)
          .sort();
        expect(replayIds).toEqual(createdIds);

        // Clean up: cancel the order(s) we created so the test account stays tidy.
        for (const o of first.orders) {
          await client.orders.cancel(o.id).catch(() => {
            /* best-effort cleanup; a non-cancelable state is fine */
          });
        }
      });

      it("positive /webhook/test → 200 WebhookTestResult — ONLY if a URL is already configured", async () => {
        // The positive `/webhook/test` path DELIVERS a real outbound POST, so it
        // is FUNDED-gated. To keep even this run NON-MUTATING, we never SET a URL
        // ourselves: we read the current config and only fire the test if the
        // test account has already configured `webhook_url`. Otherwise we skip — the
        // safe 422 path above already covers the no-URL contract.
        const cfg = await client.webhook.get();
        if (!cfg.webhook_url) {
          console.info(
            "[contract.test] FUNDED set but no webhook_url configured on the " +
              "test account — skipping the positive /webhook/test delivery " +
              "(we never set a URL ourselves to avoid mutating config).",
          );
          return;
        }
        // A URL is configured → exercise the real delivery + validate the wire
        // 200 envelope against WebhookTestResult.
        const raw = await rawPost("/v2/webhook/test", undefined);
        expect(raw.status).toBe(200);
        expectResponseValid(raw.body, "/v2/webhook/test", "post");
      });
    },
  );

  afterAll(() => {
    // No persistent resources to tear down (cancel happens inline in the funded
    // test). Placeholder kept for symmetry / future fixtures.
  });
});
