import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";
import { afterAll, describe, expect, it } from "vitest";

import { signingKeys } from "../lint/signing-keys.js";

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

// The root .oxlintrc.json registers the plugin and turns the rule on for packages/kopje/src alone. The probe runs the
// real config, plugin and binary in a scratch copy of the layout, so it writes nothing into the source tree.
describe("signing keys in the lint config", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "kopje-signing-keys-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("flags the unchecked key in packages/kopje/src and nowhere else", () => {
    symlinkSync(join(root, ".oxlintrc.json"), join(scratch, ".oxlintrc.json"));
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
    mkdirSync(join(scratch, "packages/kopje/src"), { recursive: true });
    symlinkSync(join(root, "packages/kopje/lint"), join(scratch, "packages/kopje/lint"));
    writeFileSync(join(scratch, "packages/kopje/src/probe.ts"), FORBIDDEN);
    writeFileSync(join(scratch, "packages/kopje/probe-outside.ts"), FORBIDDEN);

    let output: string;
    try {
      // The probe files are named: a scratch directory under a Git-ignored path would otherwise be skipped.
      output = execFileSync(
        join(root, "node_modules/.bin/oxlint"),
        ["--type-aware", "-f", "json", "packages/kopje/src/probe.ts", "packages/kopje/probe-outside.ts"],
        { cwd: scratch, encoding: "utf8" },
      );
    } catch (error) {
      // oxlint exits 1 when it reports an error; its report is still on stdout.
      output = (error as { stdout: string }).stdout;
    }
    const report = JSON.parse(output) as { diagnostics: { code: string; filename: string }[] };
    const flagged = report.diagnostics.filter((d) => d.code === "kopje(signing-keys)").map((d) => d.filename);
    expect(flagged).toEqual(["packages/kopje/src/probe.ts"]);
  });
});
