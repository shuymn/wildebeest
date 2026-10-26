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
		openOn: (host: string) => string
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
		// The tabs: Posts is `posts`.
		postsAndReplies: string
		media: string
	}
	tag: {
		// A hashtag page's title and heading, from the hashtag's name.
		title: (name: string) => string
		noPosts: string
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
		// The labels of a feed's pinned post and of a boost, naming the booster.
		pinned: string
		boosted: (name: string) => string
	}
	counts: {
		replies: (n: number) => string
		boosts: (n: number) => string
		favourites: (n: number) => string
		quotes: (n: number) => string
	}
	pager: {
		older: string
		newer: string
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
