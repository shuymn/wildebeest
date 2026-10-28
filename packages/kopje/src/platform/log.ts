// Shared pieces of Kopje's log events (docs/observability.md; DATA-5 in docs/threat-model.md). The rules a log call
// follows are checked by test-node/log-events.test.ts.

// A level above info: `error` when something that should have worked did not, `warn` when a bound or a degraded mode
// was hit as designed. Lifecycle events and expected outcomes pass none.
export type LogLevel = "warn" | "error";

// An injected log sink (the Store's kernel and admin, the backup job), so tests can read the entries.
export type LogSink = (entry: Record<string, unknown>, level?: LogLevel) => void;

export const consoleSink: LogSink = (entry, level) => console[level ?? "log"](entry);

// Methods logged as they are; any other is logged as OTHER (DATA-5).
const LOGGED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);

export function loggedMethod(method: string): string {
  return LOGGED_METHODS.has(method) ? method : "OTHER";
}
