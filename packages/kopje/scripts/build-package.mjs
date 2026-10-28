// Builds what the npm package ships in dist/: the Worker bundled by wrangler exactly as `wrangler deploy` bundles it
// here (worker.js, its source map and the migrations as text modules), the cutover's maintenance worker bundles
// (build-maintenance.mjs), and THIRD_PARTY_NOTICES.md for every package the bundles contain. The package then has no
// runtime dependencies: an instance installs the code that was tested.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMaintenance, MAINTENANCE_FILES } from "./build-maintenance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
// Kept out of dist/ (and out of git, under node_modules) since only the build reads it.
const metafile = join(root, "node_modules", ".cache", "kopje-metafile.json");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dirname(metafile), { recursive: true });
execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", dist, "--metafile", metafile], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
// wrangler writes a README about the build into the output directory; it is not part of the package.
rmSync(join(dist, "README.md"), { force: true });

buildMaintenance(dist, { metafileDir: dirname(metafile) });

const meta = JSON.parse(readFileSync(metafile, "utf8"));
// The maintenance bundles are built from the same sources as the Worker, so they bundle a subset of its packages;
// a package only they bundled would be missing from the notices.
const workerInputs = new Set(Object.keys(meta.inputs));
for (const file of MAINTENANCE_FILES) {
  const extra = Object.keys(
    JSON.parse(readFileSync(join(dirname(metafile), `${file}.meta.json`), "utf8")).inputs,
  ).filter((input) => input.includes("node_modules/") && !workerInputs.has(input));
  if (extra.length > 0) {
    throw new Error(`${file} bundles files the Worker does not: ${extra.slice(0, 5).join(", ")}`);
  }
}
const packages = new Map();
for (const input of Object.keys(meta.inputs)) {
  const at = input.lastIndexOf("node_modules/");
  if (at === -1) {
    continue;
  }
  const parts = input.slice(at + "node_modules/".length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  const dir = resolve(root, input.slice(0, at), "node_modules", name ?? "");
  if (name === undefined || packages.has(dir) || !existsSync(join(dir, "package.json"))) {
    continue;
  }
  packages.set(dir, name);
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
// Bundled packages whose license text is not in the package, each reviewed by hand: name -> the reason and where the
// text is.
const REVIEWED_WITHOUT_LICENSE_TEXT = new Map([
  [
    "blurhash",
    [
      "The npm package declares MIT and ships no license file; the text is License.md of its repository,",
      "https://github.com/woltapp/blurhash (the package is its TypeScript directory):",
      "",
      "MIT License",
      "",
      "Copyright (c) 2018 Wolt Enterprises",
      "",
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      'of this software and associated documentation files (the "Software"), to deal',
      "in the Software without restriction, including without limitation the rights",
      "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
      "copies of the Software, and to permit persons to whom the Software is",
      "furnished to do so, subject to the following conditions:",
      "",
      "The above copyright notice and this permission notice shall be included in all",
      "copies or substantial portions of the Software.",
      "",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
      "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
      "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
      "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
      "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
      "SOFTWARE.",
    ].join("\n"),
  ],
]);
const entries = [];
const missing = [];
for (const [dir, name] of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .toSorted();
  const texts = files.map((file) => readFileSync(join(dir, file), "utf8").trim()).filter((text) => text !== "");
  const id = `${manifest.name ?? name}@${manifest.version}`;
  const reviewed = REVIEWED_WITHOUT_LICENSE_TEXT.get(manifest.name ?? name);
  if (texts.length === 0 && reviewed === undefined) {
    missing.push(`${id} (license: ${manifest.license ?? "none"})`);
  }
  entries.push({ id, license: manifest.license ?? "see below", texts: reviewed === undefined ? texts : [reviewed] });
}
if (missing.length > 0) {
  // A bundled package's license must travel with the bundle; review it and add it to the list above, or drop it.
  throw new Error(`bundled packages without license text: ${missing.join(", ")}`);
}
// Several copies of one version (pnpm keeps one per peer set) are listed once.
const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()].toSorted((a, b) =>
  a.id.localeCompare(b.id),
);

const sections = unique.map(({ id, license, texts }) =>
  [
    `## ${id}`,
    "",
    `License: ${license}`,
    ...texts.map((text) => ["", "```", text.replaceAll("```", "'''"), "```"].join("\n")),
  ].join("\n"),
);
writeFileSync(
  join(dist, "THIRD_PARTY_NOTICES.md"),
  [
    "# Third-party notices",
    "",
    "dist/worker.js bundles the following packages (dist/maintenance-render.js a subset of them, and",
    "dist/maintenance-worker.js none). Their licenses and notices follow.",
    "",
    ...sections.map((section) => `${section}\n`),
  ].join("\n"),
);
console.log(`build-package: dist/ written, ${unique.length} bundled packages in THIRD_PARTY_NOTICES.md`);
