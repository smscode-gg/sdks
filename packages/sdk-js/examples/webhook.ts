/**
 * @smscode/sdk — verify an incoming webhook (framework-agnostic).
 * Pass the EXACT received body bytes (never re-serialized), the
 * `X-Webhook-Signature` header, and your configured webhook secret.
 * In your app, import from "@smscode/sdk"; this in-repo example imports the
 * local source so it type-checks in CI.
 */
import { verifyWebhookSignature, parseWebhookEvent } from "../src/index.js";

export async function handleWebhook(rawBody: string, signatureHeader: string | null, secret: string) {
  // MUST await — verifyWebhookSignature returns Promise<boolean>. Without await a
  // (truthy) Promise would accept EVERY request, including forged ones.
  const ok = await verifyWebhookSignature(rawBody, signatureHeader ?? "", secret);
  if (!ok) return { status: 401 as const }; // reject: bad/missing signature
  const event = parseWebhookEvent(rawBody);
  console.log("verified webhook event:", event.event);
  return { status: 200 as const };
}
