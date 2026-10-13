// Checks the kopje npm package the way an instance uses it:
//   1. builds the package (packages/kopje/scripts/build-package.mjs) and packs it with npm, as the release does;
//   2. installs the tarball into a copy of the deploy/ template (the package has no dependencies, so installing it is
//      unpacking it into node_modules/kopje) and dry-runs the template's `wrangler deploy`;
//   3. fails when the template's bundle is over 1 MiB gzipped, differs from the in-repo build by more than 1%, or when
//      deploy/wrangler.jsonc no longer matches the runtime settings and bindings of packages/kopje/wrangler.jsonc.
//
//   node scripts/check-kopje-package.mjs [--out <dir>]   keeps the tarball in <dir> (the release publishes it)
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { experimental_readRawConfig as readRawConfig } from 'wrangler'

const LIMIT_KIB = 1024
const TOLERANCE = 0.01

const repo = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(repo, 'packages', 'kopje')
const template = join(repo, 'deploy')
const bin = join(repo, 'node_modules', '.bin')
const wrangler = join(bin, 'wrangler')
const { values } = parseArgs({ options: { out: { type: 'string' } } })

const work = mkdtempSync(join(tmpdir(), 'kopje-package-'))
const failures = []
try {
	// 1. Build and pack.
	const build = run('node', [join(pkg, 'scripts', 'build-package.mjs')], pkg, {
		env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
	})
	const repoKiB = gzipKiB(build)
	const out = resolve(values.out ?? join(work, 'pack'))
	mkdirSync(out, { recursive: true })
	// dist/ was just built; --ignore-scripts keeps npm from building it a second time (prepack).
	const [packed] = JSON.parse(
		run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out, '--loglevel', 'warn'], pkg, {
			quiet: true,
		})
	)
	const tarball = join(out, packed.filename)
	console.log(`packed ${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} KiB`)
	const paths = packed.files.map((file) => file.path)
	const unexpected = paths.filter((path) => /^(src|test|test-node|stubs|scripts)\//.test(path))
	if (!paths.includes('dist/worker.js') || unexpected.length > 0) {
		failures.push(`the package must ship dist/worker.js and no sources; unexpected: ${unexpected}`)
	}

	// 2. Install into a copy of the template and dry-run it.
	const app = join(work, 'template')
	cpSync(template, app, {
		recursive: true,
		filter: (path) => !/[\\/](node_modules|public|\.wrangler)$/.test(path),
	})
	const installed = join(app, 'node_modules', 'kopje')
	mkdirSync(installed, { recursive: true })
	run('tar', ['-xzf', tarball, '-C', installed, '--strip-components', '1'], app)
	const dryRun = run(wrangler, ['deploy', '--dry-run', '--outdir', join(work, 'template-dist')], app)
	const templateKiB = gzipKiB(dryRun)
	console.log(`gzip: in-repo ${repoKiB} KiB, template ${templateKiB} KiB`)

	// 3. Checks.
	for (const [what, kib] of [
		['in-repo', repoKiB],
		['template', templateKiB],
	]) {
		if (kib > LIMIT_KIB) {
			failures.push(`the ${what} bundle is ${kib} KiB gzipped, over ${LIMIT_KIB} KiB`)
		}
	}
	if (Math.abs(templateKiB - repoKiB) > repoKiB * TOLERANCE) {
		failures.push(`the template's bundle (${templateKiB} KiB) differs from the in-repo build (${repoKiB} KiB)`)
	}
	const assets = readdirSync(join(app, 'public'), { recursive: true }).sort()
	const shipped = readdirSync(join(pkg, 'public'), { recursive: true }).sort()
	if (JSON.stringify(assets) !== JSON.stringify(shipped)) {
		failures.push(`the template's public/ (${assets}) is not the package's (${shipped})`)
	}
	failures.push(...compareConfigs())
	const ours = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies.wrangler
	const theirs = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')).devDependencies.wrangler
	if (ours !== theirs) {
		failures.push(`deploy/package.json pins wrangler ${theirs}, the repository ${ours}: update them together`)
	}
} finally {
	rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
	console.error(failures.map((failure) => `check-kopje-package: ${failure}`).join('\n'))
	process.exit(1)
}
console.log('check-kopje-package: ok')

function run(command, args, cwd, { env = {}, quiet = false } = {}) {
	const output = execFileSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		maxBuffer: 64 * 1024 * 1024,
	})
	if (!quiet) {
		process.stderr.write(output)
	}
	return output
}

function gzipKiB(output) {
	const match = /gzip: ([0-9.]+) KiB/.exec(output)
	if (match === null) {
		throw new Error('no gzip size in the wrangler output')
	}
	return Number(match[1])
}

// The template may name its Worker and resources as it likes, but everything the code depends on must be as in the
// package's own config.
function compareConfigs() {
	const read = (dir) => readRawConfig({ config: join(dir, 'wrangler.jsonc') }).rawConfig
	const source = read(pkg)
	const target = read(template)
	const shape = (config) => ({
		compatibility_date: config.compatibility_date,
		compatibility_flags: config.compatibility_flags,
		minify: config.minify,
		keep_vars: config.keep_vars,
		version_metadata: config.version_metadata,
		durable_objects: config.durable_objects,
		migrations: config.migrations,
		queues: {
			producers: config.queues?.producers?.map(({ queue: _, ...rest }) => rest),
			consumers: config.queues?.consumers?.map(({ queue: _, ...rest }) => rest),
		},
		ratelimits: config.ratelimits?.map(({ namespace_id: _, ...rest }) => rest),
		r2_buckets: config.r2_buckets?.map(({ bucket_name: _, ...rest }) => rest),
		images: config.images,
		assets: config.assets,
		triggers: config.triggers,
		rules: config.rules,
	})
	const problems = []
	const queues = new Set([...(target.queues?.producers ?? []), ...(target.queues?.consumers ?? [])].map((q) => q.queue))
	if (queues.size !== 1) {
		problems.push(`deploy/wrangler.jsonc must produce to and consume one queue, not ${[...queues]}`)
	}
	if (target.keep_names !== false) {
		problems.push('deploy/wrangler.jsonc must set keep_names to false: the kopje bundle already keeps the names')
	}
	const expected = shape(source)
	const actual = shape(target)
	for (const key of Object.keys(expected)) {
		if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
			problems.push(
				`deploy/wrangler.jsonc ${key} is ${JSON.stringify(actual[key])}, packages/kopje has ${JSON.stringify(expected[key])}`
			)
		}
	}
	return problems
}
