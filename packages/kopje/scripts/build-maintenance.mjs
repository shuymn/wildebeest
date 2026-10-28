// Builds the two bundles of the cutover's maintenance worker (docs/cutover-runbook.md, step 3), as `wrangler deploy`
// bundles them, and checks them:
//   maintenance-worker.js  src/maintenance-worker.ts, the runtime of the Pages `_worker.js`. It runs on the legacy
//                          Pages project's own compatibility settings, so it must import no Node.js or Cloudflare
//                          module, and it stays small (MAINTENANCE_WORKER_LIMIT_KIB gzipped).
//   maintenance-render.js  src/maintenance-render.ts, which `kopje-admin maintenance-worker` runs on Node to render the
//                          snapshot with Kopje's own dispatchers.
// build-package.mjs puts both in dist/; the test suites build them into a cache directory.
//
//   node scripts/build-maintenance.mjs [<out dir>]     (default: dist/)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");

export const MAINTENANCE_WORKER_LIMIT_KIB = 32;
export const MAINTENANCE_RENDER_LIMIT_KIB = 1024;
export const MAINTENANCE_FILES = /** @type {const} */ (["maintenance-worker.js", "maintenance-render.js"]);

/** @param {string} text */
export function gzipKiB(text) {
  return gzipSync(text).byteLength / 1024;
}

// Module specifiers a bundle imports: wrangler leaves node: and cloudflare: modules external.
/** @param {string} text */
export function externalImports(text) {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']((?:node|cloudflare):[^"']+)["']/g)].map((m) => m[1]);
}

// The names a bundle's final `export { ... }` gives.
/** @param {string} text */
export function moduleExports(text) {
  const list = [...text.matchAll(/export\s*\{([^}]*)\}/g)].at(-1)?.[1] ?? "";
  return list
    .split(",")
    .map(
      (item) =>
        item
          .trim()
          .split(/\s+as\s+/)
          .at(-1) ?? "",
    )
    .filter((name) => name !== "");
}

/**
 * @param {string} outDir
 * @param {{ metafileDir?: string }} [options] also write esbuild's metafile of each bundle, as <file>.meta.json
 * @returns {{ workerKiB: number, renderKiB: number }}
 */
export function buildMaintenance(outDir, { metafileDir } = {}) {
  mkdirSync(outDir, { recursive: true });
  const sizes = /** @type {Record<(typeof MAINTENANCE_FILES)[number], number>} */ ({});
  for (const file of MAINTENANCE_FILES) {
    const entry = join("src", file.replace(/\.js$/, ".ts"));
    const work = mkdtempSync(join(tmpdir(), "kopje-maintenance-"));
    try {
      execFileSync(
        process.execPath,
        [
          wrangler,
          "deploy",
          "--dry-run",
          entry,
          "--config",
          "maintenance.wrangler.jsonc",
          "--outdir",
          work,
          ...(metafileDir === undefined ? [] : ["--metafile", join(metafileDir, `${file}.meta.json`)]),
        ],
        { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
      );
      // The source maps stay out: they hold the sources of every bundled package, which nothing here needs.
      const code = readFileSync(join(work, file), "utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
      writeFileSync(join(outDir, file), code);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    sizes[file] = gzipKiB(readFileSync(join(outDir, file), "utf8"));
  }
  const worker = readFileSync(join(outDir, "maintenance-worker.js"), "utf8");
  const imports = externalImports(worker);
  if (imports.length > 0) {
    throw new Error(`maintenance-worker.js must import no runtime module, but imports ${imports.join(", ")}`);
  }
  // The runtime reads every named export of a Worker module as an entrypoint and refuses anything else.
  const exported = moduleExports(worker);
  if (exported.length !== 1 || exported[0] !== "default") {
    throw new Error(`maintenance-worker.js must export its handler only, but exports ${exported.join(", ")}`);
  }
  const workerKiB = sizes["maintenance-worker.js"];
  const renderKiB = sizes["maintenance-render.js"];
  if (workerKiB > MAINTENANCE_WORKER_LIMIT_KIB || renderKiB > MAINTENANCE_RENDER_LIMIT_KIB) {
    throw new Error(
      `maintenance bundles too large: worker ${workerKiB.toFixed(1)} KiB, render ${renderKiB.toFixed(1)} KiB`,
    );
  }
  return { workerKiB, renderKiB };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve(process.argv[2] ?? join(root, "dist"));
  const { workerKiB, renderKiB } = buildMaintenance(out);
  console.log(
    `build-maintenance: maintenance-worker.js ${workerKiB.toFixed(1)} KiB, maintenance-render.js ${renderKiB.toFixed(1)} KiB (gzip)`,
  );
}
