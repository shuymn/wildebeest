import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, ownerOf, parse, sources, walk, type Source } from "./source-scan.js";

// GET /api/v1/instance/activity counts what Mastodon's ActivityTracker counts at creation
// (domain/instance-activity.ts): each local status (a statuses row whose id allocateLocalId gives) and each local
// account (local_accounts). A remote status takes no local id, and an import or a cutover conversion runs no Store
// function that inserts one, so neither counts. The writers below count, as the runtime tests show: a post and a boost
// (test/instance-activity.test.ts, "instance activity: what counts"), a registration and its first login
// (test/setup.test.ts, "records the account's registration and its first login with the bootstrap" and the SETUP-3
// rollbacks; test/account-invitations.test.ts, an invited account's). This inventory fails on any other writer, which
// then needs a witness of its own.

const SOURCES = sources("src");

const EXPECTED = {
  "src/domain/statuses.ts writePost": 1,
  "src/domain/statuses.ts reblog": 1,
  "src/domain/setup.ts insertLocalAccount": 1,
};

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// Whether the innermost function around `offset` calls `name` (a call expression: a name in a string or a comment is
// not a call).
function innermostCalls(program: Node, offset: number, name: string): boolean {
  let fn: Node | null = null;
  walk(program, (node) => {
    if (FUNCTIONS.has(node.type) && node.start <= offset && offset < node.end) {
      fn = node;
    }
  });
  let calls = false;
  if (fn !== null) {
    walk(fn, (node) => {
      calls ||= node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === name;
    });
  }
  return calls;
}

const STATUS_INSERT = /\bINSERT\s+INTO\s+statuses\b/g;
const ACCOUNT_INSERT = /\bINSERT\s+INTO\s+local_accounts\b/g;

function sites(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const { program, code } = parse(source);
    const at = (offset: number) => `${source.path} ${ownerOf(program, offset)?.name ?? "(top level)"}`;
    return [
      ...[...code.matchAll(STATUS_INSERT)]
        .filter((m) => innermostCalls(program, m.index, "allocateLocalId"))
        .map((m) => at(m.index)),
      ...[...code.matchAll(ACCOUNT_INSERT)].map((m) => at(m.index)),
    ];
  });
}

const violations = (all: readonly Source[]) => inventoryDiff(sites(all), EXPECTED);

describe("instance activity writers", () => {
  it("are the counted writers of local statuses and accounts", () => {
    expect(violations(SOURCES)).toEqual([]);
  });

  guardFixtures(
    violations,
    {
      flagged: {
        "a local status insert in another function": [
          "function p(db) {\n\tconst id = allocateLocalId(db, now)\n\tdb.run('INSERT INTO statuses (id) VALUES (?)', id)\n}",
          "src/domain/probe.ts p has 1, expected 0",
        ],
        "a local account insert in another function": [
          "const s = (db) => {\n\tdb.run(`INSERT INTO local_accounts (account_id) VALUES (?)`, id)\n}",
          "src/domain/probe.ts s has 1, expected 0",
        ],
      },
      passed: {
        "a remote status": "function r(db) {\n\tdb.run('INSERT INTO statuses (id) VALUES (?)', storedId)\n}",
        "an insert named in a comment": "// INSERT INTO local_accounts\nf()",
      },
    },
    { over: SOURCES },
  );

  guardFixtures(
    violations,
    {
      flagged: {
        "a second insert in the same function": [
          [
            "export function insertLocalAccount(db, input) {",
            "\tdb.run('INSERT INTO local_accounts (account_id) VALUES (?)', input.id)",
            "\tdb.run('INSERT INTO local_accounts (account_id) VALUES (?)', input.other)",
            "}",
          ].join("\n"),
          "src/domain/setup.ts insertLocalAccount has 2, expected 1",
        ],
      },
      passed: {},
    },
    { path: "src/domain/setup.ts", over: SOURCES },
  );
});
