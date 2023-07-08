import { MastodonAccount } from './account'

// https://docs.joinmastodon.org/entities/V1_Instance/
export type InstanceConfig = {
	uri: string
	title: string
	short_description: string
	description: string
	email: string
	version: string
	urls: {
		// TODO: implement streaming
		// streaming_api: string
	}
	stats: {
		user_count: number
		status_count: number
		domain_count: number
	}
	thumbnail: string
	languages: Array<string>
	registrations: boolean
	approval_required: boolean
	invites_enabled: boolean
	configuration: {
		accounts: {
			max_featured_tags: number
		}
		statuses: {
			max_characters: number
			max_media_attachments: number
			characters_reserved_per_url: number
		}
		media_attachments: {
			supported_mime_types: Array<string>
			image_size_limit: number
			image_matrix_limit: number
			video_size_limit: number
			video_frame_rate_limit: number
			video_matrix_limit: number
		}
		polls: {
			max_options: number
			max_characters_per_option: number
			min_expiration: number
			max_expiration: number
		}
	}
	contact_account: MastodonAccount | null
	rules: Array<Rule>
}

// https://docs.joinmastodon.org/entities/Instance/
export type InstanceConfigV2 = {
	domain: string
	title: string
	version: string
	source_url: string
	description: string
	usage: {
		users: {
			active_month: number
		}
	}
	thumbnail: {
		url: string
		blurhash?: string
		versions?: {
			'@1x'?: string
			'@2x'?: string
		}
	}
	languages: Array<string>
	configuration: {
		urls: {
			// TODO: implement streaming
			// streaming: string
		}
		accounts: {
			max_featured_tags: number
		}
		statuses: {
			max_characters: number
			max_media_attachments: number
			characters_reserved_per_url: number
		}
		media_attachments: {
			supported_mime_types: Array<string>
			image_size_limit: number
			image_matrix_limit: number
			video_size_limit: number
			video_frame_rate_limit: number
			video_matrix_limit: number
		}
		polls: {
			max_options: number
			max_characters_per_option: number
			min_expiration: number
			max_expiration: number
		}
		translation: {
			enabled: boolean
		}
	}
	registrations: {
		enabled: boolean
		approval_required: boolean
		message: string | null
	}
	contact: {
		email: string
		account: MastodonAccount | null
	}
	rules: Array<Rule>
}

// https://docs.joinmastodon.org/entities/Rule/
export type Rule = {
	id: string
	text: string
}

export type DefaultImages = {
	avatar: string
	header: string
}
