/**
 * Webhook configuration resource — `get` / `update` / `test`.
 *
 * Manages the account's outbound-webhook configuration: the delivery URL, the
 * signing secret, and the auto-disable status. The config carries NO money, so
 * the `/v1` and `/v2` surfaces are byte-identical (no `meta.fx`); both are
 * exposed for API-surface symmetry (`client.webhook.*` defaults to `/v2`,
 * `client.v1.webhook.*` is the `/v1` alias).
 *
 * **Security note:** `get`/`update` return `webhook_secret` in CLEAR TEXT so you
 * can re-verify your local signature check — treat the response as sensitive and
 * keep it server-side. See {@link verifyWebhookSignature}.
 *
 * `update` and `test` are state-changing. They carry no idempotency key, so —
 * like the order mutations — they are issued with retry DISABLED (`retry: 0`): a
 * transient failure surfaces as a thrown error rather than a silent replay.
 */
import type { RequestFn } from "./orders.js";
import type { components } from "../types.gen.js";

/** The saved outbound-webhook configuration (secret returned in clear text). */
export type WebhookConfig = components["schemas"]["WebhookConfig"];
/** Body for `update` — provide at least one field; `""` clears a field. */
export type UpdateWebhookBody = components["schemas"]["UpdateWebhookBody"];
/** The result of `test()` — the HTTP status your endpoint returned. */
export type WebhookTestResult = components["schemas"]["WebhookTestResult"];

/** A webhook config surface bound to one API version prefix (`/v1` or `/v2`). */
class WebhookResource {
  constructor(
    private readonly request: RequestFn,
    private readonly prefix: "/v1" | "/v2",
  ) {}

  /** Fetch the current webhook configuration (includes the clear-text secret). */
  async get(): Promise<WebhookConfig> {
    const { data } = await this.request<WebhookConfig>(
      "GET",
      `${this.prefix}/webhook`,
    );
    return data as WebhookConfig;
  }

  /**
   * Set or clear the delivery URL and/or signing secret.
   *
   * Send at least one of `webhook_url` / `webhook_secret`; pass `""` to clear a
   * field. A successful update also clears any auto-disable state. Not
   * auto-retried (state-changing, no idempotency key).
   */
  async update(body: UpdateWebhookBody): Promise<WebhookConfig> {
    const { data } = await this.request<WebhookConfig>(
      "PATCH",
      `${this.prefix}/webhook`,
      { body, retry: 0 },
    );
    return data as WebhookConfig;
  }

  /**
   * Send a `webhook.test` event to your configured URL and report the HTTP
   * status your endpoint returned. Requires a configured URL and is heavily
   * rate-limited. Not auto-retried (state-changing, no idempotency key).
   */
  async test(): Promise<WebhookTestResult> {
    const { data } = await this.request<WebhookTestResult>(
      "POST",
      `${this.prefix}/webhook/test`,
      { retry: 0 },
    );
    return data as WebhookTestResult;
  }
}

/** The `/v2` webhook config surface (default; byte-identical to `/v1`). */
export class V2WebhookResource extends WebhookResource {
  constructor(request: RequestFn) {
    super(request, "/v2");
  }
}

/** The `/v1` webhook config surface. */
export class V1WebhookResource extends WebhookResource {
  constructor(request: RequestFn) {
    super(request, "/v1");
  }
}
