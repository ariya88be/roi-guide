/**
 * Typed errors for the RentCast client.
 *
 * Security rule (brief §9): user-facing errors are generic; provider errors and
 * stack traces stay server-side. These error objects therefore NEVER carry the
 * API key. `endpoint` is stored WITHOUT its query string so we don't leak
 * address/PII into logs either.
 */

/** Strip query string from a URL for safe logging. */
function safeEndpoint(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Base class so callers can `instanceof RentCastError`. */
export class RentCastError extends Error {
  readonly endpoint: string;
  constructor(message: string, endpoint: string) {
    super(message);
    this.name = "RentCastError";
    this.endpoint = safeEndpoint(endpoint);
  }
}

/** Configuration problem (e.g. missing API key). Not retryable. */
export class RentCastConfigError extends RentCastError {
  constructor(message: string) {
    super(message, "");
    this.name = "RentCastConfigError";
  }
}

/** Non-2xx HTTP response. `retryable` marks 429/5xx. */
export class RentCastHttpError extends RentCastError {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, endpoint: string, retryable: boolean) {
    super(`RentCast request failed with HTTP ${status}`, endpoint);
    this.name = "RentCastHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** Response body did not match the expected schema. Not retryable. */
export class RentCastValidationError extends RentCastError {
  readonly issues: unknown;
  constructor(endpoint: string, issues: unknown) {
    super("RentCast response failed schema validation", endpoint);
    this.name = "RentCastValidationError";
    this.issues = issues;
  }
}

/** Ran out of retries on a retryable error. Carries the last status seen. */
export class RentCastRetryExhaustedError extends RentCastError {
  readonly attempts: number;
  readonly lastStatus?: number;
  constructor(endpoint: string, attempts: number, lastStatus?: number) {
    super(`RentCast request failed after ${attempts} attempts`, endpoint);
    this.name = "RentCastRetryExhaustedError";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}
