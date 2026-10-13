// Global setup of the Workers suites (vitest.config.ts): converts a synthetic legacy export with the real CLI code,
// on Node (node:sqlite does not run in workerd), and hands the dump and the independently computed expectations to
// test/cutover-import.test.ts, which imports the dump into a real Store.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestProject } from 'vitest/node'

import { buildLegacyFixture } from './legacy-fixture.js'
import { loadLegacyExport } from '../cli/lib/cutover/legacy-load.js'
import { convertExport } from '../cli/lib/cutover/run.js'
import { expectedFromLegacy } from '../cli/lib/cutover/verify-expect.js'

export default async function setup(project: TestProject): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'kopje-cutover-setup-'))
	try {
		const fixture = await buildLegacyFixture({ level: 39, notificationSequence: 12n })
		const exportPath = join(dir, 'export')
		await mkdir(exportPath)
		for (const [table, text] of fixture.texts) {
			await writeFile(join(exportPath, `${table}.sql`), text)
		}
		const { ok, manifest } = await convertExport({
			exportPath,
			outDir: join(dir, 'out'),
			acceptDeletions: false,
			baseTime: Date.parse('2026-10-20T00:00:00.000Z'),
			env: {},
			version: 'test',
		})
		if (!ok) {
			throw new Error(`fixture conversion stopped: ${JSON.stringify(manifest.stop)}`)
		}
		const loaded = loadLegacyExport({ texts: fixture.texts.values() })
		const { records: expected } = expectedFromLegacy(loaded.db, {
			originalActorIds: loaded.originalActorIds,
			source: loaded.source,
			notificationSequence: loaded.report.notificationSequence,
		})
		loaded.db.close()
		project.provide('cutover', {
			dump: await readFile(join(dir, 'out', 'kopje.dump'), 'utf8'),
			expected,
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

declare module 'vitest' {
	export interface ProvidedContext {
		cutover: { dump: string; expected: Record<string, Record<string, string>> }
	}
}
