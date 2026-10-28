import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type LintDiagnostic = { code: string; filename: string };

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Lints `files` (repository-relative path -> source) with the real root .oxlintrc.json, the kopje plugin and the
// oxlint binary, in a scratch copy of the layout, so nothing is written into the source tree.
export function lintProbe(files: Record<string, string>): LintDiagnostic[] {
  const scratch = mkdtempSync(join(tmpdir(), "kopje-lint-probe-"));
  try {
    symlinkSync(join(root, ".oxlintrc.json"), join(scratch, ".oxlintrc.json"));
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
    mkdirSync(join(scratch, "packages/kopje"), { recursive: true });
    symlinkSync(join(root, "packages/kopje/lint"), join(scratch, "packages/kopje/lint"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), text);
    }
    let output: string;
    try {
      // The files are named: a scratch directory under a Git-ignored path would otherwise be skipped.
      output = execFileSync(
        join(root, "node_modules/.bin/oxlint"),
        ["--type-aware", "-f", "json", ...Object.keys(files)],
        {
          cwd: scratch,
          encoding: "utf8",
        },
      );
    } catch (error) {
      // oxlint exits 1 when it reports an error; its report is still on stdout.
      output = (error as { stdout: string }).stdout;
    }
    return (JSON.parse(output) as { diagnostics: LintDiagnostic[] }).diagnostics;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
