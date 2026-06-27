/**
 * Internal `/v2` envelope-decode helpers shared across resources.
 *
 * Not part of the public surface (`src/index.ts` does NOT re-export this); it
 * exists so every `/v2` resource validates a money envelope's shape ONE way,
 * rather than each re-deriving a bare `result.meta!.fx` deref.
 */
import { SmscodeError } from "../errors.js";
import type { ApiResult } from "../client.js";
import type { components } from "../types.gen.js";

type V2Fx = components["schemas"]["V2Fx"];

/**
 * Extract the FX receipt from a `/v2` success envelope, validating its shape.
 *
 * Every `/v2` money response carries `meta.fx` (the contract marks `meta`
 * required and `meta.fx` required, on BOTH `V2Meta` and the paginated
 * `V2ProductsMeta`). If `meta`/`meta.fx` is absent or malformed on a 2xx, a bare
 * `(result.meta as …).fx` would throw a raw `TypeError`. On the create path that
 * raw throw would escape the idempotency-stamp boundary **unstamped** — leaving a
 * caller unable to safely replay a possibly-already-placed order; on the `/v2`
 * reads (balance/catalog/orders) it would surface as an untyped error,
 * inconsistent with the rest of the SDK. So this throws a TYPED
 * {@link SmscodeError} (synthetic code `INVALID_RESPONSE`, mirroring the SDK-side
 * synthetic codes like `NETWORK_ERROR`/`ORDER_TERMINAL`); on create the boundary
 * then catches and stamps it with the resolved key.
 *
 * @throws {SmscodeError} (code `INVALID_RESPONSE`) when `meta`/`meta.fx` is
 *   missing or not an object.
 */
export function requireFx(result: ApiResult<unknown>): V2Fx {
  const meta = result.meta;
  if (meta && typeof meta === "object" && "fx" in meta) {
    const fx = (meta as { fx?: unknown }).fx;
    if (fx && typeof fx === "object") {
      return fx as V2Fx;
    }
  }
  throw new SmscodeError(
    "INVALID_RESPONSE",
    "The /v2 response is missing its FX receipt (meta.fx); the money projection cannot be trusted.",
    { httpStatus: result.status },
  );
}
