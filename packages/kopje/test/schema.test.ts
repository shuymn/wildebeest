import { runInDurableObject } from 'cloudflare:test'

import { describe, expect, it } from 'vitest'

import { freshStore } from './helpers'
import { MIGRATIONS } from '../src/db/migrations'
import { StoreKernel } from '../src/platform/store-kernel'
import { BUILD_VERSION } from '../src/version'

const LOCAL = '100000000000000001'
const REMOTE = '100000000000000002'
const STATUS = '100000000000000010'
const REPLY = '100000000000000011'
const BOOST = '100000000000000012'
const MEDIA = '100000000000000020'

function count(sql: SqlStorage, table: string): number {
	return sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n
}

async function migrated(): Promise<ReturnType<typeof freshStore>> {
	const store = freshStore()
	await runInDurableObject(store, (_instance, state) =>
		new StoreKernel(state, { build: BUILD_VERSION, migrations: MIGRATIONS, log: () => {} }).upgrade()
	)
	return store
}

describe('schema 0000', () => {
	it('passes foreign_key_check on a fresh database', async () => {
		await runInDurableObject(await migrated(), (_instance, state) => {
			expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})

	it('rejects ids that are not 18 digits', async () => {
		await runInDurableObject(await migrated(), (_instance, state) => {
			const insert = (id: string) =>
				state.storage.sql.exec(
					"INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'a', 'x.test')",
					id,
					`u:${id}`
				)
			expect(() => insert('12345678901234567')).toThrow(/CHECK constraint failed/)
			expect(() => insert('12345678901234567a')).toThrow(/CHECK constraint failed/)
			expect(() => insert('123456789012345678')).not.toThrow()
		})
	})

	it.each(['accounts', 'statuses', 'media_attachments', 'lists'])(
		'rejects non-text snowflake ids in %s',
		async (table) => {
			await runInDurableObject(await migrated(), (_instance, state) => {
				const sql = state.storage.sql
				sql.exec(`
				INSERT INTO accounts (id, uri, username) VALUES ('${LOCAL}', 'https://local.test/ap/users/me', 'me');
				INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					VALUES ('${LOCAL}', 'me@local.test', x'00', x'00', 'pem');
			`)
				const values: Record<string, string> = {
					accounts: "(id, uri, username, domain) VALUES (?, 'https://x.test/b', 'b', 'x.test')",
					statuses: `(id, uri, account_id, visibility, published_at) VALUES (?, 'https://x.test/s', '${LOCAL}', 'public', 'now')`,
					media_attachments: `(id, account_id, type, url) VALUES (?, '${LOCAL}', 'image', 'https://x.test/m')`,
					lists: `(id, account_id, title) VALUES (?, '${LOCAL}', 'l')`,
				}
				// 18 ASCII digits stored as a BLOB pass a length and GLOB check.
				const blob = new TextEncoder().encode('123456789012345678')
				expect(() => sql.exec(`INSERT INTO ${table} ${values[table]}`, blob)).toThrow(/CHECK constraint failed/)
				expect(() => sql.exec(`INSERT INTO ${table} ${values[table]}`, '123456789012345678')).not.toThrow()
			})
		}
	)

	it('keeps local_accounts rows on local accounts only', async () => {
		await runInDurableObject(await migrated(), (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(`
				INSERT INTO accounts (id, uri, username) VALUES ('${LOCAL}', 'https://local.test/ap/users/me', 'me');
				INSERT INTO accounts (id, uri, username, domain) VALUES ('${REMOTE}', 'https://remote.test/users/them', 'them', 'remote.test');
			`)
			const addLocal = (id: string, email: string) =>
				sql.exec(
					"INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, x'00', x'00', 'pem')",
					id,
					email
				)
			expect(() => addLocal(REMOTE, 'them@local.test')).toThrow(/local_accounts requires a local account/)
			addLocal(LOCAL, 'me@local.test')
			expect(() => sql.exec('UPDATE local_accounts SET account_id = ? WHERE account_id = ?', REMOTE, LOCAL)).toThrow(
				/local_accounts requires a local account/
			)
			expect(() => sql.exec("UPDATE accounts SET domain = 'evil.test' WHERE id = ?", LOCAL)).toThrow(
				/a local account cannot get a domain/
			)
			expect(sql.exec('SELECT domain FROM accounts WHERE id = ?', LOCAL).one()).toEqual({ domain: null })
		})
	})

	it('refuses raw on statuses of local accounts', async () => {
		await runInDurableObject(await migrated(), (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(`
				INSERT INTO accounts (id, uri, username) VALUES ('${LOCAL}', 'https://local.test/ap/users/me', 'me');
				INSERT INTO accounts (id, uri, username, domain) VALUES ('${REMOTE}', 'https://remote.test/users/them', 'them', 'remote.test');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES ('${STATUS}', 'https://local.test/ap/o/1', '${LOCAL}', 'public', 'now');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at, raw) VALUES ('${REPLY}', 'https://remote.test/notes/1', '${REMOTE}', 'public', 'now', '{}');
			`)
			const refused = /local statuses cannot hold raw/
			expect(() =>
				sql.exec(
					`INSERT INTO statuses (id, uri, account_id, visibility, published_at, raw) VALUES ('${BOOST}', 'https://local.test/ap/o/2', '${LOCAL}', 'public', 'now', '{}')`
				)
			).toThrow(refused)
			expect(() => sql.exec("UPDATE statuses SET raw = '{}' WHERE id = ?", STATUS)).toThrow(refused)
			expect(() => sql.exec('UPDATE statuses SET account_id = ? WHERE id = ?', LOCAL, REPLY)).toThrow(refused)
			// A remote account cannot turn local while its statuses still hold raw.
			expect(() => sql.exec('UPDATE accounts SET domain = NULL WHERE id = ?', REMOTE)).toThrow(refused)
		})
	})

	it('cascades a remote status delete to its children and keeps unresolved reply URIs', async () => {
		await runInDurableObject(await migrated(), (_instance, state) => {
			const sql = state.storage.sql
			sql.exec(`
				INSERT INTO accounts (id, uri, username) VALUES ('${LOCAL}', 'https://local.test/ap/users/me', 'me');
				INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
					VALUES ('${LOCAL}', 'me@local.test', x'00', x'00', 'pem');
				INSERT INTO accounts (id, uri, username, domain) VALUES ('${REMOTE}', 'https://remote.test/users/them', 'them', 'remote.test');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at, raw)
					VALUES ('${STATUS}', 'https://remote.test/notes/1', '${REMOTE}', 'limited', '2026-10-12T00:00:00.000Z', '{}');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at, in_reply_to_uri, in_reply_to_id)
					VALUES ('${REPLY}', 'https://local.test/ap/o/r', '${LOCAL}', 'public', '2026-10-12T00:00:01.000Z', 'https://remote.test/notes/1', '${STATUS}');
				INSERT INTO statuses (id, uri, account_id, visibility, published_at, reblog_of_id)
					VALUES ('${BOOST}', 'https://local.test/ap/o/b', '${LOCAL}', 'public', '2026-10-12T00:00:02.000Z', '${STATUS}');
				INSERT INTO status_edits (status_id, created_at) VALUES ('${STATUS}', '2026-10-12T00:00:00.000Z');
				INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES ('${MEDIA}', '${REMOTE}', '${STATUS}', 'image', 'https://remote.test/m.png');
				INSERT INTO status_mentions (status_id, account_id, silent) VALUES ('${STATUS}', '${LOCAL}', 1);
				INSERT INTO status_tags (status_id, name) VALUES ('${STATUS}', 'kopje');
				INSERT INTO favourites (account_id, status_id) VALUES ('${LOCAL}', '${STATUS}');
				INSERT INTO bookmarks (account_id, status_id) VALUES ('${LOCAL}', '${STATUS}');
				INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES ('${LOCAL}', 'mention', '${REMOTE}', '${STATUS}');
			`)

			sql.exec('DELETE FROM statuses WHERE id = ?', STATUS)

			for (const table of [
				'status_edits',
				'media_attachments',
				'status_mentions',
				'status_tags',
				'favourites',
				'bookmarks',
				'notifications',
			]) {
				expect(count(sql, table), table).toBe(0)
			}
			expect(sql.exec('SELECT id, in_reply_to_id, in_reply_to_uri FROM statuses').toArray()).toEqual([
				{ id: REPLY, in_reply_to_id: null, in_reply_to_uri: 'https://remote.test/notes/1' },
			])
			expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([])
		})
	})
})
