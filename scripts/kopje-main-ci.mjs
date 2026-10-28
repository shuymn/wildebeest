// Writes passed=true to $GITHUB_OUTPUT when CI (ci.yml) passed on the commit as a push to main, and
// passed=false otherwise (see mainChecked() in kopje-release-lib.mjs).
//
//   node scripts/kopje-main-ci.mjs --repo <owner/name> --sha <commit>
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { mainChecked } from "./kopje-release-lib.mjs";

const { values } = parseArgs({ options: { repo: { type: "string" }, sha: { type: "string" } } });
for (const name of ["repo", "sha"]) {
  if (values[name] === undefined) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
}
const passed = await mainChecked({ repo: values.repo, sha: values.sha });
const line = `passed=${passed}\n`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, line);
} else {
  process.stdout.write(line);
}
