// The shapes of compacted ActivityStreams JSON as remote objects are read (remote-status.ts, remote-emoji.ts): an
// object, a value or an array of values, and a type that may be a list.

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

// JsonLdHelper#equals_or_includes_any?
export function typeIs(value: unknown, types: readonly string[]): boolean {
  return asArray(value).some((type) => typeof type === "string" && types.includes(type));
}
