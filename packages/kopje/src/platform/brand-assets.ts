// Kopje's images, shipped as static assets (public/assets) under stable names and revalidated, not immutable
// (docs/web-pages.md). A changed icon takes a new file name, because browsers keep favicons in a cache of their own.

// The plain defaults for accounts without an avatar or header, and the instance thumbnail (no upload sets one).
export const DEFAULT_AVATAR = '/assets/avatar.jpg'
export const DEFAULT_HEADER = '/assets/header.jpg'
export const DEFAULT_THUMBNAIL = '/assets/thumbnail.jpg'

// The icons every page head links (the .ico holds 16, 32 and 48 px).
export const FAVICON = '/assets/favicon.ico'
export const FAVICON_192 = '/assets/favicon-192.png'
export const APPLE_TOUCH_ICON = '/assets/apple-touch-icon.png'

// The icon sizes /api/v2/instance lists (Mastodon lists nine, 36 to 512 px; docs/mastodon-deviations.md).
export const INSTANCE_ICONS = [
	{ path: '/assets/favicon-48.png', size: '48x48' },
	{ path: FAVICON_192, size: '192x192' },
	{ path: '/assets/favicon-512.png', size: '512x512' },
] as const
