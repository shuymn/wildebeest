import { type Link, linkTo } from './link'
import type { MediaAttachment } from '../../domain/status-presenter'
import { httpUrl } from '../../platform/http-url'

// A media attachment as the pages show it (design §11, "Media by type"; HTML-3: http(s) URLs only). `kind` is its
// Mastodon type; any other stored type is `unknown`, shown as a link, and the type itself is never written. `preview`
// is the attachment's own preview image, or null when it has none (amendment A3): the presenter stands its url in for
// a missing preview, which for a video or an audio file is no image, so a preview equal to the url is none. `alt` is
// its description, or '' when it has none (the page shows no marker for that). Sizes come from
// the small variant when it has them. `link` opens the file itself (through linkTo: another host's is marked).
export type MediaKind = 'image' | 'video' | 'gifv' | 'audio' | 'unknown'

export type MediaView = {
	kind: MediaKind
	full: string
	link: Link | null
	preview: string | null
	alt: string
	width?: number
	height?: number
}

const KINDS: readonly string[] = ['image', 'video', 'gifv', 'audio'] satisfies MediaKind[]

export function mediaView(media: MediaAttachment, domain: string): MediaView | null {
	const full = httpUrl(media.url)?.href
	if (full === undefined) {
		return null
	}
	const preview = httpUrl(media.preview_url)?.href
	const size = media.meta?.small
	return {
		kind: KINDS.includes(media.type) ? (media.type as MediaKind) : 'unknown',
		full,
		link: linkTo(full, domain),
		preview: preview === undefined || preview === full ? null : preview,
		// A description of only white space is none.
		alt: (media.description ?? '').trim() === '' ? '' : (media.description ?? ''),
		...(size === undefined ? {} : { width: size.width, height: size.height }),
	}
}

// The image a page shows for an attachment: an image's preview, or the image itself without one; a video's poster
// only when it has a preview of its own (A3); none for audio or another type.
export function shownImage(media: MediaView): string | null {
	switch (media.kind) {
		case 'image':
			return media.preview ?? media.full
		case 'video':
		case 'gifv':
			return media.preview
		default:
			return null
	}
}
