// Copies the static assets of the installed kopje package to public/, which wrangler.jsonc serves. wrangler runs this
// (the "build" command in wrangler.jsonc) before every deploy, so the assets always match the installed version.
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(createRequire(import.meta.url).resolve("kopje/package.json")), "public");
const target = fileURLToPath(new URL("../public", import.meta.url));
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
