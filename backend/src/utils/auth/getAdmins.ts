import { actorFromRow, Person } from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'

export async function getAdmins(db: Database): Promise<Person[]> {
	let rows: unknown[] = []
	try {
		const stmt = db.prepare('SELECT * FROM actors WHERE is_admin=1')
		const result = await stmt.all<unknown>()
		rows = result.success ? (result.results as unknown[]) : []
	} catch {
		/* empty */
	}

	return rows.map(actorFromRow) as Person[]
}

export async function getAdminByEmail(db: Database, email: string): Promise<Person | null> {
	const stmt = db.prepare('SELECT * FROM actors WHERE email=? AND is_admin=1 AND type=?').bind(email, 'Person') // TODO: use constant
	const { results } = await stmt.all()
	if (!results || results.length === 0) {
		return null
	}
	const row: any = results[0]
	return actorFromRow(row) as Person
}
