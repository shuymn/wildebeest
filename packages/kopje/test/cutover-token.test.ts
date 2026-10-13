import { describe, expect, inject, it } from 'vitest'

import { BUILD, migratedStore } from './helpers'
import { ADMIN_AUD, ADMIN_EMAIL, importChunks, splitDump, TEAM_DOMAIN } from './ops-helpers'

// The cutover's IMPORT_TOKEN (docs/cutover-runbook.md, step 6), on the converted legacy dump of the global setup:
// it begins one import into the empty Store and nothing after it (AUTH-5). The runbook also deletes the secret.

declare module 'vitest' {
	export interface ProvidedContext {
		cutover: { dump: string; expected: Record<string, Record<string, string>> }
	}
}

const TOKEN = { kind: 'import-token' } as const

describe('IMPORT_TOKEN in the cutover (AUTH-5)', () => {
	it('begins exactly one import into the empty Store, and opens nothing once Access is configured', async () => {
		const { dump } = inject('cutover')
		const { header, trailer } = splitDump(dump)
		const store = await migratedStore()
		expect(await store.setConfig(BUILD, TOKEN, { domain: 'kopje.test' })).toMatchObject({ ok: true })

		const begun = await store.importBegin(BUILD, TOKEN, header)
		if (!begun.ok || begun.session === undefined) throw new Error('no session')
		// While it runs, the token begins nothing else (bootstrap needs an empty Store with no import) and cannot change
		// the configuration.
		expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: 'not-bootstrap' })
		expect(await store.setConfig(BUILD, TOKEN, { domain: 'other.example' })).toMatchObject({
			ok: false,
			code: 'import-in-progress',
		})

		const session = { kind: 'import-session', secret: begun.session } as const
		for (const [i, chunk] of (await importChunks(dump, 1 << 20)).entries()) {
			expect(await store.importChunk(BUILD, session, begun.progress.id, i + 1, chunk)).toMatchObject({ ok: true })
		}
		expect(await store.importFinish(BUILD, session, begun.progress.id, trailer)).toMatchObject({ ok: true })
		expect(await store.importVerify(BUILD, session, begun.progress.id)).toMatchObject({ report: { ok: true } })

		// The Store holds the instance now, which ends bootstrap for an import: the token begins no second one.
		expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: 'not-bootstrap' })

		// Setting the Access values ends bootstrap; from then on the token configures and begins nothing.
		const access = { access_team_domain: TEAM_DOMAIN, access_admin_aud: ADMIN_AUD, admin_email: ADMIN_EMAIL }
		expect(await store.setConfig(BUILD, TOKEN, access)).toMatchObject({ ok: true })
		expect(await store.setConfig(BUILD, TOKEN, { domain: 'other.example' })).toMatchObject({
			ok: false,
			code: 'not-bootstrap',
		})
		expect(await store.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: 'not-bootstrap' })
		expect((await store.config(BUILD)).values.domain).toBe('kopje.test')
	})
})
