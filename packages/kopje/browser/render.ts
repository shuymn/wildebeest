import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

// Renders every fixture page to <name>.html under .pages/, where the spec serves it from (and where a failing run
// leaves it to inspect).
export const PAGES_DIR = new URL('./.pages/', import.meta.url)

// fixtures/pages.tsx is typed against the Workers types, as the components it renders are, so it is checked by its
// own tsconfig and imported here by a specifier this program does not follow.
const FIXTURES: string = './fixtures/pages.tsx'

export default async function renderPages(): Promise<void> {
	const { renderPages: render } = (await import(FIXTURES)) as {
		renderPages: () => Promise<Record<string, string>>
	}
	rmSync(PAGES_DIR, { recursive: true, force: true })
	mkdirSync(PAGES_DIR, { recursive: true })
	for (const [name, html] of Object.entries(await render())) {
		writeFileSync(new URL(`${name}.html`, PAGES_DIR), html)
	}
}
