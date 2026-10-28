// The comparison logic of the Mastodon conformance checks (test/mastodon-params*.test.ts for request parameters,
// test-node/mastodon-entities.test.ts for entity fields), kept free of the Workers runtime so both pools can import it,
// and the exception shape they share. Accepted deviations are defined in docs/mastodon-deviations.md (MD-n).

// A known departure from Mastodon: a gap tracked by an issue, or a decided deviation.
export type Exception =
  | { status: "open"; issue: number; note: string }
  | { status: "accepted"; deviation: `MD-${number}` };

// Exceptions by 'METHOD /path' (or entity), then by parameter (or field) name.
export type Exceptions = Record<string, Record<string, Exception>>;

// Open exceptions of #1142 for `names`, with the same note.
export const open = (note: string, ...names: string[]): Record<string, Exception> =>
  Object.fromEntries(names.map((name) => [name, { status: "open", issue: 1142, note }]));

// The route of `routes` with `method` and `path`, path parameters matched whatever their names.
export function sameRoute<R extends { method: string; path: string }>(
  routes: readonly R[],
  method: string,
  path: string,
): R | undefined {
  const shape = (p: string) => p.replace(/:\w+/g, ":");
  return routes.find((route) => route.method === method && shape(route.path) === shape(path));
}

// One read of a request parameter, as the spies of the parameter test record it: an accessor of Params, Hono's
// c.req.query/queries; `file` is Params#file, a declared file part (mastodon/params.ts).
export type ReadMethod = "get" | "has" | "getAll" | "list" | "objects" | "hasObject" | "query" | "queries" | "file";
// `fields`: for objects(), the members the returned records carry (a file part is among them only for a field the
// call lists in `files`).
export type Read = { method: ReadMethod; name: string; fields?: readonly string[] };

// Whether a read returns `name` (a fixture name in Params form). get/query/queries/file return their name; has and
// getAll read `n` and `n[]`; list reads `n[]`; objects returns whole records, so it covers `n[][f]` and `n[i][f]` for
// every member `f` a returned record carries (whether each member is then used is not established: a limit of this
// check). hasObject records presence only and covers no leaf: `poll[expires_in]` must itself be read.
export function covers(read: Read, name: string): boolean {
  switch (read.method) {
    case "get":
    case "query":
    case "queries":
    case "file":
      return name === read.name;
    case "has":
    case "getAll":
      return name === read.name || name === `${read.name}[]`;
    case "list":
      return name === `${read.name}[]`;
    case "objects": {
      const member = /^\[\d*\]\[([^\]]+)\]$/.exec(name.slice(read.name.length))?.[1];
      return name.startsWith(`${read.name}[`) && member !== undefined && (read.fields ?? []).includes(member);
    }
    case "hasObject":
      return false;
  }
}

// What one route's parameter check observed: the baseline's outcome, and for each fixture name the reads of the request
// that sent it.
export type RouteObservation = {
  baseline: { ok: true } | { ok: false; detail: string };
  reads: ReadonlyMap<string, readonly Read[]>;
};

export type ParamEvidence = {
  // The fixture's names and unresolved reasons for the route.
  names: readonly string[];
  unresolved: readonly string[];
  observation: RouteObservation;
  exceptions: Record<string, Exception> | undefined;
  // The UNRESOLVED entry for the route: the exact reasons acknowledged.
  acknowledged: readonly string[] | undefined;
};

// Failures of one route: a setup failure alone when the baseline did not answer as expected (never reported as a
// missing parameter); otherwise each name not read without an exception, each exception that no longer applies, and
// unresolved extraction not acknowledged exactly.
export function paramFailures(evidence: ParamEvidence): string[] {
  const { names, unresolved, observation, exceptions = {}, acknowledged } = evidence;
  if (!observation.baseline.ok) {
    return [`setup: the baseline request failed (${observation.baseline.detail})`];
  }
  const failures: string[] = [];
  for (const name of names) {
    const read = (observation.reads.get(name) ?? []).some((r) => covers(r, name));
    const exception = exceptions[name];
    if (!read && exception === undefined) {
      failures.push(`${name}: Mastodon reads it, Kopje does not (read it, or add an exception)`);
    }
    if (read && exception !== undefined) {
      failures.push(`${name}: read now; remove its exception`);
    }
  }
  for (const name of Object.keys(exceptions)) {
    if (!names.includes(name)) {
      failures.push(`${name}: not a parameter of the fixture's route; remove its exception`);
    }
  }
  failures.push(...unresolvedFailures(unresolved, acknowledged));
  return failures;
}

// Unresolved extraction fails unless acknowledged with exactly the same reasons; an acknowledgement of reasons the
// fixture no longer gives fails too.
export function unresolvedFailures(
  unresolved: readonly string[],
  acknowledged: readonly string[] | undefined,
): string[] {
  const same =
    acknowledged !== undefined &&
    acknowledged.length === unresolved.length &&
    acknowledged.every((reason, i) => reason === unresolved[i]);
  if (unresolved.length === 0 && acknowledged === undefined) {
    return [];
  }
  if (same) {
    return [];
  }
  return [
    `unresolved extraction ${JSON.stringify(unresolved)} is acknowledged as ${JSON.stringify(acknowledged ?? null)}` +
      " (acknowledge exactly the fixture reasons, or remove the entry)",
  ];
}

// The MD ids exceptions cite.
export function deviationsCited(...tables: Exceptions[]): string[] {
  return tables.flatMap((table) =>
    Object.values(table).flatMap((byName) =>
      Object.values(byName).flatMap((e) => (e.status === "accepted" ? [e.deviation] : [])),
    ),
  );
}

// docs/mastodon-deviations.md's ids, as its entries define them (`- **MD-1: ...**`).
export const deviationIds = (text: string): string[] => [...text.matchAll(/^- \*\*(MD-\d+):/gm)].map((m) => m[1] ?? "");
