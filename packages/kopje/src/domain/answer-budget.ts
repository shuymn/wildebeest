import { utf8Length } from '../platform/dump-format'

// RES-3: the UTF-8 bytes of one Mastodon API answer that presents statuses or accounts, as the Worker serializes it,
// its containers and separators included. The Store operation that returns the answer owns it, and the parts of a
// composite answer (search, a context, a profile page) share it. Every atomic item (a status with its boosted original
// and quoted status, an account) is at most 66% of it (docs/threat-model.md, "Maxima of presented units"), so an
// answer always admits its first item. docs/response-inventory.md lists every owner.
export const ANSWER_BYTES = 8 * 1024 * 1024

// The UTF-8 bytes of a value as JSON.
export function jsonBytes(value: unknown): number {
	return utf8Length(JSON.stringify(value))
}
