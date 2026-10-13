// Builds what the npm package ships in dist/: the Worker bundled by wrangler exactly as `wrangler deploy` bundles it
// here (worker.js, its source map and the migrations as text modules), and THIRD_PARTY_NOTICES.md for every package
// the bundle contains. The package then has no runtime dependencies: an instance installs the code that was tested.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
// Kept out of dist/ (and out of git, under node_modules) since only the build reads it.
const metafile = join(root, 'node_modules', '.cache', 'kopje-metafile.json')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dirname(metafile), { recursive: true })
execFileSync('wrangler', ['deploy', '--dry-run', '--outdir', dist, '--metafile', metafile], {
	cwd: root,
	stdio: 'inherit',
	shell: process.platform === 'win32',
})
// wrangler writes a README about the build into the output directory; it is not part of the package.
rmSync(join(dist, 'README.md'), { force: true })

const meta = JSON.parse(readFileSync(metafile, 'utf8'))
const packages = new Map()
for (const input of Object.keys(meta.inputs)) {
	const at = input.lastIndexOf('node_modules/')
	if (at === -1) {
		continue
	}
	const parts = input.slice(at + 'node_modules/'.length).split('/')
	const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
	const dir = resolve(root, input.slice(0, at), 'node_modules', name ?? '')
	if (name === undefined || packages.has(dir) || !existsSync(join(dir, 'package.json'))) {
		continue
	}
	packages.set(dir, name)
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i
const entries = []
for (const [dir, name] of packages) {
	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	const files = readdirSync(dir)
		.filter((file) => LICENSE_FILE.test(file))
		.sort()
	if (typeof manifest.license !== 'string' && files.length === 0) {
		throw new Error(`${name}: no license field and no license file`)
	}
	const texts = files.map((file) => readFileSync(join(dir, file), 'utf8').trim())
	entries.push({ id: `${manifest.name ?? name}@${manifest.version}`, license: manifest.license ?? 'see below', texts })
}
// Several copies of one version (pnpm keeps one per peer set) are listed once.
const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort((a, b) => a.id.localeCompare(b.id))

const sections = unique.map(({ id, license, texts }) =>
	[
		`## ${id}`,
		'',
		`License: ${license}`,
		...texts.map((text) => ['', '```', text.replaceAll('```', "'''"), '```'].join('\n')),
	].join('\n')
)
writeFileSync(
	join(dist, 'THIRD_PARTY_NOTICES.md'),
	[
		'# Third-party notices',
		'',
		'dist/worker.js bundles the following packages. Their licenses and notices follow.',
		'',
		...sections.map((section) => `${section}\n`),
	].join('\n')
)
console.log(`build-package: dist/ written, ${unique.length} bundled packages in THIRD_PARTY_NOTICES.md`)
