import { actorFromRow, ActorRow, PERSON, Person } from 'wildebeest/backend/src/activitypub/actors'
import { type Database } from 'wildebeest/backend/src/database'

export async function getAdmins(db: Database): Promise<Person[]> {
	try {
		const stmt = db.prepare('SELECT * FROM actors WHERE is_admin=1 AND type=?').bind(PERSON)
		const { success, results } = await stmt.all<{
			id: string
			type: Person['type']
			pubkey: string | null
			cdate: string
			properties: string
			is_admin: 1
			mastodon_id: string
		}>()
		if (success && results !== undefined) {
			return results.map((row: ActorRow<Person>) => actorFromRow(row))
		}
	} catch {
		/* empty */
	}
	return []
}

export async function getAdminByEmail(db: Database, email: string): Promise<Person | null> {
	const stmt = db.prepare('SELECT * FROM actors WHERE email=? AND is_admin=1 AND type=?').bind(email, PERSON)
	const { results } = await stmt.all<{
		id: string
		type: Person['type']
		pubkey: string | null
		cdate: string
		properties: string
		is_admin: 1
		mastodon_id: string
	}>()
	if (!results || results.length === 0) {
		return null
	}
	const row: ActorRow<Person> = results[0]
	return actorFromRow(row)
}
