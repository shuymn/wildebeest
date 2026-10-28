import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { editOnce, parse, walk } from "./source-scan.js";

// The Store compares applied migrations with MIGRATIONS (src/db/migrations.ts) by position, so the registry is the
// files of migrations/ numbered from 0000 without a gap or a reused number. A gap released once stays: renumbering a
// released file would make every upgraded Store diverge.
const RETIRED: Record<number, string> = {
  27: "released as a gap in 0.1.0-rc.10 (0027_quotes landed as 0033_quotes)",
};

// The registry read by its syntax, not its text: each default import of a migrations/ file, and MIGRATIONS' entries
// by their name and the file their sql imports. An entry is an object literal of plain properties only: `name` (a
// string) and `sql` (an import) exactly once each, and at most `foreignKeys` beside them. A spread, a computed key or
// any other property throws, since it could carry a name or sql this reading would not see.
const ENTRY_KEYS = new Set(["name", "sql", "foreignKeys"]);

function registryOf(text: string): { name: string; file: string | undefined }[] {
  const imports = new Map<string, string>();
  const named: { name: string; sql: string }[] = [];
  walk(parse({ path: "src/db/migrations.ts", text }).program, (node) => {
    if (node.type === "ImportDeclaration") {
      const file = /^\.\.\/\.\.\/migrations\/(\w+)\.sql$/.exec(node.source.value)?.[1];
      const local = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier")?.local.name;
      if (file !== undefined && local !== undefined) {
        imports.set(local, file);
      }
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === "MIGRATIONS") {
      if (node.init?.type !== "ArrayExpression") {
        throw new Error("MIGRATIONS is not an array literal");
      }
      for (const element of node.init.elements) {
        if (element?.type !== "ObjectExpression") {
          throw new Error("a MIGRATIONS element is not an object literal");
        }
        const values = new Map<string, Node>();
        for (const p of element.properties) {
          if (
            p.type !== "Property" ||
            p.computed ||
            p.method ||
            p.shorthand ||
            p.kind !== "init" ||
            p.key.type !== "Identifier" ||
            !ENTRY_KEYS.has(p.key.name) ||
            values.has(p.key.name)
          ) {
            throw new Error("a MIGRATIONS entry has a spread, a computed, repeated or unknown key");
          }
          values.set(p.key.name, p.value);
        }
        const name = values.get("name");
        const sql = values.get("sql");
        if (name?.type !== "Literal" || typeof name.value !== "string" || sql?.type !== "Identifier") {
          throw new Error("a MIGRATIONS entry is not { name: a string, sql: an import }");
        }
        named.push({ name: name.value, sql: sql.name });
      }
    }
  });
  return named.map(({ name, sql }) => ({ name, file: imports.get(sql) }));
}

const REGISTRY = readFileSync(fileURLToPath(new URL("../src/db/migrations.ts", import.meta.url)), "utf8");
const entries = registryOf(REGISTRY);
const files = readdirSync(fileURLToPath(new URL("../migrations/", import.meta.url)))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.slice(0, -".sql".length));

describe("Store migration registry", () => {
  it("numbers the n-th migration n, from 0000, skipping only a retired number", () => {
    const expected: string[] = [];
    for (let n = 0; expected.length < entries.length; n++) {
      if (!(n in RETIRED)) expected.push(String(n).padStart(4, "0"));
    }
    expect(entries.map((e) => e.name.slice(0, 5))).toEqual(expected.map((n) => `${n}_`));
    const numbers = entries.map((e) => Number(e.name.slice(0, 4)));
    expect(numbers.filter((n, i) => i > 0 && n <= numbers[i - 1]!)).toEqual([]);
  });

  it("registers every file under migrations/ once, by its own name", () => {
    expect(entries.filter((e) => e.file !== e.name)).toEqual([]);
    expect(entries.map((e) => e.name).toSorted()).toEqual(files.toSorted());
  });

  // Each fixture is the registry with its first entry edited.
  const edited = (entry: string) => editOnce(REGISTRY, /\{ name: ['"]0000_initial['"], sql: m0000 \}/, entry);
  it.each([
    ["a spread inside an entry", "{ name: '0000_initial', sql: m0000, ...{ name: '0001_x', sql: m0001 } }"],
    ["a spread as an element", "...[]"],
    ["a repeated name", "{ name: '0000_initial', name: '0001_x', sql: m0000 }"],
    ["a computed key", "{ name: '0000_initial', sql: m0000, ['name']: '0001_x' }"],
    ["a string key", "{ name: '0000_initial', 'sql': m0000 }"],
    ["an unknown key", "{ name: '0000_initial', sql: m0000, file: m0001 }"],
    ["a shorthand sql", "{ name: '0000_initial', sql }"],
    ["no sql", "{ name: '0000_initial' }"],
  ])("refuses %s", (_case, entry) => {
    expect(() => registryOf(edited(entry))).toThrow(/MIGRATIONS/);
  });

  it("reads an entry in either formatter style, foreignKeys beside it", () => {
    expect(registryOf(edited('{ name: "0000_initial", sql: m0000, foreignKeys: "unchanged" }'))[0]).toEqual({
      name: "0000_initial",
      file: "0000_initial",
    });
  });
});
