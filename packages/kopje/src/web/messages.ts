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
		// A page request the Store cannot serve (503, its Retry-After unchanged) and an unexpected failure (500).
		unavailableTitle: string
		unavailable: string
		serverErrorTitle: string
		serverError: string
		// An error page's way on beside its chrome: the same URL again (500 and 503).
		retry: string
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
		// The profile's counts: the word after each number, lowercase (12 followers).
		units: Record<'posts' | 'following' | 'followers', (n: number) => string>
		noPosts: string
		// The follow lists: their titles, the line of an empty list, and the line of an account that hides its lists
		// (its name is markup, its custom emoji).
		followersTitle: (name: string, address: string) => string
		followingTitle: (name: string, address: string) => string
		noFollowers: string
		noFollowing: string
		hidesList: (name: Child) => Child
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
	}
	post: {
		inReplyTo: string
		sensitiveMedia: string
		show: string
		hide: string
		edited: string
		viewOn: (domain: string) => string
		// A post of a list too large to show beside the rest of its page (design §2): why it is not shown, and a link to
		// it.
		tooLarge: string
		open: string
		// The line of a status page's tab with nothing to show: its replies, boosts, favourites or quotes. Replies
		// counted but none shown here are on other servers.
		noReplies: string
		remoteReplies: string
		noBoosts: string
		noFavourites: string
		noQuotes: string
		// A quote of the page's own post names it in one line rather than nesting it.
		quotingThis: string
		// The focal post's menu of further actions, opening it on another server or embedding it (its button's name).
		share: string
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
		// A list of accounts' pages, newest first: a follow list, the endorsed accounts, a status's boosts and favourites.
		olderAccounts: string
		newerAccounts: string
		// A status's replies' pages, oldest first.
		earlierReplies: string
		laterReplies: string
		// The short labels a narrow pager shows (the full one stays its name): newest first, then oldest first.
		newerShort: string
		olderShort: string
		earlierShort: string
		laterShort: string
	}
	about: {
		about: string
		rules: string
		contactAndDetails: string
		// The contact account, then the contact email.
		contact: string
		email: string
		documents: string
		// The software and its version, as NodeInfo gives them.
		software: string
		version: (version: string) => string
	}
	documents: {
		privacyPolicy: string
		termsOfService: string
		effectiveFrom: string
		lastUpdated: string
	}
	media: {
		// A described attachment's badge, and its name: it shows the description.
		alt: string
		showDescription: string
		// The name of an attachment's link without a description: a file's the page does not play, or an image's
		// (hidden text, as no marker shows a missing description).
		attachment: string
	}
	// A poll: how many took part (voters, or votes when it does not count voters), and whether it has ended.
	poll: {
		people: (n: number) => string
		votes: (n: number) => string
		closed: string
		ends: string
		// An open poll whose counts are hidden until it ends.
		resultsLater: string
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
		notFoundTitle: string
		notFound: string
		lookUpAnother: string
		// Each names the account (profile.title's form).
		followedTitle: string
		// The account named in a sentence is markup (its address in <strong>, part of the sentence's content).
		followed: (account: Child) => Child
		requestedTitle: string
		requested: (account: Child) => Child
		alreadyRequested: (account: Child) => Child
		refusedTitle: string
		refused: (account: Child) => Child
	}
	// Following or interacting from another server (design §8): the profile's Follow and the status's Open on your
	// server, their dialogs and the handoff pages (/@username/interact, /@username/:id/interact).
	remote: {
		follow: string
		// The follow dialog's and page's title: as the page's <title>, and as their heading, where the name is markup
		// (its custom emoji).
		followTitle: (name: string) => string
		followHeading: (name: Child) => Child
		followPrompt: string
		// The status page's Share menu item that opens its dialog.
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
		// The value to search for on another server, by its name, and what to do with it (the field's hint).
		handle: string
		postUrl: string
		searchHandle: string
		searchUrl: string
		continueTo: (host: string) => string
		// The handoff page's link to the viewer's server.
		continue: string
		back: string
		ifLinkFails: string
	}
	// The status page's embed code (design §7.1), as the oEmbed html.
	embed: {
		embed: string
		title: string
		code: string
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
	// /oauth/authorize (app/authorize.tsx): the consent form of a third-party app, the out-of-band code, and the
	// refusals shown on the page. The first-party form is signIn's.
	oauth: {
		title: (app: string) => string
		website: string
		account: string
		scopes: string
		// The permissions an app asks for, in plain language by group, and the warning over admin ones.
		scopeGroups: Record<'read' | 'write' | 'follow' | 'push' | 'admin', string>
		// The same groups by one word each, as settings' authorized apps list them.
		scopeNames: Record<'read' | 'write' | 'follow' | 'push' | 'admin', string>
		admin: string
		// The scopes' own names, behind a disclosure.
		technicalScopes: string
		approve: string
		deny: string
		codeTitle: string
		code: string
		codePrompt: string
		// An error answered on the page for the out-of-band redirect URI: RFC 6749's error code and what went wrong
		// (one of `problems`).
		failedTitle: string
		failed: (error: string, problem: string) => string
		problems: {
			missingResponseType: string
			unsupportedResponseType: string
			unsupportedResponseMode: string
			invalidScope: string
			unsupportedChallenge: string
			repeated: (parameter: string) => string
			longState: string
		}
		notSetUpTitle: string
		notSetUp: string
		accessDeniedTitle: string
		accessDenied: string
		unknownAppTitle: string
		unknownApp: string
		invalidRequestTitle: string
		unregisteredRedirect: string
		foreignForm: string
		changed: string
		noAccountTitle: string
		noAccount: string
		suspendedTitle: string
		suspended: string
		ambiguousAccountTitle: string
		ambiguousAccount: string
		deniedTitle: string
		denied: string
	}
	settings: {
		title: string
		viewProfile: string
		// The account's address, read-only (an account does not move, docs/mastodon-deviations.md).
		address: string
		backToSettings: string
		profile: string
		displayName: string
		bio: string
		fields: string
		fieldName: string
		fieldValue: string
		locked: string
		lockedHint: string
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
