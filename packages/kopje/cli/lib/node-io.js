import { open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'

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
			await handle.write(bytes)
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
	async writeTextAtomic(path, text) {
		const temporary = `${path}.tmp`
		await writeFile(temporary, text, { mode: 0o600 })
		const handle = await open(temporary, 'r+')
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(temporary, path)
	},
	async remove(path) {
		await rm(path, { force: true })
	},
}
