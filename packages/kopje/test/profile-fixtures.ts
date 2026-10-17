import { MAX_REMOTE_FIELDS } from '../src/domain/accounts'
import { sanitizeRemoteBio } from '../src/security/html'

// Remote profile parts at their bounds (RES-2), shared by the answer-size tests.

// One profile field of an actor document.
export const field = (name: string, value: string) => ({ type: 'PropertyValue', name, value })

// A bio of REMOTE_BIO_BYTES as a JSON string: control characters that escape to six bytes, among links the sanitizer
// grows.
export const MAX_BIO = sanitizeRemoteBio(`<p>${'\u0001"<a>x</a>'.repeat(20_000)}</p>`)

// MAX_REMOTE_FIELDS fields of names and values at their read bounds, about REMOTE_FIELDS_BYTES of JSON.
export const maxFields = () => Array.from({ length: MAX_REMOTE_FIELDS }, () => field('n'.repeat(255), 'v'.repeat(4096)))
