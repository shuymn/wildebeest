// The rules of Kopje's upload path (src/platform/images.ts) that `images-export` and `convert --images` apply, restated
// in plain JS because the CLI cannot load that module on Node. test/cutover-upload-rules.test.ts pins them to it.

// The largest image file, and the most pixels, an upload may have.
export const IMAGE_SIZE_LIMIT = 16 * 1024 * 1024
export const IMAGE_MATRIX_LIMIT = 16_777_216

// The long edge of the served full image and of its preview.
export const FULL_EDGE = 3840
export const SMALL_EDGE = 640

/**
 * The served size within an edge, as processImage sizes it (src/platform/images.ts, fit).
 * @param {{ width: number, height: number }} size
 * @param {number} edge
 */
export function fit(size, edge) {
	const scale = Math.min(1, edge / Math.max(size.width, size.height))
	return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

// A file token as the upload path makes one (randomToken in src/security/tokens.ts: 32 random bytes as base64url).
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
