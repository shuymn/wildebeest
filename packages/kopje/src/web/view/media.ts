import type { MediaAttachment } from '../../domain/status-presenter'
import { httpUrl } from '../../platform/http-url'

// A media attachment as the pages show it (design §11). `alt` is the attachment's description, or '' when it has none
// (the page then shows a visible "No description" marker). Sizes come from the small variant when it has them.
export type MediaView = { type: string; full: string; preview: string; alt: string; width?: number; height?: number }

export function mediaView(media: MediaAttachment): MediaView | null {
	const full = httpUrl(media.url)?.href
	const preview = httpUrl(media.preview_url)?.href ?? full
	if (full === undefined || preview === undefined) {
		return null
	}
	const size = media.meta?.small
	return {
		type: media.type,
		full,
		preview,
		alt: media.description ?? '',
		...(size === undefined ? {} : { width: size.width, height: size.height }),
	}
}
