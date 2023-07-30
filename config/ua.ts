import { MASTODON_API_VERSION, WILDEBEEST_VERSION } from 'wildebeest/config/versions'

export function getFederationUA(domain: string): string {
	return `Wildebeest/${WILDEBEEST_VERSION} (Mastodon/${MASTODON_API_VERSION}; +${domain})`
}

export const UA = `Wildebeest/${WILDEBEEST_VERSION} (Mastodon/${MASTODON_API_VERSION})`
