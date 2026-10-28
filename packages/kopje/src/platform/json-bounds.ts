// Structural bounds of a parsed JSON document from a remote server (RES-2). The body bound (1 MiB) caps the bytes, not
// the work: a megabyte of nested arrays or tiny objects costs JSON-LD expansion far more than a real actor or note does.
// Every inbound activity and every fetched document is checked before it is read or handed to JSON-LD, so one
// activity's processing is bounded by REQUEST_MAX_FETCHES documents of at most these sizes.

// Values (objects, arrays and scalars) in one document. A Mastodon actor or note has a few hundred.
export const MAX_JSON_NODES = 10_000;
// Nesting depth. Real documents nest a handful of levels.
export const MAX_JSON_DEPTH = 32;

// Whether the document stays within the bounds. The walk stops at the first value past either bound, so its cost is
// bounded too.
export function withinJsonBounds(document: unknown): boolean {
  // Counted when a value is reached, so the stack never holds more than MAX_JSON_NODES entries.
  let nodes = 1;
  const stack: [unknown, number][] = [[document, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (depth > MAX_JSON_DEPTH) {
      return false;
    }
    if (typeof value !== "object" || value === null) {
      continue;
    }
    for (const key in value) {
      if (++nodes > MAX_JSON_NODES) {
        return false;
      }
      stack.push([(value as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return true;
}
