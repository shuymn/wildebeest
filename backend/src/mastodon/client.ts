import { type Database } from 'wildebeest/backend/src/database'
import { arrayBufferToBase64 } from 'wildebeest/backend/src/utils/key-ops'

export interface Client {
	id: string
	secret: string
	name: string
	redirect_uris: string
	scopes: string
	website?: string
}

export async function createClient(
	db: Database,
	name: string,
	redirect_uris: string,
	scopes: string,
	website?: string
): Promise<Client> {
	const id = crypto.randomUUID()

	const secretBytes = new Uint8Array(64)
	crypto.getRandomValues(secretBytes)
	const secret = arrayBufferToBase64(secretBytes.buffer)

	const query = `
          INSERT INTO clients (id, secret, name, redirect_uris, website, scopes)
          VALUES (?, ?, ?, ?, ?, ?)
    `
	const { success, error } = await db
		.prepare(query)
		.bind(id, secret, name, redirect_uris, website === undefined ? null : website, scopes)
		.run()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}

	return {
		id: id,
		secret: secret,
		name: name,
		redirect_uris: redirect_uris,
		website: website,
		scopes: scopes,
	}
}

export async function getClientById(db: Database, id: string): Promise<Client | null> {
	const stmt = db.prepare('SELECT * FROM clients WHERE id=?').bind(id)
	const { results } = await stmt.all()
	if (!results || results.length === 0) {
		return null
	}
	const row: any = results[0]
	return {
		id: id,
		secret: row.secret,
		name: row.name,
		redirect_uris: row.redirect_uris,
		website: row.website,
		scopes: row.scopes,
	}
}

export async function createClientCredential(
	db: Database,
	clientId: string,
	scopes: string
): Promise<[secret: string, epoch: number]> {
	const id = crypto.randomUUID()
	const secretBytes = new Uint8Array(64)
	crypto.getRandomValues(secretBytes)
	const secret = arrayBufferToBase64(secretBytes.buffer)

	const { success, error, results } = await db
		.prepare(
			`
INSERT INTO client_credentials (id, client_id, access_token, scopes)
VALUES (?, ?, ?, ?)
RETURNING cdate
  `
		)
		.bind(id, clientId, secret, scopes)
		.all<{ cdate: string }>()
	if (!success || !results) {
		throw new Error('SQL error: ' + error)
	}

	return [secret, new Date(results[0].cdate).getTime()]
}

export async function getClientByClientCredential(db: Database, secret: string): Promise<Client | null> {
	const { results } = await db
		.prepare(
			`
SELECT clients.* FROM clients
INNER JOIN client_credentials ON clients.id = client_credentials.client_id
WHERE client_credentials.access_token=?1`
		)
		.bind(secret)
		.all<{ id: string; secret: string; name: string; redirect_uris: string; website: string | null; scopes: string }>()
	if (!results || results.length === 0) {
		return null
	}
	const [row] = results
	return {
		id: row.id,
		secret: row.secret,
		name: row.name,
		redirect_uris: row.redirect_uris,
		website: row.website ?? undefined,
		scopes: row.scopes,
	}
}
