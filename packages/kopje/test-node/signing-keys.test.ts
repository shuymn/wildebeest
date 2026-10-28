import * as tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import config from "../../../eslint.config.js";

// The rules eslint.config.js sets for Kopje's sources: a fetch signs as a local account only with a key loaded while
// the account is available; the unchecked localKey is read only by federation.ts publishedKeyPair, which returns a bare
// key pair (never a Signer) for Fedify's key-pairs dispatcher.
const block = (config as { files?: string[]; rules?: Linter.RulesRecord }[]).find(
  (entry) => entry.files?.includes("packages/kopje/src/**/*.ts") && entry.rules?.["no-restricted-syntax"] !== undefined,
);

function flagged(code: string): number {
  return new Linter({ configType: "flat" }).verify(
    code,
    [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, rules: block?.rules ?? {} }],
    "federation.ts",
  ).length;
}

const ALLOWED = `
const publishedKeyPair = async (username: string) => {
	const key = await rpc((s) => s.localKey(build, { username })) // the published key
	return key
} // a comment after the closing brace
const signer = async (username: string) => rpc((s) => s.fetchSigner(build, { by: username }))
federation.setKeyPairsDispatcher(async (_ctx, identifier) => [await publishedKeyPair(identifier)])
`;

describe("signing keys", () => {
  it("lets publishedKeyPair alone read the unchecked key", () => {
    expect(block).toBeDefined();
    expect(flagged(ALLOWED)).toBe(0);
  });

  it("flags the unchecked key read anywhere else, however it is named", () => {
    expect(flagged(ALLOWED.replace("s.fetchSigner(", "s.localKey("))).toBe(1);
    expect(flagged(ALLOWED.replace("s.fetchSigner(", "s['localKey']("))).toBe(1);
    expect(flagged(ALLOWED.replace("s.fetchSigner(", "s.localKey?.("))).toBe(1);
    expect(flagged(`${ALLOWED}\nconst load = store.localKey`)).toBe(1);
    expect(flagged(`${ALLOWED}\nconst { localKey } = store`)).toBe(1);
  });

  it("flags every Fedify call that signs with the published key pairs", () => {
    expect(
      flagged(
        `ctx.getDocumentLoader({ identifier })\nctx['getActorKeyPairs'](name)\nfederation.setInboxListeners('/u/{identifier}/inbox')`,
      ),
    ).toBe(3);
    expect(flagged(`const { ['setInboxListeners']: listen } = federation\nconst { getDocumentLoader } = ctx`)).toBe(2);
  });
});
