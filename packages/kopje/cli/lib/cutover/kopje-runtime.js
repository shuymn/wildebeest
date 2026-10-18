// Worker code the cutover tools share (the modules in KopjeRuntime below); conversation-rows.ts is the backfill of
// migration 0009_conversations. A repository checkout loads the sources; the npm package, which ships no sources,
// loads the same exports from dist/maintenance-render.js (src/maintenance-render.ts).

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {typeof import('../../../src/security/html.ts') & typeof import('../../../src/domain/search-text.ts')
 *   & typeof import('../../../src/domain/tag-name.ts') & typeof import('../../../src/domain/language.ts')
 *   & typeof import('../../../src/platform/image-bytes.ts') & typeof import('../../../src/platform/domain-name.ts')
 *   & typeof import('../../../src/domain/conversation-rows.ts')
 *   & typeof import('../../../src/platform/identity-bounds.ts') & typeof import('../../../src/platform/stored-bounds.ts')
 *   & typeof import('../../../src/platform/media-files.ts') & { renderMaintenanceSnapshot?: unknown }} KopjeRuntime
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
			...(await import('../../../src/platform/identity-bounds.ts')),
			...(await import('../../../src/platform/stored-bounds.ts')),
			...(await import('../../../src/platform/media-files.ts')),
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
	ACTOR_URI_LIMIT,
	isRemoteUsername,
	MAX_LOCAL_ADDRESSED,
	isStorableActorId,
	STATUS_URI_LIMIT,
	withinIdentityBound,
	mediaUrl,
	storedDisplayName,
	storedMediaDescription,
	storedMediaLink,
	storedMediaMeta,
	storedMediaUrl,
	storedProfileUrl,
	storedStatusUrl,
	withoutNul,
} = runtime
