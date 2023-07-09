import { APObject } from 'wildebeest/backend/src/activitypub/objects'
import { RequiredProps } from 'wildebeest/backend/src/utils/type'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-video
export type Video = RequiredProps<APObject, 'url'> & { type: 'Video' }

export function isVideo(object: APObject): object is Video {
	return object.type === 'Video'
}
