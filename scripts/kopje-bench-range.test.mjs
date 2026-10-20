// Offline checks of kopje-bench-range.sh's parsing and verdicts, with pnpm stubbed: each checkout's stub prints a
// fixed bench line. Run: pnpm run test:scripts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const script = new URL('./kopje-bench-range.sh', import.meta.url).pathname
const GIT = [
	'-c',
	'user.name=t',
	'-c',
	'user.email=t@example.com',
	'-c',
	'commit.gpgsign=false',
	'-c',
	'tag.gpgsign=false',
]

let work

function git(dir, ...args) {
	const result = spawnSync('git', ['-C', dir, ...GIT, ...args], { encoding: 'utf8' })
	assert.equal(result.status, 0, result.stderr)
}

// A checkout whose newest release tag carries 0001_a and whose HEAD adds 0002_b, and whose pnpm prints `line`.
function checkout(name) {
	const dir = join(work, name)
	mkdirSync(join(dir, 'packages/kopje/migrations'), { recursive: true })
	git(dir, 'init', '-q', '-b', 'main')
	writeFileSync(join(dir, 'packages/kopje/migrations/0001_a.sql'), 'SELECT 1;\n')
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'a')
	git(dir, 'tag', 'kopje-v0.1.0')
	writeFileSync(join(dir, 'packages/kopje/migrations/0002_b.sql'), 'SELECT 2;\n')
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'b')
	git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
	return dir
}

before(() => {
	work = mkdtempSync(join(tmpdir(), 'kopje-bench-range-test-'))
	const bin = join(work, 'bin')
	mkdirSync(bin)
	// The stub answers in the checkout the script runs it in.
	writeFileSync(join(bin, 'pnpm'), '#!/usr/bin/env bash\ncat "$PWD/bench.out"\n')
	chmodSync(join(bin, 'pnpm'), 0o755)
	checkout('head')
	checkout('base')
})

after(() => rmSync(work, { recursive: true, force: true }))

const LEGACY = (ms) => `{"migrations":["0002_b"],"scale":1,"seeded":{"accounts":1},"ms":${ms},"budgetMs":20000}`
const CURRENT = (ms, check, retry) =>
	`{"migrations":["0002_b"],"scale":1,"seeded":{"accounts":1},"ms":${ms},"budgetMs":20000,` +
	`"foreignKeyCheck":"${check}","retryEstimateMs":${retry}}`

function run(head, base) {
	writeFileSync(join(work, 'head', 'bench.out'), `${head}\n`)
	writeFileSync(join(work, 'base', 'bench.out'), `${base}\n`)
	const summary = join(work, 'summary.md')
	writeFileSync(summary, '')
	const result = spawnSync('bash', [script, join(work, 'head'), join(work, 'base')], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, RUNS: '1', GITHUB_STEP_SUMMARY: summary },
	})
	return { status: result.status, out: result.stdout + result.stderr, summary: readFileSync(summary, 'utf8') }
}

describe('kopje-bench-range.sh', () => {
	it("reads a legacy base line as a whole-Store check without a retry estimate, beside the head's fields", () => {
		const { status, out, summary } = run(CURRENT(400, 'skipped', 13500), LEGACY(13000))
		assert.equal(status, 0, out)
		assert.match(summary, /\| head \| 0002_b \| skipped \| 400 \| 400 \| 13500 \|/)
		assert.match(summary, /\| base \| 0002_b \| store \| 13000 \| 13000 \| - \|/)
	})

	it('fails when the head reports no foreign-key check or retry estimate', () => {
		const { status, out } = run(LEGACY(400), LEGACY(13000))
		assert.notEqual(status, 0)
		assert.match(out, /head-1 reported no foreignKeyCheck or retryEstimateMs/)
	})

	it('fails when the head reports no time', () => {
		const { status, out } = run('no measurement', LEGACY(13000))
		assert.notEqual(status, 0)
		assert.match(out, /head-1 reported no time/)
	})

	it("fails when the head's upgrade is past the budget", () => {
		const { status, out } = run(CURRENT(20001, 'store', 20001), CURRENT(13000, 'store', 13000))
		assert.notEqual(status, 0)
		assert.match(out, /median 20001 ms is past the 20000 ms budget/)
	})

	it("warns, without failing, when the head's retry estimate is past the budget", () => {
		const { status, out, summary } = run(CURRENT(400, 'skipped', 20500), CURRENT(13000, 'store', 13000))
		assert.equal(status, 0, out)
		assert.match(out, /::warning::the head's retry estimate 20500 ms is past the 20000 ms budget/)
		assert.match(summary, /\| base \| 0002_b \| store \| 13000 \| 13000 \| 13000 \|/)
	})
})
