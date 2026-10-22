// Publishes the web stylesheet under a fingerprinted name (design amendment A1): src/web/kopje.css is written to
// public/assets/kopje.<hash>.css, where <hash> is the first 10 hex characters of the SHA-256 of its bytes, and
// src/web/asset-versions.ts names that path for the pages. public/_headers serves /assets/kopje.*.css as immutable.
//
// The previous release's file stays for one release, so a page cached before a deploy, or a rollback, still finds its
// stylesheet; older files are deleted. A release is a version heading of CHANGELOG.md: a stylesheet written since the
// latest release is unreleased, so changing it again replaces its file and keeps the previous release's.
//
//   node scripts/build-assets.mjs          writes the files (pnpm build runs it first)
//   node scripts/build-assets.mjs --check  writes nothing and fails when the files differ from what it would write
//                                          (prepack, and test-node/stylesheet.test.ts in CI)
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SOURCE = 'src/web/kopje.css'
export const ASSETS = 'public/assets'
export const VERSIONS = 'src/web/asset-versions.ts'

// Every file name the build owns: the unversioned name of releases before A1, and the fingerprinted ones.
const OWNED = /^kopje(?:\.[0-9a-f]{10})?\.css$/

export function fingerprint(bytes) {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 10)
}

// The latest released version: the first version heading of the changelog that is not [Unreleased].
export function latestRelease(changelog) {
	const match = /^## \[(\d[^\]]*)\]/m.exec(changelog)
	if (match === null) {
		throw new Error('CHANGELOG.md has no released version')
	}
	return match[1]
}

const FIELD = (name) => new RegExp(`^export const ${name} = '([^']*)'$`, 'm')

export function readVersions(text) {
	const read = (name) => {
		const match = FIELD(name).exec(text)
		if (match === null) {
			throw new Error(`${VERSIONS} has no ${name}`)
		}
		return match[1]
	}
	return { stylesheet: read('STYLESHEET'), previous: read('PREVIOUS_STYLESHEET'), since: read('ASSETS_SINCE') }
}

export function renderVersions({ stylesheet, previous, since }) {
	return [
		'// Written by scripts/build-assets.mjs from src/web/kopje.css; never edited by hand (design amendment A1).',
		'',
		'// The stylesheet the pages link: its fingerprinted path, immutable (public/_headers).',
		`export const STYLESHEET = '${stylesheet}'`,
		'',
		"// The previous release's stylesheet, kept in public/assets for one release.",
		`export const PREVIOUS_STYLESHEET = '${previous}'`,
		'',
		'// The latest release when STYLESHEET was written.',
		`export const ASSETS_SINCE = '${since}'`,
		'',
	].join('\n')
}

const basename = (path) => path.slice(path.lastIndexOf('/') + 1)

// What the build would leave on disk: the versions module's text and the stylesheet files by name.
export function plan(root = ROOT) {
	const bytes = readFileSync(join(root, SOURCE))
	const stylesheet = `/assets/kopje.${fingerprint(bytes)}.css`
	const current = readVersions(readFileSync(join(root, VERSIONS), 'utf8'))
	const release = latestRelease(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))
	let next = current
	if (current.stylesheet !== stylesheet) {
		// The current file was released when a release has been made since it was written; otherwise it is replaced.
		const previous = current.since === release ? current.previous : current.stylesheet
		next = { stylesheet, previous, since: release }
	}
	const files = new Map([[basename(next.stylesheet), bytes]])
	if (next.previous !== next.stylesheet) {
		const kept = join(root, ASSETS, basename(next.previous))
		if (!existsSync(kept)) {
			throw new Error(`the previous release's stylesheet ${next.previous} is missing`)
		}
		files.set(basename(next.previous), readFileSync(kept))
	}
	return { versions: renderVersions(next), files }
}

// The differences between the disk and the plan, as messages; empty when the build would change nothing.
export function drift(root = ROOT) {
	const { versions, files } = plan(root)
	const problems = []
	if (readFileSync(join(root, VERSIONS), 'utf8') !== versions) {
		problems.push(`${VERSIONS} is not what the build writes`)
	}
	const owned = readdirSync(join(root, ASSETS)).filter((name) => OWNED.test(name))
	for (const name of owned) {
		if (!files.has(name)) {
			problems.push(`${ASSETS}/${name} is neither the stylesheet nor the previous release's`)
		}
	}
	for (const [name, bytes] of files) {
		const path = join(root, ASSETS, name)
		if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
			problems.push(`${ASSETS}/${name} does not hold the bytes it is named for`)
		}
	}
	return problems
}

function build(root = ROOT) {
	const { versions, files } = plan(root)
	for (const name of readdirSync(join(root, ASSETS))) {
		if (OWNED.test(name) && !files.has(name)) {
			rmSync(join(root, ASSETS, name))
		}
	}
	for (const [name, bytes] of files) {
		const path = join(root, ASSETS, name)
		if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
			writeFileSync(path, bytes)
		}
	}
	writeFileSync(join(root, VERSIONS), versions)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes('--check')) {
		const problems = drift()
		if (problems.length > 0) {
			console.error(`build-assets: ${problems.join('; ')}. Run node scripts/build-assets.mjs.`)
			process.exit(1)
		}
	} else {
		build()
		console.log(`build-assets: ${readVersions(readFileSync(join(ROOT, VERSIONS), 'utf8')).stylesheet}`)
	}
}
