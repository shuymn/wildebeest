// Creates the GitHub release of a kopje tag, unless it exists (see createRelease() in kopje-release-lib.mjs).
//
//   node scripts/kopje-github-release.mjs --repo <owner/name> --tag <tag> --version <semver> --notes <file>
//     --tarball <file> [--prerelease]
import { parseArgs } from 'node:util'

import { createRelease } from './kopje-release-lib.mjs'

const { values } = parseArgs({
	options: {
		repo: { type: 'string' },
		tag: { type: 'string' },
		version: { type: 'string' },
		notes: { type: 'string' },
		tarball: { type: 'string' },
		prerelease: { type: 'boolean', default: false },
	},
})
for (const name of ['repo', 'tag', 'version', 'notes', 'tarball']) {
	if (values[name] === undefined) {
		console.error(`missing --${name}`)
		process.exit(2)
	}
}
createRelease({
	repo: values.repo,
	tag: values.tag,
	version: values.version,
	prerelease: values.prerelease,
	notesFile: values.notes,
	tarball: values.tarball,
})
