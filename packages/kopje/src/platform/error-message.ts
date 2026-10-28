import { MAINTENANCE_REASONS, StoreUnavailableError } from "./store-errors";

// The message of a thrown value, for logs and reports.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Names of standard errors, which tell an abort or a timeout from other failures.
const STANDARD_NAMES = new Set([
  "AbortError",
  "DataError",
  "InvalidAccessError",
  "InvalidStateError",
  "NetworkError",
  "NotSupportedError",
  "OperationError",
  "QuotaExceededError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);
const REASONS = new Set<string>(MAINTENANCE_REASONS);

// What a log may say about a thrown value (DATA-5): only allowlisted metadata. Its class, its name if that is a standard
// one, and the reason of a StoreUnavailableError if it is a known one. Never the message, which can carry a token, an
// Access assertion, a request body or post content, and never a free-form name or code.
export function errorFields(error: unknown): { error: string; name?: string; reason?: string } {
  if (typeof error !== "object" || error === null) {
    return { error: typeof error };
  }
  const ctor = error.constructor?.name;
  const cls = typeof ctor === "string" && /^[A-Za-z0-9_$]{1,64}$/.test(ctor) ? ctor : "Object";
  const name = (error as { name?: unknown }).name;
  const reason = error instanceof StoreUnavailableError ? error.reason : undefined;
  return {
    error: cls,
    ...(typeof name === "string" && name !== cls && STANDARD_NAMES.has(name) ? { name } : {}),
    ...(reason !== undefined && REASONS.has(reason) ? { reason } : {}),
  };
}
