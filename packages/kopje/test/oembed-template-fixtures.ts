import { OEMBED_TEMPLATE_BYTES } from '../src/platform/stored-bounds'

// Cached oEmbed endpoint templates and whether the stored rule accepts them (stored-bounds.ts oembedTemplatePastSql
// and isOembedTemplate), in its order: the bytes, NUL, https, printable ASCII, the excluded characters, a placeholder
// after an =, and no brace outside one. Shared by the SQL/JS comparison (test/card-oembed.test.ts) and the triggers
// of migration 0069 (test/migrations.test.ts).
const BASE = 'https://p.example/o?url={url}'

export const TEMPLATE_FIXTURES: readonly (readonly [string, boolean])[] = [
	[BASE, true],
	['https://p.example/o?a={url}&b={url}', true],
	['https://p.example/o?url={url}&x=1', true],
	['https://={url}', true],
	[`https://p.example/${'={url}'.repeat(300)}`, true],
	// The bytes: 1 to OEMBED_TEMPLATE_BYTES.
	['', false],
	[`${BASE}&${'a'.repeat(OEMBED_TEMPLATE_BYTES - BASE.length - 1)}`, true],
	[`${BASE}&${'a'.repeat(OEMBED_TEMPLATE_BYTES - BASE.length)}`, false],
	// NUL, alone or before more text.
	[`${BASE}\u0000`, false],
	[`${BASE}\u0000junk`, false],
	// The scheme: https, lowercase, with something after it.
	['h', false],
	['https://', false],
	['http://p.example/o?url={url}', false],
	['HTTPS://p.example/o?url={url}', false],
	['ftp://p.example/o?url={url}', false],
	// Printable ASCII only.
	[`${BASE}\u007f`, false],
	[`${BASE}\u0085`, false],
	[`${BASE}é`, false],
	[`${BASE}\u{1f600}`, false],
	[`${BASE}\ud800`, false],
	[`${BASE} `, false],
	[`${BASE}\t`, false],
	// The characters that end or split an attribute or a URL, and the punctuation a URL may hold.
	...[...'"<>\\^`|'].map((c): readonly [string, boolean] => [`${BASE}&${c}`, false]),
	...[..."'!#$%()*+,-./:;=?@[]_~"].map((c): readonly [string, boolean] => [`${BASE}&${c}`, true]),
	// A placeholder after an =, and no other brace.
	['https://x', false],
	['https://p.example/{url}', false],
	['https://p.example/o?url=x', false],
	['https://p.example/o?url={uri}', false],
	['https://p.example/o?url{url}', false],
	['https://p.example/o?url={ url}', false],
	['https://p.example/o?url={url}}', false],
	['https://p.example/o?url={{url}', false],
	['https://p.example/o?url={url}&{', false],
	['https://p.example/o?url={url}&}', false],
]
