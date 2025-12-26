// This file is based on Sonik https://github.com/yusukebe/sonik by Yusuke Wada, licensed under the MIT license.

export const filePathToPath = (filePath: string) => {
	filePath = filePath
		.replace(/\.ts$/g, '')
		.replace(/^\/?index/, '/') // `/index`
		.replace(/\/index/, '') // `/about/index`
		.replace(/\[\.{3}.+\]/, '*')
		.replace(/\[(.+)\]/, ':$1')
	return /^\//.test(filePath) ? filePath : '/' + filePath
}

export const groupByDirectory = <T = unknown>(files: Record<string, T>) => {
	const organizedFiles = {} as Record<string, Record<string, T>>

	for (const [path, content] of Object.entries(files)) {
		const pathParts = path.split('/')
		const fileName = pathParts.pop()
		const directory = pathParts.join('/')

		if (!organizedFiles[directory]) {
			organizedFiles[directory] = {}
		}

		if (fileName) {
			organizedFiles[directory][fileName] = content
		}
	}

	// Sort the files in each directory
	for (const [directory, files] of Object.entries(organizedFiles)) {
		const sortedEntries = Object.entries(files).sort(([keyA], [keyB]) => {
			if (keyA[0] === '[' && keyB[0] !== '[') {
				return 1
			}
			if (keyA[0] !== '[' && keyB[0] === '[') {
				return -1
			}
			return keyA.localeCompare(keyB)
		})

		organizedFiles[directory] = Object.fromEntries(sortedEntries)
	}

	// Sort directories by path length (longest first) so more specific routes are registered first
	// This ensures /api/v1/statuses/:id is registered before /api/v1/statuses
	const sortedEntries = Object.entries(organizedFiles).sort(([dirA], [dirB]) => {
		return dirB.length - dirA.length
	})

	return Object.fromEntries(sortedEntries)
}
