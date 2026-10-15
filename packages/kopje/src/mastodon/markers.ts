import { type ApiHandler, authorized, requestParams, storeCall, userCredential } from './context'
import { mastodonError } from './errors'
import { MARKER_TIMELINES, type MarkerTimeline, type MarkerUpdate } from '../domain/markers'

// Timeline markers (Mastodon 4.5's Api::V1::MarkersController); the Store does the work (domain/markers.ts).

function isTimeline(name: string): name is MarkerTimeline {
	return (MARKER_TIMELINES as readonly string[]).includes(name)
}

// GET /api/v1/markers: timeline[] (or a single timeline) names the timelines; other names are ignored.
export const markers: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const input = {
		credential: userCredential(c, deps),
		timelines: [...new Set(p.getAll('timeline'))].filter(isTimeline),
	}
	return c.json(authorized(await storeCall(c, deps, (s, b) => s.getMarkers(b, input))))
}

// POST /api/v1/markers: home[last_read_id] and notifications[last_read_id]. A timeline is named when it is sent as an
// object (home[...]), whatever fields it has; only last_read_id is read (resource_params).
export const saveMarkers: ApiHandler = async (c, deps) => {
	const p = await requestParams(c, deps)
	if (p instanceof Response) {
		return p
	}
	const updates: MarkerUpdate[] = MARKER_TIMELINES.filter((timeline) => p.hasObject(timeline)).map((timeline) => ({
		timeline,
		lastReadId: p.get(`${timeline}[last_read_id]`),
	}))
	const input = { credential: userCredential(c, deps), updates }
	const result = authorized(await storeCall(c, deps, (s, b) => s.saveMarkers(b, input)))
	return result.status === 'ok'
		? c.json(result.markers)
		: mastodonError(422, `Validation failed: ${result.errors.join(', ')}`)
}
