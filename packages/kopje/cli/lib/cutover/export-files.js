// The export files a cutover command reads, and the size limits they are checked against before anything is read. A
// leaf module (it imports only sql-script.js), so any cutover module can use it without an import cycle.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ExportError } from "./sql-script.js";

// Preflight limits. A V8 string holds at most 2^29 - 24 UTF-16 units, so one export file (or the dump verify reads)
// must stay under 512 MiB. The whole export is capped at 1 GiB: the converter reads one file at a time but keeps the
// legacy and the Kopje database in memory, about three times the export at peak, which stays within a workstation's
// memory. Exports larger than that are well past the size a single-user or small legacy instance reaches.
export const MAX_FILE_BYTES = 512 * 1024 * 1024 - 1;
export const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

/** @param {string} path */
export function exportFiles(path) {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => f.endsWith(".sql"))
      .toSorted()
      .map((f) => join(path, f));
  }
  return [path];
}

/** @param {string[]} files */
export function checkSizes(files) {
  let total = 0;
  for (const file of files) {
    const size = statSync(file).size;
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_EXPORT_BYTES) {
      throw new ExportError("export-too-large", { files: files.length });
    }
  }
  return total;
}
