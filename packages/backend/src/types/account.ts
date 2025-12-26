// https://docs.joinmastodon.org/entities/Account/
// https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Account.java
export interface MastodonAccount {
	id: string
	username: string
	acct: string
	url: string
	display_name: string
	note: string
	avatar: string
	avatar_static: string
	header: string
	header_static: string
	locked: boolean
	fields: Array<Field>
	emojis: Array<CustomEmoji>
	bot: boolean
	group: boolean
	discoverable: boolean | null
	noindex?: boolean | null
	moved?: MastodonAccount | null
	suspended?: boolean
	limited?: boolean
	created_at: string
	last_status_at: string | null
	statuses_count: number
	followers_count: number
	following_count: number
}

// https://docs.joinmastodon.org/entities/Relationship/
// https://github.com/mastodon/mastodon-android/blob/master/mastodon/src/main/java/org/joinmastodon/android/model/Relationship.java
export type Relationship = {
	id: string
	following: boolean
	showing_reblogs: boolean
	notifying: boolean
	languages?: string[]
	followed_by: boolean
	blocking: boolean
	blocked_by: boolean
	muting: boolean
	muting_notifications: boolean
	requested: boolean
	domain_blocking: boolean
	endorsed: boolean
	note: string
}

export type Privacy = 'public' | 'unlisted' | 'private' | 'direct'

// https://docs.joinmastodon.org/entities/Account/#CredentialAccount
export interface CredentialAccount extends MastodonAccount {
	source: {
		note: string
		fields: Array<Field>
		privacy: Privacy
		sensitive: boolean
		language: string
		follow_requests_count: number
	}
	role: Role
}

// https://docs.joinmastodon.org/entities/Role/
export type Role = {
	id: string
	name: string
	color: string
	position: number
	// https://docs.joinmastodon.org/entities/Role/#permission-flags
	permissions: number
	highlighted: boolean
	created_at: string
	updated_at: string
}

export type Field = {
	name: string
	value: string
	verified_at?: string
}

export type ReadingExpandMedia = 'default' | 'show_all' | 'hide_all'

export type Preference = {
	posting_default_visibility: Privacy
	posting_default_sensitive: boolean
	posting_default_language: string | null
	reading_expand_media: ReadingExpandMedia
	reading_expand_spoilers: boolean
}

export type CustomEmoji = {
	shortcode: string
	url: string
	static_url: string
	visible_in_picker: boolean
	category: string
}
