import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, stat, truncate } from 'node:fs/promises'

import { writeAll } from './write-all.js'

/** @type {import('./format.js').FileIO} */
export const nodeIO = {
	async size(path) {
		try {
			return (await stat(path)).size
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
				return null
			}
			throw error
		}
	},
	async read(path, position, length) {
		const handle = await open(path, 'r')
		try {
			const buffer = new Uint8Array(length)
			let done = 0
			while (done < length) {
				const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
				if (bytesRead === 0) {
					break
				}
				done += bytesRead
			}
			return buffer.subarray(0, done)
		} finally {
			await handle.close()
		}
	},
	// Appends and flushes to disk before returning, so a recorded offset never points past durable bytes.
	async append(path, bytes) {
		const handle = await open(path, 'a', 0o600)
		try {
			await writeAll(handle, bytes)
			await handle.sync()
		} finally {
			await handle.close()
		}
	},
	async truncate(path, length) {
		await truncate(path, length)
	},
	async readText(path) {
		try {
			return await readFile(path, 'utf8')
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
				return null
			}
			throw error
		}
	},
	// These files can hold the session credential of a token import. The temporary file has an unpredictable name and
	// is created exclusively ('wx') with mode 0600, so no file planted beforehand (whose mode would be kept) is
	// reused. It is written and synced through its own handle, renamed over the target, and removed on any failure.
	async writeTextAtomic(path, text) {
		const temporary = `${path}.${randomUUID()}.tmp`
		const handle = await open(temporary, 'wx', 0o600)
		try {
			try {
				await writeAll(handle, new TextEncoder().encode(text))
				await handle.sync()
			} finally {
				await handle.close()
			}
			await rename(temporary, path)
		} catch (error) {
			await rm(temporary, { force: true })
			throw error
		}
	},
	async remove(path) {
		await rm(path, { force: true })
	},
}
