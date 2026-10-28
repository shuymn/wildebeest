import { readFileSync } from "node:fs";

import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import mastodon from "../test/fixtures/mastodon-4.5.11-api-access.json" with { type: "json" };
import {
  deviationIds,
  deviationsCited,
  type Exception,
  type Exceptions,
  open,
  unresolvedFailures,
} from "../test/mastodon-conformance.js";
import { PARAM_EXCEPTIONS } from "../test/mastodon-params-exceptions.js";
import { guardFixtures, parse, sources, type Source } from "./source-scan.js";

// Every field Mastodon's serializers emit (the fixture's entities, read from Mastodon's source by
// scripts/mastodon-scopes.mjs) is a property of Kopje's response type for that entity, and no property of those types
// is typed as a constant placeholder (`null`, `[]`, `never[]`), which a client reads as "always empty". A field whose
// type is right but whose value is wrong is out of reach: Instance and Preferences are not entities of the fixture,
// so their values (usage.users.active_month, languages, reading:autoplay:gifs) are guarded by their contract tests
// (test/instance.test.ts, test/account-reads.test.ts) alone.
// Departures are exceptions of the same shape as the parameter check's (test/mastodon-conformance.ts).

type Target = { file: string; typeName: string; property?: string };
type Mapping = Target | { deferred: string };
type FixtureEntity = { fields: readonly { name: string; optional: boolean }[]; unresolved: readonly string[] };

// Each entity's Kopje type; a nested entity names the property of its parent type that holds it. Explicit: nothing is
// inferred from field types.
const MAPPING: Record<string, Mapping> = {
  "REST::AccountSerializer": { file: "src/domain/accounts.ts", typeName: "Account" },
  "REST::AccountSerializer::FieldSerializer": { file: "src/domain/accounts.ts", typeName: "Field" },
  "REST::CredentialAccountSerializer": { file: "src/domain/accounts.ts", typeName: "CredentialAccount" },
  "REST::CredentialAccountSerializer#source": {
    file: "src/domain/accounts.ts",
    typeName: "CredentialAccount",
    property: "source",
  },
  "REST::StatusSerializer": { file: "src/domain/status-presenter.ts", typeName: "Status" },
  "REST::MediaAttachmentSerializer": { file: "src/domain/status-presenter.ts", typeName: "MediaAttachment" },
  "REST::PollSerializer": { file: "src/domain/poll-presenter.ts", typeName: "Poll" },
  "REST::PreviewCardSerializer": { file: "src/domain/status-presenter.ts", typeName: "PreviewCard" },
  "REST::TagSerializer": { file: "src/domain/tags.ts", typeName: "Tag" },
  "REST::NotificationSerializer": { file: "src/domain/notifications.ts", typeName: "Notification" },
  "REST::NotificationGroupSerializer": { file: "src/domain/notification-groups.ts", typeName: "NotificationGroup" },
  "REST::RelationshipSerializer": { file: "src/domain/accounts.ts", typeName: "Relationship" },
  "REST::ApplicationSerializer": { file: "src/mastodon/oauth.ts", typeName: "Application" },
  "REST::CredentialApplicationSerializer": { file: "src/mastodon/oauth.ts", typeName: "CredentialApplication" },
  "REST::FilterSerializer": { file: "src/domain/filters.ts", typeName: "Filter" },
  "REST::AnnouncementSerializer": { file: "src/domain/announcements.ts", typeName: "Announcement" },
  "REST::AnnouncementSerializer::AccountSerializer": {
    file: "src/domain/announcements.ts",
    typeName: "AnnouncementMention",
  },
  "REST::ReactionSerializer": { file: "src/domain/announcements.ts", typeName: "Reaction" },
};

const ACCOUNT: Record<string, Exception> = {
  ...open("missing (Mastodon emits it for a limited or memorial account)", "limited", "memorial"),
};

const ENTITY_EXCEPTIONS: Exceptions = {
  "REST::AccountSerializer": ACCOUNT,
  "REST::CredentialAccountSerializer": ACCOUNT,
  "REST::MediaAttachmentSerializer": { text_url: { status: "accepted", deviation: "MD-6" } },
  "REST::NotificationSerializer": open("the notification types that carry them are not sent", "event"),
  "REST::NotificationGroupSerializer": {
    ...open("the notification type that carries it is not sent", "event"),
    ...open("no annual report is generated, as on a stock Mastodon 4.5.11", "annual_report"),
  },
  "REST::AnnouncementSerializer": { statuses: { status: "accepted", deviation: "MD-4" } },
};

// Entities whose fixture entry has unresolved extraction, with exactly the reasons acknowledged.
const UNRESOLVED_ENTITIES: Record<string, string[]> = {};

// ---- Reading a type's properties ----

type Property = { name: string; type: Node };

// The declaration of a type alias or interface named `name` in a file's program.
function declaration(program: Node, name: string): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node) => {
    if ((node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") && node.id.name === name) {
      found = node;
    }
  };
  for (const statement of (program as Node & { body: Node[] }).body) {
    visit(
      statement.type === "ExportNamedDeclaration" && statement.declaration !== null ? statement.declaration : statement,
    );
  }
  return found;
}

// The properties of a type node, following intersections and aliases defined in the same file. Anything else throws
// with the reason: the guard never passes over a type it cannot read.
function properties(program: Node, node: Node, seen: readonly string[] = []): Property[] {
  switch (node.type) {
    case "TSTypeLiteral":
    case "TSInterfaceBody": {
      const members = node.type === "TSTypeLiteral" ? node.members : node.body;
      return members.map((member) => {
        if (member.type !== "TSPropertySignature" || member.computed || member.typeAnnotation === null) {
          throw new Error(`cannot read member ${member.type}`);
        }
        const key = member.key;
        const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
        if (name === null) {
          throw new Error(`cannot read key ${key.type}`);
        }
        return { name, type: member.typeAnnotation.typeAnnotation };
      });
    }
    case "TSIntersectionType":
      return node.types.flatMap((type) => properties(program, type, seen));
    case "TSTypeReference": {
      const name = node.typeName.type === "Identifier" ? node.typeName.name : null;
      const target = name === null || node.typeArguments !== null ? undefined : declaration(program, name);
      if (name === null || target === undefined || seen.includes(name)) {
        throw new Error(`cannot follow ${name ?? "a qualified name"} (not an alias of this file)`);
      }
      return typeProperties(program, target, [...seen, name]);
    }
    default:
      throw new Error(`cannot read a ${node.type}`);
  }
}

function typeProperties(program: Node, decl: Node, seen: readonly string[]): Property[] {
  if (decl.type === "TSTypeAliasDeclaration") {
    return properties(program, decl.typeAnnotation, seen);
  }
  if (decl.type === "TSInterfaceDeclaration") {
    if (decl.extends.length > 0) {
      throw new Error(`cannot follow the interface ${decl.id.name}'s extends`);
    }
    return properties(program, decl.body, seen);
  }
  throw new Error(`cannot read a ${decl.type}`);
}

// A constant placeholder: the literal null, an empty tuple, or never[], directly or through aliases of the same file
// (a cycle of aliases is no placeholder).
function constant(program: Node, type: Node, seen: readonly string[] = []): string | null {
  if (type.type === "TSTypeReference" && type.typeName.type === "Identifier" && type.typeArguments === null) {
    const name = type.typeName.name;
    const decl = seen.includes(name) ? undefined : declaration(program, name);
    return decl?.type === "TSTypeAliasDeclaration" ? constant(program, decl.typeAnnotation, [...seen, name]) : null;
  }
  if (type.type === "TSNullKeyword") {
    return "null";
  }
  if (type.type === "TSTupleType" && type.elementTypes.length === 0) {
    return "[]";
  }
  if (type.type === "TSArrayType" && constant(program, type.elementType, seen) === "never") {
    return "never[]";
  }
  if (type.type === "TSNeverKeyword") {
    return "never";
  }
  return null;
}

function targetProperties(all: readonly Source[], target: Target): { program: Node; props: Property[] } {
  const source = all.find((s) => s.path === target.file);
  if (source === undefined) {
    throw new Error(`${target.file} not found`);
  }
  const { program } = parse(source);
  const decl = declaration(program, target.typeName);
  if (decl === undefined) {
    throw new Error(`no type ${target.typeName} in ${target.file}`);
  }
  const props = typeProperties(program, decl, [target.typeName]);
  if (target.property === undefined) {
    return { program, props };
  }
  const nested = props.find((p) => p.name === target.property);
  if (nested === undefined) {
    throw new Error(`${target.typeName} has no property ${target.property}`);
  }
  return { program, props: properties(program, nested.type, [target.typeName]) };
}

// What fails of the entities: a Mastodon field missing from its Kopje type, a property typed as a constant
// placeholder, an exception that no longer applies, a type the reader cannot follow, unresolved extraction not
// acknowledged.
function findings(
  all: readonly Source[],
  mapping: Record<string, Mapping>,
  entities: Record<string, FixtureEntity>,
  exceptions: Exceptions,
  acknowledged: Record<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const [entity, theirs] of Object.entries(entities)) {
    out.push(...unresolvedFailures(theirs.unresolved, acknowledged[entity]).map((f) => `${entity}: ${f}`));
    const map = mapping[entity];
    if (map === undefined) {
      out.push(`${entity}: not mapped to a Kopje type`);
      continue;
    }
    if ("deferred" in map) {
      continue;
    }
    let read: ReturnType<typeof targetProperties>;
    try {
      read = targetProperties(all, map);
    } catch (error) {
      out.push(`${entity}: ${(error as Error).message}`);
      continue;
    }
    const { program, props } = read;
    const flagged = new Map<string, string>();
    for (const field of theirs.fields) {
      if (!props.some((p) => p.name === field.name)) {
        flagged.set(field.name, `missing from ${map.file} ${map.typeName}${map.property ? `.${map.property}` : ""}`);
      }
    }
    for (const prop of props) {
      const placeholder = constant(program, prop.type);
      if (placeholder !== null && placeholder !== "never") {
        flagged.set(prop.name, `typed as the constant ${placeholder}`);
      }
    }
    const own = exceptions[entity] ?? {};
    for (const [name, problem] of flagged) {
      if (own[name] === undefined) {
        out.push(`${entity}: ${name} ${problem}`);
      }
    }
    for (const name of Object.keys(own)) {
      if (!flagged.has(name)) {
        out.push(`${entity}: ${name} no longer departs; remove its exception`);
      }
    }
  }
  for (const entity of Object.keys(exceptions)) {
    if (entities[entity] === undefined) {
      out.push(`${entity}: not an entity of the fixture; remove its exceptions`);
    }
  }
  for (const entity of Object.keys(acknowledged)) {
    if (entities[entity] === undefined) {
      out.push(`${entity}: not an entity of the fixture; remove its acknowledgement`);
    }
  }
  return out;
}

const ALL = sources("src");

describe(`entity fields match Mastodon v${mastodon.mastodon}`, () => {
  it("finds no field missing or typed as a placeholder beyond the exceptions", () => {
    expect(findings(ALL, MAPPING, mastodon.entities, ENTITY_EXCEPTIONS, UNRESOLVED_ENTITIES)).toEqual([]);
  });

  it("cites only defined deviations, and every deviation is cited by an exception of either check", () => {
    const defined = deviationIds(readFileSync(new URL("../docs/mastodon-deviations.md", import.meta.url), "utf8"));
    const cited = new Set(deviationsCited(PARAM_EXCEPTIONS, ENTITY_EXCEPTIONS));
    expect([...cited].filter((id) => !defined.includes(id))).toEqual([]);
    expect(defined.filter((id) => !cited.has(id))).toEqual([]);
  });

  it("maps every entity of the fixture and only those", () => {
    expect(Object.keys(MAPPING).toSorted()).toEqual(Object.keys(mastodon.entities).toSorted());
  });

  describe("the finder", () => {
    const PROBE: Record<string, Mapping> = {
      Probe: { file: "src/domain/probe.ts", typeName: "Probe" },
      "Probe#nested": { file: "src/domain/probe.ts", typeName: "Probe", property: "nested" },
    };
    const fields = (...names: string[]) => ({
      fields: names.map((name) => ({ name, optional: false })),
      unresolved: [],
    });
    const ENTITIES = { Probe: fields("a", "nested"), "Probe#nested": fields("x") };
    const find = (all: Source[]) => findings(all, PROBE, ENTITIES, {}, {});
    guardFixtures(find, {
      flagged: {
        "a missing field": [
          "export type Probe = { nested: { x: string } }",
          "Probe: a missing from src/domain/probe.ts Probe",
        ],
        "a null field": [
          "export type Probe = { a: null; nested: { x: string } }",
          "Probe: a typed as the constant null",
        ],
        "an empty tuple through an alias": [
          "type Base = { a: [] }\nexport type Probe = Base & { nested: { x: string } }",
          "Probe: a typed as the constant []",
        ],
        "never[] in a nested type": [
          "export type Probe = { a: string; nested: { x: never[] } }",
          "Probe#nested: x typed as the constant never[]",
        ],
        "a field missing from a nested alias": [
          "type Nested = { y: string }\nexport type Probe = { a: string; nested: Nested }",
          "Probe#nested: x missing from src/domain/probe.ts Probe.nested",
        ],
        "an alias of null": [
          "type Nothing = null\nexport type Probe = { a: Nothing; nested: { x: string } }",
          "Probe: a typed as the constant null",
        ],
        "an alias of an alias of []": [
          "type Empty = []\ntype None = Empty\nexport type Probe = { a: None; nested: { x: string } }",
          "Probe: a typed as the constant []",
        ],
        "an alias of never[]": [
          "type Never = never[]\nexport type Probe = { a: string; nested: { x: Never } }",
          "Probe#nested: x typed as the constant never[]",
        ],
        "an array of an alias of never": [
          "type No = never\nexport type Probe = { a: No[]; nested: { x: string } }",
          "Probe: a typed as the constant never[]",
        ],
        "a type it cannot follow": [
          "import type { Other } from './other'\nexport type Probe = Other & { nested: { x: string } }",
          "Probe: cannot follow Other (not an alias of this file)",
        ],
      },
      passed: {
        "real fields": "type Base = { a: string | null }\nexport type Probe = Base & { nested: { x: string[] } }",
        "a cycle of aliases": "type A = B\ntype B = A\nexport type Probe = { a: A; nested: { x: string } }",
      },
    });

    it("fails an exception that no longer applies, and passes one that does", () => {
      const all = [{ path: "src/domain/probe.ts", text: "export type Probe = { a: null; nested: { x: string } }" }];
      const gap = { status: "open", issue: 1, note: "n" } as const;
      expect(findings(all, PROBE, ENTITIES, { Probe: { a: gap } }, {})).toEqual([]);
      expect(findings(all, PROBE, ENTITIES, { Probe: { a: gap, nested: gap } }, {})).toEqual([
        "Probe: nested no longer departs; remove its exception",
      ]);
    });

    it("fails unresolved extraction unless acknowledged", () => {
      const all = [{ path: "src/domain/probe.ts", text: "export type Probe = { a: string; nested: { x: string } }" }];
      const entities = { ...ENTITIES, Probe: { ...ENTITIES.Probe, unresolved: ["x.rb: `attributes(*FIELDS)`"] } };
      expect(findings(all, PROBE, entities, {}, {})).toHaveLength(1);
      expect(findings(all, PROBE, entities, {}, { Probe: ["x.rb: `attributes(*FIELDS)`"] })).toEqual([]);
      expect(findings(all, PROBE, ENTITIES, {}, { Gone: [] })).toEqual([
        "Gone: not an entity of the fixture; remove its acknowledgement",
      ]);
    });
  });
});
