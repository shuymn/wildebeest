// The message of a thrown value, for logs and reports.
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
