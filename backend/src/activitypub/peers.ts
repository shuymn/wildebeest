import { type Database } from 'wildebeest/backend/src/database'
import { getResultsField } from 'wildebeest/backend/src/mastodon/utils'

export async function getPeers(db: Database): Promise<Array<string>> {
	const query = `SELECT domain FROM peers `
	const statement = db.prepare(query)

	return getResultsField(statement, 'domain')
}

export async function addPeer(db: Database, domain: string): Promise<void> {
	const query = db.qb.insertOrIgnore(`
		INTO peers (domain) VALUES (?)
	`)

	const out = await db.prepare(query).bind(domain).run()
	if (!out.success) {
		throw new Error('SQL error: ' + out.error)
	}
}
