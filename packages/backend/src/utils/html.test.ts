import { strict as assert } from 'node:assert/strict'

import { escapeHtml, htmlToText, sanitizeHtml, textToHtml } from '@wildebeest/backend/utils/html'

describe('html sanitization', () => {
	test('keeps allowed tags', () => {
		assert.equal(
			sanitizeHtml('<p>hello <strong>world</strong><br/><em>!</em></p>'),
			'<p>hello <strong>world</strong><br /><em>!</em></p>'
		)
		assert.equal(
			sanitizeHtml('<ol start="3" reversed><li value="4">a</li></ol>'),
			'<ol start="3" reversed=""><li value="4">a</li></ol>'
		)
	})

	test('keeps Mastodon style mentions and hashtags', () => {
		const mention =
			'<p><span class="h-card"><a href="https://example.com/@sven" class="u-url mention">@<span>sven</span></a></span> hi <a href="https://example.com/tags/test" class="mention hashtag">#<span>test</span></a></p>'
		assert.equal(
			sanitizeHtml(mention),
			'<p><span class="h-card"><a href="https://example.com/@sven" class="u-url mention" rel="nofollow noopener noreferrer" target="_blank">@<span>sven</span></a></span> hi <a href="https://example.com/tags/test" class="mention hashtag" rel="nofollow noopener noreferrer" target="_blank">#<span>test</span></a></p>'
		)
	})

	test('keeps GoToSocial, Pleroma and Misskey mentions and hashtags', () => {
		const rel = 'rel="nofollow noopener noreferrer" target="_blank"'
		// GoToSocial
		assert.equal(
			sanitizeHtml(
				'<p><span class="h-card"><a href="https://gts.example/@a" class="u-url mention" rel="nofollow noreferrer noopener" target="_blank">@<span>a</span></a></span> <a href="https://gts.example/tags/t" class="mention hashtag" rel="tag nofollow noreferrer noopener" target="_blank">#<span>t</span></a></p>'
			),
			`<p><span class="h-card"><a href="https://gts.example/@a" class="u-url mention" ${rel}>@<span>a</span></a></span> <a href="https://gts.example/tags/t" class="mention hashtag" ${rel}>#<span>t</span></a></p>`
		)
		// Pleroma / Akkoma
		assert.equal(
			sanitizeHtml(
				'<span class="h-card"><a class="u-url mention" data-user="9x" href="https://pl.example/users/a" rel="ugc">@<span>a</span></a></span> <a class="hashtag" data-tag="t" href="https://pl.example/tag/t" rel="tag ugc">#t</a>'
			),
			`<span class="h-card"><a class="u-url mention" href="https://pl.example/users/a" ${rel}>@<span>a</span></a></span> <a class="hashtag" href="https://pl.example/tag/t" ${rel}>#t</a>`
		)
		// Misskey
		assert.equal(
			sanitizeHtml(
				'<p><a href="https://mk.example/@a" class="u-url mention">@a</a> hi<br><a href="https://mk.example/tags/t" rel="tag">#t</a></p>'
			),
			`<p><a href="https://mk.example/@a" class="u-url mention" ${rel}>@a</a> hi<br /><a href="https://mk.example/tags/t" ${rel}>#t</a></p>`
		)
	})

	test('drops unknown classes', () => {
		assert.equal(sanitizeHtml('<span class="bad invisible o-bad">x</span>'), '<span class="invisible">x</span>')
		assert.equal(sanitizeHtml('<span class="bad">x</span>'), '<span>x</span>')
	})

	test('removes event handlers and style attributes', () => {
		assert.equal(sanitizeHtml('<p onclick="alert(1)">x</p>'), '<p>x</p>')
		assert.equal(sanitizeHtml('<p style="position:fixed">x</p>'), '<p>x</p>')
		assert.equal(
			sanitizeHtml('<span onerror="alert(1)" class="invisible">x</span>'),
			'<span class="invisible">x</span>'
		)
		assert.equal(
			sanitizeHtml('<a href="https://a.com" onmouseover="alert(1)">x</a>'),
			'<a href="https://a.com" rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
	})

	test('removes dangerous elements with their contents', () => {
		assert.equal(sanitizeHtml('<p>a</p><script>alert("evil")</script>'), '<p>a</p>')
		assert.equal(sanitizeHtml('<style>body{display:none}</style>hi'), 'hi')
		assert.equal(sanitizeHtml('<svg><script>alert(1)</script></svg>ok'), 'ok')
		assert.equal(sanitizeHtml('<iframe src="https://evil.com"></iframe>ok'), 'ok')
		assert.equal(sanitizeHtml('<math><mtext><script>alert(1)</script></mtext></math>ok'), 'ok')
	})

	test('removes images and other unknown tags but keeps their text', () => {
		assert.equal(sanitizeHtml('<img src="x" onerror="alert(1)">hi'), 'hi')
		assert.equal(sanitizeHtml('<div>hi</div>'), '<p>hi</p>')
	})

	test('rejects non http(s) URLs', () => {
		assert.equal(
			sanitizeHtml('<a href="javascript:alert(1)">x</a>'),
			'<a rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(
			sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>'),
			'<a rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(
			sanitizeHtml('<a href="java\tscript:alert(1)">x</a>'),
			'<a rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(
			sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'),
			'<a rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(
			sanitizeHtml('<a href="mailto:a@b.com">x</a>'),
			'<a rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(
			sanitizeHtml('<a href="/tags/test">x</a>'),
			'<a href="/tags/test" rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
	})

	test('does not allow breaking out of attributes or text', () => {
		assert.equal(
			sanitizeHtml('<a href="https://a.com/&quot;&gt;&lt;script&gt;">x</a>'),
			'<a href="https://a.com/&quot;&gt;&lt;script&gt;" rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
		assert.equal(sanitizeHtml('1 < 2 & 3 > 2'), '1 &lt; 2 &amp; 3 &gt; 2')
		assert.equal(sanitizeHtml('<p>a'), '<p>a</p>')
	})

	test('overrides rel on links', () => {
		assert.equal(
			sanitizeHtml('<a href="https://a.com" rel="dofollow">x</a>'),
			'<a href="https://a.com" rel="nofollow noopener noreferrer" target="_blank">x</a>'
		)
	})
})

describe('htmlToText', () => {
	test('returns the text content', () => {
		assert.equal(htmlToText('hi<br />hey'), 'hi hey')
		assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a b')
		assert.equal(htmlToText('a &amp; b'), 'a & b')
	})

	test('drops scripts entirely', () => {
		assert.equal(htmlToText('<script>alert(1)</script>'), '')
		assert.equal(htmlToText('<img src=x onerror=alert(1)>'), '')
	})
})

describe('textToHtml', () => {
	test('escapes and keeps paragraphs', () => {
		assert.equal(textToHtml('a\nb\n\nc'), '<p>a<br />b</p><p>c</p>')
		assert.equal(textToHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
		assert.equal(textToHtml(''), '')
	})
})

describe('escapeHtml', () => {
	test('escapes the HTML special characters', () => {
		assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
	})
})
