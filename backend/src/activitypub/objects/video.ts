import { ApObject } from '@wildebeest/backend/activitypub/objects'
import { RequiredProps } from '@wildebeest/backend/utils/type'

// https://www.w3.org/TR/activitystreams-vocabulary/#dfn-video
export type Video = RequiredProps<ApObject, 'url'> & { type: 'Video' }

export function isVideo(object: ApObject): object is Video {
	return object.type === 'Video'
}
