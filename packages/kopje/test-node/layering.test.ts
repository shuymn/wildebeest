import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, ownerOf, parse, resolve, sources, walk, type Source } from "./source-scan.js";

// worker -> app/jobs -> {mastodon, federation, web} -> domain -> {db, platform, security}
// A module may import its own layer or any lower one. Top-level files (worker.ts, store.ts, version.ts) are the entry
// tier. Durable Object features (cloudflare:*) belong to platform and the entry tier only. src/client is the browser's
// L1 bundle (docs/web-pages.md), a program of its own: it imports only its own modules, and nothing imports it (having
// no rank, it is neither above nor below any layer).
const CLIENT = "client";
const RANK: Record<string, number> = {
  worker: 0,
  app: 1,
  jobs: 1,
  mastodon: 2,
  federation: 2,
  web: 2,
  domain: 3,
  db: 4,
  platform: 4,
  security: 4,
};
const PLATFORM_MODULE_LAYERS = new Set(["worker", "platform"]);

const SOURCES = sources("src");

function layerOf(file: string): string {
  const parts = file.replace(/^src\//, "").split("/");
  return parts.length === 1 ? "worker" : (parts[0] ?? "");
}

// The specifiers a module imports: import and export declarations, import() and import types. An import() whose
// specifier is not a string literal is null: its layer cannot be read.
function specifiers(source: Source): (string | null)[] {
  const found: (string | null)[] = [];
  walk(parse(source).program, (node) => {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "TSImportType" ||
      (node.type === "ExportNamedDeclaration" && node.source !== null)
    ) {
      found.push(node.source?.value ?? null);
    } else if (node.type === "ImportExpression") {
      found.push(node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value : null);
    }
  });
  return found;
}

function violations(files: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of files) {
    const file = source.path;
    const from = layerOf(file);
    if (from !== CLIENT && RANK[from] === undefined) {
      found.push(`${file}: directory is not part of the layering`);
      continue;
    }
    for (const specifier of specifiers(source)) {
      if (specifier === null) {
        found.push(`${file}: imports a computed specifier`);
        continue;
      }
      if (specifier.startsWith("cloudflare:") && !PLATFORM_MODULE_LAYERS.has(from)) {
        found.push(`${file}: ${from} imports ${specifier}`);
      }
      if (!specifier.startsWith(".")) {
        if (from === CLIENT) {
          found.push(`${file}: client imports ${specifier}`);
        }
        continue;
      }
      const target = resolve(file, specifier);
      if (!target.startsWith("src/")) {
        if (from === CLIENT) {
          found.push(`${file}: client imports ${specifier}`);
        }
        continue;
      }
      const to = layerOf(target);
      const allowed = to === from || (RANK[to] ?? -1) > (RANK[from] ?? Infinity);
      if (!allowed) {
        found.push(`${file}: ${from} imports ${to} (${specifier})`);
      }
    }
  }
  return found;
}

describe("module layering", () => {
  it("sees the source tree", () => {
    expect(SOURCES.map((s) => s.path)).toEqual(expect.arrayContaining(["src/worker.ts", "src/domain/ids.ts"]));
  });

  it("has no upward, sideways, or platform-leaking imports", () => {
    expect(violations(SOURCES)).toEqual([]);
  });

  it("detects violations", () => {
    expect(
      violations([
        {
          path: "src/domain/a.ts",
          text: "import { x } from '../app/app'\nimport { DurableObject } from 'cloudflare:workers'",
        },
        { path: "src/mastodon/b.ts", text: "export { y } from '../federation/spool'" },
        { path: "src/db/c.ts", text: "export type X = string\nconst m = await import('../platform/config')" },
        { path: "src/security/e.ts", text: "import '../domain/ids'" },
        { path: "src/stray/d.ts", text: "" },
        {
          path: "src/client/f.ts",
          text: "import { g } from './g'\nimport { h } from '../web/format'\nimport 'valibot'\nimport '../../scripts/x'",
        },
        { path: "src/web/i.ts", text: "import { f } from '../client/f'" },
      ]),
    ).toEqual([
      "src/domain/a.ts: domain imports app (../app/app)",
      "src/domain/a.ts: domain imports cloudflare:workers",
      "src/mastodon/b.ts: mastodon imports federation (../federation/spool)",
      "src/db/c.ts: db imports platform (../platform/config)",
      "src/security/e.ts: security imports domain (../domain/ids)",
      "src/stray/d.ts: directory is not part of the layering",
      "src/client/f.ts: client imports web (../web/format)",
      "src/client/f.ts: client imports valibot",
      "src/client/f.ts: client imports ../../scripts/x",
      "src/web/i.ts: web imports client (../client/f)",
    ]);
  });

  guardFixtures(violations, {
    flagged: {
      "an export of everything": ["export * from '../app/app'", "src/domain/probe.ts: domain imports app (../app/app)"],
      "an import type": [
        "type T = import('../web/pages').Page",
        "src/domain/probe.ts: domain imports web (../web/pages)",
      ],
      "a computed import()": [
        "const m = await import(`../app/${name}`)",
        "src/domain/probe.ts: imports a computed specifier",
      ],
    },
    passed: {
      "its own layer, a lower one and a package":
        "import { a } from './ids'\nimport { b } from '../db/sql'\nimport * as v from 'valibot'",
      "an import in a comment": "// import { x } from '../app/app'\nconst s = \"import '../app/app'\"",
    },
  });
});

// R32 (docs/visibility.md): a streaming delete is captured (streamDelete in src/domain/streaming.ts) at exactly these
// four sites. That each captures once, before the first change to the status's audience, and keeps its capture when a
// batch fails, the runtime tests show (test/stream-delete.test.ts unless named):
// - deleteStatus: the captures of a status's boosts and its tombstone, and the streaming suite;
// - unreblog: "captures a local boost removed by unreblog, by its own id, before it is hidden";
// - deleteObject: "names the viewers a mention authorized, once, through every batch and a redelivery", and in
//   test/inbound-job-isolation.test.ts a failing first batch that keeps its capture and a redelivered Delete whose job
//   exists that captures nothing;
// - removeBoost: "captures a remote boost removed by Delete or Undo, by its own id".
// This inventory fails on any other site, which then needs a witness of its own. No capture function runs under a
// batch's budget (JobBudget, RowBudget): a capture a budget could skip is invisible to those tests, which never
// exhaust one before it.
const CAPTURES = {
  "src/domain/statuses.ts deleteStatus": 1,
  "src/domain/statuses.ts unreblog": 1,
  "src/domain/inbox.ts deleteObject": 1,
  "src/domain/inbox.ts removeBoost": 1,
};

function captureProblems(files: readonly Source[]): string[] {
  const found: string[] = [];
  const owners = new Map<string, string>();
  for (const source of files) {
    const { program, code } = parse(source);
    walk(program, (node) => {
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "streamDelete") {
        const owner = ownerOf(program, node.start);
        const key = `${source.path} ${owner?.name ?? "(top level)"}`;
        found.push(key);
        if (owner !== null) {
          owners.set(key, code.slice(owner.start, owner.end));
        }
      }
    });
  }
  const budgets = [...owners]
    .filter(([, text]) => /\b(?:Job|Row)?Budget\b/.test(text))
    .map(([key]) => `${key} runs under a budget`);
  return [...inventoryDiff(found, CAPTURES), ...budgets.toSorted()];
}

describe("the streaming delete capture sites", () => {
  it("are the four sites, none under a budget", () => {
    expect(captureProblems(SOURCES)).toEqual([]);
  });

  guardFixtures(
    captureProblems,
    {
      flagged: {
        "a fifth site": [
          "function extra(db: Db): void {\n\tstreamDelete(db, 'x', 0)\n}",
          "src/domain/probe.ts extra has 1, expected 0",
        ],
        "a capture under a budget": [
          "function extra(budget: JobBudget, db: Db): void {\n\tstreamDelete(db, 'x', 0)\n}",
          "src/domain/probe.ts extra runs under a budget",
        ],
      },
      passed: { "a capture named in a comment": "// streamDelete(db, id, now) runs above.\nf()" },
    },
    { over: SOURCES },
  );

  guardFixtures(
    captureProblems,
    {
      flagged: {
        "a second capture in the same function": [
          [
            "export const unreblog = (db: Db, id: string) => {",
            "\tstreamDelete(db, id, 0)",
            "\tstreamDelete(db, id, 0)",
            "}",
            "export const deleteStatus = (db: Db, id: string) => streamDelete(db, id, 0)",
          ].join("\n"),
          "src/domain/statuses.ts unreblog has 2, expected 1",
        ],
        "a capture function under a RowBudget": [
          [
            "export const unreblog = (db: Db, id: string) => streamDelete(db, id, 0)",
            "export const deleteStatus = (db: Db, id: string, budget: RowBudget) => streamDelete(db, id, 0)",
          ].join("\n"),
          "src/domain/statuses.ts deleteStatus runs under a budget",
        ],
      },
      passed: {
        "the two sites alone": [
          "export const unreblog = (db: Db, id: string) => streamDelete(db, id, 0)",
          "export const deleteStatus = (db: Db, id: string) => streamDelete(db, id, 0)",
        ].join("\n"),
      },
    },
    { path: "src/domain/statuses.ts", over: SOURCES },
  );
});
