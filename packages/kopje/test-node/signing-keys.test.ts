import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { signingKeys } from "../lint/signing-keys.js";
import { lintProbe } from "./lint-probe.js";

// The kopje/signing-keys rule (lint/signing-keys.js): a fetch signs as a local account only with a key loaded while the
// account is available; the unchecked localKey is read only by federation.ts publishedKeyPair, which returns a bare key
// pair (never a Signer) for Fedify's key-pairs dispatcher.
RuleTester.describe = describe;
RuleTester.it = it;

const ALLOWED = `
const publishedKeyPair = async (username: string) => {
	const key = await rpc((s) => s.localKey(build, { username })) // the published key
	return key
} // a comment after the closing brace
const signer = async (username: string) => rpc((s) => s.fetchSigner(build, { by: username }))
federation.setKeyPairsDispatcher(async (_ctx, identifier) => [await publishedKeyPair(identifier)])
`;
const FORBIDDEN = ALLOWED.replace("s.fetchSigner(", "s.localKey(");

const cases = (code: string, errors: number) => ({ code, errors, filename: "federation.ts" });

new RuleTester().run("signing-keys", signingKeys, {
  valid: [{ code: ALLOWED, filename: "federation.ts" }],
  invalid: [
    cases(FORBIDDEN, 1),
    cases(ALLOWED.replace("s.fetchSigner(", "s['localKey']("), 1),
    cases(ALLOWED.replace("s.fetchSigner(", "s.localKey?.("), 1),
    cases(`${ALLOWED}\nconst load = store.localKey`, 1),
    cases(`${ALLOWED}\nconst { localKey } = store`, 1),
    cases(
      `ctx.getDocumentLoader({ identifier })\nctx['getActorKeyPairs'](name)\nfederation.setInboxListeners('/u/{identifier}/inbox')`,
      3,
    ),
    cases(`const { ['setInboxListeners']: listen } = federation\nconst { getDocumentLoader } = ctx`, 2),
  ],
});

// The root .oxlintrc.json registers the plugin and turns the rule on for packages/kopje/src alone.
describe("signing keys in the lint config", () => {
  it("flags the unchecked key in packages/kopje/src and nowhere else", () => {
    const flagged = lintProbe({
      "packages/kopje/src/probe.ts": FORBIDDEN,
      "packages/kopje/probe-outside.ts": FORBIDDEN,
    })
      .filter((d) => d.code === "kopje(signing-keys)")
      .map((d) => d.filename);
    expect(flagged).toEqual(["packages/kopje/src/probe.ts"]);
  });
});
