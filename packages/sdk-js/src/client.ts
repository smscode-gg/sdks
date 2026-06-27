/**
 * Core HTTP client for the SMSCode API.
 *
 * {@link SmscodeClient} is transport-only: it builds the request, attaches
 * Bearer auth, parses the JSON envelope with the standard `JSON.parse` (money
 * fields are domain-bounded within the JS safe-integer range and are decoded by
 * the resource layer in a later task — no lossless parser here), captures the
 * `X-Request-Id`, and converts failures into the typed errors from
 * `./errors`. Resource methods are layered on top in later tasks.
 */
import {
  AbortError,
  NetworkError,
  TimeoutError,
  mapError,
} from "./errors.js";
import { withRetry } from "./retry.js";
import { V1CatalogResource, V2CatalogResource } from "./resources/catalog.js";
import { V1BalanceResource, V2BalanceResource } from "./resources/balance.js";
import { V1OrdersResource, V2OrdersResource } from "./resources/orders.js";
import { V1WebhookResource, V2WebhookResource } from "./resources/webhook.js";

/** The `/v1` (canonical IDR) resource namespace, reachable via `client.v1`. */
export interface V1Namespace {
  readonly catalog: V1CatalogResource;
  readonly balance: V1BalanceResource;
  readonly orders: V1OrdersResource;
  readonly webhook: V1WebhookResource;
}

/** Default API origin. Override via {@link SmscodeClientOptions.baseUrl}. */
const DEFAULT_BASE_URL = "https://api.smscode.gg";

/** A query string value. `undefined` (and `null`) entries are omitted. */
export type QueryValue = string | number | boolean | null | undefined;

/** Options for constructing a {@link SmscodeClient}. */
export interface SmscodeClientOptions {
  /** API bearer token. Sent as `Authorization: Bearer <token>`. */
  token: string;
  /** API origin. Defaults to `https://api.smscode.gg`. A trailing slash is tolerated. */
  baseUrl?: string;
  /**
   * `fetch` implementation. Defaults to the global `fetch`. Injectable for
   * testing and for runtimes that supply a custom fetch.
   */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Omit (or `0`) to disable. */
  timeoutMs?: number;
  /** Max automatic retries for transient failures (429/503/network). Default 0. */
  maxRetries?: number;
}

/** Per-request options for {@link SmscodeClient.request}. */
export interface RequestOptions {
  /** Query parameters appended to the URL. `undefined`/`null` values are dropped. */
  query?: Record<string, QueryValue>;
  /** JSON request body. Serialized with `JSON.stringify`. */
  body?: unknown;
  /** Extra headers. Merged over (and may override) the defaults. */
  headers?: Record<string, string>;
  /** Override the client-level retry count for this request. */
  retry?: number;
  /** An external abort signal, combined with the timeout signal. */
  signal?: AbortSignal;
}

/** The parsed result of a successful request. */
export interface ApiResult<T = unknown> {
  /** The decoded success envelope body. */
  data: T;
  /** Optional response metadata (`meta` on the envelope), when present. */
  meta?: Record<string, unknown>;
  /** The `X-Request-Id` of the response, when present. */
  requestId?: string;
  /** HTTP status of the response. */
  status: number;
}

/** HTTP methods the client issues. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Statuses that are safe to retry (transient throttling / outage). */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Read `retryAfterSeconds` off an already-mapped error, when present. */
function retryAfterSecondsOf(err: unknown): number | undefined {
  if (
    err &&
    typeof err === "object" &&
    "retryAfterSeconds" in err &&
    typeof (err as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
  ) {
    return (err as { retryAfterSeconds: number }).retryAfterSeconds;
  }
  return undefined;
}

/** Resolve a relative API path against a base origin. */
function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  // Normalize: drop a trailing slash on the base, ensure a leading slash on the path.
  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(base + rel);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Parse a response body as JSON, returning `undefined` for empty/non-JSON. */
async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    // Standard JSON.parse — zero-dep. Money fields stay within JS safe-integer
    // range and are handled by the resource layer.
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The SMSCode API client.
 *
 * @example
 * ```ts
 * const client = new SmscodeClient({ token: process.env.SMSCODE_TOKEN! });
 * const { data } = await client.request("GET", "/v2/balance");
 * ```
 */
export class SmscodeClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /** `/v2` catalog reads (USD-projected). The default surface. */
  readonly catalog: V2CatalogResource;
  /** `/v2` balance read (USD-projected). The default surface. */
  readonly balance: V2BalanceResource;
  /** `/v2` order reads (USD-projected). The default surface. */
  readonly orders: V2OrdersResource;
  /** Webhook configuration (`get`/`update`/`test`). Money-free; defaults to `/v2`. */
  readonly webhook: V2WebhookResource;
  /** The `/v1` namespace — the same reads against the canonical IDR API. */
  readonly v1: V1Namespace;

  constructor(options: SmscodeClientOptions) {
    if (!options.token) {
      throw new TypeError("SmscodeClient requires a `token`.");
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    // Capture the global fetch lazily-bound so `this` is correct on all runtimes.
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new TypeError(
        "No `fetch` available. Pass one via `fetch` or run on a fetch-capable runtime.",
      );
    }
    this.fetchImpl = options.fetch ? f : f.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 0;
    this.maxRetries = options.maxRetries ?? 0;

    // Resource tree. Each resource delegates to `request`; the default surface
    // is `/v2` (USD-projected), with the canonical IDR API under `.v1`.
    const request = this.request.bind(this);
    this.catalog = new V2CatalogResource(request);
    this.balance = new V2BalanceResource(request);
    this.orders = new V2OrdersResource(request);
    this.webhook = new V2WebhookResource(request);
    this.v1 = {
      catalog: new V1CatalogResource(request),
      balance: new V1BalanceResource(request),
      orders: new V1OrdersResource(request),
      webhook: new V1WebhookResource(request),
    };
  }

  /**
   * Issue a request to the API.
   *
   * Builds the URL + query, attaches Bearer auth + `Content-Type`, applies the
   * timeout via `AbortSignal`, parses the JSON envelope, and on a non-2xx
   * response **or** a `success: false` envelope throws the mapped typed error.
   *
   * @typeParam T  The expected `data` payload type.
   */
  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const maxRetries = options.retry ?? this.maxRetries;

    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    };

    const hasBody = options.body !== undefined;
    const serializedBody = hasBody ? JSON.stringify(options.body) : undefined;

    // Delegate transient-failure retry to the shared `withRetry` engine — the
    // single source of retry truth (it also owns Retry-After + backoff). Only
    // network failures and the transient statuses (429/503) are retried; mapped
    // business failures (422/409/…) are thrown on the first attempt.
    return withRetry<ApiResult<T>>(
      () =>
        this.attempt<T>(
          method,
          url,
          baseHeaders,
          serializedBody,
          options.signal,
        ),
      {
        maxRetries,
        retryOn: (err) => this.isRetryable(err),
        retryAfter: (err) => retryAfterSecondsOf(err),
      },
    );
  }

  /** A single (non-retried) attempt. */
  private async attempt<T>(
    method: HttpMethod,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    externalSignal: AbortSignal | undefined,
  ): Promise<ApiResult<T>> {
    const controller = this.timeoutMs > 0 ? new AbortController() : undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      // Forward an external abort onto our controller.
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else
          externalSignal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
      }
    }

    const signal = controller?.signal ?? externalSignal;

    let response: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = body;
      if (signal) init.signal = signal;
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (this.isAbort(err)) {
        if (timedOut) {
          throw new TimeoutError(
            `Request to ${url} timed out after ${this.timeoutMs}ms`,
            { cause: err },
          );
        }
        throw new AbortError(`Request to ${url} was aborted`, { cause: err });
      }
      throw new NetworkError(
        err instanceof Error ? err.message : `Network request to ${url} failed`,
        { cause: err },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const requestId = response.headers.get("X-Request-Id") ?? undefined;
    const parsed = await parseJsonBody(response);

    const envelope =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : undefined;
    const isFailure =
      !response.ok || (envelope !== undefined && envelope.success === false);

    if (isFailure) {
      throw mapError(response.status, parsed, requestId, response.headers);
    }

    const result: ApiResult<T> = {
      data: (envelope?.data ?? parsed) as T,
      status: response.status,
    };
    if (envelope && typeof envelope.meta === "object" && envelope.meta !== null) {
      result.meta = envelope.meta as Record<string, unknown>;
    }
    if (requestId !== undefined) result.requestId = requestId;
    return result;
  }

  /** Whether an already-mapped error is worth retrying. */
  private isRetryable(err: unknown): boolean {
    if (err instanceof NetworkError) return true;
    if (
      err &&
      typeof err === "object" &&
      "httpStatus" in err &&
      typeof (err as { httpStatus?: unknown }).httpStatus === "number"
    ) {
      return RETRYABLE_STATUSES.has((err as { httpStatus: number }).httpStatus);
    }
    return false;
  }

  /** Distinguish an abort/timeout rejection from a generic network failure. */
  private isAbort(err: unknown): boolean {
    return (
      err instanceof DOMException && err.name === "AbortError"
    ) ||
      (err instanceof Error && err.name === "AbortError");
  }
}
