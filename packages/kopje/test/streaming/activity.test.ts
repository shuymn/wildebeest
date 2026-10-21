import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../../src/security/tokens'
import { sql } from '../api-helpers'
import { NOW } from '../app-helpers'
import { BUILD } from '../helpers'
import { appToken } from '../read-helpers'
import { community } from '../status-helpers'
import { drained, subscribed } from './stream-helpers'

// Activity recording (domain/auth.ts noteActivity) starts no stream turn (stream-hub.ts written), whether it writes the
// day or not. Called on the Store directly, so the Worker's memo cannot make the no-op case vacuous.
describe('activity and the streams', () => {
	it('asks for no turn with a socket open, written or not, while another commit does', async () => {
		const h = await community(['alice'])
		const app = await appToken(h)
		const inbox = await subscribed(h, h.users.alice.token, 'user')
		const note = async (token: string) => h.store.noteActivity(BUILD, { tokenHash: await sha256Hex(token), now: NOW })
		const before = (await drained(h, inbox)).turns
		await note(h.users.alice.token)
		expect(await sql(h.store, 'SELECT active_on FROM local_accounts')).toEqual([
			{ active_on: new Date(NOW).toISOString().slice(0, 10) },
		])
		// The same day again, and an app token: neither writes.
		await note(h.users.alice.token)
		await note(app)
		expect((await drained(h, inbox)).turns).toBe(before)
		// Another session operation's commit asks for one.
		await h.store.registerApp(BUILD, {
			clientId: 'control',
			secret: 's',
			name: 'Control',
			redirectUris: ['https://client.test/cb'],
			website: null,
			scopes: ['read'],
			now: NOW,
		})
		expect((await drained(h, inbox)).turns).toBeGreaterThan(before)
	})
})
