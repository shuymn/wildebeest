import type { Document, ApObject } from 'wildebeest/backend/src/activitypub/objects'
import { isDocument, mastodonIdSymbol } from 'wildebeest/backend/src/activitypub/objects'
import { type Image, isImage } from 'wildebeest/backend/src/activitypub/objects/image'
import { isVideo, Video } from 'wildebeest/backend/src/activitypub/objects/video'
import type { MediaAttachment } from 'wildebeest/backend/src/types/media'

export function fromObject(obj: ApObject): MediaAttachment {
	if (isImage(obj)) {
		return fromObjectImage(obj)
	}
	if (isVideo(obj)) {
		return fromObjectVideo(obj)
	}
	if (isDocument(obj)) {
		return fromObjectDocument(obj)
	}
	throw new Error(`unsupported media type ${obj.type}: ${JSON.stringify(obj)}`)
}

const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']

export function fromObjectDocument(obj: Document): MediaAttachment {
	if (obj.mediaType !== undefined) {
		if (imageTypes.includes(obj.mediaType)) {
			return fromObjectImage({ ...obj, type: 'Image' })
		} else if (obj.mediaType === 'video/mp4') {
			return fromObjectVideo({ ...obj, type: 'Video' })
		}
	}
	throw new Error(`unsupported media Document type: ${JSON.stringify(obj)}`)
}

function fromObjectImage(obj: Image): MediaAttachment {
	return {
		url: new URL(obj.url),
		id: obj[mastodonIdSymbol] || obj.url.toString(),
		preview_url: new URL(obj.url),
		type: 'image',
		meta: {
			original: {
				width: 640,
				height: 480,
				size: '640x480',
				aspect: 1.3333333333333333,
			},
			small: {
				width: 461,
				height: 346,
				size: '461x346',
				aspect: 1.3323699421965318,
			},
			focus: {
				x: -0.27,
				y: 0.51,
			},
		},
		description: obj.description || '',
		blurhash: 'UFBWY:8_0Jxv4mx]t8t64.%M-:IUWGWAt6M}',
	}
}

function fromObjectVideo(obj: Video): MediaAttachment {
	return {
		url: new URL(obj.url),
		preview_url: new URL(obj.url),
		id: obj.url.toString(),
		type: 'video',
		meta: {
			length: '0:01:28.65',
			duration: 88.65,
			fps: 24,
			size: '1280x720',
			width: 1280,
			height: 720,
			aspect: 1.7777777777777777,
			audio_encode: 'aac (LC) (mp4a / 0x6134706D)',
			audio_bitrate: '44100 Hz',
			audio_channels: 'stereo',
			original: {
				width: 1280,
				height: 720,
				frame_rate: '6159375/249269',
				duration: 88.654,
				bitrate: 862056,
			},
			small: {
				width: 400,
				height: 225,
				size: '400x225',
				aspect: 1.7777777777777777,
			},
		},
		description: 'test media description',
		blurhash: 'UFBWY:8_0Jxv4mx]t8t64.%M-:IUWGWAt6M}',
	}
}
