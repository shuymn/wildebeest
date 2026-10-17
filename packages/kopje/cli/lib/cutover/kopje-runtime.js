// Kopje's own functions the cutover tools share with the Worker: the HTML, bio and content sanitizers and the bounds
// of status text (src/security/html.ts), the search text (src/domain/search-text.ts), hashtag names (src/domain/tag-name.ts), an
// object's language
// (src/domain/language.ts), the image signature check (src/platform/image-bytes.ts), the domain of a domain block
// (src/platform/domain-name.ts) and the conversations of the direct statuses stored (src/domain/conversation-rows.ts,
// the backfill of migration 0009_conversations). A repository checkout runs them from the sources; the npm package, which ships no
// sources, runs the same code from dist/maintenance-render.js, which re-exports them (src/maintenance-render.ts).

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {typeof import('../../../src/security/html.ts') & typeof import('../../../src/domain/search-text.ts')
 *   & typeof import('../../../src/domain/tag-name.ts') & typeof import('../../../src/domain/language.ts')
 *   & typeof import('../../../src/platform/image-bytes.ts') & typeof import('../../../src/platform/domain-name.ts')
 *   & typeof import('../../../src/domain/conversation-rows.ts') & { renderMaintenanceSnapshot?: unknown }} KopjeRuntime
 */

const fromSources = existsSync(fileURLToPath(new URL('../../../src/security/html.ts', import.meta.url)))

/** @type {KopjeRuntime} */
const runtime = fromSources
	? {
			...(await import('../../../src/security/html.ts')),
			...(await import('../../../src/domain/search-text.ts')),
			...(await import('../../../src/domain/tag-name.ts')),
			...(await import('../../../src/domain/language.ts')),
			...(await import('../../../src/platform/image-bytes.ts')),
			...(await import('../../../src/platform/domain-name.ts')),
			...(await import('../../../src/domain/conversation-rows.ts')),
		}
	: /** @type {KopjeRuntime} */ (await import(new URL('../../../dist/maintenance-render.js', import.meta.url).href))

export const {
	sanitizeRemoteHtml,
	sanitizeRemoteBio,
	sanitizeRemoteContent,
	cutJsonString,
	jsonStringBytes,
	REMOTE_BIO_BYTES,
	STATUS_CONTENT_BYTES,
	SPOILER_BYTES,
	remoteHtmlText,
	normalizeSearchText,
	normalizeTag,
	hashtagObjectName,
	languageOf,
	REMOTE_HTML_RAW_LIMIT,
	sniffImageType,
	blockedDomain,
	backfillConversations,
} = runtime
