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
  included, deletes what is still at or below it). A round that can run (its configuration is present and it is
  admitted) changes the state of at least one due item whenever one exists, so it cannot stall; a round that cannot
  run leaves its items as they are (push rounds without `VAPID_JWK`, RES-5). The total work of a bulk delete, its
  cascades included, is bounded.
- **Each family of rounds is its own error boundary** (`jobsRound` in `src/jobs/queue.ts`, RES-5): a Store family is
  one Store call, a Worker family one round of its own Store calls and fetches; a family's failure is logged and stops
  no other family, and only a Store refusal ends the round.
- **Each item of a round runs in its own savepoint, and a failure or a stall is recorded on the item** (the retry
  state of `src/domain/job-attempts.ts`, RES-5; inbound jobs: `runJobBatch` in `src/domain/inbox.ts`; every other
  family: `runJobItem`): a batch that throws or leaves work without moving its durable state (a progress write that
  changed a row, a cursor that advanced) counts an attempt; the item backs off and parks after its last, so it holds
  back no other item, and a progress write never rewrites unchanged state to look like progress. A family whose every
  batch moves a cursor, a phase or a row on, or ends its item, counts failures only. A family's selection takes a due
  retry first, and its pending answer comes from the same seeks, so a round with only parked or backing-off items asks
  for none. A request's first batch is such an item too: its failure leaves the request's own writes committed. A
  write that establishes a visibility or safety boundary (a hide, a mark, a block) is committed outside the item's
  savepoint, so a failed or parked item cannot undo it, and a new decision on an existing item resets its retry state
  with its generation, while a duplicate that changes nothing does not. A step without retry state (an unlock
  acceptance) isolates the part that can fail and keeps its cursor's advance outside it.
- **An operation may isolate a step in a savepoint** (`Db.savepoint`, `isolated` in `src/domain/job-attempts.ts`): a
  nested `transactionSync` inside the operation's transaction, so a step that throws rolls back alone and the operation
  goes on. The rollback does not reduce `total_changes()`, so a step's row budget is created inside the step. After an
  error SQLite cannot recover from, the operation fails at its commit and nothing commits; a Db without the capability
  (`op.run` outside the kernel without the storage's `transactionSync`) refuses the step.
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
- **What a page does once rendered is checked in the browser job** (`browser/`, `pnpm --filter kopje test:browser`,
  Chromium in CI): fixture pages from the real components under the production stylesheet and headers, with axe in both
  colour schemes. Layout, focus, disclosure state and CSP checks are cases there; markup contracts stay in parse5.
- **A workerd suite shares its worker with the suites run before it** (`vitest.config.ts`, without isolation): a test
  works on a Store of its own name, and what it leaves in module scope (a held call, a cache) is keyed per test or
  settles before the test ends, also when an assertion fails. The media bucket is emptied before each suite.
