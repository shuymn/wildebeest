// Global setup of the Workers suites (vitest.config.ts): converts a synthetic legacy export with the real CLI code,
// on Node (node:sqlite does not run in workerd), and hands the dump and the independently computed expectations to
// test/cutover-import.test.ts, which imports the dump into a real Store. It also builds the cutover's maintenance
// worker bundles (scripts/build-maintenance.mjs) and writes the `_worker.js` for the same export with the real CLI code,
// for test/maintenance-worker.test.ts: the file is written where the Workers suite can import it.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import { exportImages } from "../cli/lib/cutover/images-export.js";
import { loadLegacyExport } from "../cli/lib/cutover/legacy-load.js";
import { maintenanceWorker } from "../cli/lib/cutover/maintenance.js";
import { convertExport } from "../cli/lib/cutover/run.js";
import { expectedFromLegacy } from "../cli/lib/cutover/verify-expect.js";
import { buildMaintenance } from "../scripts/build-maintenance.mjs";
import { PNG_PLAIN } from "../test/fixtures/images.js";
import { buildLegacyFixture } from "./legacy-fixture.js";

// Under the package, so the Workers suite's module runner may load the generated file.
export const MAINTENANCE_CACHE = fileURLToPath(new URL("../node_modules/.cache/kopje-maintenance/", import.meta.url));

export default async function setup(project: TestProject): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kopje-cutover-setup-"));
  try {
    const fixture = await buildLegacyFixture({ level: 39, notificationSequence: 12n });
    const exportPath = join(dir, "export");
    await mkdir(exportPath);
    for (const [table, text] of fixture.texts) {
      await writeFile(join(exportPath, `${table}.sql`), text);
    }
    const { ok, manifest } = await convertExport({
      exportPath,
      outDir: join(dir, "out"),
      acceptDeletions: false,
      baseTime: Date.parse("2026-10-20T00:00:00.000Z"),
      env: {},
      version: "test",
    });
    if (!ok) {
      throw new Error(`fixture conversion stopped: ${JSON.stringify(manifest.stop)}`);
    }
    const loaded = loadLegacyExport({ texts: fixture.texts.values() });
    const { records: expected } = expectedFromLegacy(loaded.db, {
      originalActorIds: loaded.originalActorIds,
      source: loaded.source,
      notificationSequence: loaded.report.notificationSequence,
    });
    loaded.db.close();
    project.provide("cutover", {
      dump: await readFile(join(dir, "out", "kopje.dump"), "utf8"),
      expected,
    });

    project.provide("cutoverImages", await convertedWithImages(dir));

    await rm(MAINTENANCE_CACHE, { recursive: true, force: true });
    const bundleDir = join(MAINTENANCE_CACHE, "bundle");
    buildMaintenance(bundleDir);
    const generated = await maintenanceWorker({
      exportPath,
      domain: "kopje.test",
      outDir: join(MAINTENANCE_CACHE, "pages"),
      env: {},
      bundleDir,
    });
    if (!generated.ok) {
      throw new Error(`maintenance worker not written: ${JSON.stringify(generated.report.stop)}`);
    }
    project.provide("maintenance", {
      source: await readFile(join(MAINTENANCE_CACHE, "pages", "_worker.js"), "utf8"),
      workerPath: join(MAINTENANCE_CACHE, "pages", "_worker.js"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The same export with its images in Cloudflare Images (a fake fetch answers with one small PNG for every image),
// converted with --images, for test/cutover-images-lifecycle.test.ts and test/media-rebuild.test.ts: the dump, and the
// originals the conversion wrote for R2 (base64, by media id).
async function convertedWithImages(dir: string): Promise<{ dump: string; originals: Record<string, string> }> {
  const fixture = await buildLegacyFixture({
    level: 39,
    notificationSequence: 12n,
    imagesAccount: "OperatorAccount0123",
  });
  const exportPath = join(dir, "export-images");
  await mkdir(exportPath);
  for (const [table, text] of fixture.texts) {
    await writeFile(join(exportPath, `${table}.sql`), text);
  }
  // A real PNG, so the originals can be re-encoded.
  const png = Buffer.from(PNG_PLAIN, "base64");
  const imagesDir = join(dir, "images");
  const exported = await exportImages({
    exportPath,
    accountHash: "OperatorAccount0123",
    outDir: imagesDir,
    fetch: () => Promise.resolve(new Response(png)),
  });
  if (!exported.ok) {
    throw new Error(`fixture images not exported: ${JSON.stringify(exported.report)}`);
  }
  const outDir = join(dir, "out-images");
  const { ok, manifest } = await convertExport({
    exportPath,
    outDir,
    acceptDeletions: false,
    baseTime: Date.parse("2026-10-20T00:00:00.000Z"),
    env: {},
    version: "test",
    imagesDir,
  });
  if (!ok) {
    throw new Error(`fixture conversion with images stopped: ${JSON.stringify(manifest.stop)}`);
  }
  const originals: Record<string, string> = {};
  for (const name of await readdir(join(outDir, "originals"))) {
    originals[name] = (await readFile(join(outDir, "originals", name))).toString("base64");
  }
  return { dump: await readFile(join(outDir, "kopje.dump"), "utf8"), originals };
}

declare module "vitest" {
  export interface ProvidedContext {
    cutover: { dump: string; expected: Record<string, Record<string, string>> };
    cutoverImages: { dump: string; originals: Record<string, string> };
    maintenance: { source: string; workerPath: string };
  }
}
