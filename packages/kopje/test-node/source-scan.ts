import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSync, visitorKeys, type Node, type Program } from "oxc-parser";
import { expect, it } from "vitest";

// The base of the source guards: tests that read the package's own code and assert a rule about it. Each reads its
// files with sources(), parses them with parse() (comments never count as code), and proves with guardFixtures()
// that its finder still flags what it must and passes what it may, through the same path as the real files.
//
// Parser: oxc-parser, through parseSync only. It reads TS and JS into ESTree (its JS output matches acorn's). The
// package's TypeScript 7 has no in-process compiler API, acorn reads no TypeScript, and Babel 8's AST is not ESTree
// without a plugin and is heavier. Offsets are UTF-16 code units, as String#slice counts them; parentheses are not
// kept as nodes (preserveParens: false), as in acorn.

export type Source = { path: string; text: string };

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));

// The files under `dir` (relative to the package, as 'src/domain') with one of `extensions`, declaration files left
// out, by their package-relative paths. A directory with none throws, so a guard cannot pass over nothing.
export function sources(dir: string, extensions: readonly string[] = [".ts", ".tsx"]): Source[] {
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        return walk(child);
      }
      return extensions.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts") ? [child] : [];
    });
  const files = walk(join(PACKAGE, dir))
    .map((path) => ({ path: relative(PACKAGE, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
  if (files.length === 0) {
    throw new Error(`no sources in ${dir}`);
  }
  return files;
}

// The package-relative path a relative specifier of `from` names (`../db/sql` from `src/web/a.ts` is `src/db/sql`).
export function resolve(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

// A string or template literal: its text parts and interpolated expressions in order, its ancestors (nearest first),
// and the name of the constant it initializes (`const NAME = '...'`, with or without `as const` or a type; never a
// `let` or `var`, which may be reassigned). An interpolated expression has its source (whitespace runs as one space), to
// show, and its keyOf(), to compare: the same under any formatter style.
export type Part = { text: string } | { expression: Node; source: string; key: string };
export type Literal = { node: Node; parts: Part[]; parents: Node[]; constant: string | null };

export type Parsed = {
  program: Program;
  // The text with every comment blanked, line breaks kept, so offsets and lines stay those of the file.
  code: string;
  literals: Literal[];
};

const parsed = new WeakMap<Source, Parsed>();

// The parse of a source, by its path's extension. A parse error throws: a guard does not skip what it cannot read.
export function parse(source: Source): Parsed {
  const cached = parsed.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const result = parseSync(source.path, source.text, { preserveParens: false });
  const error = result.errors[0];
  if (error !== undefined) {
    const at = error.labels[0]?.start;
    throw new Error(`${source.path}${at === undefined ? "" : `:${lineOf(source.text, at)}`}: ${error.message}`);
  }
  let code = "";
  let from = 0;
  for (const comment of result.comments) {
    code +=
      source.text.slice(from, comment.start) + source.text.slice(comment.start, comment.end).replace(/[^\n]/g, " ");
    from = comment.end;
  }
  code += source.text.slice(from);
  const literals: Literal[] = [];
  walk(result.program, (node, parents) => {
    if (node.type === "Literal" && typeof node.value === "string") {
      literals.push({ node, parts: [{ text: node.value }], parents, constant: constantOf(node, parents) });
    } else if (node.type === "TemplateLiteral") {
      const parts: Part[] = [];
      node.quasis.forEach((quasi, i) => {
        parts.push({ text: quasi.value.cooked ?? quasi.value.raw });
        const expression = node.expressions[i];
        if (expression !== undefined) {
          parts.push({
            expression,
            source: source.text.slice(expression.start, expression.end).replace(/\s+/g, " ").trim(),
            key: keyOf(expression),
          });
        }
      });
      literals.push({ node, parts, parents, constant: constantOf(node, parents) });
    }
  });
  const value = { program: result.program, code, literals };
  parsed.set(source, value);
  return value;
}

// The structural key of a node: its type and every property but its position and raw text, children by their keys, so
// two different trees never share one. Only what a formatter may change is normalised, here and nowhere else:
// - a string literal is its value (any quote, any escape);
// - a number is its value, tagged (`Num(1)`, `Num(Infinity)`), and a bigint its digits, tagged apart;
// - a static property key or enum member name, an identifier or a string, is `Key(name)` either way;
// - an empty statement in a statement list (`;`) is dropped; one that is a loop's or an if's body is kept;
// - parentheses are not nodes (ParenthesizedExpression and TSParenthesizedType are unwrapped; parse() keeps none).
// Line breaks, semicolons and trailing commas are not in the tree.
function keyOf(node: Node): string {
  const n = node as Node & Record<string, unknown>;
  if (n.type === "ParenthesizedExpression") {
    return keyOf(n.expression);
  }
  if (n.type === "TSParenthesizedType") {
    return keyOf(n.typeAnnotation);
  }
  if (n.type === "Literal") {
    if (typeof n.value === "string") {
      return `Str(${JSON.stringify(n.value)})`;
    }
    if (typeof n.bigint === "string") {
      return `BigInt(${BigInt(n.bigint).toString()})`;
    }
    if (typeof n.value === "number") {
      return `Num(${String(n.value)})`;
    }
  }
  const value = (v: unknown, owner?: string): string => {
    if (Array.isArray(v)) {
      const list =
        STATEMENT_LISTS[n.type] === owner ? v.filter((e) => (e as Node | null)?.type !== "EmptyStatement") : v;
      return `[${list.map((e) => value(e)).join(" ")}]`;
    }
    if (typeof v === "object" && v !== null && typeof (v as Node).type === "string") {
      const child = v as Node & Record<string, unknown>;
      const staticKey =
        (owner === "key" || (owner === "id" && n.type === "TSEnumMember")) &&
        n.computed !== true &&
        (child.type === "Identifier" || (child.type === "Literal" && typeof child.value === "string"));
      return staticKey
        ? `Key(${JSON.stringify(child.type === "Identifier" ? child.name : child.value)})`
        : keyOf(child);
    }
    return v === undefined ? "undefined" : JSON.stringify(v);
  };
  const fields = Object.keys(n)
    .filter((k) => !UNKEYED.has(k))
    .toSorted()
    .map((k) => `${k}=${value(n[k], k)}`);
  return `${n.type}{${fields.join(" ")}}`;
}

const UNKEYED = new Set(["type", "start", "end", "range", "loc", "raw"]);
// The property holding a statement list, by node type.
const STATEMENT_LISTS: Record<string, string> = {
  Program: "body",
  BlockStatement: "body",
  StaticBlock: "body",
  TSModuleBlock: "body",
  SwitchCase: "consequent",
};

// The structural key of `snippet`, one expression, parsed as TypeScript. It throws unless the snippet is exactly one
// expression, so a key written by hand (an allowlist entry) cannot silently name nothing: the parentheses it is parsed
// in must enclose the whole of it, so they cannot close a snippet such as `a) + (b`.
export function expressionKey(snippet: string): string {
  const text = `(${snippet}\n)`;
  const result = parseSync("snippet.ts", text, { preserveParens: true });
  const [statement, ...rest] = result.program.body;
  const expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
  if (
    result.errors.length > 0 ||
    rest.length > 0 ||
    expression?.type !== "ParenthesizedExpression" ||
    expression.start !== 0 ||
    expression.end !== text.length
  ) {
    throw new Error(`not one expression: ${snippet}`);
  }
  return keyOf(expression);
}

function constantOf(node: Node, parents: readonly Node[]): string | null {
  let child: Node = node;
  for (const [i, parent] of parents.entries()) {
    if (parent.type === "TSAsExpression" || parent.type === "TSSatisfiesExpression") {
      child = parent;
      continue;
    }
    const declaration = parents[i + 1];
    return parent.type === "VariableDeclarator" &&
      parent.init === child &&
      parent.id.type === "Identifier" &&
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
      ? parent.id.name
      : null;
  }
  return null;
}

// Visits `node` and every node below it in source order, each with its ancestors, nearest first.
export function walk(node: Node, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []): void {
  visit(node, parents);
  const inner = [node, ...parents];
  for (const key of visitorKeys[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (typeof child === "object" && child !== null && typeof (child as Node).type === "string") {
        walk(child as Node, visit, inner);
      }
    }
  }
}

export function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

// The top-level statement of `program` holding `offset`, with the name it declares (a function, a class, or the first
// declarator of a const, let or var, exported or not); `(top level)` for one that declares no name.
export function ownerOf(program: Program, offset: number): { name: string; start: number; end: number } | null {
  for (const statement of program.body) {
    if (statement.start <= offset && offset < statement.end) {
      const declaration =
        statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      let name: string | undefined;
      if (
        (declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") &&
        declaration.id !== null
      ) {
        name = declaration.id.name;
      } else if (declaration?.type === "VariableDeclaration") {
        const id = declaration.declarations[0]?.id;
        name = id?.type === "Identifier" ? id.name : undefined;
      }
      return { name: name ?? "(top level)", start: statement.start, end: statement.end };
    }
  }
  return null;
}

// An inventory guard's finding: each `file owner` key whose number of sites differs from `expected`'s (0 when it
// names none), so a new site, a second one in the same owner and a lost one each fail.
export function inventoryDiff(sites: readonly string[], expected: Readonly<Record<string, number>>): string[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...new Set([...counts.keys(), ...Object.keys(expected)])].toSorted().flatMap((key) => {
    const found = counts.get(key) ?? 0;
    const want = expected[key] ?? 0;
    return found === want ? [] : [`${key} has ${found}, expected ${want}`];
  });
}

// A fixture edit: replaces the one match of `pattern` (`$1` and the like as in String#replace) and throws unless it
// matches exactly once, so a fixture cannot silently stop editing the code it names.
export function editOnce(text: string, pattern: RegExp, replacement: string): string {
  const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"))].length;
  if (count !== 1) {
    throw new Error(`${pattern} matches ${count} times`);
  }
  return text.replace(pattern, replacement);
}

// The self-check of a guard: `find` (the guard's own finder, given sources) reports each `flagged` fixture's finding
// and nothing for each `passed` fixture. A fixture is the text of one file at `path`; with `over`, it joins those
// sources in place of the one at its path.
export function guardFixtures(
  find: (sources: Source[]) => readonly string[],
  cases: { flagged: Record<string, [text: string, finding: string]>; passed: Record<string, string> },
  { path = "src/domain/probe.ts", over = [] }: { path?: string; over?: readonly Source[] } = {},
): void {
  const sources = (text: string) => [...over.filter((s) => s.path !== path), { path, text }];
  it.each(Object.entries(cases.flagged))("flags %s", (_name, [text, finding]) => {
    expect(find(sources(text))).toContain(finding);
  });
  it.each(Object.entries(cases.passed))("passes %s", (_name, text) => {
    expect(find(sources(text))).toEqual([]);
  });
}
