import { expect, test } from '@playwright/test'

const base = 'http://127.0.0.1:8788'

for (const path of [
	'/settings/server-settings/branding',
	'/settings/server-settings/about',
	'/settings/server-settings/rules',
	'/settings/server-settings/rules/edit/1',
	'/settings/migration',
]) {
	test(`Unauthenticated requests cannot read ${path}`, async ({ request }) => {
		const response = await request.get(base + path)
		expect(response.status()).toEqual(401)
	})
}

test('Unauthenticated requests cannot update the server settings', async ({ request }) => {
	const response = await request.post(base + '/settings/server-settings/branding/', {
		headers: { origin: base },
		form: { 'server name': 'pwned', 'server description': 'pwned' },
	})
	expect(response.ok()).toBe(false)

	const instance = await request.get(base + '/api/v1/instance')
	expect(await instance.text()).not.toContain('pwned')
})
