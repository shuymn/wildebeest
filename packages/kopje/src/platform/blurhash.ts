import { encode } from 'blurhash'

import { storedBlurhash } from './stored-bounds'

// The blurhash of a card image (federation/card-images.ts) or of a local upload's preview (images.ts processImage) from
// its pixels as Images outputs them in RGBA (images.ts encodeRgba), as Mastodon's BlurhashTranscoder computes one
// (lib/paperclip/blurhash_transcoder.rb:6-12, 21-24, v4.5.11): the image fitted within BLURHASH_EDGE pixels, its RGB
// (alpha dropped: woltapp's encoder reads only R, G and B), BLURHASH_COMPONENTS × BLURHASH_COMPONENTS components, by
// woltapp's reference encoder (the blurhash package, pinned). Declared deviations (docs/mastodon-deviations.md, "Link
// previews" and "Media"): the fit averages each target pixel's box of source pixels where vips resamples.

// Row-major pixels, 4 bytes each (R, G, B, alpha).
export type Rgba = { data: Uint8ClampedArray; width: number; height: number }

export const BLURHASH_EDGE = 100
const BLURHASH_COMPONENTS = 4

// The image fitted within `edge` pixels: each target pixel the mean of its box of source pixels (every source pixel in
// exactly one box, and each box at least one pixel wide and high, as the target is no larger than the source). The
// image itself when it fits. At most edge × edge × 4 bytes.
export function fitRgba(image: Rgba, edge = BLURHASH_EDGE): Rgba {
	const { width, height, data } = image
	const scale = Math.min(1, edge / Math.max(width, height))
	if (scale === 1) {
		return image
	}
	const w = Math.max(1, Math.round(width * scale))
	const h = Math.max(1, Math.round(height * scale))
	const out = new Uint8ClampedArray(w * h * 4)
	const box = (i: number, from: number, to: number) => [Math.floor((i * from) / to), Math.floor(((i + 1) * from) / to)]
	for (let y = 0; y < h; y++) {
		const [y0 = 0, y1 = 0] = box(y, height, h)
		for (let x = 0; x < w; x++) {
			const [x0 = 0, x1 = 0] = box(x, width, w)
			const sums = [0, 0, 0, 0]
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const at = (sy * width + sx) * 4
					for (let c = 0; c < 4; c++) {
						sums[c]! += data[at + c] ?? 0
					}
				}
			}
			const n = (y1 - y0) * (x1 - x0)
			for (let c = 0; c < 4; c++) {
				out[(y * w + x) * 4 + c] = Math.round(sums[c]! / n)
			}
		}
	}
	return { data: out, width: w, height: h }
}

// The blurhash of `image` as stored (storedBlurhash), or null when the encoder fails or its output would not be kept.
export function imageBlurhash(image: Rgba): string | null {
	try {
		const fitted = fitRgba(image)
		return storedBlurhash(encode(fitted.data, fitted.width, fitted.height, BLURHASH_COMPONENTS, BLURHASH_COMPONENTS))
	} catch {
		return null
	}
}
