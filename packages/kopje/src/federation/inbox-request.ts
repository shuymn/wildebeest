import { isActivityPubMediaType, parseMediaType } from "../platform/media-type";

// What an inbox request is, before the Store sees it. Shared by the Worker's gate (federation/inbox.ts) and the
// cutover's maintenance worker (src/maintenance-worker.ts), which must refuse and spool exactly the same requests.

export const INBOX_ROUTES = ["/inbox", "/ap/users/:username/inbox", "/actor/inbox"];

const PERSONAL_INBOX = /^\/ap\/users\/([^/]+)\/inbox$/;

// The username a personal inbox path names, as written (Hono does not decode it either), or null for a shared inbox.
export function inboxRecipient(path: string): string | null {
  return PERSONAL_INBOX.exec(path)?.[1] ?? null;
}

export type InboxPrecheck = "ok" | "not-found" | "unsupported-media-type";

// ID-8: the body is declared as ActivityStreams.
export function activityStreamsRequest(request: Request): boolean {
  const media = parseMediaType(request.headers.get("content-type") ?? "");
  return media !== null && isActivityPubMediaType(media);
}

// What can be refused before anything is spooled: a body that is not ActivityStreams (415), and a personal inbox that
// does not name a local account with its exact stored username (404, ID-5). ownerExists answers for the username as
// written.
export async function precheckInboxRequest(
  request: Request,
  ownerExists: (username: string) => Promise<boolean>,
): Promise<InboxPrecheck> {
  if (!activityStreamsRequest(request)) {
    return "unsupported-media-type";
  }
  const username = inboxRecipient(new URL(request.url).pathname);
  if (username === null) {
    return "ok";
  }
  return (await ownerExists(username)) ? "ok" : "not-found";
}

const KEY_ID_LIMIT = 2048;
const CAVAGE_KEY_ID = /(?:^|,)\s*keyId\s*=\s*"([^"]*)"/i;
const RFC9421_KEY_ID = /;\s*keyid\s*=\s*"([^"]*)"/i;

// The key id an HTTP signature names, as a URL: a draft-cavage `Signature` header with keyId, or RFC 9421
// `Signature-Input` and `Signature` with keyid (the first one). null when there is none, it is empty or over
// KEY_ID_LIMIT code units, or it is not a URL.
function signatureKeyUrl(headers: Headers): URL | null {
  const signature = headers.get("signature");
  if (signature === null) {
    return null;
  }
  const input = headers.get("signature-input");
  const keyId = (input === null ? CAVAGE_KEY_ID.exec(signature) : RFC9421_KEY_ID.exec(input))?.[1];
  if (keyId === undefined || keyId.length === 0 || keyId.length > KEY_ID_LIMIT) {
    return null;
  }
  try {
    return new URL(keyId);
  } catch {
    return null;
  }
}

// The key id to look up before verifying (the inbox gate): the URL's href, as Fedify asks its KeyCache, also within
// KEY_ID_LIMIT code units after normalization, else null. Only a hint: Fedify parses the signature itself (portable
// key ids, the last of duplicate keyIds, every RFC 9421 signature), so a different reading costs one key lookup,
// never a wrong key.
export function signatureKeyId(headers: Headers): string | null {
  const href = signatureKeyUrl(headers)?.href ?? null;
  return href !== null && href.length <= KEY_ID_LIMIT ? href : null;
}

// Whether the request carries an HTTP signature naming an https key. Only the shape: replay verifies the signature
// itself.
export function hasSignatureShape(headers: Headers): boolean {
  return signatureKeyUrl(headers)?.protocol === "https:";
}
