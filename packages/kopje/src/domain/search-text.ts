// search_text (design §6): plain text, NFKC, lowercase, whitespace collapsed, variation selectors removed. Rows are
// matched with instr; there is no virtual table. Kana and long-vowel variants are expanded on the query side only.

const VARIATION_SELECTORS = /[︀-️]|\uDB40[\uDD00-\uDDEF]/g

export function normalizeSearchText(text: string): string {
	return text.normalize('NFKC').toLowerCase().replace(VARIATION_SELECTORS, '').replace(/\s+/g, ' ').trim()
}

// What an account is found by: its display name and its acct (username, plus @domain for remote accounts).
export function accountSearchText(username: string, domain: string | null, displayName: string): string {
	return normalizeSearchText(`${displayName} ${domain === null ? username : `${username}@${domain}`}`)
}

const MAX_TERMS = 8

// Splits a query into AND terms, each with its OR variants: hiragana and katakana forms of a kana term, and a
// katakana word without its trailing long vowel mark (サーバー also finds サーバ).
export function queryTerms(query: string): string[][] {
	return normalizeSearchText(query)
		.split(' ')
		.filter((term) => term !== '')
		.slice(0, MAX_TERMS)
		.map((term) => {
			const variants = new Set([term, toHiragana(term), toKatakana(term)])
			for (const variant of [...variants]) {
				if (/[ァ-ヺ]ー+$/.test(variant)) {
					variants.add(variant.replace(/ー+$/, ''))
				}
			}
			return [...variants]
		})
}

// A status query: AND terms, and terms prefixed with '-' that must not occur (Mastodon's search syntax). Each term has
// the variants of queryTerms.
export function statusQueryTerms(query: string): { include: string[][]; exclude: string[][] } {
	const include: string[] = []
	const exclude: string[] = []
	for (const term of normalizeSearchText(query).split(' ')) {
		if (term.length > 1 && term.startsWith('-')) {
			exclude.push(term.slice(1))
		} else if (term !== '') {
			include.push(term)
		}
	}
	return { include: queryTerms(include.join(' ')), exclude: queryTerms(exclude.join(' ')) }
}

function toHiragana(text: string): string {
	return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

function toKatakana(text: string): string {
	return text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
}
