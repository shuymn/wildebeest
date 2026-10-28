import { expect, it } from 'vitest'

// Bounds computed at module load from another module's export are numbers in the order the Worker loads its modules.
// Imported dynamically, after the entry, so a sorted import list in this file cannot choose the order: a module read
// before its cycle partner has initialized makes the bound NaN (remote-suspension.ts SEVER_ROWS, delivery-bounds.ts).
it('loads the moderation round bounds as numbers after the Worker entry', async () => {
	await import('../src/worker')
	const { SEVER_ROWS } = await import('../src/domain/remote-suspension')
	expect(Number.isInteger(SEVER_ROWS), `SEVER_ROWS is ${SEVER_ROWS}`).toBe(true)
})
