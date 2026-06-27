/**
 * @smscode/sdk quickstart — create an order, wait for the OTP, USE it, then finish.
 * Cancel ONLY when no OTP arrives (once an OTP is received, cancel/refund is
 * closed — finish the order instead). In your app, import from "@smscode/sdk";
 * this in-repo example imports the local source so it type-checks in CI.
 * Read your token from the environment; never hardcode it.
 *   SMSCODE_TOKEN               your API token (Account Settings)
 *   SMSCODE_CATALOG_PRODUCT_ID  the catalog product to order
 * Run: SMSCODE_TOKEN=... SMSCODE_CATALOG_PRODUCT_ID=... bun run examples/quickstart.ts
 */
import { SmscodeClient, OtpTimeoutError, OrderTerminalError } from "../src/index.js";

const token = process.env.SMSCODE_TOKEN;
const catalogProductId = Number(process.env.SMSCODE_CATALOG_PRODUCT_ID);
if (!token || !Number.isInteger(catalogProductId)) {
  console.error("Set SMSCODE_TOKEN and SMSCODE_CATALOG_PRODUCT_ID.");
  process.exit(1);
}

const client = new SmscodeClient({ token });

const { orders, idempotencyKey } = await client.orders.create({
  catalog_product_id: catalogProductId,
  max_price: "0.50",
  quantity: 1,
});
const order = orders[0]!;
console.log(`created order ${order.id} (reuse idempotency-key ${idempotencyKey} on retry)`);

try {
  const { otpCode } = await client.orders.waitForOtp(order.id, { timeoutMs: 120_000 });
  console.log("OTP:", otpCode);
  // → submit `otpCode` in your target app here (the actual verification step).
  // Once the code has been used, finish the order (refund is closed once an OTP arrives):
  await client.orders.finish(order.id);
} catch (err) {
  if (err instanceof OtpTimeoutError || err instanceof OrderTerminalError) {
    await client.orders.cancel(order.id); // no OTP → cancel for a refund
    console.log("no OTP — canceled for refund");
  } else throw err;
}
