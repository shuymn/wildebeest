import { sniffImageType } from './image-bytes'
import type { ImageInfo, ProcessedImage } from './images'

// The image limits of a local custom emoji (MEDIA-3, MEDIA-4, RES-1), shared by the upload (mastodon/emoji-upload.ts)
// and the media rebuild (mastodon/media-rebuild.ts), so a restored emoji meets what an uploaded one met. Migration
// 0055_local_custom_emojis repeats EMOJI_EDGE_LIMIT and the served types (test/migrations.test.ts compares them).
//
// Mastodon accepts a local emoji below CustomEmoji::LIMIT, 256 KiB, as PNG, GIF or WebP (app/models/custom_emoji.rb:27,
// 39, 49) and downloads a remote one within the same limit (remotable_attachment :image, LIMIT, :60), so a served
// `full` of 262,144 bytes or more never installs on a Mastodon peer: the published file is held below it too.

// Input and published `full`, in bytes: strictly below this.
export const EMOJI_IMAGE_LIMIT = 262_144
// Both edges of the input and of the published image, in pixels: at most this.
export const EMOJI_EDGE_LIMIT = 1024
// The preview (`small`), in bytes: at most this. It is never published in the API or ActivityPub.
export const EMOJI_PREVIEW_LIMIT = 524_288
// Input types, by signature (sniffImageType). PNG is served as PNG, GIF and WebP as WebP (platform/images.ts).
export const EMOJI_INPUT_TYPES: readonly string[] = ['image/png', 'image/gif', 'image/webp']
// What an emoji image is served as.
export const EMOJI_SERVED_TYPES: readonly string[] = ['image/png', 'image/webp']

export type EmojiImageProblem = 'image-too-large' | 'invalid-image'

// Why `bytes`, read by the free info() as `info`, is not an emoji input: past EMOJI_IMAGE_LIMIT, not an input type by
// signature, read as another type, without dimensions, or an edge past EMOJI_EDGE_LIMIT. null when it is one.
export function emojiInputProblem(bytes: Uint8Array, info: ImageInfo): EmojiImageProblem | null {
	const type = sniffImageType(bytes)
	const preflight = emojiInputSizeProblem(bytes.length, type)
	if (preflight !== null || info.format !== type) {
		return preflight ?? 'invalid-image'
	}
	if (!validEdge(info.width) || !validEdge(info.height)) {
		return info.width === undefined || info.height === undefined ? 'invalid-image' : 'image-too-large'
	}
	return null
}

function validEdge(edge: number | undefined): boolean {
	return edge !== undefined && Number.isInteger(edge) && edge >= 1 && edge <= EMOJI_EDGE_LIMIT
}

// The size preflight of an input before its body is read (the media rebuild's dry run and its original's size):
// whether `size` bytes and the type its signature names may be an emoji input.
export function emojiInputSizeProblem(size: number, type: string | null): EmojiImageProblem | null {
	if (size >= EMOJI_IMAGE_LIMIT) {
		return 'image-too-large'
	}
	return type === null || !EMOJI_INPUT_TYPES.includes(type) ? 'invalid-image' : null
}

// Why the re-encoded files of an emoji may not be published: `full` of EMOJI_IMAGE_LIMIT bytes or more, `small` past
// EMOJI_PREVIEW_LIMIT, a served type that is not PNG or WebP, or an edge of `full` past EMOJI_EDGE_LIMIT. null when
// they may be.
export function emojiOutputProblem(image: Pick<ProcessedImage, 'full' | 'small'>): EmojiImageProblem | null {
	const { full, small } = image
	if (!EMOJI_SERVED_TYPES.includes(full.contentType) || small.contentType !== full.contentType) {
		return 'invalid-image'
	}
	const sizes = emojiFilesProblem({ full: full.bytes.length, small: small.bytes.length })
	if (sizes !== null) {
		return sizes
	}
	return validEdge(full.width) && validEdge(full.height) ? null : 'image-too-large'
}

// Whether existing served files of `sizes` bytes may stay published (the media rebuild's check of an emoji whose files
// exist): `full` below EMOJI_IMAGE_LIMIT and `small` within EMOJI_PREVIEW_LIMIT.
export function emojiFilesProblem(sizes: { full: number; small: number }): EmojiImageProblem | null {
	return sizes.full >= EMOJI_IMAGE_LIMIT || sizes.small > EMOJI_PREVIEW_LIMIT ? 'image-too-large' : null
}
