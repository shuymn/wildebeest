import { RequestEvent } from '@builder.io/qwik-city'

export const onGet = async ({ redirect }: RequestEvent) => {
	throw redirect(303, '/explore')
}
