import { type DocumentLoader, preloadedContexts, signJsonLd } from "@fedify/fedify";

import type { StoredKey } from "../domain/actors";
import { createKeyring } from "../security/keyring";

// Linked Data Signatures made by Kopje (RsaSignature2017, the form Mastodon verifies; Fedify's signJsonLd): a quoted
// author's stamp Delete, which receivers may relay with the author's proof (Mastodon's always_sign). The
// key is unwrapped for this one call and dropped (DATA-1). Only the preloaded JSON-LD contexts are read: signing never
// fetches. The signed body is recorded once and delivered unedited to every destination (an immutable envelope).

const preloaded: DocumentLoader = (url) => {
  const document = (preloadedContexts as Record<string, unknown>)[url];
  return document === undefined
    ? Promise.reject(new Error(`Not a preloaded JSON-LD context: ${url}`))
    : Promise.resolve({ document, documentUrl: url, contextUrl: null });
};

export async function signAsAuthor(
  kek: string,
  sign: { activity: Record<string, unknown>; keyId: string; key: StoredKey },
): Promise<Record<string, unknown>> {
  const signer = await createKeyring(kek).signerFor({
    keyId: new URL(sign.keyId),
    privkey: sign.key.privkey,
    salt: sign.key.salt,
    pubkey: sign.key.pubkey,
  });
  return (await signJsonLd(sign.activity, signer.keyPair.privateKey, signer.keyId, {
    contextLoader: preloaded,
  })) as Record<string, unknown>;
}
