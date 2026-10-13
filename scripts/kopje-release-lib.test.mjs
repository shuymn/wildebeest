// Offline checks of the release steps in kopje-release-lib.mjs, with npm and gh stubbed. Run: pnpm run test:scripts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createRelease, publish, withManifestVersion } from './kopje-release-lib.mjs'

let work
let tarball
let integrity

before(() => {
	work = mkdtempSync(join(tmpdir(), 'kopje-release-test-'))
	mkdirSync(join(work, 'package'))
	writeFileSync(join(work, 'package', 'package.json'), JSON.stringify({ name: 'kopje', version: '1.2.3' }))
	tarball = join(work, 'kopje-1.2.3.tgz')
	execFileSync('tar', ['-czf', tarball, '-C', work, 'package'])
	integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
})

after(() => rmSync(work, { recursive: true, force: true }))

// A stub command: answers `view`/`release view` with the given result, records every call, and succeeds otherwise.
function stub(answers) {
	const calls = []
	const command = (args) => {
		calls.push(args)
		const answer = answers[args[0] === 'release' ? `${args[0]} ${args[1]}` : args[0]]
		return answer ?? { code: 0, stdout: '', stderr: '' }
	}
	return { command, calls }
}

const e404 = { code: 1, stdout: JSON.stringify({ error: { code: 'E404', summary: 'not found' } }), stderr: '' }
const quiet = () => {}
const file = () => 'file'

describe('publish', () => {
	it('publishes exactly the absolute path of the tarball when the version is not on npm', () => {
		const npm = stub({ view: e404 })
		const result = publish({
			tarball: relative(process.cwd(), tarball),
			tag: 'latest',
			npm: npm.command,
			specType: file,
			log: quiet,
		})
		assert.equal(result, 'published')
		const publishes = npm.calls.filter((args) => args[0] === 'publish')
		assert.equal(publishes.length, 1)
		assert.equal(publishes[0][1], tarball)
		assert.deepEqual(publishes[0].slice(2, 6), ['--access', 'public', '--provenance', '--tag'])
		assert.equal(publishes[0][6], 'latest')
	})

	it('treats an empty answer from npm view as a version not on npm', () => {
		const npm = stub({ view: { code: 0, stdout: '', stderr: '' } })
		assert.equal(publish({ tarball, tag: 'next', npm: npm.command, specType: file, log: quiet }), 'published')
	})

	it('skips the publish when npm has the version with the same integrity', () => {
		const npm = stub({ view: { code: 0, stdout: JSON.stringify(integrity), stderr: '' } })
		assert.equal(publish({ tarball, tag: 'latest', npm: npm.command, specType: file, log: quiet }), 'skipped')
		assert.equal(npm.calls.filter((args) => args[0] === 'publish').length, 0)
	})

	it('fails without publishing when npm has the version with another integrity', () => {
		const npm = stub({ view: { code: 0, stdout: JSON.stringify('sha512-other'), stderr: '' } })
		assert.throws(
			() => publish({ tarball, tag: 'latest', npm: npm.command, specType: file, log: quiet }),
			/another tarball/
		)
		assert.equal(npm.calls.filter((args) => args[0] === 'publish').length, 0)
	})

	for (const [what, answer] of [
		['another error code', { code: 1, stdout: JSON.stringify({ error: { code: 'E500' } }), stderr: 'boom' }],
		['a failure without output', { code: 1, stdout: '', stderr: 'network down' }],
		['output that is not JSON', { code: 0, stdout: 'not json', stderr: '' }],
		['an answer that is not an integrity', { code: 0, stdout: JSON.stringify({ a: 1 }), stderr: '' }],
	]) {
		it(`fails without publishing when npm view answers ${what}`, () => {
			const npm = stub({ view: answer })
			assert.throws(() => publish({ tarball, tag: 'latest', npm: npm.command, specType: file, log: quiet }))
			assert.equal(npm.calls.filter((args) => args[0] === 'publish').length, 0)
		})
	}

	it('refuses an argument npm would not read as a local file, before asking npm anything', () => {
		const npm = stub({ view: e404 })
		assert.throws(
			() => publish({ tarball, tag: 'latest', npm: npm.command, specType: () => 'git', log: quiet }),
			/not a local file/
		)
		assert.equal(npm.calls.length, 0)
	})

	it('fails when npm publish fails', () => {
		const npm = stub({ view: e404, publish: { code: 1, stdout: '', stderr: '' } })
		assert.throws(() => publish({ tarball, tag: 'latest', npm: npm.command, specType: file, log: quiet }), /failed/)
	})

	it('publishes nothing in a dry run', () => {
		const npm = stub({ view: e404 })
		assert.equal(
			publish({ tarball, tag: 'latest', dryRun: true, npm: npm.command, specType: file, log: quiet }),
			'dry-run'
		)
		assert.equal(npm.calls.filter((args) => args[0] === 'publish').length, 0)
	})
})

describe('createRelease', () => {
	const release = { repo: 'owner/repo', tag: 'kopje-v1.2.3', version: '1.2.3', notesFile: 'notes.md', tarball: 't.tgz' }

	it('never creates a release that exists', () => {
		const gh = stub({ 'release view': { code: 0, stdout: '{"tagName":"kopje-v1.2.3"}', stderr: '' } })
		assert.equal(createRelease({ ...release, prerelease: false, gh: gh.command, log: quiet }), 'exists')
		assert.equal(gh.calls.filter((args) => args[1] === 'create').length, 0)
	})

	it('creates a release that is not found, with the notes and the tarball', () => {
		const gh = stub({ 'release view': { code: 1, stdout: '', stderr: 'release not found\n' } })
		assert.equal(createRelease({ ...release, prerelease: true, gh: gh.command, log: quiet }), 'created')
		const creates = gh.calls.filter((args) => args[1] === 'create')
		assert.equal(creates.length, 1)
		const args = creates[0]
		assert.equal(args[2], 'kopje-v1.2.3')
		assert.ok(args.includes('--verify-tag'))
		assert.ok(args.includes('--prerelease'))
		assert.equal(args[args.indexOf('--notes-file') + 1], 'notes.md')
		assert.equal(args.at(-1), 't.tgz')
	})

	it('creates nothing when gh release view fails for another reason', () => {
		const gh = stub({ 'release view': { code: 1, stdout: '', stderr: 'HTTP 502' } })
		assert.throws(() => createRelease({ ...release, prerelease: false, gh: gh.command, log: quiet }))
		assert.equal(gh.calls.filter((args) => args[1] === 'create').length, 0)
	})
})

describe('withManifestVersion', () => {
	const original = '{\n\t"name": "kopje",\n\t"version": "0.0.0"\n}\n'

	it('sets the version while it runs and restores the file after a pack failure', () => {
		const manifest = join(work, 'manifest-fail.json')
		writeFileSync(manifest, original)
		let seen
		assert.throws(
			() =>
				withManifestVersion(manifest, '1.2.3', () => {
					seen = JSON.parse(readFileSync(manifest, 'utf8')).version
					throw new Error('npm pack failed')
				}),
			/npm pack failed/
		)
		assert.equal(seen, '1.2.3')
		assert.equal(readFileSync(manifest, 'utf8'), original)
	})

	it('restores the file after success and returns the result', () => {
		const manifest = join(work, 'manifest-ok.json')
		writeFileSync(manifest, original)
		assert.equal(
			withManifestVersion(manifest, '1.2.3', () => 'packed'),
			'packed'
		)
		assert.equal(readFileSync(manifest, 'utf8'), original)
	})
})
