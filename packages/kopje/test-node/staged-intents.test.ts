import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// RES-6: an outbound intent still staging (outbound_activities.staged set) is never deleted, so a retraction's staging
// row (retraction_stagings) needs no foreign key to it: its end is marked when staged is cleared
// (outbound_activities_staging_ended, migration 0085_retraction_staging). Every delete of an intent in src/ requires
// staged IS NULL in its own statement.
const root = fileURLToPath(new URL('../src/', import.meta.url))

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sources(`${dir}${entry.name}/`) : /\.tsx?$/.test(entry.name) ? [`${dir}${entry.name}`] : []
	)
}

// The text of each template or string literal holding a DELETE of outbound_activities, up to its closing quote.
function intentDeletes(text: string): string[] {
	return [...text.matchAll(/DELETE FROM outbound_activities\b[^`'"]*/g)].map((m) => m[0])
}

describe('the deletes of an outbound intent', () => {
	it('each require staged IS NULL', () => {
		const deletes = sources(root).flatMap((path) => intentDeletes(readFileSync(path, 'utf8')))
		expect(deletes.length).toBeGreaterThan(0)
		expect(deletes.filter((statement) => !/\bstaged IS NULL\b/.test(statement))).toEqual([])
	})

	it('finds a delete that does not', () => {
		expect(intentDeletes('db.run(`DELETE FROM outbound_activities WHERE id = ?`)')).toEqual([
			'DELETE FROM outbound_activities WHERE id = ?',
		])
	})
})
