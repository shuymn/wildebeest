// Publishes a checked kopje tarball to npm, once; safe to run again (see publish() in kopje-release-lib.mjs).
//
//   node scripts/kopje-publish.mjs <tarball> --tag <dist-tag> [--dry-run]
import { parseArgs } from "node:util";

import { publish } from "./kopje-release-lib.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { tag: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});
if (positionals.length !== 1 || values.tag === undefined) {
  console.error("usage: node scripts/kopje-publish.mjs <tarball> --tag <dist-tag> [--dry-run]");
  process.exit(2);
}
publish({ tarball: positionals[0], tag: values.tag, dryRun: values["dry-run"] });
