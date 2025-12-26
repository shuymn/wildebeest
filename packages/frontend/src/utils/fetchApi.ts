import { parse } from 'cookie'

const UI_CLIENT_ID = '924801be-d211-495d-8cac-e73503413af8'

export const fetchApi = async (baseReq: Request, baseUrl: URL, path: string) => {
	const cookie = parse(baseReq.headers.get('Cookie') || '')
	const jwt = cookie['CF_Authorization']

	const url = new URL(path, baseUrl.origin)
	const req = jwt ? new Request(url, { headers: { Authorization: `Bearer ${UI_CLIENT_ID}.${jwt}` } }) : new Request(url)
	return fetch(req)
}
