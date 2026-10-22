// Publishes the web stylesheet under a fingerprinted name (design amendment A1): src/web/kopje.css is written to
// public/assets/kopje.<hash>.css, where <hash> is the first 10 hex characters of the SHA-256 of its bytes, and
// src/web/asset-versions.ts names that path for the pages. public/_headers serves /assets/kopje.*.css as immutable.
//
// public/assets keeps exactly two stylesheets: the current one and the one the latest completed release linked, so a
// page cached before a deploy, or a rollback, still finds its stylesheet. That release is the nearest kopje-v* tag
// reachable from HEAD, leaving out the release being built (releasedStylesheet); its stylesheet is STYLESHEET in its
// tree's asset-versions.ts, or /assets/kopje.css for a release before A1. Every other stylesheet file is deleted.
//
//   node scripts/build-assets.mjs          writes the files (pnpm build runs it first)
//   node scripts/build-assets.mjs --check  writes nothing and fails when the files differ from what it would write
//                                          (prepack, and test-node/stylesheet.test.ts)
//
// Without git history or release tags (a shallow clone), the release cannot be read: the build refuses, and --check
// trusts PREVIOUS_STYLESHEET as recorded, with a warning, unless KOPJE_ASSETS_REQUIRE_TAGS=1 makes it refuse too (the
// CI job that packs the package and the release workflow check out the whole history).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SOURCE = 'src/web/kopje.css'
export const ASSETS = 'public/assets'
export const VERSIONS = 'src/web/asset-versions.ts'
export const LEGACY_STYLESHEET = '/assets/kopje.css'
const TAGS = 'kopje-v*'

// Every file name the build owns: the unversioned name of releases before A1, and the fingerprinted ones.
const OWNED = /^kopje(?:\.[0-9a-f]{10})?\.css$/

export function fingerprint(bytes) {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 10)
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
	return { stylesheet: read('STYLESHEET'), previous: read('PREVIOUS_STYLESHEET') }
}

export function renderVersions({ stylesheet, previous }) {
	return [
		'// Written by scripts/build-assets.mjs from src/web/kopje.css; never edited by hand (design amendment A1).',
		'',
		'// The stylesheet the pages link: its fingerprinted path, immutable (public/_headers).',
		`export const STYLESHEET = '${stylesheet}'`,
		'',
		"// The latest completed release's stylesheet, kept in public/assets for one release.",
		`export const PREVIOUS_STYLESHEET = '${previous}'`,
		'',
	].join('\n')
}

const basename = (path) => path.slice(path.lastIndexOf('/') + 1)

function git(root, args, encoding = 'utf8') {
	return execFileSync('git', ['-C', root, ...args], { encoding, stdio: ['ignore', 'pipe', 'ignore'] })
}

// The stylesheet a release linked: STYLESHEET in its tree's versions module, or the unversioned stylesheet for a release
// before A1, which has none.
function stylesheetAt(root, prefix, tag) {
	let text
	try {
		text = git(root, ['show', `${tag}:${prefix}${VERSIONS}`])
	} catch {
		return LEGACY_STYLESHEET
	}
	return readVersions(text).stylesheet
}

// The latest completed release and its stylesheet, or null when git or the tags cannot tell (no repository, a
// shallow clone, no tag reachable). `current` is the stylesheet being built: a tag on HEAD whose release links it is
// the release being built, and the one before it is the latest completed; a tag on HEAD with other CSS on top is
// complete.
export function releasedStylesheet(root = ROOT, current = currentStylesheet(root)) {
	try {
		const prefix = git(root, ['rev-parse', '--show-prefix']).trim()
		const describe = (exclude) =>
			git(root, [
				'describe',
				'--tags',
				'--abbrev=0',
				'--match',
				TAGS,
				...exclude.flatMap((t) => ['--exclude', t]),
				'HEAD',
			]).trim()
		let tag = describe([])
		const building = git(root, ['tag', '--points-at', 'HEAD', '--list', TAGS]).split('\n').filter(Boolean)
		if (building.includes(tag) && stylesheetAt(root, prefix, tag) === current) {
			tag = describe(building)
		}
		return { tag, prefix, stylesheet: stylesheetAt(root, prefix, tag) }
	} catch {
		return null
	}
}

// The bytes of the released stylesheet: always the release's own, from its tag, so an edited or lost working copy is
// a drift that the build repairs. Only without tags (--check's fallback) are they the working copy's.
function releasedBytes(root, released) {
	const name = basename(released.stylesheet)
	if (released.tag === null) {
		return readFileSync(join(root, ASSETS, name))
	}
	return git(root, ['show', `${released.tag}:${released.prefix}${ASSETS}/${name}`], 'buffer')
}

export function currentStylesheet(root = ROOT) {
	return `/assets/kopje.${fingerprint(readFileSync(join(root, SOURCE)))}.css`
}

// What the build leaves on disk: the versions module's text and the stylesheet files by name. `released` is
// releasedStylesheet()'s answer, or { tag: null, stylesheet } as recorded when the tags are not available.
export function plan(root, released) {
	const bytes = readFileSync(join(root, SOURCE))
	const stylesheet = currentStylesheet(root)
	const files = new Map([[basename(stylesheet), bytes]])
	if (released.stylesheet !== stylesheet) {
		files.set(basename(released.stylesheet), releasedBytes(root, released))
	}
	return { versions: renderVersions({ stylesheet, previous: released.stylesheet }), files }
}

// The differences between the disk and the plan, as messages; empty when the build would change nothing.
export function drift(root, released) {
	const { versions, files } = plan(root, released)
	const problems = []
	if (readFileSync(join(root, VERSIONS), 'utf8') !== versions) {
		problems.push(`${VERSIONS} is not what the build writes`)
	}
	for (const name of readdirSync(join(root, ASSETS)).filter((n) => OWNED.test(n))) {
		if (!files.has(name)) {
			problems.push(`${ASSETS}/${name} is neither the stylesheet nor the latest release's`)
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

// The release --check compares with: from the tags, or as recorded when they are unavailable and not required.
export function releaseForCheck(root = ROOT, env = process.env) {
	const released = releasedStylesheet(root)
	if (released !== null) {
		return { released, warning: null }
	}
	if (env.KOPJE_ASSETS_REQUIRE_TAGS === '1') {
		throw new Error('build-assets: no release tag is reachable from HEAD (a shallow clone?)')
	}
	const recorded = readVersions(readFileSync(join(root, VERSIONS), 'utf8')).previous
	return {
		released: { tag: null, prefix: '', stylesheet: recorded },
		warning: `build-assets: no release tag is reachable from HEAD; trusting PREVIOUS_STYLESHEET ${recorded}`,
	}
}

export function build(root = ROOT) {
	const released = releasedStylesheet(root)
	if (released === null) {
		throw new Error('build-assets: no release tag is reachable from HEAD; fetch the history and the tags')
	}
	const { versions, files } = plan(root, released)
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
	return readVersions(versions)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.includes('--check')) {
			const { released, warning } = releaseForCheck()
			if (warning !== null) {
				console.warn(warning)
			}
			const problems = drift(ROOT, released)
			if (problems.length > 0) {
				console.error(`build-assets: ${problems.join('; ')}. Run node scripts/build-assets.mjs.`)
				process.exit(1)
			}
		} else {
			const { stylesheet, previous } = build()
			console.log(`build-assets: ${stylesheet}, keeping ${previous}`)
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	}
}
