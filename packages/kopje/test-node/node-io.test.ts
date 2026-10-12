import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { nodeIO } from '../cli/lib/node-io.js'

// The CLI's file layer on a real filesystem: the session credential of a token import lives in these files.
let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'kopje-node-io-'))
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

const mode = async (path: string) => (await stat(path)).mode & 0o777

describe('nodeIO.writeTextAtomic', () => {
	it('writes a private file even when a world-readable temp file and target already exist', async () => {
		const path = join(dir, 'dump.sql.import.json')
		await writeFile(`${path}.tmp`, 'planted', { mode: 0o644 })
		await chmod(`${path}.tmp`, 0o644)
		await writeFile(path, 'old', { mode: 0o644 })
		await chmod(path, 0o644)

		await nodeIO.writeTextAtomic(path, '{"session":"secret"}')

		expect(await readFile(path, 'utf8')).toBe('{"session":"secret"}')
		expect(await mode(path)).toBe(0o600)
		// The planted file was not used and is left as it was.
		expect(await readFile(`${path}.tmp`, 'utf8')).toBe('planted')
		expect((await readdir(dir)).sort()).toEqual(['dump.sql.import.json', 'dump.sql.import.json.tmp'])
	})

	it('writes next to a file whose name is close to the 255-byte limit', async () => {
		// A valid 216-byte state file name (a 204-byte dump name + ".import.json") must not turn into an invalid temp name.
		const path = join(dir, `${'d'.repeat(204)}.import.json`)
		await nodeIO.writeTextAtomic(path, '{}')
		expect(await readFile(path, 'utf8')).toBe('{}')
		expect(await readdir(dir)).toEqual([`${'d'.repeat(204)}.import.json`])
	})

	it('removes its temporary file when the write fails', async () => {
		const path = join(dir, 'target')
		await mkdir(path)
		await expect(nodeIO.writeTextAtomic(path, 'x')).rejects.toThrow()
		expect(await readdir(dir)).toEqual(['target'])
	})
})

describe('nodeIO.append', () => {
	it('creates a new file private', async () => {
		const path = join(dir, 'dump.sql')
		await nodeIO.append(path, new TextEncoder().encode('abc'))
		expect(await mode(path)).toBe(0o600)
	})
})
