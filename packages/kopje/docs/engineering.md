# Engineering rules

How Kopje code and tests are written so that the invariants of the [threat model](threat-model.md) and the rules of
[visibility.md](visibility.md) keep holding: for imported data, under concurrency and at the bounds. The threat model
says what holds; this page says how a change keeps it. A cap that drops protocol-visible data is a departure from
Mastodon, decided as [mastodon-deviations.md](mastodon-deviations.md) says.

## Ordering, rounds and fences

- **Fences and ordering use transactional state**: counters, ids, generations, CHECKs and compare-and-set in the
  Store's transaction, never a timestamp the caller supplies.
- **Work split between a request and rounds never handles an item twice and always continues from durable state**
  (for example, notification removal records its fixed `max_id` boundary, and every batch, the request's first ones
  included, deletes what is still at or below it). Each round changes the state of at least one due item whenever one
  exists, so it cannot stall, and the total work of a bulk delete, its cascades included, is bounded.
- **A refusal that must avoid network work runs before any network-capable step** (a DNS check, a fetch, a Store call
  that may lead to one).
- **A credential or `now` that a Store call uses is taken after any await on network work**, never before it, and a
  writing path checks the Store's flags and the maintenance mode before any network-capable step.

## Bounds

- **Every bound names its unit**: JSON-escaped UTF-8 bytes, UTF-8 bytes, code points or UTF-16 code units. Its test
  measures in that unit, with NUL and astral characters among its inputs.
- **Bounds are checked where data crosses into the Worker and where it is returned**, after every expansion: JSON
  escaping, HTML sanitizing, hydration of nested entities, delete cascades. Tests assert the materialized rows or bytes,
  not the inputs.
- **Bounds hold for cutover-converted rows and legacy imports**, not only for what Kopje's writers produce; a growth
  test includes a converted-row fixture.
- **Measure a unit's maximum before setting an aggregate budget over it.**
- **Presented maxima are derived by a test** from the column caps at the worst JSON escaping; measured fills are
  witnesses at or below the derived figure. Each endpoint's maximum comes from its own bounds (RES-3, "Maxima of
  presented units", is the table they feed).
- **A memory bound that rests on an estimate has a runtime backstop** that counts bytes as they are read. Memory peaks
  are computed by a test from per-column maxima, never by arithmetic in prose.

## Stored values

- **A new stored column or setting gets a stored bound that holds for imported values**, judged in order: the raw
  bytes first, then NUL anywhere, then the structure. Its writer drops what the trigger would refuse by sharing the
  trigger's acceptance rule, so a write never fails on it, and its presenter never throws on a stored value (RES-2,
  "stored values", applies this per column).
- **Every presented string or href passes its raw bound and its escaped-JSON bound after UTF-8 decoding**, through one
  shared helper per kind. A stored-bound predicate refuses NUL inside decoded JSON elements too, not only in the raw
  text.
- **A presented URL is judged twice**: on the decoded stored value before normalization, and on the normalized result
  after it. A value shown in its stored spelling refuses the characters that end or split an HTML attribute or a URL.
- **Imported TEXT may be malformed UTF-8 or non-canonical.** Compare, cut and identify stored values in SQL by bytes;
  never write a decoded string back as an identity; validate stored times with `isoTimeSql`
  (`src/platform/stored-bounds.ts`); pad a normalized id to its stored form before comparing (DATA-6).
- **A new write-time invariant means auditing every path that copies a stored value** (edits, snapshots, moves,
  conversions), and such copies are kept in SQL.
- **Before reading an existing column into the Worker, check its migration** for a CHECK or a trigger. A column bound
  only by its type affinity is projected in SQL before JavaScript sees it.

## Queries

- **A query bound is shown by `EXPLAIN QUERY PLAN` of the production SQL** at saturation with stale statistics
  (`ANALYZE` taken before the data grew), and a regression witness crosses the real cap. A query joining a large table
  pins its join order (`CROSS JOIN`, `INDEXED BY`) wherever stale statistics could choose a scan (RES-7).
- **A cap counts raw candidates before any residual predicate**: an inner stage reads the candidates by the walk's
  index and the predicate is applied outside it (paged reads: [visibility.md](visibility.md), "Read bounds"). Where
  passing the cap must be detected (a refusal or a cut past it), the inner stage reads cap + 1.
- **A page may hold fewer rows than its limit only when its continuation is derived from the rows it consumed**, so no
  row is skipped (for example, an answer cut by its byte budget links on from the last row it consumed). A row is never
  dropped after the page's own `LIMIT`/`OFFSET` without the continuation moving past it.
- **A range on an optional cursor is a direct range** ([visibility.md](visibility.md), "Read bounds";
  `test-node/range-predicates.test.ts`).
- **workerd refuses `LIKE` and `GLOB` patterns over 50 bytes**; a pattern is kept within that.

## Tests

- **A concurrency test holds one actor at an explicit await point while the other commits** (`Promise.all` alone is
  not a gate), runs the production paths, and crosses the real step boundaries (Store calls, rounds, network awaits).
- **A test that expects a refusal, an absence or `false` also shows that the guarded branch ran**, so it cannot pass
  because the input never reached the check.
- **A benchmark asserts that it ran the path it claims to time.**
