import type { Child } from 'hono/jsx'

import type { Visibility } from '../domain/accounts'

// The shape of a web UI catalogue (design §9.1). English is STRINGS (strings.ts); a translation is another value of
// this type, so a missing key is a type error. Text with a number or a name is a function, so each language orders
// and inflects it itself.

export type NoticeMessages = {
	saved: string
	avatar: string
	header: string
	revoked: string
	sessions: string
}

export type Messages = {
	site: {
		// The product name, shown where no instance domain is known yet (/setup) and in the footer.
		product: string
		about: string
		poweredBy: string
	}
	a11y: {
		skipToContent: string
		pages: string
		// The name of the profile's tabs (a nav).
		profileSections: string
		// The name of a follow list's tabs, followers and following (a nav).
		followLists: string
		// The name of a status page's posts above its status (an ol), and of its tabs (a nav).
		thread: string
		statusSections: string
		openOn: (host: string) => string
		// The label of a dialog's close button.
		close: string
	}
	errors: {
		notFoundTitle: string
		notFound: string
		goneTitle: string
		gone: string
		forbiddenTitle: string
		forbidden: string
		invalidFormTitle: string
		invalidForm: string
		uploadFailedTitle: string
	}
	signIn: {
		signIn: string
		signInAs: string
		cancel: string
		signOut: string
		signedOutTitle: string
		signedOut: string
		signInAgain: string
		expiredTitle: string
		expired: string
		cancelledTitle: string
		cancelled: string
		busyTitle: string
		busy: string
		failedTitle: string
		failed: string
	}
	profile: {
		title: (name: string, address: string) => string
		posts: string
		following: string
		followers: string
		noPosts: string
		// The follow lists: their titles, and the line of an empty list.
		followersTitle: (name: string, address: string) => string
		followingTitle: (name: string, address: string) => string
		noFollowers: string
		noFollowing: string
		// The tabs: Posts is `posts`.
		postsAndReplies: string
		media: string
	}
	tag: {
		// A hashtag page's title and heading, from the hashtag's name.
		title: (name: string) => string
		noPosts: string
	}
	// The profile's Featured tab: its featured hashtags, each with its count of posts, and the accounts it endorses.
	featured: {
		tab: string
		hashtags: string
		accounts: string
		posts: (n: number) => string
		noHashtags: string
		noAccounts: string
		// The pages of the endorsed accounts, by account id.
		previous: string
		next: string
	}
	post: {
		inReplyTo: string
		sensitiveMedia: string
		show: string
		hide: string
		edited: string
		viewOn: (domain: string) => string
		// A post of a list too large to show beside the rest of its page (design §2): a link to it.
		open: string
		// The line of a status page's tab with nothing to show: its replies, boosts, favourites or quotes.
		noReplies: string
		noBoosts: string
		noFavourites: string
		noQuotes: string
		// The labels of a feed's pinned post and of a boost, naming the booster.
		pinned: string
		// The booster's name is markup (its custom emoji), placed where the language puts it.
		boosted: (name: Child) => Child
	}
	counts: {
		replies: (n: number) => string
		boosts: (n: number) => string
		favourites: (n: number) => string
		quotes: (n: number) => string
		followers: (n: number) => string
		following: (n: number) => string
	}
	pager: {
		older: string
		newer: string
		// A list of accounts' pages, newest first: a follow list, a status's boosts and favourites.
		olderFollows: string
		newerFollows: string
		// A status's replies' pages, oldest first.
		earlierReplies: string
		laterReplies: string
	}
	about: {
		about: string
		rules: string
		contactAndDocuments: string
		contact: string
		documents: string
	}
	documents: {
		privacyPolicy: string
		termsOfService: string
		effectiveFrom: string
		lastUpdated: string
	}
	media: {
		noDescription: string
		// The link of an attachment of a type the page does not play, without a description.
		attachment: string
	}
	// A poll: how many took part (voters, or votes when it does not count voters), and whether it has ended.
	poll: {
		people: (n: number) => string
		votes: (n: number) => string
		closed: string
		ends: string
	}
	// A status's edit history (design §8): the dialog's title, each version's label, and the one notice that older
	// versions are left out.
	history: {
		title: string
		current: string
		edited: string
		original: string
		olderVersionsLeftOut: (n: number) => string
	}
	// The state of a quote whose quoted post is not shown (design §11, Quote).
	quote: {
		pending: string
		revoked: string
		unavailable: string
	}
	// /authorize_interaction: the look-up form, its result and the outcomes of a follow.
	interact: {
		title: string
		lookUpPrompt: string
		target: string
		targetHint: string
		lookUp: string
		follow: string
		followAuthor: (name: string) => string
		notFoundTitle: string
		notFound: string
		lookUpAnother: string
		// Each names the account (profile.title's form).
		followedTitle: string
		followed: (account: string) => string
		requestedTitle: string
		requested: (account: string) => string
		alreadyRequested: (account: string) => string
		refusedTitle: string
		refused: (account: string) => string
	}
	// Following or interacting from another server (design §8): the profile's Follow and the status's Open on your
	// server, their dialogs and the handoff pages (/@username/interact, /@username/:id/interact).
	remote: {
		follow: string
		followTitle: (name: string) => string
		followPrompt: string
		openOnYourServer: string
		openTitle: string
		openPrompt: string
		server: string
		serverHint: string
		go: string
		// The refusal of a server that is not a domain name.
		invalidServer: string
		// Between the form and the address to search for.
		or: string
		searchHandle: string
		searchUrl: string
		continueTo: (host: string) => string
		back: string
		ifLinkFails: string
	}
	// The status page's embed code (design §7.1), as the oEmbed html.
	embed: {
		embed: string
		title: string
		prompt: string
	}
	// The copy control (design §7.7): the labels of its button, and the results the script writes.
	copy: {
		copyHandle: string
		copyUrl: string
		copyCode: string
		copied: string
		failed: string
	}
	settings: {
		title: string
		backToSettings: string
		profile: string
		displayName: string
		bio: string
		fields: string
		fieldName: string
		fieldValue: string
		locked: string
		discoverable: string
		indexable: string
		hideCollections: string
		defaultVisibility: string
		visibilities: Record<Visibility, string>
		save: string
		avatar: string
		header: string
		avatarFile: string
		headerFile: string
		upload: string
		imageHint: string
		authorizedApps: string
		noApps: string
		authorizedAt: string
		scopes: string
		revoke: string
		sessions: string
		otherSessions: (n: number) => string
		signOutOthers: string
		problemsTitle: string
		notices: NoticeMessages
	}
}
