import { expect, it } from 'vitest'

// filterTextUnitsSql reads MAX_FILTER_TEXT through filters.ts, which is in an import cycle with status-presenter.ts
// (filters → accounts → media → status-presenter → filters). Imported cold from filters.ts first, as a module graph may
// be, the statement still holds the cap and no unset value: it is built on first use, not at load. The specifiers are
// values, so test-node's program does not type the Worker sources; each module is read as the shape used here.
const FILTERS = '../src/domain/filters'
const PRESENTER = '../src/domain/status-presenter'

it('builds the filter text SQL with its cap when filters.ts is imported first', async () => {
	const filters = (await import(/* @vite-ignore */ FILTERS)) as { MAX_FILTER_TEXT: number }
	const { filterTextUnitsSql } = (await import(/* @vite-ignore */ PRESENTER)) as { filterTextUnitsSql: () => string }
	expect(filters.MAX_FILTER_TEXT).toBe(10_000)
	expect(filterTextUnitsSql()).not.toContain('undefined')
	expect(filterTextUnitsSql()).toContain(`), ${filters.MAX_FILTER_TEXT}) AS units`)
})
