// The steps of a kopje release that decide what happens to npm, GitHub and the repository, kept apart from the
// commands they run so that scripts/kopje-release-lib.test.mjs can check them offline with stubbed npm and gh.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'

export const REGISTRY = 'https://registry.npmjs.org/'

// Runs a command and returns its exit code and output, never throwing on a non-zero exit.
export function runCommand(command) {
	return (args) => {
		const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
		if (result.error !== undefined) {
			throw result.error
		}
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
	}
}

// How `npm publish <argument>` reads its argument, by npm's own spec parser (npm-package-arg, shipped inside npm).
export function npmSpecType(argument) {
	const npmRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim()
	const npa = createRequire(join(npmRoot, 'npm', 'package.json'))('npm-package-arg')
	return npa(argument).type
}

// Runs fn with packages/kopje/package.json (or any manifest) set to the version, and restores the file byte for byte
// afterwards, whether fn returns or throws.
export function withManifestVersion(manifestPath, version, fn) {
	const original = readFileSync(manifestPath, 'utf8')
	try {
		const manifest = JSON.parse(original)
		if (manifest.version !== version) {
			writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, '\t')}\n`)
		}
		return fn()
	} finally {
		writeFileSync(manifestPath, original)
	}
}

// Publishes a checked tarball once, and is safe to run again:
//   - the tarball goes to npm as an absolute path that npm's parser reads as a local file (a bare relative path such as
//     package/kopje-1.0.0.tgz would be read as a GitHub repository);
//   - a version not on npm is published;
//   - a version on npm with the tarball's integrity is not published again ('skipped'), so a run that published and
//     then failed can be rerun;
//   - a version on npm with another integrity, or a lookup that fails for another reason, publishes nothing and throws.
export function publish({
	tarball: given,
	tag,
	dryRun = false,
	npm = runCommand('npm'),
	specType = npmSpecType,
	log = console.log,
}) {
	const tarball = resolve(given)
	if (!existsSync(tarball)) {
		throw new Error(`${tarball} does not exist`)
	}
	const type = specType(tarball)
	if (!isAbsolute(tarball) || type !== 'file') {
		throw new Error(`npm reads ${tarball} as a ${type} spec, not a local file`)
	}
	const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
	const id = `${manifest.name}@${manifest.version}`
	const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`

	const published = publishedIntegrity(npm, id)
	if (published === integrity) {
		log(`${id} is already on npm with this tarball's integrity; nothing to publish`)
		return 'skipped'
	}
	if (published !== null) {
		throw new Error(
			`${id} is already on npm with another tarball (${published}, this one ${integrity}). npm never replaces a ` +
				'published version: release a new version instead.'
		)
	}
	const args = ['publish', tarball, '--access', 'public', '--provenance', '--tag', tag, '--registry', REGISTRY]
	if (dryRun) {
		log(`dry run: would publish ${id} (${integrity}): npm ${args.join(' ')}`)
		return 'dry-run'
	}
	const result = npm(args)
	process.stderr.write(result.stderr)
	if (result.code !== 0) {
		throw new Error(`npm publish ${id} failed (exit ${result.code})`)
	}
	log(`published ${id} (${integrity})`)
	return 'published'
}

// The integrity npm has for the version, or null when npm has no such version.
function publishedIntegrity(npm, id) {
	const { code, stdout, stderr } = npm(['view', id, 'dist.integrity', '--json', '--registry', REGISTRY])
	const output = stdout.trim()
	let parsed
	try {
		parsed = output === '' ? null : JSON.parse(output)
	} catch {
		throw new Error(`npm view ${id} printed something unexpected; publishing nothing: ${output.slice(0, 200)}`)
	}
	if (code !== 0) {
		if (parsed?.error?.code === 'E404') {
			return null
		}
		throw new Error(`npm view ${id} failed (exit ${code}); publishing nothing: ${stderr.slice(0, 500)}`)
	}
	// Some npm versions answer a missing version with nothing at all.
	if (parsed === null) {
		return null
	}
	if (typeof parsed !== 'string' || !parsed.startsWith('sha512-')) {
		throw new Error(`npm view ${id} returned no sha512 integrity: ${output.slice(0, 200)}`)
	}
	return parsed
}

// Creates the GitHub release for the tag, unless it exists: a rerun after the release was made leaves it as it is.
// Any answer from `gh release view` other than "found" or "not found" throws without creating anything.
export function createRelease({
	repo,
	tag,
	version,
	prerelease,
	notesFile,
	tarball,
	gh = runCommand('gh'),
	log = console.log,
}) {
	const view = gh(['release', 'view', tag, '--repo', repo, '--json', 'tagName'])
	if (view.code === 0) {
		log(`the release ${tag} exists already; leaving it as it is`)
		return 'exists'
	}
	if (!/release not found/i.test(view.stderr)) {
		throw new Error(`gh release view ${tag} failed (exit ${view.code}): ${view.stderr.slice(0, 500)}`)
	}
	const args = ['release', 'create', tag, '--repo', repo, '--verify-tag', '--title', `Kopje ${version}`]
	args.push('--notes-file', notesFile)
	if (prerelease) {
		args.push('--prerelease')
	}
	args.push(tarball)
	const created = gh(args)
	process.stderr.write(created.stderr)
	if (created.code !== 0) {
		throw new Error(`gh release create ${tag} failed (exit ${created.code})`)
	}
	log(`created the release ${tag}`)
	return 'created'
}
