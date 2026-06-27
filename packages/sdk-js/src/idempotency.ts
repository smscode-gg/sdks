/**
 * Idempotency-key resolution for write operations (the money-safety primitive).
 *
 * Every order create carries an `idempotency-key` header so a retried (or
 * resubmitted) write is applied **at most once** by the server. {@link resolveKey}
 * is the single source of truth for "what key does this request use":
 *
 * - A caller-provided key is **validated up front** against the server's exact
 *   contract (`^[A-Za-z0-9_-]{1,128}$`) and a {@link ValidationError} is thrown
 *   *before any request is issued* — an invalid key never reaches the wire (and so
 *   never risks a money operation under a bad key).
 * - When no key is provided, a v4 UUID is generated with {@link crypto.randomUUID},
 *   which always satisfies the contract.
 *
 * The resolved key is then attached to the request header, to the success result,
 * and to **every** thrown error by `orders.create`, so a caller can always retry
 * with the SAME key.
 */
import { ValidationError } from "./errors.js";

/**
 * The idempotency-key contract, byte-for-byte the server's validator
 * (`vn-api` `validate_idempotency_key`, spec §3.0): 1–128 chars from
 * `A-Za-z0-9_-`. Anchored, so a partial match is rejected. The SDK validates to
 * the SAME pattern so an invalid key fails locally instead of round-tripping to a
 * `422 VALIDATION_ERROR`.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether `key` satisfies the idempotency-key contract.
 *
 * Mirrors the server's byte-wise check (`A-Za-z0-9_-` only, 1–128 chars). The
 * character class is ASCII-only, so the regex and a byte-wise scan agree.
 */
export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Resolve the idempotency key for a write.
 *
 * @param provided  An optional caller-supplied key.
 * @returns The key to send on the `idempotency-key` header.
 * @throws {ValidationError} if `provided` is present but fails the contract — the
 *   throw happens **before any request is issued**, so no money operation is ever
 *   attempted under an invalid key.
 */
export function resolveKey(provided?: string): string {
  if (provided !== undefined) {
    if (!isValidIdempotencyKey(provided)) {
      throw new ValidationError(
        `Invalid idempotency key ${JSON.stringify(
          provided,
        )} (allowed: A-Z a-z 0-9 _ - ; 1–128 chars).`,
      );
    }
    return provided;
  }
  return crypto.randomUUID();
}
