// Kopje's own functions the cutover tools share with the Worker: the HTML sanitizer (src/security/html.ts), the
// search text (src/domain/search-text.ts) and the image signature check (src/platform/image-bytes.ts). A repository checkout runs them from the sources; the npm package, which
// ships no sources, runs the same code from dist/maintenance-render.js, which re-exports them
// (src/maintenance-render.ts).

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {typeof import('../../../src/security/html.ts') & typeof import('../../../src/domain/search-text.ts')
 *   & typeof import('../../../src/platform/image-bytes.ts')
 *   & { renderMaintenanceSnapshot?: unknown }} KopjeRuntime
 */

const fromSources = existsSync(fileURLToPath(new URL('../../../src/security/html.ts', import.meta.url)))

/** @type {KopjeRuntime} */
const runtime = fromSources
	? {
			...(await import('../../../src/security/html.ts')),
			...(await import('../../../src/domain/search-text.ts')),
			...(await import('../../../src/platform/image-bytes.ts')),
		}
	: /** @type {KopjeRuntime} */ (await import(new URL('../../../dist/maintenance-render.js', import.meta.url).href))

export const { sanitizeRemoteHtml, remoteHtmlText, normalizeSearchText, REMOTE_HTML_RAW_LIMIT, sniffImageType } =
	runtime
