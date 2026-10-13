// Publishes a checked kopje tarball to npm, once. The release workflow runs it; it is safe to run again.
//   - The tarball is given to npm as an absolute path, and npm's own parser must read it as a local file: a bare
//     relative path such as package/kopje-1.0.0.tgz would be read as a GitHub repository.
//   - If the version is not on npm, it publishes the tarball.
//   - If the version is on npm with the same integrity as the tarball (a run that published and then failed), it
//     publishes nothing and succeeds, so the GitHub release can be made by running the workflow's jobs again.
//   - If the version is on npm with another integrity, it fails: npm never replaces a version, so release a new one.
//
//   node scripts/kopje-publish.mjs <tarball> --tag <dist-tag> [--dry-run]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const REGISTRY = 'https://registry.npmjs.org/'

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { tag: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
})
if (positionals.length !== 1 || values.tag === undefined) {
	console.error('usage: node scripts/kopje-publish.mjs <tarball> --tag <dist-tag> [--dry-run]')
	process.exit(2)
}
const tarball = resolve(positionals[0])
if (!existsSync(tarball)) {
	throw new Error(`${tarball} does not exist`)
}

// npm's own spec parser (npm-package-arg, shipped inside npm) decides what `npm publish <arg>` publishes.
const npmRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim()
const npa = createRequire(join(npmRoot, 'npm', 'package.json'))('npm-package-arg')
const spec = npa(tarball)
if (spec.type !== 'file') {
	throw new Error(`npm reads ${tarball} as a ${spec.type} spec, not a local file`)
}

const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
const id = `${manifest.name}@${manifest.version}`
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`

const published = publishedIntegrity(id)
if (published === integrity) {
	console.log(`${id} is already on npm with this tarball's integrity; nothing to publish`)
	process.exit(0)
}
if (published !== null) {
	console.error(`${id} is already on npm with another tarball (${published}, this one ${integrity}).`)
	console.error('npm never replaces a published version: release a new version instead.')
	process.exit(1)
}

const args = ['publish', tarball, '--access', 'public', '--provenance', '--tag', values.tag, '--registry', REGISTRY]
if (values['dry-run']) {
	console.log(`dry run: would publish ${id} (${integrity}): npm ${args.join(' ')}`)
	process.exit(0)
}
execFileSync('npm', args, { stdio: 'inherit' })
console.log(`published ${id} (${integrity})`)

// The integrity npm has for the version, or null when npm has no such version.
function publishedIntegrity(name) {
	let output
	try {
		output = execFileSync('npm', ['view', name, 'dist.integrity', '--json', '--registry', REGISTRY], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	} catch (error) {
		output = error.stdout ?? ''
		const code = output.trim() === '' ? undefined : JSON.parse(output).error?.code
		if (code === 'E404') {
			return null
		}
		throw new Error(`npm view ${name} failed; publishing nothing: ${error.stderr ?? error.message}`)
	}
	// Some npm versions answer a missing version with nothing at all.
	if (output.trim() === '') {
		return null
	}
	const value = JSON.parse(output)
	if (typeof value !== 'string') {
		throw new Error(`npm view ${name} returned no integrity: ${output}`)
	}
	return value
}
