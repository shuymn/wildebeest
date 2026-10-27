// Offline checks of test-affected.sh: the suites it picks for changed paths, and the passed trees the pre-push hook
// skips, with pnpm stubbed to log its arguments and exit with the code in pnpm.exit. Run: pnpm run test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

const script = new URL('./test-affected.sh', import.meta.url).pathname
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false']

let work
let bin
let repo

function git(...args) {
	const result = spawnSync('git', ['-C', repo, ...GIT, ...args], { encoding: 'utf8' })
	assert.equal(result.status, 0, result.stderr)
	return result.stdout.trim()
}

function suites(...paths) {
	const result = spawnSync('bash', [script, 'suites'], { input: paths.join('\n'), encoding: 'utf8' })
	assert.equal(result.status, 0, result.stderr)
	return Object.fromEntries(
		result.stdout
			.trim()
			.split('\n')
			.map((line) => line.split('='))
	)
}

// Runs the script in the checkout with the hook's environment unless env says otherwise.
function run(env = { TEST_AFFECTED_SKIP_PASSED: '1' }, ...args) {
	writeFileSync(join(work, 'pnpm.log'), '')
	const result = spawnSync('bash', [script, ...args], {
		cwd: repo,
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KOPJE: '', KOPJE_CODE: '', ...env },
	})
	return { status: result.status, stderr: result.stderr, pnpm: readFileSync(join(work, 'pnpm.log'), 'utf8').trim() }
}

const B = (kopje, kopjeCode) => ({ kopje: `${kopje}`, kopje_code: `${kopjeCode}` })

describe('suites', () => {
	it('runs only the Node suite for Kopje Markdown', () => {
		assert.deepEqual(suites('packages/kopje/docs/visibility.md', 'packages/kopje/CHANGELOG.md'), B(true, false))
		assert.deepEqual(suites('deploy/README.md'), B(true, false))
	})

	it('runs no suite for Markdown outside the packages', () => {
		assert.deepEqual(suites('AGENTS.md', 'README.md', '.claude/rules/kopje-web.md'), B(false, false))
	})

	it('runs Kopje for the scope table its vectors import', () => {
		assert.deepEqual(suites('packages/kopje/docs/mastodon-api-spec/client-api/auth-oauth.md'), B(true, true))
	})

	it('runs every suite for code, root config and an empty list', () => {
		assert.deepEqual(suites('packages/kopje/docs/x.md', 'packages/kopje/src/store.ts'), B(true, true))
		assert.deepEqual(suites('pnpm-lock.yaml'), B(true, true))
		assert.deepEqual(suites(), B(true, true))
	})
})

describe('runs', () => {
	before(() => {
		work = mkdtempSync(join(tmpdir(), 'test-affected-test-'))
		bin = join(work, 'bin')
		mkdirSync(bin)
		writeFileSync(
			join(bin, 'pnpm'),
			[
				'#!/usr/bin/env bash',
				`echo "$*" >>"${join(work, 'pnpm.log')}"`,
				'echo "vitest output"',
				`exit "$(cat "${join(work, 'pnpm.exit')}")"`,
				'',
			].join('\n')
		)
		chmodSync(join(bin, 'pnpm'), 0o755)
	})

	after(() => rmSync(work, { recursive: true, force: true }))

	// A checkout whose origin/main has one Kopje file and whose HEAD changes it.
	beforeEach(() => {
		repo = mkdtempSync(join(work, 'repo-'))
		writeFileSync(join(work, 'pnpm.exit'), '0')
		mkdirSync(join(repo, 'packages/kopje/src'), { recursive: true })
		writeFileSync(join(repo, 'packages/kopje/src/a.ts'), '1\n')
		git('init', '-q', '-b', 'main')
		git('add', '.')
		git('commit', '-q', '-m', 'a')
		git('update-ref', 'refs/remotes/origin/main', 'HEAD')
		writeFileSync(join(repo, 'packages/kopje/src/a.ts'), '2\n')
		git('commit', '-q', '-am', 'b')
	})

	it('skips a clean tree that already passed, and runs again once it changes', () => {
		assert.match(run().pnpm, /--project kopje --project kopje-streaming --project kopje-cli$/)
		const again = run()
		assert.equal(again.status, 0)
		assert.equal(again.pnpm, '')
		assert.match(again.stderr, /already passed/)
		writeFileSync(join(repo, 'packages/kopje/src/a.ts'), '3\n')
		git('commit', '-q', '-am', 'c')
		assert.notEqual(run().pnpm, '')
	})

	it('reruns without the hook environment', () => {
		run()
		assert.notEqual(run({}).pnpm, '')
	})

	it('records no pass for a dirty tree, vitest args or a failure', () => {
		const stamp = join(repo, '.git/test-affected-passed')
		// Git configuration that hides untracked files does not hide them from the check.
		git('config', 'status.showUntrackedFiles', 'no')
		writeFileSync(join(repo, 'untracked.txt'), 'x\n')
		run()
		assert.equal(existsSync(stamp), false)
		assert.notEqual(run().pnpm, '')
		rmSync(join(repo, 'untracked.txt'))
		run(undefined, '--shard', '1/4')
		assert.notEqual(run({ TEST_AFFECTED_SKIP_PASSED: '1' }, '--shard', '1/4').pnpm, '')
		assert.equal(existsSync(stamp), false)
		writeFileSync(join(work, 'pnpm.exit'), '1')
		const failed = run()
		assert.equal(failed.status, 1)
		assert.match(failed.stderr, /whole output is in .*test-affected\.log/)
		assert.match(readFileSync(join(repo, '.git/test-affected.log'), 'utf8'), /vitest output/)
		writeFileSync(join(work, 'pnpm.exit'), '0')
		assert.notEqual(run().pnpm, '')
	})

	it('does not let a Node-only pass cover a run that needs every Kopje suite', () => {
		const nodeOnly = { TEST_AFFECTED_SKIP_PASSED: '1', KOPJE: 'true', KOPJE_CODE: 'false' }
		assert.equal(run(nodeOnly).pnpm, 'run test --project kopje-cli')
		const hit = run(nodeOnly)
		assert.equal(hit.status, 0)
		assert.equal(hit.pnpm, '')
		assert.match(hit.stderr, /already passed/)
		assert.match(run().pnpm, /--project kopje --project kopje-streaming/)
	})

	it('runs nothing when no suite reads the change', () => {
		git('reset', '-q', '--hard', 'origin/main')
		writeFileSync(join(repo, 'AGENTS.md'), 'x\n')
		git('add', '.')
		git('commit', '-q', '-m', 'docs')
		const result = run()
		assert.equal(result.status, 0)
		assert.equal(result.pnpm, '')
		assert.match(result.stderr, /no suite reads/)
	})
})
