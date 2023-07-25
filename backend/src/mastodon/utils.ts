import { PreparedStatement, Result } from 'wildebeest/backend/src/database'

export async function getResultsField(statement: PreparedStatement, fieldName: string): Promise<Array<string>> {
	const out: Result<Record<string, string>> = await statement.all()

	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}

	return (out.results ?? []).map((x) => x[fieldName])
}
