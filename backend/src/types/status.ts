import type { MastodonId } from 'wildebeest/backend/src/types'

import type { CustomEmoji, MastodonAccount } from './account'
import type { MediaAttachment } from './media'

export type Visibility = 'public' | 'unlisted' | 'private' | 'direct'

type Mention = {
	id: string
	username: string
	url: string
	acct: string
}

type Tag = {
	name: string
	url: string
}

// https://docs.joinmastodon.org/entities/Poll/
type Poll = {
	id: string
	expires_at: string | null
	expired: boolean
	votes_count: number
	options: PollOption[]
	emojis: CustomEmoji[]
	voted?: boolean
	own_votes?: number[]
} & ({ multiple: true; voters_count: number } | { multiple: false; voters_count: null })

type PollOption = {
	title: string
	votes_count: number | null
}

// https://docs.joinmastodon.org/entities/PreviewCard/
type PreviewCard = {
	url: URL
	title: string
	description: string
	type: 'link' | 'photo' | 'video' | 'rich'
	author_name: string
	author_url: URL
	provider_name: string
	provider_url: URL
	html: string
	width: number
	height: number
	image: URL | null
	embed_url: URL
	blurhash: string | null
}

// https://docs.joinmastodon.org/entities/FilterResult/
type FilterResult = {
	filter: Filter
	keyword_matches: string[] | null
	status_matches: string[] | null
}

// https://docs.joinmastodon.org/entities/Filter/
type Filter = {
	id: string
	title: string
	context: 'home' | 'notifications' | 'public' | 'thread' | 'account'
	expires_at: string | null
	filter_action: 'warn' | 'hide'
	keywords: FilterKeyword[]
	statuses: FilterStatus[]
}

// https://docs.joinmastodon.org/entities/FilterKeyword/
type FilterKeyword = {
	id: string
	keyword: string
	whole_word: boolean
}

// https://docs.joinmastodon.org/entities/FilterStatus/
type FilterStatus = {
	id: string
	status_id: string
}

// https://docs.joinmastodon.org/entities/Status/
// https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Status.java
export type MastodonStatus = {
	id: MastodonId
	uri: URL
	created_at: string
	account: MastodonAccount
	content: string
	visibility: Visibility
	sensitive: boolean
	spoiler_text: string
	media_attachments: MediaAttachment[]
	application?: {
		name: string
		website: URL | null
	}
	mentions: Mention[]
	tags: Tag[]
	emojis: CustomEmoji[]
	reblogs_count: number
	favourites_count: number
	replies_count: number
	url: URL | null
	in_reply_to_id: string | null
	in_reply_to_account_id: string | null
	reblog: MastodonStatus | null
	poll: Poll | null
	card: PreviewCard | null
	language: string | null
	text: string | null
	edited_at: string | null
	favourited?: boolean
	reblogged?: boolean
	muted?: boolean
	bookmarked?: boolean
	pinned?: boolean
	filtered?: FilterResult[]
}

// https://docs.joinmastodon.org/entities/Context/
export type Context = {
	ancestors: MastodonStatus[]
	descendants: MastodonStatus[]
}
