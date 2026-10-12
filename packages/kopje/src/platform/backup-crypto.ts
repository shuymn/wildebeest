import { Encrypter } from 'age-encryption'

// age encryption for backups (DATA-4), by typage (age-encryption): every byte that leaves for the backup bucket passes
// through here first. Kopje implements no cryptography of its own; it only chooses the recipients.

function encrypter(recipients: readonly string[]): Encrypter {
	if (recipients.length === 0) {
		throw new Error('no backup recipient')
	}
	const e = new Encrypter()
	for (const recipient of recipients) {
		e.addRecipient(recipient)
	}
	return e
}

export function encryptBytes(recipients: readonly string[], bytes: Uint8Array): Promise<Uint8Array> {
	return encrypter(recipients).encrypt(bytes)
}

// Encrypts a stream as it is read. The age STREAM state lives inside typage and cannot be saved, so an interrupted
// stream is restarted from the beginning, never continued.
export function encryptStream(
	recipients: readonly string[],
	plaintext: ReadableStream<Uint8Array>
): Promise<ReadableStream<Uint8Array>> {
	return encrypter(recipients).encrypt(plaintext)
}

export function toHex(buffer: ArrayBuffer | Uint8Array): string {
	return Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), (b) =>
		b.toString(16).padStart(2, '0')
	).join('')
}

export async function sha256Of(bytes: Uint8Array): Promise<string> {
	return toHex(await crypto.subtle.digest('SHA-256', bytes))
}
