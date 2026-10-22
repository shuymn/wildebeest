import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	build,
	drift,
	fingerprint,
	LEGACY_STYLESHEET,
	releaseForCheck,
	releasedStylesheet,
} from '../scripts/build-assets.mjs'

// The stylesheet files across development and releases (amendment A1, scripts/build-assets.mjs): public/assets keeps
// the current stylesheet and the one the latest completed release linked, and nothing else. Each case drives a real
// repository with kopje-v* tags, laid out as packages/kopje is.

// A git that reads no user or system configuration (no signing, no hooks).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

const repos: string[] = []

afterEach(() => {
	for (const repo of repos.splice(0)) {
		rmSync(repo, { recursive: true, force: true })
	}
})

function repository() {
	const repo = mkdtempSync(join(tmpdir(), 'kopje-assets-'))
	repos.push(repo)
	const root = join(repo, 'packages', 'kopje')
	mkdirSync(join(root, 'src', 'web'), { recursive: true })
	mkdirSync(join(root, 'public', 'assets'), { recursive: true })
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
			env: GIT_ENV,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	git('init', '-q', '-b', 'main')
	const commit = (message: string) => {
		git('add', '-A')
		git('commit', '-q', '--allow-empty', '-m', message)
	}
	// A release before A1: the unversioned stylesheet and no versions module.
	writeFileSync(join(root, 'public', 'assets', 'kopje.css'), 'legacy {}\n')
	commit('legacy')
	git('tag', 'kopje-v0.1.0-rc.1')
	const css = (text: string) => {
		writeFileSync(join(root, 'src', 'web', 'kopje.css'), text)
		build(root)
		commit(`css ${text}`)
		return `kopje.${fingerprint(Buffer.from(text))}.css`
	}
	const files = () =>
		readdirSync(join(root, 'public', 'assets'))
			.filter((name) => name.startsWith('kopje'))
			.sort()
	const release = (version: string) => git('tag', `kopje-v${version}`)
	return { root, css, files, release, git }
}

describe('build-assets (amendment A1)', () => {
	it('keeps the legacy stylesheet while development edits replace each other', () => {
		const { root, css, files } = repository()
		css('a {}\n')
		const b = css('b {}\n')
		const c = css('c {}\n')
		expect(files()).toEqual([c, 'kopje.css'].sort())
		expect(b).not.toBe(c)
		expect(releasedStylesheet(root)?.stylesheet).toBe(LEGACY_STYLESHEET)
	})

	it('keeps the released stylesheet when a fix follows the release preparation, until the next tag', () => {
		const { root, css, files, release } = repository()
		const a = css('a {}\n')
		release('0.1.0-rc.2')
		// Preparing rc.3 (a changelog heading, anything) and then a CSS fix: rc.2's stylesheet stays.
		const b = css('b {}\n')
		const c = css('c {}\n')
		expect(files()).toEqual([a, c].sort())
		expect(b).not.toBe(a)
		// The tag of the release being built does not count: its check still compares with rc.2.
		release('0.1.0-rc.3')
		expect(releasedStylesheet(root)?.tag).toBe('kopje-v0.1.0-rc.2')
		expect(drift(root, releaseForCheck(root).released)).toEqual([])
	})

	it('counts a tag on HEAD as complete once other CSS is built on top of it', () => {
		const { root, css, files, release } = repository()
		css('a {}\n')
		const b = css('b {}\n')
		release('0.1.0-rc.2')
		// A branch started at the tagged commit edits the CSS: rc.2's stylesheet is the one to keep.
		const c = css('c {}\n')
		expect(files()).toEqual([b, c].sort())
		expect(releasedStylesheet(root)?.tag).toBe('kopje-v0.1.0-rc.2')
	})

	it('drops the older stylesheet when a release keeps the CSS unchanged', () => {
		const { root, css, files, release, git } = repository()
		const a = css('a {}\n')
		release('0.1.0-rc.2')
		git('commit', '-q', '--allow-empty', '-m', 'no css change')
		release('0.1.0-rc.3')
		git('commit', '-q', '--allow-empty', '-m', 'after rc.3')
		build(root)
		expect(files()).toEqual([a])
	})

	it('goes A → B → A without keeping B', () => {
		const { css, files, release } = repository()
		const a = css('a {}\n')
		release('0.1.0-rc.2')
		const b = css('b {}\n')
		expect(files()).toEqual([a, b].sort())
		expect(css('a {}\n')).toBe(a)
		expect(files()).toEqual([a])
	})

	it('restores the released file from the release when it was deleted', () => {
		const { root, css, files, release } = repository()
		const a = css('a {}\n')
		release('0.1.0-rc.2')
		const b = css('b {}\n')
		rmSync(join(root, 'public', 'assets', a))
		expect(drift(root, releaseForCheck(root).released)).toContain(
			`public/assets/${a} does not hold the bytes it is named for`
		)
		build(root)
		expect(files()).toEqual([a, b].sort())
		expect(readFileSync(join(root, 'public', 'assets', a), 'utf8')).toBe('a {}\n')
	})

	it('flags a stray stylesheet and a stale versions module', () => {
		const { root, css } = repository()
		css('a {}\n')
		writeFileSync(join(root, 'public', 'assets', 'kopje.0123456789.css'), 'stray')
		writeFileSync(join(root, 'src', 'web', 'kopje.css'), 'edited {}\n')
		const problems = drift(root, releaseForCheck(root).released)
		expect(problems).toContain('src/web/asset-versions.ts is not what the build writes')
		expect(problems).toContain(`public/assets/kopje.0123456789.css is neither the stylesheet nor the latest release's`)
		expect(problems.filter((p) => p.endsWith('does not hold the bytes it is named for'))).toHaveLength(1)
	})

	it('without tags: the build refuses, and the check trusts the recorded file unless tags are required', () => {
		const { root, css, git } = repository()
		css('a {}\n')
		git('tag', '-d', 'kopje-v0.1.0-rc.1')
		expect(releasedStylesheet(root)).toBeNull()
		expect(() => build(root)).toThrow(/no release tag/)
		const { released, warning } = releaseForCheck(root, {})
		expect(released.stylesheet).toBe(LEGACY_STYLESHEET)
		expect(warning).toMatch(/trusting PREVIOUS_STYLESHEET/)
		expect(drift(root, released)).toEqual([])
		expect(() => releaseForCheck(root, { KOPJE_ASSETS_REQUIRE_TAGS: '1' })).toThrow(/no release tag/)
	})
})
