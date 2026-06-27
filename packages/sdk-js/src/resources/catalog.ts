/**
 * Catalog read resources — countries, services, products, exchange rate.
 *
 * Two surfaces are exposed by the client:
 * - {@link V2CatalogResource} (the default, `client.catalog.*`) projects prices
 *   to USD {@link Money} objects and carries the per-response FX receipt.
 * - {@link V1CatalogResource} (`client.v1.catalog.*`) returns the canonical IDR
 *   shapes verbatim — `price` is a plain IDR `number`.
 *
 * Both are read-only (`GET`); they delegate to {@link RequestFn} (the client's
 * `request`) and never touch transport details themselves.
 */
import type { ApiResult, QueryValue } from "../client.js";
import { requireFx } from "../internal/decode.js";
import { parseMoney } from "../money.js";
import type { Money } from "../money.js";
import type { components } from "../types.gen.js";

/** The subset of the client used by resources: its `request` method. */
export type RequestFn = <T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options?: { query?: Record<string, QueryValue> },
) => Promise<ApiResult<T>>;

type V1Country = components["schemas"]["V1Country"];
type V1Service = components["schemas"]["V1Service"];
type V1Product = components["schemas"]["V1Product"];
type V2Product = components["schemas"]["V2Product"];
type V1ExchangeRate = components["schemas"]["V1ExchangeRate"];
type V2Fx = components["schemas"]["V2Fx"];
type PaginationMeta = components["schemas"]["PaginationMeta"];
type V2ProductsMeta = components["schemas"]["V2ProductsMeta"];

/** Query parameters shared by the `services` listing. */
export interface ServicesParams {
  /** Filter by country (`V1Country.id`). */
  country_id?: number;
}

/** Query parameters for the `products` listing. */
export interface ProductsParams {
  /** Filter by country (`V1Country.id`). */
  country_id?: number;
  /** Filter by service/platform (`V1Service.id`). */
  platform_id?: number;
  /** Max items per page (server-clamped 1–10000; default 1000). */
  limit?: number;
  /** 1-based page number (default 1). */
  page?: number;
  /** Sort order for the product list. */
  sort?: components["parameters"]["SortQuery"];
}

/** Query parameters for the exchange-rate lookup. */
export interface ExchangeRateParams {
  /** Currency pair, formatted `BASE/QUOTE` (default `USD/IDR`). */
  pair?: string;
}

/** A decoded `/v2` product — identical to {@link V2Product} but `price` is a {@link Money}. */
export interface ProductV2 extends Omit<V2Product, "price"> {
  price: Money;
}

/** A page of `/v2` products with pagination metadata + the FX receipt. */
export interface ProductsPageV2 {
  products: ProductV2[];
  meta: V2ProductsMeta;
  fx: V2Fx;
}

/** A page of `/v1` products (IDR prices) with pagination metadata. */
export interface ProductsPageV1 {
  products: V1Product[];
  meta: PaginationMeta;
}

/** The `/v2` catalog surface (USD-projected). */
export class V2CatalogResource {
  constructor(private readonly request: RequestFn) {}

  /** List every country in the catalog. */
  async countries(): Promise<V1Country[]> {
    const { data } = await this.request<V1Country[]>(
      "GET",
      "/v2/catalog/countries",
    );
    return data ?? [];
  }

  /** List services, optionally scoped to a country. */
  async services(params: ServicesParams = {}): Promise<V1Service[]> {
    const { data } = await this.request<V1Service[]>(
      "GET",
      "/v2/catalog/services",
      { query: { country_id: params.country_id } },
    );
    return data ?? [];
  }

  /** List a page of products with USD-projected prices + the FX receipt. */
  async products(params: ProductsParams = {}): Promise<ProductsPageV2> {
    const result = await this.request<V2Product[]>("GET", "/v2/catalog/products", {
      query: {
        country_id: params.country_id,
        platform_id: params.platform_id,
        limit: params.limit,
        page: params.page,
        sort: params.sort,
      },
    });
    // Validate the envelope shape with TYPED errors (consistent with orders):
    // `requireFx` throws `INVALID_RESPONSE` on a missing FX receipt (rather than
    // a bare `meta.fx` raw `TypeError` on a malformed 2xx), and `parseMoney`
    // throws `INVALID_MONEY` on a missing/malformed per-product `price`. This is
    // a read; no idempotency key is involved.
    const fx = requireFx(result);
    const meta = result.meta as V2ProductsMeta;
    const products = (result.data ?? []).map((p) => ({
      ...p,
      price: parseMoney(p.price),
    }));
    return { products, meta, fx };
  }

  /** The current USD/IDR FX receipt. */
  async exchangeRate(params: ExchangeRateParams = {}): Promise<V2Fx> {
    const { data } = await this.request<V2Fx>(
      "GET",
      "/v2/catalog/exchange-rate",
      { query: { pair: params.pair } },
    );
    return data as V2Fx;
  }
}

/** The `/v1` catalog surface (canonical IDR). */
export class V1CatalogResource {
  constructor(private readonly request: RequestFn) {}

  /** List every country in the catalog. */
  async countries(): Promise<V1Country[]> {
    const { data } = await this.request<V1Country[]>(
      "GET",
      "/v1/catalog/countries",
    );
    return data ?? [];
  }

  /** List services, optionally scoped to a country. */
  async services(params: ServicesParams = {}): Promise<V1Service[]> {
    const { data } = await this.request<V1Service[]>(
      "GET",
      "/v1/catalog/services",
      { query: { country_id: params.country_id } },
    );
    return data ?? [];
  }

  /** List a page of products with IDR prices + pagination metadata. */
  async products(params: ProductsParams = {}): Promise<ProductsPageV1> {
    const result = await this.request<V1Product[]>("GET", "/v1/catalog/products", {
      query: {
        country_id: params.country_id,
        platform_id: params.platform_id,
        limit: params.limit,
        page: params.page,
        sort: params.sort,
      },
    });
    return {
      products: result.data ?? [],
      meta: result.meta as PaginationMeta,
    };
  }

  /** The stored exchange rate for a currency pair (default `USD/IDR`). */
  async exchangeRate(params: ExchangeRateParams = {}): Promise<V1ExchangeRate> {
    const { data } = await this.request<V1ExchangeRate>(
      "GET",
      "/v1/catalog/exchange-rate",
      { query: { pair: params.pair } },
    );
    return data as V1ExchangeRate;
  }
}
