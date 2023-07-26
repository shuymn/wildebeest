import { cors } from 'wildebeest/backend/src/utils'

const headers = {
	...cors(),
	'content-type': 'application/json; charset=utf-8',
}

// TODO: implement
export const onRequestGet = async () => {
	return new Response(JSON.stringify([]), { headers })
}
