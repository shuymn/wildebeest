import process from 'node:process'

import { chromium } from 'playwright-core'

const BASE_URL = 'https://docs.joinmastodon.org'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.goto(BASE_URL)

const hrefs = await page.$$eval('body > div > nav > ul > li:nth-child(8) > ul a', (anchors) => {
	return anchors.map((anchor) => anchor.getAttribute('href'))
})

const csv = [['Protocol', 'Method', 'Endpoint', 'Description', 'Document']]

for (const href of hrefs) {
	const header = ['/filters'].includes(href) ? 'h3' : 'h2'
	await page.goto(new URL(href, BASE_URL).toString())

	const ids = await page.$$eval(`${header}.heading`, (headings) => {
		return headings.filter((heading) => heading.id !== 'see-also').map((heading) => heading.id)
	})

	for (const id of ids) {
		const skip = await page.$eval(`${header}#${id} + *`, (el) => !el.classList.contains('highlight'))
		if (skip) {
			continue
		}

		const desc = await page.$eval(`${header}#${id} > span.heading__text`, (span) => {
			return span.textContent
		})
		const doc = await page.$eval(`${header}#${id} > a.heading__anchor-link`, (anchor) => {
			return anchor.href
		})
		const [method, endpoint, protocol] = await page.$eval(`${header}#${id} + *`, (el) => {
			return el.innerText.trim().split(' ')
		})
		csv.push([protocol, method, endpoint, desc, doc])
	}
}

process.stdout.write(csv.map((row) => row.join(',')).join('\n'))

await browser.close()
