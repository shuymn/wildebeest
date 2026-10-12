// The message of a thrown value, for logs and reports.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// What a log may say about a thrown value (DATA-5): its class, and its name or code when they are short identifiers
// (DOMException's AbortError, jose's ERR_JWT_EXPIRED). Never the message, which can carry a token, an Access
// assertion, a request body or post content.
export function errorFields(error: unknown): { error: string; name?: string; code?: string } {
	if (typeof error !== 'object' || error === null) {
		return { error: typeof error }
	}
	const cls = identifier(error.constructor?.name) ?? 'Object'
	const name = identifier((error as { name?: unknown }).name)
	const code = identifier((error as { code?: unknown }).code)
	return {
		error: cls,
		...(name !== undefined && name !== cls ? { name } : {}),
		...(code !== undefined ? { code } : {}),
	}
}

function identifier(value: unknown): string | undefined {
	const text = typeof value === 'number' ? String(value) : value
	return typeof text === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : undefined
}
