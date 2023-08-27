import { parse } from 'cookie'

export const fetchApi = async (baseReq: Request, baseUrl: URL, path: string) => {
	const cookie = parse(baseReq.headers.get('Cookie') || '')
	const jwt = cookie['CF_Authorization']

	const url = new URL(path, baseUrl.origin)
	const req = jwt ? new Request(url, { headers: { Authorization: `Bearer ${jwt}` } }) : new Request(url)
	return fetch(req)
}
