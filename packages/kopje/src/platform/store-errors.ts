// Errors crossing the RPC boundary keep only their message (DO errors carry no code), so the Store encodes
// "maintenance" in the message and the Worker decodes it back into a typed error.
const MAINTENANCE_PREFIX = "kopje-maintenance: ";

export const MAINTENANCE_REASONS = [
  "version-mismatch",
  "schema-pending",
  "schema-diverged",
  "upgrade-in-progress",
  "upgrade-failed",
  "bookmark-failed",
  "verify-failed",
  "maintenance",
  "dump-in-progress",
  "import-in-progress",
  "unpublished",
  "rebuild-in-progress",
  "transient",
] as const;

export type MaintenanceReason = (typeof MAINTENANCE_REASONS)[number];

// Thrown inside the Store.
export function storeMaintenanceError(reason: MaintenanceReason): Error {
  return new Error(`${MAINTENANCE_PREFIX}${reason}`);
}

// Thrown on the Worker side: the Store cannot serve this call right now. The gate maps it to maintenance
// behavior (inbox: spool, everything else: 503).
export class StoreUnavailableError extends Error {
  constructor(readonly reason: MaintenanceReason) {
    super(`store unavailable: ${reason}`);
    this.name = "StoreUnavailableError";
  }
}

// Returns the typed error for a Store call failure, or undefined if the failure is not a maintenance condition.
export function toStoreUnavailable(error: unknown): StoreUnavailableError | undefined {
  if (error instanceof StoreUnavailableError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return undefined;
  }
  const at = error.message.indexOf(MAINTENANCE_PREFIX);
  if (at !== -1) {
    return new StoreUnavailableError(error.message.slice(at + MAINTENANCE_PREFIX.length).trim() as MaintenanceReason);
  }
  // Overloaded, reset, and other retryable DO errors are treated like maintenance for this request.
  const flags = error as { retryable?: boolean; overloaded?: boolean };
  if (flags.retryable === true || flags.overloaded === true) {
    return new StoreUnavailableError("transient");
  }
  return undefined;
}
