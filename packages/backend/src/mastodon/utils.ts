import { PreparedStatement } from '@wildebeest/backend/database'

export function assertBatchSuccess(results: D1Result[]): void {
	for (const out of results) {
		if (!out.success) {
			throw new Error('SQL error: ' + out.error)
		}
	}
}

export async function getResultsField(statement: PreparedStatement, fieldName: string): Promise<Array<string>> {
	const out: D1Result<Record<string, string>> = await statement.all()

	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}

	return (out.results ?? []).map((x) => x[fieldName])
}
