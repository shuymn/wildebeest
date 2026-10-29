import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, ownerOf, parse, sources, type Source } from "./source-scan.js";

// RES-6: an outbound intent still staging (outbound_activities.staged set) is never deleted, so a retraction's staging
// row (retraction_stagings) needs no foreign key to it: its end is marked when staged is cleared
// (outbound_activities_staging_ended, migration 0085_retraction_staging). The one delete of an intent,
// dropSettledActivity, refuses it by its own staged IS NULL, which the runtime tests show: a retraction staging over
// calls (test/retraction-staging.test.ts, "keeps its intent while every chunk it has written is delivered") and a
// moderation staging's replaceWaiting (test/admin-suspension.test.ts, "sends the restoration to a non-follower even
// when the profile is edited before it is staged"). This inventory fails on any other delete, which then needs a
// witness of its own.
const SOURCES = sources("src");

const EXPECTED = { "src/domain/deliveries.ts dropSettledActivity": 1 };

// A DELETE of outbound_activities in a string or template literal's decoded text (escapes resolved, an interpolation
// read as a space), the table quoted or not, across line breaks; each counted at its literal's owner.
const INTENT_DELETE = /\bDELETE\s+FROM\s+["`[]?outbound_activities\b/gi;

function sites(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const { program, literals } = parse(source);
    return literals.flatMap((literal) => {
      const text = literal.parts.map((part) => ("text" in part ? part.text : " ")).join("");
      return [...text.matchAll(INTENT_DELETE)].map(
        () => `${source.path} ${ownerOf(program, literal.node.start)?.name ?? "(top level)"}`,
      );
    });
  });
}

const violations = (all: readonly Source[]) => inventoryDiff(sites(all), EXPECTED);

describe("the deletes of an outbound intent", () => {
  it("are dropSettledActivity's one statement", () => {
    expect(violations(SOURCES)).toEqual([]);
  });

  guardFixtures(
    violations,
    {
      flagged: {
        "a second site": [
          "export function sweep(db) {\n\tdb.run('DELETE FROM outbound_activities WHERE id = ?', id)\n}",
          "src/domain/probe.ts sweep has 1, expected 0",
        ],
        "a newline between FROM and the table": [
          'const drop = (db) => db.run(`DELETE FROM\n\t\t"outbound_activities" WHERE id = ?`, id)',
          "src/domain/probe.ts drop has 1, expected 0",
        ],
        "an escaped quote around the table": [
          'const quoted = (db) => db.run("DELETE FROM \\"outbound_activities\\" WHERE id = ?", id)',
          "src/domain/probe.ts quoted has 1, expected 0",
        ],
        "an escaped newline before the table": [
          'const escaped = (db) => db.run("DELETE FROM\\noutbound_activities WHERE id = ?", id)',
          "src/domain/probe.ts escaped has 1, expected 0",
        ],
      },
      passed: { "a delete named in a comment": "// DELETE FROM outbound_activities\nf()" },
    },
    { over: SOURCES },
  );

  guardFixtures(
    violations,
    {
      flagged: {
        "a second delete in the same function": [
          [
            "function dropSettledActivity(db, id) {",
            "\tdb.run('DELETE FROM outbound_activities WHERE id = ? AND staged IS NULL', id)",
            "\tdb.run('DELETE FROM outbound_activities WHERE id = ?', id)",
            "}",
          ].join("\n"),
          "src/domain/deliveries.ts dropSettledActivity has 2, expected 1",
        ],
      },
      passed: {},
    },
    { path: "src/domain/deliveries.ts", over: SOURCES },
  );
});
