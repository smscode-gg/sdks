/**
 * End-to-end SDK smoke: `create → waitForOtp → finish` (cancel only on no-OTP) against a test account.
 *
 * **GATED + DEFAULT-OFF.** This script places a REAL order (and spends real
 * balance) ONLY when `SMSCODE_E2E_FUNDED=1` AND a token is present. With the flag
 * unset (the default) — or with no token — it runs in DRY mode: it prints what it
 * *would* do and exits cleanly **before any create**. No order is ever placed in
 * dry mode.
 *
 * Configuration comes from the environment ONLY (never from any committed file):
 *   SMSCODE_E2E_FUNDED          must be "1" to arm the funded run (default off)
 *   SMSCODE_TOKEN               API token (required to arm; dry-exits if absent)
 *   SMSCODE_CATALOG_PRODUCT_ID  catalog product id to order (required to arm)
 *   SMSCODE_BASE_URL            optional API origin override
 *   SMSCODE_MAX_PRICE_USD       optional USD decimal-string price guard (default "0.50")
 *   SMSCODE_OTP_TIMEOUT_MS      optional waitForOtp budget in ms (default 120000)
 *
 * Run:
 *   bun run examples/smoke.ts                                   # dry no-op
 *   SMSCODE_E2E_FUNDED=1 SMSCODE_TOKEN=... \
 *     SMSCODE_CATALOG_PRODUCT_ID=... bun run examples/smoke.ts  # funded e2e
 *
 * Imports the SDK via its public entry (mirrors the published `@smscode/sdk`
 * surface) so it exercises exactly what consumers use.
 */
import {
  SmscodeClient,
  SmscodeError,
  OtpTimeoutError,
  OrderTerminalError,
} from "../src/index.js";

/** Read an env var, returning `undefined` for unset/empty. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
}

async function main(): Promise<void> {
  const funded = env("SMSCODE_E2E_FUNDED") === "1";
  const token = env("SMSCODE_TOKEN");
  const catalogProductIdRaw = env("SMSCODE_CATALOG_PRODUCT_ID");
  const baseUrl = env("SMSCODE_BASE_URL");
  const maxPrice = env("SMSCODE_MAX_PRICE_USD") ?? "0.50";
  const otpTimeoutMs = Number(env("SMSCODE_OTP_TIMEOUT_MS") ?? "120000");

  // ── Gate: dry mode unless explicitly armed AND fully configured. ──────────
  // The default run takes this branch and exits 0 BEFORE constructing anything
  // that could place an order.
  if (!funded) {
    console.log(
      "[smoke] DRY MODE — SMSCODE_E2E_FUNDED is not '1'. No order will be placed.",
    );
    console.log(
      "[smoke] To run the funded end-to-end smoke (spends real balance):",
    );
    console.log(
      "[smoke]   SMSCODE_E2E_FUNDED=1 SMSCODE_TOKEN=... SMSCODE_CATALOG_PRODUCT_ID=... bun run examples/smoke.ts",
    );
    return;
  }
  if (!token) {
    console.log(
      "[smoke] DRY MODE — armed but SMSCODE_TOKEN is missing. No order will be placed.",
    );
    return;
  }
  if (!catalogProductIdRaw) {
    console.log(
      "[smoke] DRY MODE — armed but SMSCODE_CATALOG_PRODUCT_ID is missing. No order will be placed.",
    );
    return;
  }
  const catalogProductId = Number(catalogProductIdRaw);
  if (!Number.isInteger(catalogProductId) || catalogProductId <= 0) {
    console.log(
      `[smoke] DRY MODE — SMSCODE_CATALOG_PRODUCT_ID (${catalogProductIdRaw}) is not a positive integer. No order will be placed.`,
    );
    return;
  }

  // ── Funded end-to-end: create → waitForOtp → finish (cancel only on no-OTP). ──
  console.log("[smoke] FUNDED RUN — this WILL place a real order.");
  const client = new SmscodeClient({
    token,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  // 1) Create (rent) one number. The resolved idempotency key is returned so a
  //    retry could reuse it; we don't retry here (the smoke is single-shot).
  const { orders, idempotencyKey } = await client.orders.create({
    catalog_product_id: catalogProductId,
    max_price: maxPrice,
    quantity: 1,
  });
  const order = orders[0];
  if (!order) {
    throw new Error("[smoke] create returned no orders");
  }
  console.log(
    `[smoke] created order ${order.id} (idempotency-key ${idempotencyKey}); amount ${order.amount.amount} ${order.amount.currency}`,
  );

  // 2) Wait for the OTP (FX-free /v1 poll under the hood). A no-OTP outcome
  //    (timeout or terminal-without-OTP) is expected on a stub/test account and is
  //    NOT fatal — we clean up below. Any other error is captured and re-thrown
  //    AFTER cleanup (never thrown from a `finally`).
  let gotOtp = false;
  let fatal: unknown;
  try {
    const { otpCode, status } = await client.orders.waitForOtp(order.id, {
      timeoutMs: otpTimeoutMs,
    });
    console.log(`[smoke] OTP received: ${otpCode} (status ${status})`);
    gotOtp = true;
  } catch (err) {
    if (err instanceof OtpTimeoutError || err instanceof OrderTerminalError) {
      console.log(`[smoke] no classified OTP (${err.code}); checking lifecycle capabilities.`);
    } else {
      fatal = err;
    }
  }

  // 3) Lifecycle-correct cleanup: any delivered SMS closes cancel/refund, even
  //    when no OTP code was classified. Re-read the canonical capabilities
  //    before choosing FINISH versus CANCEL; a wait-helper error alone does not
  //    prove refund eligibility. Tolerate a lifecycle that permits neither.
  try {
    if (gotOtp) {
      await client.orders.finish(order.id);
      console.log(`[smoke] finished order ${order.id}.`);
    } else {
      const latest = await client.v1.orders.get(order.id);
      if (latest.can_finish) {
        await client.orders.finish(order.id);
        console.log(`[smoke] finished delivered order ${order.id}.`);
      } else if (latest.can_cancel) {
        const result = await client.orders.cancel(order.id);
        console.log(
          `[smoke] canceled order ${result.order_id}; refunded ${result.refund_amount.amount} ${result.refund_amount.currency}`,
        );
      } else {
        console.log(`[smoke] cleanup skipped: order ${order.id} has no permitted action.`);
      }
    }
  } catch (err) {
    if (err instanceof SmscodeError) {
      console.log(`[smoke] cleanup skipped (${err.code}): ${err.message}`);
    } else if (fatal === undefined) {
      fatal = err;
    }
  }

  // Surface the original (non-OTP) failure now that cleanup has run.
  if (fatal !== undefined) throw fatal;

  console.log(`[smoke] done (order ${order.id}).`);
}

main().catch((err: unknown) => {
  console.error("[smoke] FAILED:", err);
  process.exitCode = 1;
});
