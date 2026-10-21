# Kopje threat model

What Kopje protects, from whom, and the security invariants the code must keep, by ID (for example `ID-1`). It covers
security only; correctness, compatibility and design are reviewed against their own criteria.

**Keep it current.** A PR that adds an entry point, asset, trust boundary or accepted risk, or changes an invariant's
status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired with the reason.

## Status of an invariant

Each part of an invariant carries one of three statuses:

- _Enforced (main)_: the cited source and tests exist on `main`.
- _Planned (topic)_: not implemented; the text names what is missing.
- _Retired_: no longer applies, with the reason. Its ID is never reused.

A **Gap** note (`_Gap:_`) names a part that no test pins yet; that part does not count as enforced.

`test-node/threat-model.test.ts` holds the document to this contract:

- `_..._` emphasis is reserved for a status (`_Enforced (main)_`, `_Planned (topic)_`, `_Retired_`, each optionally
  followed by `:` or `.`) and for Gap notes; every invariant has a status, and no text names a branch.
- A status runs from its mark to the next status mark of the same invariant. Every _Enforced (main)_ part cites at
  least one file that exists: a path in a code span, relative to `packages/kopje` (from the repository root when it
  starts with `packages/` or `/`), a bare configuration file of the package (`wrangler.jsonc`, `package.json`,
  `vitest.config.ts`), or a migration by name (`0011_scheduled_statuses`). A part kept by configuration alone cites
  that file.
- Test names follow their file in parentheses: `test/a.test.ts` ("name", "other name"). Each name is a contiguous part
  of one title the file declares (the literal first argument of `it`, `test` or `describe`, after any `.each(...)` or
  other chain), so a name may shorten a title but never joins two. `…` stands for text a parameter or interpolation
  supplies: the parts around it appear in that order within one title. A name that is empty or only `…` is refused.
- In the entry-point table, each status is `main: <paths>` with at least one path, or exactly `Planned (topic)`.

Planned topics: the KV sweep (expired signed-fetch cache rows: NET-4, RES-4), remote media (a fetch sink for remote
media: NET-3) and restore (DATA-8).

## Deployment assumptions

- One operator, one Cloudflare account and domain, up to about 10 local accounts (which does not bound remote traffic,
  RES-6).
- One Worker does HTTP, Access and signature verification, fetching, sanitizing, delivery and the Queue. One SQLite
  Durable Object, the Store, holds all state; each operation runs in `transactionSync` with no external I/O.
- Access protects only `/oauth/authorize` and `/admin/*`, each with its own application; the Worker verifies the JWT.
- Media originals live in R2 and are re-encoded by Images. Backups are age-encrypted to an offline key.

**Out of scope:** a compromised Cloudflare account or platform, a compromised operator machine, and the operator acting
against their own instance. TLS is assumed between all parties.

## Assets

| ID  | Asset                                                                                                             | Why it matters                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A1  | Non-public posts (private, direct, limited), their edits and media                                                | Disclosure harms the people involved                                   |
| A2  | Local actor identity: profile and the right to publish as a local account                                         | Forgery speaks for a local user to the whole fediverse                 |
| A3  | Actor private keys, the instance actor key, `USER_KEK`                                                            | Possession forges A2 everywhere and cannot be revoked quickly          |
| A4  | OAuth client secrets, access tokens and authorization codes                                                       | Possession acts as the user or app within the granted scopes           |
| A5  | Admin authority: the configuration rows, the service-token identity, `IMPORT_TOKEN`, import session credentials   | Possession can dump, import, reconfigure or reset the Store            |
| A6  | Setup authority: `SETUP_TOKEN` and the short-lived Cloudflare API token used by `/setup`                          | Possession fixes the domain, the Access applications and the admin     |
| A7  | VAPID keys and Web Push subscriptions (endpoints and keys)                                                        | Regeneration breaks every subscription; endpoints are delivery targets |
| A8  | Dumps, backups, R2 originals and backup storage credentials                                                       | Dumps hold A1, wrapped A3, client secrets, token digests and emails    |
| A9  | Private derived copies: signed-fetch cache rows (`fedify_kv`), spooled inbox bodies, outbound intents, deliveries | They hold A1 outside the tables that enforce visibility                |
| A10 | Integrity of relationships, counters and notifications                                                            | Forged edges change who receives A1                                    |
| A11 | Availability and cost: Store CPU and storage, Queue, R2, Images quota                                             | The Store is a single point of service, and the operator pays          |

## Adversaries

| ID  | Adversary                                          | Capabilities                                                                                    |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| R1  | A remote server or actor, malicious or compromised | Sends signed or unsigned activities; serves arbitrary documents and redirects; controls its DNS |
| R2  | An anonymous internet client                       | Calls any public route with arbitrary methods, headers and bodies                               |
| R3  | A third-party OAuth app, or a stolen token         | Holds a token with some scopes for one local account, or an app token                           |
| R4  | Another local account on the same instance         | Holds full user scopes for its own account                                                      |
| R5  | A holder of a leaked dump, backup or log           | Reads files offline                                                                             |
| R6  | A person who passes Access but is not the admin    | Holds a valid Access JWT for the sign-in application                                            |
| R7  | A malicious website visited by a signed-in user    | Makes the user's browser send requests, submit forms and frame pages                            |
| R8  | A supplier of altered restore or cutover input     | Provides a dump, manifest or legacy export that is not what the operator selected               |

## Entry points

| Entry point                                                    | Reached by | Authenticated by                                              | Status and code                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /inbox`, `/ap/users/:username/inbox`, `/actor/inbox`     | R1, R2     | HTTP signature, also on replay from the spool                 | main: `src/federation/inbound.ts`                                                                                                                                                                                                                                                                            |
| Actor, `/actor`, WebFinger, NodeInfo, followers and following  | R1, R2     | none (public)                                                 | main: `src/federation/*`                                                                                                                                                                                                                                                                                     |
| `/ap/o/:uuid`, status documents and the outbox                 | R1, R2     | none (VIS-4)                                                  | main: `src/federation/federation.ts`                                                                                                                                                                                                                                                                         |
| Outbound document fetches                                      | R1 answers | final URL and parsed id (ID-2)                                | main: `src/federation/loader.ts`                                                                                                                                                                                                                                                                             |
| Deliveries, remote media fetches, Web Push POSTs               | R1 answers | sink policy (NET-3)                                           | main: `src/federation/delivery.ts`, `src/jobs/push.ts`; Planned (remote media: NET-3)                                                                                                                                                                                                                        |
| Mastodon API `/api/*`                                          | R2–R4, R7  | bearer token and route access                                 | main: `src/mastodon/*`, `src/domain/auth.ts`                                                                                                                                                                                                                                                                 |
| Mastodon admin API `/api/v1/admin/*`, `/api/v2/admin/*`        | R2–R4      | bearer token with an admin scope, of the OAuth admin (VIS-29) | main: `src/mastodon/admin.ts`, `src/domain/auth.ts`, `src/domain/admin-authority.ts`, `src/domain/reports.ts`, `src/domain/admin-*.ts`, `src/domain/suspension.ts`                                                                                                                                           |
| `/oauth/authorize`                                             | R2, R6, R7 | Access JWT, Origin, consent                                   | main: `src/app/authorize.tsx`                                                                                                                                                                                                                                                                                |
| `/oauth/token`, `/oauth/revoke`                                | R2, R3     | client credentials                                            | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/oauth/userinfo`                                              | R2, R3     | bearer token with `profile`                                   | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/.well-known/oauth-authorization-server`                      | R2         | none (public)                                                 | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/admin/*` and the `kopje-admin` CLI                           | R2, R6     | admin Access JWT, service token, `IMPORT_TOKEN`, session      | main: `src/app/admin.ts`                                                                                                                                                                                                                                                                                     |
| `/setup` and its Cloudflare API calls                          | R2, R7     | `SETUP_TOKEN`, then the admin's web session (SETUP-2)         | main: `src/app/setup.tsx`, `src/platform/cloudflare-api.ts`                                                                                                                                                                                                                                                  |
| Web UI (profiles, permalinks, embeds, settings)                | R2, R4, R7 | session (AUTH-8), Origin and form token (WEB-4)               | main: `src/app/web.tsx`, `src/web/*`                                                                                                                                                                                                                                                                         |
| Media upload and serving, Images transformation                | R2–R4      | bearer token; capability URL for reads                        | main: `src/mastodon/media.ts`                                                                                                                                                                                                                                                                                |
| Web Push registration                                          | R3         | bearer token with `push`                                      | main: `src/mastodon/push.ts`, `src/domain/push.ts`                                                                                                                                                                                                                                                           |
| Streaming API `/api/v1/streaming` (WebSocket)                  | R2–R4      | bearer token or subprotocol (VIS-26)                          | main: `src/mastodon/streaming.ts`, `src/stream-hub.ts`, `src/domain/streaming.ts`                                                                                                                                                                                                                            |
| Queue consumer, alarms, cron                                   | internal   | —                                                             | main: `src/jobs/queue.ts`, `src/platform/store-kernel.ts`                                                                                                                                                                                                                                                    |
| Delivery doorbell and cron (`src/jobs/deliver.ts`)             | internal   | —                                                             | main: `src/jobs/deliver.ts`                                                                                                                                                                                                                                                                                  |
| Dump import, backup restore, cutover tools                     | R5, R8     | admin authority, then digest chain and manifest               | main: `src/platform/store-import.ts`, `cli/lib/commands.js`, `cli/lib/cutover/*`, `src/app/cutover.ts` (import, `backup-verify`, `convert`, `verify-conversion`, `cutover-preflight`, `maintenance-worker`, `fingerprint`, `cutover`: DATA-10 to DATA-16, OPS-4, OPS-7 to OPS-10); Planned (restore: DATA-8) |
| Cutover maintenance worker (the legacy Pages routes, step 3)   | R1, R2     | none; inbox requests as above, on replay (OPS-1)              | main: `src/maintenance.ts` (OPS-6, OPS-7)                                                                                                                                                                                                                                                                    |
| Backup bucket (S3-compatible, outside Cloudflare) and its cron | R5, R8     | SigV4 credentials scoped to the prefix (DATA-9)               | main: `src/jobs/backup.ts`                                                                                                                                                                                                                                                                                   |

## Invariants

### Identity and inbound activities (ID)

- **ID-1: an inbound activity acts only for its signer.** It is processed only if its HTTP signature verifies, the key's
  owner equals `activity.actor`, and that actor is not local. An unsigned or unverifiable request changes nothing and
  answers 401. The owner is the actor whose document lists the key, by id and key material, and the key names no
  other owner. A stored key (`remote_keys`, kept per key id with its owner, whatever the shape of the key URL) is
  trusted for 24 hours after its document was fetched; after that, or when its signature fails, the key and the actor
  document are fetched anew, bypassing the document cache. The one exception is an actor's own `Delete` when its key (by the status its fetch actually returned) and
  its actor document both answer 404 or 410: it is verified with the stored key at any age. A live actor is never
  deleted with a key its current document does not list (401), and a transient failure answers 503. _Enforced (main):_ `receiveInbound` in `src/federation/inbound.ts`;
  `test/inbox.test.ts` ("ID-1: an inbound activity acts only for its signer"), `test/inbox-regressions.test.ts`
  ("stored keys, rotation and ownership"). A second exception: a `Delete` another server relays (a quoting server
  forwarding the quoted author's revocation of a quote's stamp, signed with its own key, as Mastodon forwards it). Its
  HTTP signer must own its key by the same rule; the `Delete` is applied as its `actor`'s only when it carries that
  actor's own proof, an RsaSignature2017 Linked Data Signature or an FEP-8b32 proof, which Fedify verifies against a key
  the actor's current document embeds (no other key is ever loaded), and only when the proven activity is a `Delete`
  with exactly the id, actor and object Kopje read. Applied, it reaches one handler, which acts only on what is neither
  an actor, a status nor a boost (so on a stamp at most). A relay without a proof is applied as nothing but a reason to
  verify the actor's accepted quote naming the stamp again; a proof that does not verify answers 401; any other
  activity signed by a key its actor does not own still answers 401. Fedify 2.4.4 refuses `@graph`, `@included` and
  `@reverse` (and their aliases) before and after compacting a signed document and verifies the compacted form it
  parses, the class of Linked Data Signature bypass Mastodon fixed in 4.5.10 (GHSA-53m7-2wrh-q839). _Enforced (main):_ `relayed` in `src/federation/inbound.ts`, `src/federation/author-proof.ts`,
  `relayedDelete` in `src/domain/inbox.ts`; `test/quotes.test.ts` ("relayed revocations (ID-1’s one exception)": a
  missing proof, a forged signature, a proof by another actor's key, a proof covering another object, a valid proof on
  another activity type and on the `Delete` of a status), `test/inbox.test.ts` ("records no retraction for input that
  fails ID-1"). Kopje's own stamp `Delete`s carry such a proof (VIS-28), so a server relaying one can be believed.
  See `src/federation/ld-sign.ts`, `test/quote-requests.test.ts` and `test-node/fedify-usage.test.ts`.
- **ID-2: a fetched document is trusted only for its own origin.** The identity of a fetched object is its parsed `id`
  after JSON-LD processing, and it must have the origin of the final response URL. The loader's literal `id` check is a
  pre-filter. Cross-origin redirects are refused. _Enforced (main):_ `src/federation/loader.ts`;
  `test/remote-identity.test.ts`, `test/loader.test.ts`.
- **ID-3: remote input never changes local actors or local objects.** No inbound activity updates, deletes, moves or
  attributes anything to a local account or local status. _Enforced (main)_ for actors and relationships: `upsertRemoteActor` and
  `localAccount` in `src/domain/inbox.ts`; `test/inbox.test.ts` ("a local actor URI is never written", "an actor updates
  only itself"). _Enforced (main)_ for statuses, favourites and boosts: a remote object
  must have its actor's origin and name no other author, and only its stored author updates or deletes it, so a local
  status is never created, updated or deleted from outside (`storeRemoteStatus` and `updateRemoteStatus` in
  `src/domain/remote-statuses.ts`, `deleteObject` in `src/domain/inbox.ts`); `test/inbox-statuses.test.ts` ("nobody
  remote updates a local one (ID-3)", "nothing of anyone else’s (ID-6, ID-3)").
- **ID-4: `Move` requires the alias.** A `Move` is honoured only if the freshly fetched target lists the source in
  `alsoKnownAs`. _Enforced (main):_ `prepare` in `src/federation/inbound.ts`, `move` in
  `src/domain/inbox.ts`; `test/inbox.test.ts` ("ignores a Move whose target does not list the actor"). The stored
  move (`accounts.moved_to_account_id`, shown as `Account#moved`) is display-only, the source's own claim as in
  Mastodon: an actor document's `movedTo` may name any stored account, and a verified `Move` sets it when first
  processed; followers move only on a verified `Move` (`upsertRemoteActor` and `move` in `src/domain/inbox.ts`;
  `test/inbox.test.ts` ("account moves")).
- **ID-5: local documents come from stored data only.** Actor ids derive from the domain fixed at setup and the stored
  username's exact spelling; public keys come from `local_accounts.pubkey`. Another spelling or host answers 404 and has
  no key pair. _Enforced (main):_ `src/federation/federation.ts`; `test/federation.test.ts` ("differently cased path",
  "another host, an unknown user, and the request host"), `test/signed-fetch.test.ts` ("no key pairs for a spelling").
- **ID-6: each activity type has a fixed authorization rule** (Mastodon 4.7.3's table, pinned by one negative test per
  row). The activity `id` has the actor's origin before any idempotency key is reserved. `Undo` requires the actor of
  the undone activity; `Accept` and `Reject` require the target of the matching `Follow`; `Update` and `Delete` require
  the object's current author, and an update never changes the author. A same-origin but different actor is refused like
  a cross-origin one. _Enforced (main)_ for Follow, Accept, Reject, Undo, Block, Move and
  Update and Delete of actors: the table in `src/domain/inbox.ts`; `test/inbox.test.ts` ("ID-6: the authorization
  table"). _Enforced (main)_ for Create, Update and Delete of statuses, Like and
  Announce (the rows of the same table): `Create` needs the actor's origin and no other `attributedTo`; `Update` and
  `Delete` the stored status's author (a refused `Delete` records no retraction); `Like` a local status the actor may
  see (VIS-1, which Mastodon does not check), whichever of `Like`, `EmojiReact` or `EmojiReaction` it is spelled as
  (an embedded `Undo` object too, `LIKE_TYPES` in `src/federation/inbound.ts`); `Announce` an original that is public,
  unlisted or the actor's own (VIS-6); `Undo` of a `Like` or `Announce` the actor's own, and of a `Like` only the
  actor's own favourite that tracks its id, or a legacy favourite of the status it names; `test/inbox-statuses.test.ts` ("ID-6: another actor of
  the same origin cannot update a status", "deletes the author’s status with its children, and nothing of anyone
  else’s (ID-6, ID-3)", "ID-6, ID-7: keeps an Undo that arrived before its Like", "ID-6, VIS-6: a boost of a private,
  direct or unfetchable object stores nothing"). _Enforced (main)_ for the `Delete` of a quote's
  stamp (FEP-044f's `QuoteAuthorization`, a row of the same table): only the quoted status's author revokes, and only
  the quotes of that author's statuses that name the stamp; the revocation is recorded once, for good, under the stamp
  and that author (`quote_revocations`), so the stamp never verifies a quote of that author's statuses again, and
  another actor's `Delete` of the same URI revokes nothing of theirs, and a `Delete` that arrived before the quote wins
  (ID-7). A received quote is accepted only as a self-quote or by a stamp fetched from its own id that passes every check
  (the quoted author's, on that author's origin, naming exactly this quote of exactly that status); a local quoted status
  is never accepted from outside. A quoted Note embedded in a status is taken only when it is that status's author's
  own (its `attributedTo` the author, its id on the author's origin), with one hop less of work. `revokeStamp` and `completeQuote` in `src/domain/quotes.ts`; `test/quotes.test.ts`
  ("is not taken from anyone but the quoted author", "leaves a quote pending when its stamp is …", "wins over a quote
  that arrives after it"). For locally authored quotes of remote statuses, `Accept`/`Reject` must come from the quoted
  author and name our request by id or inline it with our quoting status as instrument and their status as object.
  An `Accept`'s `result` must share their origin; `test/quote-authoring.test.ts` ("7: Accept and Reject are each one
  compare-and-set"). _Enforced (main)_ for `Flag` (a row of the same table): the actor is the reporter, available and
  not covered by a domain block (the inbox gate), and a domain block with `reject_reports` refuses it; the reported
  accounts are local ones named by exact actor id, or stored remote ones only with a named status of theirs replying
  to a local account (Mastodon's `flag.rb:15-17`), available (R1); a named status is attached only when it is the
  reported account's original and passes the remote reporter rule (R34, `remoteReportableSql`). Nothing is fetched.
  `fileRemoteReports` in `src/domain/reports.ts`; `test/inbox.test.ts` ("Flag: the actor is the reporter"),
  `test/inbox-flag.test.ts`.
- **ID-7: replay changes nothing twice.** A repeated activity creates no second relationship, counter change,
  notification, push or outbound intent (natural keys). A valid `Delete` or `Undo` that arrives before its target is
  recorded for 30 days and prevents the target from appearing later. Input that fails ID-1 or ID-6 reserves no key and
  records no retraction. _Enforced (main):_ natural keys and `retract` and `isRetracted` in
  `src/domain/inbox.ts`. A `Flag` files one report per Flag id and reported account (`UNIQUE (uri,
  target_account_id)`, migration `0054_remote_reports`): a redelivery writes nothing, and a Flag id past
  `ACTIVITY_ID_LIMIT` (4,096 JSON-escaped UTF-8 bytes) is ignored by the Worker and by the Store before any write,
  which the column's CHECK holds for dumps too (`test/inbox-flag.test.ts`). Report ids are never reused and remain
  within 18 digits. Migration 0054 starts the counter above retained references and holds the upgrade before writing
  when that start would pass 18 digits; exhaustion aborts the writer's whole transaction. See the migration header and
  `test/migrations.test.ts` (0054). A Follow has generations: a superseded, undone, refused or blocked Follow id is
  recorded as retracted, so no late Undo, Accept, Reject or replay reaches a newer generation, and no Accept or
  Reject is recorded twice; an answer's id derives from the Follow it answers; a new generation cancels the earlier generations' answers no claim
  has taken (NET-2). A Move is a job keyed by its id that never moves a follow made after
  it. An actor's deletion is a tombstone (`inbound_jobs`) independent of the retraction cap and TTL, honoured by every
  upsert and by every Move batch, and recorded even for a verified Delete of an actor never stored. A generation change
  whose retraction cannot be recorded (the per-actor cap) is not made: a Block, and a local reject of a request (which
  records the remote Follow as retracted and answers 503 if it cannot), change nothing then. Misskey's pair-shaped
  Follow id (`/follows/<a>/<b>`) is never recorded as retracted, whether the Undo or the stored edge carries it, so the
  same pair can undo a later generation; the exception applies only to a Follow: an Undo decides the undone type first
  (embedded, or a stored block with that id), and a Block id is always recorded whatever its shape (an untyped pair-shaped id that matches nothing is not: see the accepted risks); a `Reject` with a pair id matches our follow whatever its uri. Every Follow retraction (Undo,
  Block, a refused or superseded Follow, a local reject) goes through one helper (`retractFollow`) that never records a
  pair id, so on the reject path too a redelivered pair Follow asks again. A Block that takes a new id records its old
  id as retracted first (and changes nothing if it cannot), so a redelivered old Block does not come back after an
  Undo of the new one (and at the retraction cap the Block keeps its id, edges and deliveries). The limit is
  that a redelivered pair Undo or Reject after a new Follow cannot be told from a new one. `test/inbox.test.ts` ("ID-7: replay changes nothing twice", "OPS-1"), `test/inbox-regressions.test.ts`,
  `test/inbox-verify4.test.ts` ("keeps a Block with a pair-shaped id undone", "changes nothing when a Block takes a new
  id at the retraction cap").
  _Enforced (main)_ for statuses, favourites and boosts: a status, favourite or boost
  exists once per natural key (its uri; one favourite and one boost per account and status), so a repeated `Create`,
  `Like` or `Announce` adds no row or notification; a `Delete` or `Undo` that arrives first is recorded and keeps the
  object, favourite or boost from appearing, and a replay after it changes nothing; an `Update` applies only if its
  `updated` is newer than the last accepted version (`statuses.remote_version`, kept as the remote wrote it whether
  or not the change wrote history, and compared unclamped), so a reordered or repeated one changes nothing whenever it
  arrives; an `Update` dated more than 5 minutes ahead of the clock is ignored (no change, history or notification)
  until the clock reaches it; a status whose `Delete` was recorded takes no `Update`. A `Delete` of an unknown object
  of the actor's origin is recorded for that actor only, so it cannot suppress another actor's objects never seen
  here; the `Delete` of a stored status or boost is also recorded for every actor (`ANY_ACTOR`), so nobody, another
  actor of the same origin included, creates or updates that uri again (bounded by the authors' caps: it is written
  only with the author's own retraction of the uri, which counts against the author's cap, and expires and is swept
  with it). A change whose retraction cannot be recorded (the per-actor cap) is not made: the `Delete` of a stored
  status or boost, and an `Undo` of a `Like` or `Announce`, answer 503 and the whole receive transaction rolls back,
  the actor document and keys refreshed for it included (`RetryLater`, turned into the answer by the Store's RPC); a
  `Delete` of an unknown object at the cap is not recorded and answers 202, and an untyped `Undo` that matches nothing
  stored answers 503 (it may name a `Like` or `Announce` on its way), while one naming a stored follow or block keeps
  its answer. A remote favourite (one per actor and status) tracks the ids of the actor's `Like`s of it whose `Undo`
  has not arrived (`favourite_likes`, migration `0052_favourite_likes`) and exists while it tracks one: a server that
  replaces a reaction undoes the old `Like` and sends a new one, and they arrive in any order, so an `Undo` removes
  only its own id and records only it; a `Like` id is tracked once in the instance (`favourite_likes_uri` is unique,
  for imports too, so another actor's `Like` under it is ignored and its `Undo` reaches only its own), and one past
  `ACTIVITY_ID_LIMIT` (4,096 JSON-escaped UTF-8 bytes, a CHECK for imports) is not stored. An `Undo` naming a status the actor holds a legacy
  favourite of (one with no id at all: the cutover keeps none for a remote favourite) removes it, as
  Mastodon's `undo_like` finds the favourite by its object; a `Like` of it makes it tracked. A favourite stored before
  that migration retains its `Like` id in `favourites.uri` as one of its outstanding ids, counted under the cap, never
  retired, held instance-wide like a tracked one, and cleared only by its own `Undo`, typed or not, even after a
  `Delete` of the id tombstoned it; the favourite goes when no outstanding id remains. A favourite with an id of its
  own, tracked or retained, goes only by an `Undo` of one of its ids; the fallback by object applies only to an
  id-less (converted) one, so an `Undo` that overtakes its `Like` never removes it. Accepted limits: old data holding
  the same id on several of one actor's favourites has only one of them ended by that id's `Undo`, and a retained id
  whose `Undo` was lost for good keeps one of its favourite's 4 slots (the tracked ones still retire by age). These stored matches come
  first; then an `Undo` of a `Like` naming anything but a local original records nothing (Mastodon's `undo_like`), so
  a server's Undos of reactions to other servers' notes, which it also sends to the reactor's followers, spend no
  tombstone. A favourite tracks at most `MAX_TRACKED_LIKES` (4) ids (a trigger holds it for imports too); at the cap
  a further `Like` answers 503 with nothing written, and the `Undo`s it waits for make room, except that the earliest
  id the Store received `LIKE_RETIRE_AFTER_MS` (7 days, above Mastodon's and Misskey's delivery retry windows) before,
  by its own clock (never the Worker's), is retired for it and recorded as retracted, so ids whose `Undo` was lost
  for good never strand the pair and a replay of a retired `Like` does not come back; a younger id never is, and
  without room for the retraction nothing is written (503). A local boost of a status that is
  deleted while its author is purged is withdrawn once: the boost row's own marker (`statuses.withdrawn`) records
  that its Undo was recorded, whichever job did it, and lives until the boost is deleted, however soon the intent
  itself goes once its deliveries settle; both jobs wait for the intent's staging before they delete the boost.
  `test/inbox-statuses.test.ts` ("ID-7: duplicate and reordered Create and Delete", "ignores an Update that is not
  newer"), `test/inbox-statuses-edge.test.ts` ("ID-7: the Update watermark", "leaves nothing for every order of
  Create, Update and Delete", "ID-7: retractions at the per-actor cap", "removes only its own id", "withdraws a local
  boost once", "ID-7: a retryable refusal commits nothing", "ID-6, ID-7: a deleted status is not created again by anyone",
  "after its deliveries are done"), `test/inbox-reactions.test.ts` (every arrival order of three reactions and their
  Undos, a burst retried after its 503s, "is retired by the Store’s clock", "Like ids are unique instance-wide, and bounded", "Undos at the
  retraction cap", "records no
  tombstone, unless a stored favourite needs it removed", "a legacy favourite of a local status").
- **ID-8: only ActivityStreams media types become objects.** A fetched document is used as an actor, key or object only
  if served as `application/activity+json` or `application/ld+json` with the ActivityStreams profile, as Mastodon
  requires, and only if its root is a JSON object (JSON-LD would fetch a string root through the context loader). Other
  JSON (an uploaded file, for example) is refused, and a combined or malformed Content-Type is refused. Signed-document
  cache entries live under a versioned namespace that is bumped whenever this policy is tightened. _Enforced (main):_ `createSafeLoader` and `requireObjectRoot` in `src/federation/loader.ts` (Fedify's
  document loaders, around their caches too) with `isActivityPubMediaType` in `src/platform/media-type.ts`; JSON-LD
  contexts go through `createContextLoader`, which never yields an object; `SIGNED_DOCUMENT_PREFIX` in
  `src/federation/federation.ts`; `test/loader.test.ts`, `test/media-type.test.ts`, `test/document-root.test.ts`,
  `test/signed-fetch.test.ts` ("plain JSON-LD on the context loader only", "unversioned namespace").

### Visibility (VIS)

Content authorization (may this viewer see this status at all) is separate from filtering (does this viewer want it in a
list). VIS-1 to VIS-4 are authorization; VIS-5 is filtering.

- **VIS-1: one rule decides who may see a status**, Mastodon's `StatusPolicy#show?`: the statuses of an unavailable
  author (a suspended local account, or a remote account whose deletion has started) are seen by nobody; the author sees all their own; an author who blocks the viewer hides everything from them; `public`
  and `unlisted` are seen by everyone else; `private` by accepted followers and the mentioned (silent included);
  `direct` and `limited` by the mentioned (silent included) only. Every read path uses the same SQL rule, from the one policy module (`docs/visibility.md`; `test-node/policy-boundary.test.ts` keeps the rule out of other modules). A remote account is unavailable from the first transaction of its purge (`accounts.deleted_at`), so nothing of it is shown while the purge's batches remove its relationships and statuses (`test/inbox-regressions.test.ts` ("shows nothing of the actor from the Delete on")). _Enforced (main):_ `src/domain/audience.ts` (`visibleSql`, `canView`); `test/audience.test.ts`,
  `test/visibility.test.ts` (single status, context, history, source, `favourited_by`, timelines, account statuses,
  notifications, bookmarks, favourites). _Enforced (main)_ for search: `src/domain/search.ts`;
  `test/search.test.ts` ("never returns a status the viewer may not see", "drops a boosted status that became
  inaccessible", hashtags only where a status with them is visible), `test/search-edge.test.ts` (hashtag candidates
  pass the rule before ranking and truncation, so hidden statuses neither hide nor crowd out a visible tag, hidden
  mentions included). Hashtag search is recent autocomplete over the viewer's own library windows and the newest
  public statuses, not a catalogue: a tag outside the windows is not found. _Gap:_ a status the viewer saved that later
  became hidden still takes a slot of the viewer's own window, which reveals that something changed, not what. Media
  URLs appear only in statuses that pass the rule (see the capability URL accepted risk). The object endpoint serves only what VIS-4 allows. The web UI's public pages apply the rule with no viewer: _Enforced (main):_ `src/domain/web-pages.ts`; `test/web-pages.test.ts`. oEmbed (`GET /api/oembed`) and the embed page take the status page's read: `test/oembed.test.ts`.
- **VIS-2: limited stays limited.** A direct status with silent recipients (Misskey `specified`) is `limited`: shown
  only to its addressed recipients, presented as `private` by the API, never widened by an edit. _Enforced (main):_ `interpretAddressing` in `src/domain/audience.ts`; `test/audience.test.ts` ("reads Misskey
  specified"). _Enforced (main)_ for inbound statuses: addressing goes through
  `interpretAddressing`, including the owner of the personal inbox a status came to, and an edit never changes the
  visibility or adds a recipient to a private, direct or limited status; `test/inbox-statuses.test.ts` ("VIS-2: a
  Misskey specified note is limited", "never widens a private audience"). Outbound: each silent recipient gets a copy of its own at
  its personal inbox naming only itself in `to` (no Mention), because Misskey derives `visibleUsers` from `to` and
  `cc` only; the copy everyone else gets never names a silent recipient. So a silent recipient learns that it is
  addressed, and nothing about other silent recipients. A personal copy goes only to its recipient's personal inbox:
  if there is none, nothing is sent to them, never a substitute at a shared inbox, and the copy is kept as `gave_up`
  `no personal inbox` for the operator (it cannot be retried) and logged without identifiers. A personal copy never
  replaces the neutral copy for an inbox. _Enforced (main):_ `audienceTargets` and `bodyFor`
  in `src/domain/deliveries.ts`; `test/delivery-regressions.test.ts` ("sends each silent recipient a copy addressed to
  them alone", "never names a silent recipient in the copy for the followers"), `test/delivery-verify.test.ts` ("sends
  nothing to a silent recipient without a personal inbox", "POSTs each silent recipient a copy naming only them").
- **VIS-3: changes reach only the original audience.** `Update` and `Delete` are addressed to the audience the status
  already had; `Delete` carries a `Tombstone`, not the content. _Enforced (main):_
  `src/domain/activities.ts`; `test/statuses.test.ts` ("records Create, Update and Delete for the original audience
  only"). Delivery: _Enforced (main):_ silent recipients get the activity as VIS-2 says and
  are never named in the shared copy; a `Delete` or `Undo` also reaches every inbox that received the object or may
  still receive it (receipts, and the rows and unexpanded targets of earlier activities about it, leased ones
  included), and never any other. Deleting an original first records an `Undo(Announce)` for each local boost of it,
  with the same targets (a booster's followers may never have received the original, so its `Delete` would not reach
  them); only then does the cascade take the boosts and their receipts. Receipts belong to their status, and none is
  written once the status is gone or a retraction is pending (a retraction still staging its targets over a purge's
  batches reads them from the receipts, so they are still written until it is staged). An edit goes as an `Update` only to servers that have
  the object (a receipt or a `Create` in flight there); any other server gets a `Create` of the current version, which
  replaces a `Create` or `Update` still waiting for it. An `Update` supersedes earlier `Update`s only. `src/domain/deliveries.ts`; `test/deliveries.test.ts` ("VIS-3, VIS-7: a silent recipient",
  "VIS-3: a Delete reaches the inboxes that received the status"), `test/delivery-regressions.test.ts` ("sends a Delete
  to inboxes whose Create is still leased", "retires the receipts of local boosts"), `test/delivery-verify.test.ts`
  ("boosts that cascade with their original", "a destination that never received the Create", "retraction targets in
  every state"). Peer limitation: Misskey ignores `Update` of a Note, so edits do not reach Misskey users.
  A profile change (API or settings page, images and fields included) records an `Update` of the actor to Public for
  the followers, only when the published document changed; it replaces the earlier actor Updates still waiting, and
  is never turned into a Create. A suspended actor sends none. Publication of a cutover records the same Update for
  each local profile whose images the conversion changed (OPS-8). _Enforced (main):_
  `src/domain/actor-update.ts`, `enqueueActivity` in `src/domain/deliveries.ts`; `test/actor-update.test.ts`.
- **VIS-4: the object endpoint serves public and unlisted local statuses only.** `/ap/o/:uuid` and status documents
  answer for local `public` and `unlisted` statuses, as Mastodon does for an unauthenticated fetch. `private`, `direct`,
  `limited`, remote objects and statuses of suspended accounts answer 404, whether or not the request is signed.
  The Note is built by `noteOf`, the presenter of the outbound `Create`; the outbox lists the same statuses and boosts
  of public or unlisted originals. _Enforced (main):_ `getLocalNote` and `getOutbox` in
  `src/domain/activities.ts`, the object and outbox dispatchers in `src/federation/federation.ts`;
  `test/object-endpoint.test.ts`. Legacy aliases the cutover kept answer by the same rule (DATA-15): a remote proxy
  moves to a public original, a legacy image shows only with a servable status. Boosts (`Announce` ids) answer 404; Mastodon serves them. The permalink `/@user/:id`
  shows the same set as HTML, and answers every other case (private, direct, limited, a boost, a remote status, another
  author, a suspended author, no status) with the same 404 page; with an ActivityPub `Accept` it serves the object
  endpoint's Note. A profile page lists only the account's public and unlisted originals. _Enforced (main):_
  `statusPage` and `profilePage` in `src/domain/web-pages.ts`; `test/web-pages.test.ts` ("answers the same 404 for
  private, direct, limited, boosts, remote, another author and nothing", "hides the statuses of a suspended account").
- **VIS-5: lists also apply the viewer's filters**, Mastodon's `StatusFilter`. Feeds, context, notifications, bookmarks,
  favourites, `favourited_by` and `reblogged_by` drop authors the viewer blocks, mutes or domain-blocks. A single status
  by id is not filtered. A mute counts only until it expires (VIS-14), and home also drops a status or boosted
  original that mentions an account the viewer blocks or mutes (`FeedManager#filter_from_home`; VIS-13, VIS-14). _Enforced (main):_ `filteredForSql`, `listableSql` and `homeFilterSql` in
  `src/domain/audience.ts`; `test/audience.test.ts`, `test/visibility.test.ts` ("blocked and muted accounts stay out of
  lists"). _Enforced (main):_ a domain block matches an account by its stored domain
  and by the host of its actor id, the account's side normalized (lowercase, no port, no trailing dot) and compared with the block's stored, normalized domain through its index (`inDomainSql`, `domainBlocksSql`), everywhere a domain block applies (lists, notifications,
  relationships, inbound Follows and Moves, account search and search resolution), so an account confirmed under
  another WebFinger domain cannot escape a block of the server it lives on; `test/inbox-canonical-address.test.ts`
  ("applies a block of the actor’s host on every path", "never lets a third-party alias replace a confirmed domain or
  evade a block on it"). Account search finds an account that is available and not on a domain the viewer blocks
  (`findableBySql`). Search resolution answers an account only when account search would find it, and a status by the
  rule of a single status (VIS-1, `canView`, as Mastodon's `ResolveURLService` authorizes `show?`) unless the viewer
  blocks its author's domain. _Enforced (main):_ `findAccountIds` and `searchAccountIds` in
  `src/domain/accounts.ts`, `resolveSearch` in `src/domain/remote-statuses.ts`; `test/inbox-statuses.test.ts`
  ("answers a status by the single-status rule"), `test/policy-endpoints.test.ts`.
- **VIS-6: a wrapper reveals nothing its target hides.** A boost is visible only if its original is; boosting is limited
  to `public` and `unlisted` statuses and one's own `private` ones (`StatusPolicy#reblog?`). _Enforced (main):_ `viewableSql`; `test/visibility.test.ts` ("a boost of an original the viewer may not see is hidden
  with it"), `test/statuses.test.ts` ("refuses to boost direct and others’ private statuses"). A quote embeds its quoted
  status only as VIS-27 allows. _Enforced (main)_ for
  inbound boosts: an `Announce` is stored only for an original that is public, unlisted or the booster's own, decided
  before anything is stored, so a boost of a private, direct, limited or unfetchable object stores nothing (neither
  the boost nor the fetched original); an embedded copy of someone else's object is never trusted (it is fetched); a
  boost of an unlisted original stays out of the public timelines. The boost's own audience is kept: the known
  accounts its `to` and `cc` address are its silent recipients (bounded like a status's), so the audience rule
  decides who sees the wrapper, and a reblog notification is written and shown only while its recipient may see the
  sender's boost as well as the original (`shownSql` in `src/domain/audience.ts`, for local boosts too);
  `test/inbox-statuses.test.ts` ("VIS-6: a boost of a private, direct or unfetchable object stores nothing", "VIS-6:
  a boost of an unlisted object stays out of the public timelines"), `test/inbox-statuses-edge.test.ts` ("notifies a
  local author of a private boost only if they may see the boost", "hides an already written notification once its
  recipient may no longer see the boost").
- **VIS-7: silent recipients see, but are not mentioned.** A silent mention grants VIS-1 access only. It never appears
  in `mentions` and never produces a mention notification. _Enforced (main):_
  `src/domain/status-presenter.ts`, `src/domain/notifications.ts`; `test/visibility.test.ts` ("none for a silent
  recipient").
- **VIS-8: a pending follow grants nothing.** A follow of a locked local account or of any remote account starts
  `pending`; only `accepted` follows count, appear in follower lists, or grant `private` access. _Enforced (main):_
  `follow` in `src/domain/accounts.ts`; `test/accounts.test.ts` ("requests a locked or remote account", "lists following
  without pending requests"). `GET /api/v1/accounts/familiar_followers` reads accepted follows on both sides only,
  leaves out suspended accounts and the followers the viewer filters out of lists (VIS-5, VIS-14, VIS-15: blocks,
  mutes while they apply, domain blocks; `filteredForSql`), and shows no follow that the followers and following lists
  would not show the same viewer: _Enforced (main):_ `familiarFollowers` in
  `src/domain/accounts.ts`; `test/account-reads.test.ts` ("counts accepted follows only (VIS-8)", "leaves out
  accounts the viewer blocks or mutes", "shows a follower whose mute has expired, and hides one on a domain the viewer
  blocks", "shows no more than the followers and following lists show"). The followers and following lists
  (`GET /api/v1/accounts/:id/followers` and `/following`, Mastodon 4.5's `FollowerAccountsController` and
  `FollowingAccountsController`) read the viewer from an optional token and list nothing when the account is suspended,
  or, to anyone but the account itself, when it hides its network (`hide_collections`, set through `update_credentials`)
  or blocks the viewer; other viewers do not see the accounts they block, mute (while the mute applies) or are blocked
  by. Familiar followers show no followers of an account that hides its network, to anyone, the account itself included,
  and leave out a follower that hides its own (Mastodon's `FamiliarFollowersPresenter`). The ActivityPub followers and
  following collections of a suspended actor answer 404, and those of an actor that hides its network show `totalItems`
  only and answer a page with 403. A remote account's setting is learned as Mastodon's ProcessAccountService learns
  it (its followers or following collection shows no first page) and hides its lists the same way; one Kopje has not
  learned yet hides nothing, and a collection that cannot be read for now leaves what was learned unless the other
  one is known to hide its items (`src/federation/collections.ts`, `accounts.hide_collections`;
  `test/remote-collections.test.ts`). _Enforced (main):_ `followListsShownSql` and
  `followListedSql` in
  `src/domain/audience.ts`, `listFollows` and `familiarFollowers` in `src/domain/accounts.ts`, `getCollection` in
  `src/domain/actors.ts`; `test/accounts.test.ts` ("follower lists for the viewer (R13)"), `test/account-reads.test.ts`
  ("shows no followers of an account that hides its network"), `test/federation.test.ts` ("shows only the size of the
  collections of an actor that hides its network"), `test/policy-oracle.test.ts`, `test/policy-endpoints.test.ts`.
  Suggestions count only accepted edges readable under R13 and R12 (R39). Mastodon does not apply all of Kopje's
  source checks. Accepted inference from the raw edge window is described in
  [Suggestions](visibility.md#suggestions-r39). _Enforced (main):_
  `suggestionSourceSql` and `suggestionCandidateSql` in `src/domain/audience.ts`, `suggestions` in
  `src/domain/suggestions.ts`; `test/suggestions.test.ts`, `test/policy-endpoints.test.ts`.
- **VIS-9: only the followed side accepts.** A pending follow of a local account becomes `accepted` only by that
  account's own authorize call; a pending remote follow only by an `Accept` that passes ID-6. _Enforced (main):_ `answerFollowRequest` in `src/domain/accounts.ts` (`POST
/api/v1/follow_requests/:id/authorize` and `/reject`, the viewer from the credential; a remote requester gets the
  Accept or Reject at its shared inbox, or its personal inbox without one), and the inbound `Accept`, matched first by the `follows.uri` of our Follow;
  `test/inbox.test.ts` ("Accept: only the target of our Follow accepts it"), `test/inbox-regressions.test.ts` ("with
  outbound delivery").
- **VIS-10: a notification is emitted once.** It is written only if the recipient is local and may see the status, and
  only when new under its natural key; a repeat inserts nothing (`update` replaces the previous one). Its push is sent
  only for a newly inserted row. A remote favourite notifies when it is created and its notification goes with it, as
  Mastodon's does: a further `Like` it tracks notifies nothing, and an `Undo` followed by the next reaction's `Like`
  notifies (and pushes) again, while the reverse order does not; `test/inbox-reactions.test.ts` ("VIS-10: the
  favourite notification follows the aggregate"). _Enforced (main):_ `notify` in `src/domain/notifications.ts`;
  `test/statuses.test.ts` ("a retry has no second side effect"), `test/timelines.test.ts` ("notifies followers who
  asked to be notified, once"). Push: _Enforced (main):_ `notify` records pushes for the row it inserted only, never for a
  repeat (`queuePushes` in `src/domain/notifications.ts`); `test/push-send.test.ts` ("pushes every notification type
  Kopje emits, once each (VIS-10)").
- **VIS-11: earlier versions keep the original audience.** Edit history and earlier versions are visible only to the
  status's original audience, and an edit of a non-public status never widens that audience (a recipient added by an
  edit does not see earlier versions). This differs from Mastodon on purpose. _Enforced (main):_
  `editStatus` in `src/domain/statuses.ts`; `test/statuses.test.ts` ("a mention added by editing a direct status adds no
  recipient").
- **VIS-12: metadata reveals no hidden status.** Presenter fields never disclose a status the viewer may not see:
  `last_status_at` ignores `direct` and `limited` statuses; `in_reply_to_id` and `in_reply_to_account_id` follow an
  explicit rule for a parent the viewer may not see; `reblogged_by` lists only `public` and `unlisted` boosts and both
  interactor lists only accounts the viewer may see; a write response (such as deleting a boost) applies VIS-1 to every
  status it embeds, and `source` appears only on the viewer's own status. Aggregate counters are excepted (see accepted
  risks). Parent references follow Mastodon: `in_reply_to_id` and `in_reply_to_account_id` are shown even when the
  parent is hidden, because they belong to the reply (its ActivityPub object carries `inReplyTo` to every recipient);
  the parent itself stays behind VIS-1. _Enforced (main):_ `src/domain/status-presenter.ts`,
  `src/domain/statuses.ts`, `ACCOUNT_COLUMN_MAP` in `src/domain/accounts.ts`; `test/statuses.test.ts` ("review
  regressions"). A tag's `history` (`GET /api/v1/tags/:id`) counts only public originals (as Mastodon's
  `Trends::Tags`) of accounts that are not suspended, the same for every viewer, so it counts no status the caller may
  not see: _Enforced (main):_ `getTag` in `src/domain/tags.ts`; `test/tags.test.ts`
  ("shows a tag with seven days of history", "leaves out the statuses of a suspended account", "keeps the public
  history whatever hidden statuses the window holds", "counts public statuses only"). The rule is applied in the query
  with no row limit, so hidden statuses cannot change the public counts.
  The trends lists (R41) are bounded the same way: hashtag trends are counted by the cron's round from public
  originals of available accounts only, and a trending hashtag's `history` counts the newest 200 entries of its public
  range of the 7 days before the rule, the same for every viewer; a trending status passes the anonymous public
  timeline's rule (`trendableStatusSql`) and then R8 for the viewer. _Enforced (main):_ `src/domain/trends.ts`
  (`trendsRound`, `trendTagHistory`, `trendingStatuses`); `test/trends-round.test.ts`, `test/policy-endpoints.test.ts`
  ("shows no viewer a status the model does not allow, and lists exactly what it allows": the trends list for every
  viewer, the anonymous one within the anonymous public timeline).
- **VIS-13: a block cuts both ways, as Mastodon's does.** A block (local, or a remote `Block` that passes ID-6)
  ends the follows between the two accounts in both directions and in either state; while it lasts neither may
  follow the other (a remote `Follow` is answered with a `Reject`), the blocked account sees nothing of the blocker
  (VIS-1) and cannot favourite or boost the blocker's statuses (an inbound `Like` or `Announce` of one is ignored,
  where Mastodon stores it and only filters its notification), and nothing from the blocked account reaches the
  blocker: no list shows it (VIS-5), and no notification of it is written or shown, including a mention or reply
  that mentions or answers it and a post notification (`notify`) of a status that mentions it. Relationships show `blocking` and `blocked_by`. A local block of a remote account
  sends, in order, the `Undo` of our follow, a `Reject` of theirs (one that withdraws it if it was accepted) and the
  `Block`; an unblock sends the `Block`'s `Undo`, which supersedes a `Block` still waiting. All go to the blocked
  account only (NET-2). After the block, the blocked account is no recipient of the blocker's statuses: a new status
  or an edit does not mention it (the name stays text, as Mastodon's `ProcessMentionsService` drops the mention), and
  an activity that carries content (`Create`, an `Update` of a status, `Announce`) recorded after the block is neither
  addressed nor delivered to it; a `Block`, `Reject`, `Undo` or `Delete` still reaches it and names it in `to` or `cc`
  as it would anyone (`recipientsFor` and `outboundKind` in `src/domain/audience.ts`). Deliveries queued before the block are
  sent as queued, as in Mastodon (see the accepted risks). A local block always applies: the ended remote `Follow` is recorded as retracted (ID-7)
  only within that actor's retraction cap, since the block itself refuses the actor's Follows while it lasts.
  _Enforced (main):_ `block` and `unblock` in `src/domain/blocks.ts`, the inbound `block`
  in `src/domain/inbox.ts`, `resolveMentions` and `editStatus` in `src/domain/statuses.ts`, `audienceTargets` in
  `src/domain/deliveries.ts`, `shownSql` and `homeFilterSql` in `src/domain/audience.ts`, `homeTimeline` in
  `src/domain/timelines.ts`, `mayInteract` in `src/domain/inbox.ts`; `test/blocks.test.ts` ("blocks a local account",
  "sends a remote account Undo Follow, Reject and Block", "applies an inbound Block and its Undo", "blocked
  recipients", "mentions of blocked and muted accounts", "names and reaches the author in the Undo of a boost"),
  `test/inbox.test.ts` ("records a Block, ends both follows"), `test/policy-writes.test.ts` (the outbound and
  notification rules on generated worlds), `test/inbox-statuses.test.ts` ("ignores a Like by an actor the author
  blocks", "ignores a boost by an actor the author blocks").
- **VIS-14: a mute hides only for the muter, and only while it lasts.** A mute is never federated and changes nothing
  the muted account sees or may do. It keeps the muted account out of the muter's lists (VIS-5) and home, including
  others' statuses that mention it, and, unless created with `notifications=false`, out of the muter's notifications
  (a mention or reply that mentions or answers it included); a post notification (`notify`) of a status that
  mentions it, or that the muted account wrote, is left out whether or not the mute hides notifications, as home leaves the status out (Mastodon's `FeedInsertWorker`), and so is its push. A mute with a duration applies until its `expires_at`,
  judged at the time of each request or write (the credential's time, or the activity's), so it stops applying at its
  time whether or not the sweep has removed it; the inbound sweep removes 100 expired mutes per call (RES-4). A `Move`
  carries the muter's active mutes to the target with their expiry, replacing an expired mute of the target but never
  an active one (`move` in `src/domain/inbox.ts`; `test/inbox.test.ts` ("carries an active mute over an expired one")).
  _Enforced (main):_ `activeMuteSql`, `filteredForSql`, `homeFilterSql` and `shownSql` in
  `src/domain/audience.ts`, `mute` in `src/domain/blocks.ts`; `test/blocks.test.ts` ("hides the
  muted account from timelines and search", "stops applying an expired mute at its time", "keeps the viewer's own
  statuses in home", "leaves out post notifications from a sender the recipient mutes"), `test/push-send.test.ts`
  ("PUSH-3: pushes no post notification of a sender the recipient mutes").
- **VIS-15: a domain block hides the domain and ends the relationships with it.** A user's domain block matches every
  account whose stored domain or actor host is the domain, exactly (Mastodon's `AccountDomainBlock` matches no
  subdomains; `inDomainSql`, `domainBlocksSql`), and hides them as VIS-5 says; following an account there is refused, a `Follow`
  from one is rejected, and none of the user's statuses mentions or is addressed to one (as VIS-13); an account there
  may not see the user's public and unlisted statuses as a viewer (Mastodon's `StatusPolicy#show?`,
  `author_blocking_domain?`; `visibleSql`), so its `Like` or `Announce` of one is ignored; a boost of a
  status by an account there, which Mastodon allows, leaves its author out of the `Announce`'s addressing and audience
  (`boostAnnounce` in `src/domain/activities.ts`, for the delivered `Announce` and the outbox's copy); the boost's
  `Undo`, a retraction, names and reaches the author all the same.
  As Mastodon 4.5's `AfterBlockDomainFromAccountService` does, the user's follows to and from accounts there end, in either state:
  each follower gets a `Reject`, each of our follows an `Undo`. That is a durable cleanup (`domain_block_cleanups`,
  progress kept as a cursor over follow ids up to the newest follow when the domain was blocked) done in batches that
  each scan 500 follows (RES-6, RES-7): the first in the request, the rest in the rounds the Queue and the cron run
  with the inbound jobs, until done; the next cleanup is picked through an index (`domain_block_cleanups_next`). Until
  then, followers there are left out of the targets of anything that carries content recorded after the block; a
  profile `Update`, a `Delete` or an `Undo` still reaches them, as Mastodon 4.5 sends those to `followers.inboxes`. An
  unblock
  stops the cleanup: what it removed stays removed. The domain is normalized (lowercase, punycode, no trailing dot or
  slash) and this instance's own domain is refused. _Enforced (main):_ `blockDomain` and
  `runDomainBlockCleanups` in `src/domain/blocks.ts`, `runInboundJobs` in `src/store.ts`, `audienceTargets` in
  `src/domain/deliveries.ts`; `test/blocks.test.ts` ("ends our follows there with an Undo and theirs
  with a Reject", "finishes the cleanup in later rounds", "stops the cleanup when the domain is unblocked", "reads a
  bounded number of rows to block a domain", "picks the next cleanup through an index", "normalizes the domain", "sends a
  profile Update, but no new status, to a follower on a domain the cleanup has not reached yet").
- **VIS-16: a list shows its owner nothing home would hide, and nobody else anything.** A list belongs to a local
  account; to anyone else it is not found, read or written (Mastodon's `List.where(account: current_account)`). Its
  members are the owner and accounts the owner follows or has asked to follow (`ListAccount#validate_relationship`),
  and a member leaves the owner's lists when that follow ends, whatever ends it (an unfollow, a block either way, a
  domain block's cleanup, a `Reject`, a purge, a `Move`, which carries the membership to the target as Mastodon's
  `FollowMigrationService` does): a trigger deletes the rows with the follow, so no path can forget it, and a later
  follow does not bring a member back. The list timeline shows the public, unlisted and private statuses of active
  members (the owner, and accounts followed with an accepted follow) through `homeFilterSql` (VIS-1, VIS-5, VIS-13 to
  VIS-15) and the follow's options, with the list's `replies_policy`; a pending member contributes nothing. An
  exclusive list only removes its members' statuses from the owner's home; post notifications are unchanged, as
  Mastodon's `FeedInsertWorker#notify?` lets `:skip_home` through. _Enforced (main):_
  `src/domain/lists.ts`, `listTimeline` and `EXCLUSIVE_MEMBERS` in `src/domain/timelines.ts`, migration
  `0007_list_members` (trigger `list_members_follow_ended`), `moveBatch` in `src/domain/inbox.ts`; `test/lists.test.ts`,
  `test/inbox.test.ts` ("list members and inbound activities"), `test/migrations.test.ts`,
  `test/policy-endpoints.test.ts`, `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`.
- **VIS-17: a conversation shows its owner only what the owner may see, and nobody else anything.** A conversation
  belongs to a local account; to anyone else it is not found, read, marked or deleted (Mastodon's
  `AccountConversation.where(account: current_account)`). It is written when a direct status is stored, for its local
  author and for each local account the notification rule lets it notify of the mention (VIS-10, VIS-13, VIS-14), and a
  status leaves it with its row however the status is deleted (a trigger, so no deletion path can forget it). It is
  keyed by the thread each status is stored with (`statuses.thread`), which no delete changes; a received status's
  named `conversation` is taken whatever its origin (Mastodon's `conversation_from_uri`), which lets a sender group only
  its own statuses within a conversation it is a participant of. Accepted costs (RES-7): dismissing a conversation
  deletes all of its rows in one transaction (a few reads and a write each, no recount of its last status), and a block
  reads the blocker's conversations to find those with the blocked account; both are a local user's action on their
  own data, and rare. Its last
  status is shown only while the read rule (VIS-1) lets the owner see it, else as null; a block ends the blocker's
  conversations with the blocked account. _Enforced (main):_ `src/domain/conversations.ts`,
  `src/domain/conversation-rows.ts`, migration `0009_conversations` (triggers `statuses_thread` and
  `conversation_statuses_removed`);
  `test/conversations.test.ts`, `test/migrations.test.ts`, `test/policy-endpoints.test.ts`,
  `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`.
- **VIS-18: a filter changes only what its owner is told.** Filters (`CustomFilter`) belong to a local account; another
  account's filter, keyword or filter status is not found, read or written. They apply after the read rule (VIS-1,
  VIS-5), in the presenter, for their owner only: each status presented to the owner carries in `filtered` the owner's
  active filters that match it, whatever their context and action, and the client decides by context, as Mastodon's;
  nothing is removed on the server. Nothing a filter reports names a status other than the one it is on or its original.
  A filter status is accepted only for a status the owner may view; one they may not view is refused as a missing status
  is ("Status must exist"), so the two cannot be told apart, and it is listed by id only. Matching is bounded (RES-1,
  RES-7): at most 50 filters per account, 20 keywords of 512 characters per filter and 200 statuses per filter, each
  status matched on at most 10,000 code units of its text and the statuses of one response on 400,000 together, shared
  by water-filling (short texts whole, long ones up to one level; a page of 40 is always matched in full, but a keyword
  deep in a long status of a very large response may be missed, while filter statuses always match), each keyword an
  escaped literal pattern (the `iu` flags, no quantifier) that cannot backtrack. _Enforced (main):_ `src/domain/filters.ts`, `src/domain/status-presenter.ts`, migration `0012_filters`;
  `test/filters.test.ts` (API, ownership, matching, the worst case at the caps), `test/policy-filters.test.ts`
  (generated worlds), `test/policy-bounds.test.ts` (rows read up to the caps).
- **VIS-19: a private note is its author's alone, and an endorsement lasts only as long as the follow.** A note
  (`AccountNote`) on an account is shown only to the local account that wrote it, as the `note` of its Relationship
  with that account; no other read path reads the notes (`test-node/policy-boundary.test.ts`), and they are never
  federated. An endorsement (`AccountPin`) needs the endorser's accepted follow of the account, and goes when that
  follow ends, whatever ends it (an unfollow, a block either way, a removal from followers, a domain block's cleanup, a
  `Reject`, a `Move`, a purge): a trigger deletes it with the follow, so no path can forget it, and a later follow does
  not bring it back. Endorsements are public, as Mastodon 4.5's: an account's list is shown to anyone while the account
  is available, leaving out unavailable endorsed accounts (R28). They are not federated (Mastodon 4.5's actor has no
  endorsements collection). A remote account's purge deletes the endorsements of it and the notes on it within its
  batches (RES-6). _Enforced (main):_ `src/domain/endorsements.ts`, `setNote` and
  `relationshipsOf` in `src/domain/accounts.ts`, `removeFromFollowers` in `src/domain/blocks.ts`, `purgeRelationships`
  in `src/domain/inbox.ts`, migration `0014_account_notes_and_pins` (trigger `account_pins_follow_ended`);
  `test/account-relations.test.ts`, `test/inbox.test.ts` ("endorsements and inbound activities"),
  `test/inbox-regressions.test.ts`, `test/migrations.test.ts`, `test/policy-oracle.test.ts`,
  `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`.
- **VIS-20: a followed hashtag brings into home only what home may show, and featured hashtags show only their
  counts.** The hashtags a local account follows are its own: only it lists them, and only its home and its Tag
  entities read them (R29). Home shows a followed hashtag's public originals, not boosts, through `homeFilterSql` (VIS-1,
  VIS-5, VIS-13 to VIS-15: nothing of an author or a mentioned account the viewer blocks or mutes, of an author who
  blocks the viewer or whose domain the viewer blocks), as Mastodon's `FeedManager#filter_from_tags?`; never an
  unlisted, private, direct or limited status, which the hashtag index it reads does not hold. Its cost is bounded
  (RES-7): a window of a page per followed hashtag, at most 100 hashtags. A featured hashtag shows how many of the
  account's public and unlisted statuses carry it and the date of the newest, never which; an unavailable account
  shows none (VIS-1). The counts are kept on write, so no read counts the account's history; featuring a hashtag counts
  the account's own history once, and deleting or editing the newest tagged status walks back to the one before it, as
  Mastodon does (accepted: a local user's action on their own data). _Enforced (main):_
  `src/domain/tags.ts`, `src/domain/featured-tags.ts`, `homeTimeline` in `src/domain/timelines.ts`, `TagWindows` in
  `src/domain/audience.ts`, migration `0016_tags`; `test/followed-tags.test.ts`, `test/featured-tags.test.ts`,
  `test/policy-endpoints.test.ts`, `test/policy-bounds.test.ts`, `test/migrations.test.ts`.
- **VIS-22: a pin shows only what its status shows, and a conversation mute is its owner's alone.** A pin
  (`StatusPin`) is of the pinner's own status, never a boost or a direct or limited one, at most five per account
  (`StatusPinValidator`). Pins are public, as Mastodon's: `GET /api/v1/accounts/:id/statuses?pinned=true` lists them
  through the account statuses rule (R11, VIS-1), so a viewer sees only the pins it may see; the actor's `featured`
  collection serves the Note of a public or unlisted pin, as the object endpoint does (VIS-4), and only the uri of any
  other; `Add` and `Remove` carry the uri alone to the pinner's followers (R23). A conversation mute
  (`ConversationMute`) is read only by the policy module (`conversationMutedSql`, `test-node/policy-boundary.test.ts`):
  it shows in its owner's `muted` and keeps notify from writing a notification about a status of the muted conversation
  (`notifiedSql`, R15 with R31); it is never federated. A remote status's removal deletes its pins within its batches
  (RES-6). _Enforced (main):_ `src/domain/status-actions.ts`, `getFeatured` and
  `featuredActivity` in `src/domain/activities.ts`, `accountStatuses` in `src/domain/timelines.ts`, the presenter's
  viewer flags, `notifiedSql` and `conversationMutedSql` in `src/domain/audience.ts`, `deleteStatusWithin` in
  `src/domain/inbox.ts`, migration `0018_status_pins_and_conversation_mutes`; `test/status-actions.test.ts`,
  `test/inbox-regressions.test.ts`, `test/migrations.test.ts`, `test/policy-oracle.test.ts`,
  `test/policy-endpoints.test.ts`, `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`.
- **VIS-23: a notification policy only withholds from its owner, and its requests are its owner's alone.** A local
  account's policy (`NotificationPolicy`) is applied as `notify` writes (R15, `notificationPolicySql`), after the rules
  that refuse a notification (VIS-10, VIS-13, VIS-14): it can drop or filter a notification the recipient would be
  shown, never show one they would not. A filtered notification reveals no more than a shown one would: it is
  written only if R15 lets it through, it is left out of every list, grouped list and unread count unless its owner
  asks for filtered ones (`include_filtered`, `account_id`), and every read of it still applies R15 at the time of the
  read; it is never pushed (PUSH-3) and a filtered private mention joins no conversation until its request is
  accepted. A request (`NotificationRequest`) names the sender, how many of its mentions were filtered (at most 100)
  and the last one's status, shown only if the owner may still see it (R2); it, the policy, its permissions
  (`NotificationPermission`) and the work an answer leaves are read and answered only by their owner, and anyone
  else's request is not found. Blocking the sender deletes the pair's request and permission (Mastodon's
  `BlockService` and `AfterBlockService`); a domain block keeps the permissions, which a sender there cannot use while
  the block lasts (R15). Nothing of them is federated: the sender cannot tell a filtered or dropped notification
  from a shown one. Their cost is bounded (RES-6, RES-7): the lists and counts read the partial index of unfiltered
  notifications (`notifications_unfiltered`), so a sender's filtered notifications cost them nothing; the requests are
  paged by their index and the summary reads at most 100; a request's count is kept as it is written; the private
  mention walk reads at most 101 statuses; answering a request, or a bulk form of at most 100 ids, walks at most 2,000
  of the senders' notifications in the request and the rest in the inbound job rounds; and a remote sender's purge
  deletes its requests, permissions and jobs within its batches. _Enforced (main):_
  `notificationPolicySql` and `UNFILTERED_SQL` in `src/domain/audience.ts`, `notify` in
  `src/domain/notifications.ts`, `src/domain/notification-requests.ts`, `src/domain/notification-groups.ts`,
  `src/domain/push.ts`, `purgeRelationships` and `STATUS_CHILDREN` in `src/domain/inbox.ts`, migration
  `0020_notification_policies`; `test/notification-policy.test.ts`, `test/policy-endpoints.test.ts`,
  `test/policy-writes.test.ts`, `test/policy-bounds.test.ts`, `test/migrations.test.ts`,
  `test/cascade-guard.test.ts`.

- **VIS-25: a report reveals to the servers it is forwarded to only what its reporter may see, and never its reporter.**
  A report (`Report`) is its reporter's: it is read only where it is written and answered once to its reporter (R34,
  `test-node/policy-boundary.test.ts`), and goes with the reported account's purge. It names an available account and
  only statuses of that account the reporter may see by the account statuses rule (R11, VIS-1); any other status refuses
  the whole report as not found, so a report cannot probe for a status the reporter may not see. Forwarded (only for a
  remote account and `forward`), it is a `Flag` from the instance actor carrying the reporter's comment and the uris of
  the account and its reported statuses, never the reporter's identity (DATA-7). It goes only to the inboxes Mastodon's
  `ReportService` chooses (R23, `reportForwardees`): the account's server when its domain is listed (by default its
  own), and the servers of the accounts the reported statuses reply to on the listed domains, less the account's own
  inboxes; by Kopje's rule for an activity without `to`, each by shared inbox when it has one. A replied-to server may
  so learn the uri of a status it was not sent, as with Mastodon; the uri carries no content, and the status is served,
  or not, by its own server, the reported account's. The work is bounded (RES-7): at most 100 statuses and 100 domains,
  the statuses and replied-to accounts read by key. _Enforced (main):_ `src/domain/reports.ts`,
  `accountStatusIds` in `src/domain/timelines.ts`, `reportForwardees` in `src/domain/audience.ts`, `flagActivity` in
  `src/domain/activities.ts`, `purgeRelationships` and `PURGED_ACCOUNT_CHILDREN` in `src/domain/inbox.ts`, migration
  `0022_reports`; `test/reports.test.ts`, `test-node/policy-boundary.test.ts`, `test/policy-bounds.test.ts`,
  `test/migrations.test.ts`, `test/cascade-guard.test.ts`.

- **VIS-26: streaming reveals no more than the REST reads, judged when each message is made.** A socket of the
  streaming API (`/api/v1/streaming`) opens only with a valid token of a user while the instance is published: none, an
  invalid, revoked or expired token, an app token and a suspended account's answer 401. The token comes from the
  `Authorization` header or the subprotocol, never from the URL, which the platform's invocation logs record (Mastodon
  also takes `access_token`; a query token alone answers 401 as none does); the Worker sends only its sha256 to the
  Store, which validates it (DATA-5). Each subscription
  needs its stream's scope (`read:statuses` for `user`, `list`, `direct`, `public*` and `hashtag*`, `read:notifications`
  for `user:notification`), a `list` subscription the viewer's own list, and notifications
  go on `user` only with `read:notifications` too. A write records ids only (`stream_events`, by a trigger); each
  message is made later in its own transaction, which authorizes the socket's token again and runs the reference for
  its event and stream (R33): for a `notification` on `user` or `user:notification`, the recipient's notification
  list positioned at it (R15: kept, and not filtered by their policy, as Mastodon pushes none of those), presented as
  REST presents it; for an `update` on `user`, home positioned at the status (R9, the read with `max_id` just above it,
  narrowed to it), for a status published within 6 hours of its arrival; for a `status.update`, home positioned at it
  or, only with `read:notifications`, the viewer's mention notification of it (R15), and on `user:notification` the
  mention alone; on `list:<id>`, the list positioned at the status, which must still be the viewer's; on a `public*` or
  `hashtag*` stream, the public or the hashtag's timeline positioned at the status (R8: public, not a boost, on `public*`
  not a reply to others, no author the viewer blocks, mutes or domain-blocks or who blocks the viewer), less a status
  that mentions an account the viewer blocks or mutes, as Mastodon's streaming server filters each connection; for a
  `conversation` on `direct`, the viewer's own conversation row, presented as the list presents it (R25); for
  `notifications_merged`, a notification scope. A `delete` is the one message judged at write time (R32): captured once, before anything changes the
  status's audience (a local delete or unboost, a remote `Delete` when its job is created and before its first batch
  removes the mentions, a remote `Delete` or `Undo` of a boost), it names only the listening accounts that could view
  the status, for those on `user` or a list each one's boosts of it that it could view, at most 40, and the lists whose
  read held each, sent on a list only while it is still the viewer's, and for a public status that is not a boost a
  tombstone (local, media, the subscribed hashtags) that decides the `public*` and `hashtag*` streams its `delete` goes
  on, never a boost's, in rows of proven size that a
  truncation keeps within bounds without failing the delete. Nothing authorized is kept across units. Each unit is sent at most once: the position past it is
  persisted by compare-and-set before its messages go, and a send that fails closes the sockets left without it
  (1011), whose clients read REST again. Every turn checks every open socket's token again, so the socket of a revoked
  token, a signed-out web session or a suspended account closes (1008) at the next turn, which any write starts, and an
  expired token's at the cron's turn within 5 minutes. A conversation's change is sent at most once to each socket:
  its convSeq is raised and written before the send. Every stream Mastodon's streaming server knows is served; any other
  name answers `Unknown stream type`. The work is bounded (RES-6, RES-7). _Enforced (main):_ `src/mastodon/streaming.ts`, `src/stream-hub.ts`, `src/domain/streaming.ts`,
  `authorizeStream` in `src/domain/auth.ts`, `streamedNotification` in `src/domain/notifications.ts`, migration
  `0026_streaming`; `test/streaming/streaming.test.ts`, `test/policy-bounds.test.ts`, `test/log-redaction.test.ts`,
  `test/migrations.test.ts`, `test/cascade-guard.test.ts`. _Enforced (main):_ the home
  events: `homeStatus` in `src/domain/timelines.ts` (with `statusReads`' `only`), `mentionedStatus` in
  `src/domain/notifications.ts`, `deleteAudience` in `src/domain/audience.ts`, `streamUnit` and `streamDelete` in
  `src/domain/streaming.ts`, migration `0028_streaming_home`; `test/streaming/home.test.ts`,
  `test/streaming-oracle.test.ts`, `test/stream-delete.test.ts`, `test-node/layering.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`, `test/cascade-guard.test.ts`. _Enforced (main):_ lists, direct and merged: `listStatus` in `src/domain/timelines.ts`, `streamedConversation`
  and the change sequence in `src/domain/conversations.ts`, the merge transition in
  `src/domain/notification-requests.ts`, `streamUnit`, `streamDelete` and `streamConversations` in
  `src/domain/streaming.ts`, migration `0032_streaming_lists`; `test/streaming/lists.test.ts`,
  `test/streaming/direct.test.ts`, `test/streaming-oracle.test.ts`, `test/stream-delete.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`, `test/cascade-guard.test.ts`. _Enforced (main):_ public and hashtag: `publicStatus` and `tagStatus` in `src/domain/timelines.ts`,
  `mentionsFilteredFor` in `src/domain/audience.ts`, `streamUnit` and `streamDelete` (the tombstone) in
  `src/domain/streaming.ts`, the hashtag subscription in `src/stream-hub.ts`, migration `0035_streaming_public`;
  `test/streaming/public.test.ts`, `test/streaming-oracle.test.ts`, `test/stream-delete.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`, `test/cascade-guard.test.ts`.
  _Enforced (main)_ for announcements (R40): `announcement`, `announcement.reaction` and `announcement.delete` go on
  `user` only, under `read:statuses` (or `read`), to every listener alike, presented with no viewer (no `read`, no
  `me`); each write that changes what a listener may be shown journals its own row (nothing is coalesced, so a socket
  opened while an event is pending is sent every later change), and the unit presents the announcement as it is when
  sent: published, its entity; otherwise its delete. An expiry by the cron sends nothing,
  as Mastodon's. `streamAnnouncement` in `src/domain/streaming.ts`, `streamedAnnouncement` and
  `streamedAnnouncementReaction` in `src/domain/announcements.ts`; `test/streaming/announcements.test.ts`.

- **VIS-27: a quote reveals nothing its quoted status hides.** R35 applies VIS-1/R2 to the quoted status for the
  same viewer, whatever the quoting status's own visibility: `unauthorized` carries no content, and the filter states
  carry only a status the viewer may see, for a local user's quote as for a received one. A `quoted_update` is written
  and shown only while its quote is accepted and its recipient may see the edited status (R15). Ordinary reads embed it
  only for an accepted quote; the `DELETE` response's
  source also requires R2. States, legacy quotes and Mastodon's behaviour: [visibility.md](visibility.md). Embedding
  stops after one level; the inner quote is a state and an id. The quotes list answers 404 under R3, then applies R8
  to quoting statuses, or R2 for the quoted author. Quotes never widen feed membership. The work is bounded (RES-7).
  _Enforced (main):_ `quoteReads` in `src/domain/audience.ts`, the presenter in `src/domain/status-presenter.ts`,
  `statusQuotes` in `src/domain/statuses.ts`, `acceptedQuoteWindow` in `src/domain/quotes.ts`, migration
  `0036_quotes_list`; `test/quotes-api.test.ts`, `test/policy-oracle.test.ts`, `test/policy-bounds.test.ts`,
  `test-node/policy-boundary.test.ts`, `test/migrations.test.ts`.

- **VIS-28: a quote is approved only by the quoted author, and a revoked approval never becomes valid again.** A quote
  is `accepted` only as a self-quote, by a remote stamp that passes every check (section 5 of the quotes design), or,
  for a local quoted status, by Kopje's answer to a QuoteRequest, decided by R36 (`mayQuoteSql`) in the inbox's final
  Store round and never by a verification round. Each transition into `accepted` draws a fresh 128-bit random
  authorization id; the id exists exactly while the quote is accepted (a CHECK), and every way out of `accepted` (a
  revoke, the quoter's `Update` replacing or dropping the quote, the quoted status's delete, the quoting status's
  `Delete`, which retires it in its first transaction before any batch, and a purge) records it in
  `quote_revocations` through a trigger, whatever the statement. Kopje serves a stamp only for the current id of an
  accepted quote of an available author's public or unlisted status, named by that author in the path, with the quoting
  status present and its author not being purged, ids only, `Cache-Control: no-store`; a recorded id answers 404 for
  good. A revoked quote may be accepted again by a later request, with a new id, as Mastodon does; the author's lasting
  tools are the policy and blocks. A revoke records, in one transaction and only while the quote still holds the id
  its `Delete` was signed for, the quoted author's LD-signed `Delete` (signed once in the Worker, delivered byte for
  byte to the quoter and to the receipts and audiences of both statuses), then a `Reject` of every live request the
  quoting author had answered for the quote, by id, in the same lane, recorded as retractions like the `Delete`. Accepted risk: a receiver that applies an `Accept` and a `Reject`
  concurrently (Mastodon 4.5.11 checks `pending?` in memory) may keep the quote. _Enforced (main):_ `answerQuoteRequest`,
  `quoteAuthorization`, `retireQuoteOf` and `revokeQuoteRow` in `src/domain/quotes.ts`, `mayQuoteSql` and
  `reachQuoters` in `src/domain/audience.ts`, `revokeQuote` in `src/domain/statuses.ts`, the immutable and `reachOf`
  envelopes in `src/domain/deliveries.ts`, migration `0038_quote_requests`; `test/quote-requests.test.ts`,
  `test/migrations.test.ts`. A local user's quote is accepted only by R36 at posting (a local quoted status) or by the
  quoted author's `Accept` of our QuoteRequest (a remote one): one compare-and-set on a pending quote, from the quoted
  author only, with a stamp on that author's origin that they neither revoked nor retracted, and that no other local
  quote holds (one local quote per stamp and author, a unique index). A `Reject`, or the author's `Delete` of the stamp,
  ends it and records an `Update` of the quoting status without it; the revoked quote keeps the stamp, so no other
  local quote takes it, until the `Delete` records it for good in `quote_revocations`; a `Delete` proven by
  the author's own signature is also forwarded unedited, once, to every inbox that received the quoting status, signed
  by its local author, as a retraction (FEP-044f "Handling a revocation"). No verification round ever decides a local
  quote. _Enforced (main):_ `recordLocalQuote`, `acceptOurQuote`, `rejectOurQuote` and `revokeStamp` in
  `src/domain/quotes.ts`, `preparePost` in `src/domain/statuses.ts`, migration `0039_quotes_local`;
  `test/quote-authoring.test.ts`.

- **VIS-29: admin views and actions disclose and change only through the admin account.** Only the OAuth admin, through
  a token covering the route's admin scope, reads or acts through `/api/v1/admin/*` and `/api/v2/admin/*` (R37, reserved
  for the admin API's rule). The OAuth admin is the one local account whose email equals `admin_email` after trimming
  and lowercasing both; the match fails closed: no admin when `admin_email` is unset or empty, when no local account
  matches, when the match is suspended, or when two accounts match. It is checked in the transaction of each admin
  operation, so existing tokens follow the current match, and the role's permissions are exactly the route groups Kopje
  serves. No admin action targets the admin's own account; a suspension fences the account's tokens; every admin write
  is logged; and the OAuth admin never holds A5 (AUTH-5). `ADMIN_PERMISSIONS` is 1080 (manage_reports, manage_users,
  manage_federation, view_dashboard); every other admin route answers as Mastodon answers a role without the permission.
  _Enforced (main):_ the match and the check: `oauthAdmin` and `adminAccountId` in `src/domain/admin-authority.ts`,
  `adminReadOperation` and `adminWriteOperation` in `src/domain/auth.ts`, setup's admin in `src/domain/setup.ts`;
  `test/admin-api.test.ts`, `test/setup-access.test.ts`. Reports (manage_reports): anyone but the OAuth admin is refused
  before a report is read, so not even its existence is disclosed; the admin sees every report with its accounts (local
  emails included) and only the statuses its reporter may still see (R37); every admin write, and every Access repair
  below, writes its moderation log row (`admin_actions`, actor, account and client or Access identity, newest 10,000
  kept) in its own transaction, read only through Access (`GET /admin/moderation-log`). `listAdminReports`,
  `getAdminReport`, `updateAdminReport` and `actOnReport` in `src/domain/reports.ts`, `presentAdminAccounts` in
  `src/domain/admin-accounts.ts`, `src/domain/moderation-log.ts`, migration `0029_admin_reports`;
  `test/admin-reports.test.ts`, `test/admin-api.test.ts`, `test/policy-bounds.test.ts`, `test/migrations.test.ts`.
  Accounts (manage_users): only the OAuth admin lists every account, local and remote, with each local account's email,
  shows one, and logs the actions that change nothing (`enable`, `unsilence`, `unsensitive`), while `approve` and
  `reject` are refused for every account. Each list reads a bounded set (the local accounts, at most 2,000 search
  candidates, or an id-ordered range) and answers 422 rather than an unordered or empty page. `listAdminAccounts`,
  `getAdminAccount` and `actOnAdminAccount` in `src/domain/admin-accounts.ts`, `src/mastodon/admin.ts`, migrations
  `0030_admin_accounts` and `0031_admin_accounts_available`; `test/admin-accounts.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`. Local suspension, self-protection and the credential epoch:
  the OAuth admin's `action` (`none`, which resolves the report it names, and `suspend`) and `unsuspend`; `disable`,
  `sensitive` and `silence` answer 422, and any action on the admin's own account 403 (remote suspension is VIS-30's). A
  suspension commits, in one bounded transaction, the account's `suspended_at` (its time S) and a new credential epoch
  (`local_accounts.credential_epoch`, incremented), the frozen report and follow bounds, its jobs and its actor's
  `Update` with no targets. Every token, code and web session is stamped with its account's epoch in the transaction
  that inserts it (`oauth_tokens.epoch`), and is valid only while that epoch is its account's, with no clock involved:
  from the suspension's commit every credential issued before it is refused (`currentCredentialSql`: API calls, web
  sessions, code exchange, streaming, pushes queued, claimed or confirmed, and the authorized apps listed), also after
  an unsuspension, which keeps the epoch, so credentials issued after it are valid at once; the tokens job deletes the
  older ones later. An unsuspension of a suspension made before the epoch existed moves it once. The jobs are bound to
  their epoch: the suspension's job resolves only the reports frozen by the suspension, and stops when the account is
  unsuspended or in a later epoch; an unsuspension's job stops when the account is suspended again. A suspended local
  sender's queued deliveries are dropped when claimed or confirmed, except retractions and its suspension `Update` (R1);
  a delivery confirmed before the suspension committed may still be sent (VIS-30's boundary). `actOnAccount` and
  `unsuspendAdminAccount` in `src/domain/admin-accounts.ts`, `src/domain/suspension.ts`, `currentCredentialSql` in
  `src/domain/auth.ts`, `REFUSED_SENDER` in `src/domain/deliveries.ts`, migration `0034_admin_suspension`;
  `test/admin-suspension.test.ts`, `test/cascade-guard.test.ts`, `test/migrations.test.ts`. The report fence uses no
  caller clock: every write to a report stamps it, in that write's transaction, with the moderation log id of the admin
  action that caused it (`reports.last_action_id`; an admin's write its own row, a suspension round's resolution the
  suspension's row, never one row per report), and log ids are given in commit order and never twice. A suspension
  freezes the newest report id and its own log id (`moderation_jobs.action_bound`) in its transaction, and its job
  resolves only reports filed up to the first, still unresolved, and last stamped at or below the second (none counts as
  0). So a report reopened or changed after the suspension committed, and one filed after it, stay as they are, whatever
  either request's clock said. A job whose bound is unknown (a suspension from before the fence whose log row was
  pruned) resolves none, and leaves them to the admin. `resolveSuspensionReports` and `writeReport` in
  `src/domain/reports.ts`, `suspendLocal` in `src/domain/suspension.ts`, `logAction` in `src/domain/moderation-log.ts`,
  migration `0042_report_action_fence`; `test/admin-suspension.test.ts` ("the report fence"), `test/migrations.test.ts`.
  A remote report (an inbound `Flag`) is shown the same way, its reporter the remote actor in the remote admin account
  shape; its statuses are shown while they pass the remote reporter rule (`remoteReportStatusIds`), and its
  `status_ids`, the ids admitted when it was filed, are metadata the admin alone sees in its notifications (R15, R37),
  whatever the rule says later. A report another account files notifies the OAuth admin (`admin.report`) when no
  other report of the same account is unresolved, read in the report's transaction; the notification carries the report as its reporter sees it,
  and R15 shows it, lists it, streams it and pushes it only while its recipient is the current OAuth admin (R37), so it
  leaves every read when `admin_email` changes or the match fails closed, and comes back with the match; it goes with
  its report (a remote account's purge deletes it before the report, whether the account is the report's target or
  its reporter). `GET /admin/reports/:id`, where clients open it,
  redirects the Access admin to the reported account's web page and reads nothing for anyone else: the Access admin is
  checked again against the saved settings in the read's transaction (`accessAdminRefusal`), so a settings change during
  the request's authentication refuses it. `notifyStaff` and `reportTargetPage` in `src/domain/reports.ts`, `shownSql`
  in `src/domain/audience.ts`, `adminAccountIdOnce` in `src/domain/admin-authority.ts`, migration
  `0040_report_notifications` and `0041_report_notifications_key` (one notification per report and recipient);
  `test/report-notifications.test.ts`, `test/policy-oracle.test.ts`, `test/migrations.test.ts`. Domain blocks and allows
  (manage_federation): the block API of VIS-30; domain allows list none, and their create answers 403 to everyone. The
  measure `instance_follows` (view_dashboard) counts accepted follows of the domain's accounts by a walk of at most
  20,000 local follows, and answers 422 beyond it, never an undercount; dimensions and retention answer `[]`.
  `src/domain/admin-domain-blocks.ts`, `src/domain/admin-measures.ts`; `test/admin-domain-blocks.test.ts`,
  `test/admin-measures.test.ts`, `test/admin-domain-blocks-replay.test.ts`.
  Announcements are the Access admin's (AUTH-5), never the OAuth admin's; each write logs its row in its own transaction
  (`test/admin-announcements.test.ts`, `test/cli.test.ts`).
  Trends reviews are the Access admin's too (`/admin/trends`, `kopje-admin trends`: AUTH-5); through the Mastodon admin
  API the OAuth admin is shown the public trends and its approve and reject answer 403 (MD-2). Each review logs its row
  in its own transaction (`test/admin-trends.test.ts`, `test/cli.test.ts`, `test/trends.test.ts`).
- **VIS-30: an instance-suspended account is shown to nobody and gets no new content.** An account the instance
  suspended (R38) is unavailable (R1) from the suspension's commit: shown to nobody (as any unavailable account), sent
  nothing but retractions, and its inbound activity is not applied but for its `Delete`, `DeleteActor`, `Undo` and
  `Reject`, after a routing refresh of its inbox from a verified document; no path refreshes its profile, keys or
  domain, or stores a status of it. Its follows of local accounts are severed in bounded, generation-bound rounds (R38),
  each accepted one with a withdrawing `Reject` to the follower's current inbox alone, as Mastodon sends it (a
  retraction, never refused, but not sent to the earlier receivers of what it withdraws); local follows of it are kept.
  An instance domain block of severity `suspend` (R38) covers a host by its longest matching block (a child `noop`
  exempts its subdomains), with at most `MAX_BLOCK_LABELS` (8) labels per stored block; a covered account (by its stored
  domain or its actor host) is unavailable from the block's commit, read live; nothing is fetched from a covered host
  (advisory: the writes refuse to store a covered account or its statuses, and refresh no covered row); its inbound
  activity is ignored before any fetch but `Delete`, `DeleteActor`, `Undo` and `Reject` verified with a key already
  stored. The OAuth admin creates, changes and deletes blocks through the Mastodon admin API (VIS-29). Each change into
  or out of `suspend` resets the domain job, whose bounded rounds mark the covered accounts and sever their follows both
  ways up to a frozen follow bound, and clear the marks a block no longer covers; the admin's `active` and `suspended`
  lists answer 503 while it runs (docs/visibility.md, "Instance domain blocks"). Each staged target records the
  recipients behind it (merged across followers, addressed accounts, silent recipients, poll voters and other statuses'
  reach before deduplication by inbox): up to 16 account ids, the hosts of their actor ids, or `many` above 16, meaning
  "not all unavailable"; expansion copies them onto the delivery row. A row that is not a retraction (by its persisted
  `retracts` flag) is dropped, its lane promoted, when its sender is refused (R1), an instance domain block covers its
  inbox host, none of its listed accounts exists and is available (R1: a recipient the instance suspended, or one being
  deleted or purged), or a block covers every listed host. The check runs at the claim and again in `confirmDelivery`,
  which the Worker calls under the claim's lease after the signer is loaded and the host checked, right before signing
  and the POST; the body sent is read there, never from the claim. A change that commits after confirmation does not
  stop that POST; a confirmation that fails, or finds the lease taken over, sends nothing, and the lease expires.
  Accepted residuals: a shared inbox serving an available recipient besides unavailable ones is sent (content expansion
  already left the unavailable out); a row without provenance (queued before migration `0044`, phase A's staged reach, a
  retraction's earlier receivers) gets the inbox host rule only; Mastodon's `DeliveryWorker` has no such check, so this
  is stricter than Mastodon, whose reach already leaves deleted accounts out. A dropped row writes no receipt. An
  account that moved to an unavailable one shows it redacted in `moved` (`suspended: true`, no name, note, fields or
  emojis, the default images), and an unavailable account shows `moved: null` with its target not read, as
  REST::AccountSerializer does (`test/account-moved.test.ts`). _Enforced
  (main)._ Implementation, for accounts: `src/domain/remote-suspension.ts`, `actOnAccount` and `unsuspendAdminAccount`
  in `src/domain/admin-accounts.ts`, `availableSql` in `src/domain/audience.ts`, the gate in `receive` and
  `upsertRemoteActor` in `src/domain/inbox.ts`, `storeRemoteStatus` in `src/domain/remote-statuses.ts`, migration
  `0045_remote_suspension`; `test/remote-suspension.test.ts`, `test/remote-suspension-deliveries.test.ts`,
  `test/remote-suspension-inbound.test.ts`, `test/policy-oracle.test.ts` and `test/policy-writes.test.ts` (against
  `available` and `sends` in `test/policy-model.ts`). For the delivery part: `targetsOf`, `sendRefused`,
  `claimDeliveries` and `confirmDelivery` in `src/domain/deliveries.ts`, `recipientsFor` in `src/domain/audience.ts`,
  `deliveryRound` in `src/jobs/deliver.ts`, migration `0044_delivery_provenance`; `test/delivery-send-check.test.ts`,
  `test/policy-writes.test.ts` (provenance and the send-time rule against `sends` in `test/policy-model.ts`),
  `test/migrations.test.ts`. For domains: `src/domain/instance-domain-blocks.ts`, `hostCoveredSql` and `availableSql` in
  `src/domain/audience.ts`, the fetch policy in `src/federation/loader.ts`, the inbound path in
  `src/federation/inbound.ts`, the domain job in `src/domain/remote-suspension.ts`, the admin API in
  `src/domain/admin-domain-blocks.ts`, migration `0046_instance_domain_blocks`; `test/instance-domain-blocks.test.ts`,
  `test/domain-job.test.ts`, `test/admin-domain-blocks-replay.test.ts`, `test/instance-domain-blocks-inbound.test.ts`,
  `test/read-windows.test.ts`, `test/policy-oracle.test.ts` (against `available` and `covered` in
  `test/policy-model.ts`).

### Authorization (AUTH)

- **AUTH-1: authorization happens inside the operation.** Token validity, expiry, revocation, scope and account
  suspension are checked in the same Store transaction as the operation they authorize. _Enforced (main):_
  `userReadOperation` and `userWriteOperation` in `src/domain/auth.ts`; `test/store-auth.test.ts`, `test/oauth.test.ts`
  ("refuses a token that survived the suspension").
- **AUTH-2: every API route declares its access.** Each Mastodon API route is `public`, `token` (any valid token, app
  tokens included) or a required user scope, or any one of several (`GET /api/v1/accounts/verify_credentials`:
  `profile` or `read:accounts`); one helper decides scope coverage (parents cover children, `follow` expands to its
  split scopes, nothing else is implied: `read` does not cover `profile`, which covers nothing else). _Enforced (main):_ `src/mastodon/routes.ts`, `src/security/scopes.ts`;
  `test/scopes.test.ts`, `test/vectors.test.ts` ("Mastodon's scope hierarchy"), `test/oauth.test.ts` ("scopes on
  routes"). A route may also be `optional`: no token reads as anonymous, and a token sent must be valid; such a route may declare no scope (`GET /api/v1/tags/:id`: any valid token,
  app tokens read as anonymous), and a `token` route may still require a user (`GET /api/v1/announcements`: any user
  token, whatever its scopes; app tokens 422: `tokenUserReadOperation` in `src/domain/auth.ts`, which
  `announcements.listAnnouncements` declares); `test/tags.test.ts`, `test/announcements.test.ts`. _Enforced (main):_ the admin API's routes are optional-token routes with admin scopes (Mastodon's
  `authorize_if_got_token!`): a token sent must be valid and cover the route's scope, and who may act is decided in
  the Store (VIS-29); `test/mastodon-access.test.ts` compares them with Mastodon's, setting aside only each admin
  route's role policy, and `test/admin-api.test.ts` ("admin routes").
- **AUTH-3: OAuth follows the supported contract.** _Enforced (main):_ `src/app/authorize.tsx`, `src/mastodon/oauth.ts`,
  `src/domain/oauth.ts`; `test/oauth.test.ts`, `test/vectors.test.ts`. - Grants: authorization code and client
  credentials. Codes expire after 10 minutes and are single-use. PKCE is optional and S256 only; a bound code needs the
  matching verifier, and a failed exchange burns the code. - Redirect URIs match a registered string exactly, including
  denial and error paths. Client and redirect URI errors stay on the page; later errors go to the verified callback with
  a unique `state` of at most 2,000 characters; a repeated or longer `state` is omitted. Out-of-band errors stay on the
  page. - Repeated scalar OAuth parameters (query and body together) are rejected; documented array parameters are not.
    - Client authentication failures answer 401 `invalid_client`; a client can revoke only its own tokens.
- **AUTH-4: Access JWTs are verified with jose.** RS256 only; issuer, audience and `exp` required; at most 60 s clock
  tolerance; a fetched key set used for at most 7 days. Sign-in requires an email claim. _Enforced (main):_
  `src/security/access-jwt.ts`; `test/oauth.test.ts` ("Access assertion").
- **AUTH-5: admin authority comes only from the target's own configuration.** _Enforced (main):_
  `src/app/admin.ts`, `src/platform/store-admin.ts`, `src/platform/access-settings.ts`; `test/ops-authority.test.ts`,
  `test/admin.test.ts`, `test/dump-import.test.ts`. - Configuration is every name `/admin/config` accepts: `domain`,
  `access_aud`, `access_team_domain`, `access_admin_aud`, `admin_email`, `access_service_token_client_id`. A verified
  import restores the target's values exactly; an imported value never replaces them and an absent name stays absent. -
  An admin is the configured `admin_email`, or a service token with no email, `sub === ""` and `common_name` equal to
  the configured client id. - `IMPORT_TOKEN` only begins an import into an empty Store without usable admin access, or
  configures the Store while admin access is not usable. The Store checks this, not only the Worker. - A token import
  continues only with the one-time session credential `begin` returned; the Store keeps its SHA-256 only. An unverified
  token import idle for 15 minutes may be reset with `IMPORT_TOKEN`; an Access import never. In the cutover the token
  only configures the Store (domain and Access values) and is deleted before the import, which runs through Access; it
  begins one import into an empty Store and nothing after it (`test/cutover-token.test.ts`). - Secrets are compared as
  fixed-size SHA-256 digests, in time independent of their contents and lengths: `constantTimeEqual` in
  `src/security/tokens.ts` and `sessionMatches` in `src/platform/store-admin.ts`; `test/ops-authority.test.ts`
  ("constantTimeEqual"). - The OAuth admin of the Mastodon admin API (VIS-29) is not an admin here: it never
  holds an `ImportAuthority`, and `/api/v1/admin/*` is outside the Access application's `/admin` path. Its diagnostic
  state (why there is or is not an OAuth admin, and a suspended match's username) is shown only to
  Access, as `oauthAdmin` in `GET /admin/health`. _Enforced (main):_
  `src/app/admin.ts`; `test/admin-api.test.ts` ("GET /admin/health: oauthAdmin"). Which account it is, while it is
  one, is public, as Mastodon shows it: that account's `roles` holds the Owner's badge (id, name and color, no
  permissions) wherever it is presented, and every other local account's holds none (`presentAccount` in
  `src/domain/accounts.ts`, read once per operation through `adminAccountIdOnce`;
  `test/account-entity-fields.test.ts`). The instance's contact account is configured apart and need not be it. The
  operations that repair the OAuth admin, setting an account's email and unsuspending an account, are Access-only.
  _Enforced (main)_ for setting an email (`POST /admin/accounts/email`, `setAccountEmail` in
  `src/domain/admin-accounts.ts`, checked with `accessAdminRefusal` in its transaction, refusing an email that another
  local account's matches after normalization;
  `test/admin-reports.test.ts` ("set-email"), `test/cli.test.ts`). _Enforced (main)_ for unsuspending (`POST /admin/accounts/unsuspend` and `kopje-admin account unsuspend <username>`,
  `unsuspendAccount` in `src/domain/admin-accounts.ts`, checked with `accessAdminRefusal` in its transaction, the same
  unsuspension as the admin API's, its credential epoch kept, logged with the Access identity;
  `test/admin-suspension.test.ts` ("POST /admin/accounts/unsuspend"), `test/cli.test.ts`). It is how a suspended
  OAuth admin is recovered: no OAuth admin can unsuspend it.
  Custom emoji writes (`/admin/emojis`, `kopje-admin emoji`) are Access-only, checked with `accessAdminRefusal` in the
  Store transaction and logged with the Access identity (`CustomEmoji` targets); the import token and import sessions
  never reach them; `test/local-emojis.test.ts` ("is refused for the import token and import sessions").
  Announcement writes (`/admin/announcements`, `kopje-admin announcement`: create, change, publish, unpublish, delete)
  are Access-only, checked with `accessAdminRefusal` in the Store transaction and logged with the Access identity
  (`Announcement` targets, with the text's first 200 code units); the import token and import sessions never reach them;
  `src/domain/announcements.ts`; `test/admin-announcements.test.ts` ("is refused for the import token and import
  sessions", "answers announcement-not-found and refuses every authority but Access").
  Trends reviews and lists (`/admin/trends`, `kopje-admin trends`) are the same: the import token and import sessions
  never reach them, and `src/domain/trends.ts` refuses every authority but Access in the transaction
  (`test/admin-trends.test.ts` ("refuses anyone but the Access admin")).
- **AUTH-6: a user acts only on what that user may touch.** User operations take the acting account from the validated
  viewer, never from the body or path, and check ownership or VIS-1 access to every referenced resource in the same
  transaction. Admin, setup and federation operations use their own named rules (AUTH-5, SETUP-2, ID-6), and the
  Mastodon admin API's operations VIS-29. _Enforced (main)_ for accounts and OAuth: `src/domain/accounts.ts`,
  `src/domain/oauth.ts`; `test/oauth.test.ts` ("does not revoke a token of another client"). _Enforced (main)_ for
  statuses and notifications:
  `test/statuses.test.ts` ("cannot edit someone else's status", "gives the source for editing to the author only"),
  `test/notifications.test.ts` ("only the viewer’s own notifications"). _Enforced (main)_ for scheduled statuses: every read and change
  of `scheduled_statuses` is the owner's (`scheduledOwnSql`, R26, all in `src/domain/scheduled-statuses.ts`, which
  `test-node/policy-boundary.test.ts` keeps alone in touching the table), so another account's is not found (404), and
  the media a scheduled status holds is the poster's own, checked as for a post; publication runs as the scheduled
  status's owner and through the checks of a post (`preparePost`), and an account suspended meanwhile publishes nothing;
  `test/scheduled-statuses.test.ts` ("never shows or changes another account's scheduled status", "nothing leaks
  before publication").
- **AUTH-7: opaque credentials are unguessable and stored as digests.** Client ids and secrets, codes and access tokens
  are 32 random bytes. Codes and access tokens are stored and looked up only by their full SHA-256. _Enforced (main):_
  `src/security/tokens.ts`, `src/domain/oauth.ts`; `test/oauth.test.ts` ("stores only digests of tokens and codes").
  A Web Push subscription also keeps the access token it was made with, for the payload's `access_token` (Mastodon's),
  only sealed: AES-GCM under a key derived from `VAPID_JWK`, which the Store never holds, bound to the token's digest.
  _Enforced (main):_ `sealPushToken` in `src/security/web-push.ts`; `test/web-push-crypto.test.ts` ("opens a sealed
  token only with its key and digest (AUTH-7)").
- **AUTH-8: a web session is an OAuth token of the web UI, and nothing else.** The web UI is an ordinary OAuth client
  of the instance: `/login` sends the browser to `/oauth/authorize` (Access, WEB-1) with a PKCE S256 challenge. The
  Store keeps the attempt (state, challenge, return path, and the digest of the session cookie the request carried)
  under the digest of an opaque id the Worker minted; the browser's 10-minute `__Host-` login cookie holds only that id,
  and nothing else from the browser is trusted for the attempt. Attempts are keyed per browser, expire after 10
  minutes and are pruned as new ones come; `/login` is limited to 10 per minute per client IP (the Rate Limiting
  binding), so no shared cap or counter exists that an anonymous party could fill to lock anyone out. The callback
  consumes the attempt (once) and the code, which must be bound to the attempt's challenge; a state that is not the
  attempt's leaves both in place. A session is an access token of the web
  client (AUTH-1, AUTH-7) with a fixed lifetime of 7 days, held in an opaque `__Host-` cookie (HttpOnly, Secure,
  SameSite=Lax, Path=/). Session values are minted only by the server at the callback, never taken from a URL; a
  callback without the login cookie, with another state, or with a code bound to another challenge starts nothing
  (session fixation, login CSRF), and a stale callback leaves the newer login cookie in place. Sessions of one browser
  form a family: a new session deletes the family's live one and every session the browser presented; sign-out
  deletes the presented and the live session and ends the family, so a sign-in started before it installs nothing.
  Every retired session is a deleted token row, refused by cookie and as a bearer token alike; suspension, expiry and
  "sign out other sessions" end sessions too. An attempt records its family when it starts, and an ended family's record
  outlives every attempt naming it, so expiry and the sweep cannot lift the fence. "Sign out other sessions" ends their
  families and deletes the web client's unexchanged codes for the user in the same transaction, so their sign-ins in
  flight install nothing. Only a signed-in browser's sign-out (Origin and form token, WEB-4) can end
  a family. Authorizations and sessions are listed and revoked only by a session of the web client, for the viewer's
  own tokens (AUTH-6). _Enforced (main):_ `src/domain/web-session.ts`, `src/web/session.ts`,
  `src/app/web.tsx`; `test/web-session.test.ts` ("signs in through Access and sets an opaque, HttpOnly, Secure,
  SameSite session cookie", "refuses a callback without the login cookie, or with another state", "uses a code once",
  "consumes a sign-in attempt once", "keeps one session per browser", "trusts nothing but the attempt id from the
  login cookie", "leaves the newer sign-in in place when a stale
  callback arrives", "installs nothing from a callback that arrives after sign-out", "signs out the newer session when
  sign-out carries the session it replaced", "keeps the sign-out fence when the session expires and is swept",
  "fences the sign-ins in flight of the sessions \"sign out other sessions\" ends", "retires every replaced or signed-out session for cookies and bearer use
  alike", "lets no anonymous flood of sign-ins or failed callbacks lock out the owner", "expires a session after its
  lifetime", "does not take an API token for a session", "signs out, and the cookie authenticates nothing afterwards",
  "signs out the other sessions only", "lists the authorized apps and revokes one").

### Web (WEB)

- **WEB-1: the consent decision cannot be forged cross-site.** `GET /oauth/authorize` issues nothing. The `POST`
  requires a valid Access identity, an `Origin` equal to the instance origin (missing, `null` or foreign answers 403),
  and `decision=approve`; the Store revalidates client, redirect URI, scopes and account when it writes the code.
  _Enforced (main):_ `src/app/authorize.tsx`, `issueCode` in `src/domain/oauth.ts`; `test/oauth.test.ts` ("refuses a
  decision posted from another origin, a null origin or none", "refuses an account suspended between the consent page
  and approval").
- **WEB-2: Kopje's HTML pages cannot be framed, scripted or cached.** Consent and code pages send a CSP with `script-src
'none'` and `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control:
no-store`, and render every value escaped. _Enforced (main):_ `src/app/authorize.tsx`, `src/web/consent.tsx`;
  `test/oauth.test.ts` ("logs in through Access and calls the API with the token"). _Gap: only `script-src`,
  `X-Frame-Options` and escaping are asserted._ Web UI pages: _Enforced (main):_ a CSP of `default-src 'none'` with only
  `style-src 'self'` (the stylesheet is a static asset), `img-src 'self' https:`, `form-action 'self'`, `base-uri 'none'`
  and `frame-ancestors 'none'` (no script source at all), `X-Frame-Options: DENY`; pages of a signed-in user and the
  sign-in flow send `Cache-Control: no-store` and `Referrer-Policy: same-origin`; public pages may be kept 60 s and vary
  with `Accept`. `src/app/web.tsx`; `test/web-pages.test.ts` ("sends a CSP without script, denies framing"),
  `test/web-session.test.ts` ("is never cached, framed or opened to other origins"). The one exception is the embed
  page, `/@username/:id/embed`, which oEmbed names for other sites to frame, as Mastodon's: it sends neither
  `frame-ancestors` nor `X-Frame-Options`, its CSP allows exactly one script (`script-src` naming
  `/assets/embed-status.js`, which only answers the embedding page's height request), and it may be kept 180 s. It
  shows only the status its status page shows (VIS-4), has no form and no signed-in state, and links open outside the
  frame; its 404 is the ordinary framing-denied page. `src/app/web.tsx`; `test/oembed.test.ts` ("may be framed by any
  site", "leaves every other page unframable"). `/setup`: _Enforced (main):_ the same CSP, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control: no-store`
  on every page. Not `no-referrer`: under it browsers post a same-origin form with `Origin: null`, which WEB-1's
  Origin check refuses; `same-origin` still sends no referrer to other origins; `src/app/setup.tsx`; `test/setup.test.ts` ("WEB-2, WEB-3, WEB-5: is never cached, framed, scripted
  or opened to other origins").
- **WEB-3: CORS is open only where no ambient credential exists.** Wildcard CORS without credentials applies to
  `/api/*`, `/oauth/token`, `/oauth/revoke`, `/oauth/userinfo` (bearer tokens), and for GET to the public documents
  `/.well-known/*`, `/nodeinfo/*` and local actor documents (`/ap/users/:username`), as Mastodon opens them, only.
  `/oauth/authorize`, `/admin/*`, `/setup` and the web UI send no CORS headers; the profile page `/@:username`, which
  Mastodon opens, is open only in its ActivityPub form (the actor document), not as HTML. _Enforced (main):_ CORS is
  added on those paths only (`API_CORS_PATHS` and `DOCUMENT_CORS_PATHS` in `src/app/app.ts`); `test/oauth.test.ts`
  ("opens the API and token endpoints to browser clients, errors included", which also finds none on the consent
  page), `test/federation.test.ts` ("documents open to browsers", "opens the profile page only as the actor document,
  not as HTML"); UI routes send none even for a request with a foreign `Origin` (`test/web-pages.test.ts`,
  `test/web-session.test.ts`), nor does `/setup`, preflight included (`test/setup.test.ts`). _Gap:_ no test sends
  `/admin/*` a foreign `Origin`.
- **WEB-4: the web UI applies WEB-1 to every state change.** Each form that changes state checks `Origin` and its
  session; a return or redirect target is a validated local path. _Enforced (main):_ every POST (profile, avatar, header,
  revoking an app, signing out other sessions, sign-out) first requires `Origin` equal to the instance origin (missing,
  `null` and foreign answer 403 before the body is read), then the session and an anti-forgery token derived from it
  (SHA-256 of the session token under its own context, compared in constant time). The only redirect targets are fixed
  local paths and the sign-in's return path, which must start with exactly one `/`, contain no backslash, whitespace,
  control character, `.` or `..` segment, or percent-encoded slash, backslash, dot, control or `%`, and resolve to the
  instance origin as a path of the same form (so normalization cannot turn it into `//host`); anything else becomes
  `/settings`. A legacy permalink moves to the author's stored username, not the request's text. `src/web/session.ts`,
  `src/app/web.tsx`; `test/web-session.test.ts` ("refuses a missing, null or foreign Origin on every form", "refuses a
  missing or wrong anti-forgery token on every form", "accepts only local paths (WEB-4: unsafe return path)", "returns after sign-in only to a
  validated local path", "trusts nothing but the attempt id from the login cookie"), `test/web-images.test.ts` ("refuses a
  foreign, null or missing Origin and a wrong token before any transformation"). `/setup`: _Enforced (main):_ every POST, sign-in with `SETUP_TOKEN` included, first requires `Origin` equal to the instance origin;
  every other POST then requires the session that authorizes it (the setup session, or after bootstrap the admin's web
  session) and an anti-forgery token derived from it under a context of its own (`kopje-setup-csrf`). The only
  redirect target is `/setup`. `test/setup.test.ts` ("WEB-1, WEB-4: refuse a missing, null or foreign Origin on every
  form", "WEB-4: refuse a missing or wrong anti-forgery token on every form", "WEB-1: refuses a sign-in posted from
  another origin, a null origin or none").
- **WEB-5: responses declare their type.** API and federation responses carry their exact JSON media type and
  `X-Content-Type-Options: nosniff`. _Enforced (main):_ one middleware sets `nosniff`
  on every response (API, federation, inbox, media, errors and maintenance answers), and API and federation bodies
  are written by Hono's `c.json` and Fedify with their JSON types; `src/app/app.ts`; `test/inbox-statuses.test.ts`
  ("WEB-5: responses declare their type").
  Web UI pages: _Enforced (main):_ `text/html; charset=UTF-8` and `nosniff` on every page and error page; static assets
  get `nosniff` from `public/_headers`; `test/web-pages.test.ts`, `test/web-session.test.ts`.

### Setup (SETUP)

- **SETUP-1: nothing is published before setup.** Federation paths answer 503 until `/setup` has fixed the domain;
  sign-in answers 503 until Access is configured. _Enforced (main):_ `src/federation/setup-gate.ts`,
  `src/app/authorize.tsx`; `test/app.test.ts` ("answers 503 on federation routes until setup has fixed the domain"),
  `test/oauth.test.ts` ("answers 503 until Access is configured"). The wizard's steps before the bootstrap write only a
  draft in the setup session, so nothing is published until SETUP-3 commits; `test/setup.test.ts` ("confirms the host
  the request came to, and refuses workers.dev, IP addresses and ports").
- **SETUP-2: `SETUP_TOKEN` only bootstraps.** `/setup` changes require `SETUP_TOKEN`, compared as fixed-size digests.
  Once the domain and admin exist, the token cannot change the domain, the admin or the Access configuration.
  _Enforced (main):_ the Worker compares the token with `constantTimeEqual` (AUTH-5; it must be at
  least 32 characters) and opens a setup session: an opaque id in a `__Host-` cookie (HttpOnly, Secure,
  SameSite=Strict) for at most an hour, of which the Store keeps only the SHA-256. Every setup operation authorizes in
  its own transaction: a live setup session only while nothing is bootstrapped (any configuration row or local account
  counts), the admin's web session (a web-client token of the account whose email is `admin_email`) only afterwards.
  After bootstrap no setup session opens, and those left authorize nothing; the admin may see the status, run the
  checks and reconcile the Access applications (keeping `admin_email` and the domain), never change the domain or the
  admin. Access reconciliations are coordinated by the Store, which is the authority on time: a run reserves the
  instance-wide reconciliation (the next revision and a lease with a deadline the Store issues) before its first
  Cloudflare call, and renews it at a checkpoint before every write; a checkpoint refuses a run that was superseded or
  whose authority ended at the operation's own time (bootstrap ended the setup session; the admin's web session
  expired, was signed out or suspended). Immediately before each Cloudflare request the Worker compares its clock with
  the last deadline it was given and sends nothing with less than 15 s left; every request is aborted at the deadline
  and after 10 s at most. A reservation is superseded only 30 s after its deadline. What is guaranteed: no request of a
  run is in flight once a newer run may reserve, and no request is dispatched after a stale checkpoint answer, as long
  as the Worker's and the Store's clocks differ by less than the 30 s grace minus the 10 s request bound. A
  superseded run's late failure is recorded and shown, without changing the newer run's outcome. Before any write
  the run checks that the team is the selected account's organization (`auth_domain`), and it changes only objects
  whose ids it recorded or a single checked object of its name (adopting or recreating is an explicit recovery
  choice). `test/setup-access.test.ts` ("a run paused before its reservation makes no external write after bootstrap",
  "a run whose checkpoint answer arrives after its lease dispatches nothing; the next waits out the grace", "stops at
  the next checkpoint when the admin’s session expires during the run", "refuses a team that is not the selected
  account’s organization, before any write", "refuses a reusable policy attached to other applications"). `src/domain/setup.ts`, `src/app/setup.tsx`; `test/setup.test.ts` ("a reused setup token opens nothing", "a
  setup session opened before bootstrap cannot change the domain, the admin or Access", "shows the status to the
  admin, runs the checks, and reconciles Access with a new token", "refuses a signed-in user who is not the admin",
  "AUTH-5: refuses when SETUP_TOKEN is unset or shorter than 32 characters").
- **SETUP-3: bootstrap happens once.** The domain and the first admin are written in one Store transaction that fails if
  either exists, so concurrent requests cannot create two. _Enforced (main):_ `bootstrapInstance`
  writes the domain, the Access configuration, `admin_email` and the admin's local account together, refuses once any
  configuration row or local account exists, while a reconciliation runs or is unresolved (a failure, or a lease that
  ran out without an outcome), or when the session's Access outcome is not the latest completed revision; it ends
  every setup session. `src/domain/setup.ts`;
  `test/setup.test.ts` ("SETUP-3: concurrent bootstraps create one admin", "SETUP-3: refuses when … is configured
  already", "SETUP-3: refuses when a local account exists already", "SETUP-3: writes the domain, the Access configuration and the admin together", "SETUP-3: a
  failure at the last insert rolls the whole bootstrap back"), `test/setup-access.test.ts` ("only the latest completed
  run bootstraps", "bootstrap waits while a run is in progress", "a failure after external write … of 4 leaves the
  state unresolved").
- **SETUP-4: the Cloudflare API token is transient.** It is used only within the request that received it and is never
  stored, logged or returned. _Enforced (main):_ it is read from the form of one POST, sent only to
  `api.cloudflare.com` as a bearer token, never rendered (token fields are never filled), never put in a cookie or
  redirect; redirects are refused, not followed. A failure is reported as a fixed category with the step, the HTTP
  status and the API's validated numeric error codes; no text of the API's answer or of a thrown error is rendered,
  and an unexpected error is logged with `errorFields()` only (DATA-5). Only the API's answers (team, AUD tags,
  account id) reach the Store. `src/platform/cloudflare-api.ts`, `src/app/setup.tsx`;
  `test/setup-access.test.ts` ("SETUP-4: uses the API token in its own request only, and never stores, logs, renders
  or redirects it", "shows no fragment of the token for an echoed error across a truncation boundary, a
  thrown name or a redirect").

### Network (NET)

- **NET-1: document fetches are bounded and public-only.** The safe loader fetches https only, refuses URLs with
  credentials, literal IPs, `localhost` and single-label hosts, checks that the name resolves to public addresses,
  re-checks every redirect hop (same origin, at most 5), stops at 1 MiB and 5 s for the whole load, and honours abort
  signals. _Enforced (main):_ `src/federation/loader.ts`; `test/loader.test.ts`.
- **NET-2: deliveries reach only the audience's inboxes.** Inboxes come from the stored audience and are deduplicated by
  shared inbox; an activity without `to` (a Like, Follow, Accept, Reject, Block or their Undo, each naming its recipient
  through its object) goes to the recipient's shared inbox when it has one, and moves to its distinct personal inbox on
  the same origin (same lane, within the row's attempts) if the shared inbox answers 404, 405 or 410; targets pass
  NET-3; a non-public activity is never sent to a redirect target. Claims serialize each lane; the POST timeout (30 s)
  is shorter than the lease (60 s), and completion requires the current lease token, so a stale completion cannot settle
  a later claim. A lane is `(actor, inbox origin)`: everything an actor sends one server, to shared and personal inboxes
  alike, arrives in order, so a later `Update` or `Delete` cannot overtake the `Create`. The whole path from claim to
  POST (key loading, DNS, signing, the POST) runs under one absolute deadline, the earlier of 30 s and 10 s before the
  lease ends; the clock is checked against it after the key is loaded and right before the POST, so a late timer cannot
  let a POST through. _Enforced (main):_
  `src/domain/deliveries.ts` (expansion, lanes, claims, completions), `src/federation/delivery.ts` (the POST);
  `test/deliveries.test.ts` ("NET-2: delivers a public status once per shared inbox", "NET-2: a recipient outside the
  audience gets nothing", "NET-2: an expired lease is claimed again", "moves a Follow and its Undo to the personal
  inbox once when the shared inbox answers 404"), `test/delivery-post.test.ts` ("NET-2: never
  follows a redirect", "NET-2: times out the POST before the lease ends"), `test/delivery-regressions.test.ts` ("keeps a
  Create to a server's shared inbox ahead of an Update", "counts slow DNS and slow key loading against the budget",
  "refuses to send once the lease budget has run out"). A remote `Follow` cancels, in its receive transaction, its
  pair's `Accept`s and `Reject`s that no claim has taken (`deliveries.exposed`, set by the claim's lease and never
  cleared) or that are still unexpanded, for interoperability with servers that match answers by account pair: the
  follower's server gets only the new generation's answer. An answer a claim took stays, superseded (see the accepted
  risks): it may have been POSTed, or its attempt failed before any POST. An answer that is its lane's head when
  deliveries to that server fail is exposed by its first attempt, so what is cancelled is the answers queued behind a
  claimed head, or unexpanded. `cancelFollowAnswers` in `src/domain/deliveries.ts`; `test/follow-answers.test.ts`
  (each renewal path, both serialized orders against a claim and an expansion).
- **NET-3: every outbound sink has its own policy.** Any URL derived from remote or user input is fetched only through a
  sink client that applies NET-1's host rules (https, public address, re-checked hops, a hop limit) plus its own budget:
  documents as NET-1; remote media a size cap, a time limit and a type allowlist; Web Push and deliveries no redirects.
  Credentials and signatures never follow a redirect to another origin. Fedify's sending and queueing are not used.
  _Enforced (main)_ for documents and the Fedify rule: `test-node/fedify-usage.test.ts` ("never sends or queues through
  Fedify"). Deliveries: _Enforced (main):_ `assertPublicShape` and the DNS check before every
  POST, no redirects, 30 s (`postActivity` in `src/federation/delivery.ts`); `test/delivery-post.test.ts` ("NET-3:
  refuses inboxes that fail the public-host rules"). Web Push: _Enforced (main):_ the same sink before every POST
  (`sendPush` in `src/jobs/push.ts`), and the rules that need no lookup at registration (`publicShapeRefusal` in
  `src/platform/http-url.ts`, shared with `assertPublicShape`); `test/push.test.ts` ("NET-3: refuses endpoints that are
  not public https URLs"), `test/push-send.test.ts` ("PUSH-2: the endpoint is an outbound sink at every send", "never
  follows a redirect, and retries instead"). Remote media: _Planned (remote media):_ Kopje fetches no remote media
  (remote attachments, avatars, headers and custom emoji images are kept as http(s) URLs, HTML-3); a cache of them
  needs its own sink with a size cap, a time limit and a type allowlist.
  Kopje fetches nothing for local emoji; peers fetch `/media/…` and `/emojis/:id`.
- **NET-4: signed fetches stay with their signer.** A document fetched with a signature is cached under a key that
  includes the signing key id and is never served to another key or to the unsigned path. _Enforced (main):_
  `signedLoader` in `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("caches signed documents per signing
  key"). Expiry within 5 minutes: _Enforced (main):_ an entry carries Fedify `kvCache`'s default lifetime of 5
  minutes, and the KV store reads an expired entry as absent (`src/federation/kv-store.ts`, `src/domain/fedify-kv.ts`);
  `test/kv-store.test.ts` ("honors expires_at with the injected clock"). _Gap:_ no test pins the 5 minutes, Fedify's
  default. A sweep of expired rows: _Planned (KV sweep):_ nothing deletes expired `fedify_kv` rows yet.
  _Enforced (main)_ for the fetches of inbound processing and search:
  the original of a boost (and its author) is fetched as the request's other fetches are, with the personal inbox
  owner's key or the instance actor's, never from the signed-document cache; search with `resolve=true`
  (`GET /api/v2/search`, and `GET /api/v1/accounts/search` for addresses) fetches as the instance actor only, for a
  request whose token is valid, has the scope and names a user (401, 403 or 422 otherwise, before anything is
  fetched), with WebFinger unsigned; the search after the fetch judges the token again at its own time. An account's
  canonical address is decided as Mastodon 4.7.3's `ActivityPub::ProcessAccountService#check_webfinger!` and
  `ResolveAccountService` decide it: the actor's own host
  declares it in the subject of its WebFinger answer for `acct:<preferredUsername>@<host>`; another domain there is a
  candidate, which must answer for that subject with the same actor id; otherwise the address is on the host
  (`declaredDomain` in `src/federation/resolve.ts`). Every domain from an address or a subject goes through one strict
  parser (`normalizeDomain`): lowercase, punycode for an IDN, a hostname of two labels or more, and nothing else (no
  port, userinfo, path, trailing dot or IP literal); a subject needs exactly one `@` and no empty part. Domains are
  queried, compared and stored only in that form, so the domain stored is the one queried and confirmed. An address is
  split into its parts before its domain is normalized, for resolution, exact account search and lookup, so a Unicode
  and a punycode spelling find the same account. The fallback domain is the actor id's host as Mastodon takes it
  (`Addressable::URI#normalized_host`: lowercase, punycode, without the port), also without a trailing dot
  (`hostDomain` in `src/platform/domain-name.ts`); the id itself is kept whole for origin checks. Only an
  authoritative answer (404 or 410, or another subject or actor) drops a confirmation: a transient failure (network,
  timeout, 5xx, the fetch budget) keeps the stored address for that username. The confirmation is bound to its (username, domain, actor id):
  `accounts.confirmed_username` holds the username it was made for, and an actor whose `preferredUsername` changes
  falls back to its host until it is confirmed again. A search by an alias (any address whose WebFinger names an
  existing actor) finds the account by its actor id and never sets or replaces its address. One helper
  (`accountDomain` in `src/domain/inbox.ts`) decides the stored domain for every path. _Gap:_ inbound activities do
  not look up WebFinger, so an account first seen inbound shows its actor's host until it is resolved, and a renamed
  actor keeps its host until it is resolved again. `test/inbox-canonical-address.test.ts` ("the canonical address of a
  remote account", "the domains of WebFinger subjects and addresses, parsed one way"). `createRemoteLoaders` in
  `src/federation/federation.ts`, `src/federation/resolve.ts`; `test/inbox-statuses.test.ts` ("signed by the instance
  actor (NET-4)", "resolves a status URL as the instance actor", "answers 401 without a token and fetches nothing",
  "account search with resolve=true (NET-4, VIS-1)"), `test/inbox-statuses-edge.test.ts` ("NET-4: search resolution
  fetches nothing without a valid token").
- **NET-5: snapshots come only from authoritative local data.** A rescue snapshot holds only a canonical actor,
  WebFinger or NodeInfo document rendered on the fixed domain from Store columns, and is kept only if its source still
  matches the Store when saved. Request hosts, arbitrary queries and remote documents never create or change one.
  Suspending an account removes the snapshots of its actor document and WebFinger answers in the same transaction, so
  the rescue path answers 503 for them, never with the document from before the suspension, until a live request keeps
  the redacted one. _Enforced (main):_ `src/domain/snapshot.ts`, `src/federation/routes.ts`; `test/snapshot.test.ts`
  ("snapshots of a suspended actor").

### Content (HTML)

- **HTML-1: remote HTML is sanitized by allowlist.** Tags, attributes and URL schemes are allowlisted by a maintained
  sanitizer (or custom code that passes the vector suites below). Sanitized HTML enters only rich-content sinks
  (`content`, `note`, field values) and is not escaped a second time. _Enforced (main)_ for bios:
  `sanitizeRemoteHtml` in `src/security/html.ts` (sanitize-html with Mastodon's `MASTODON_STRICT` allowlist, styles never allowed and postcss stubbed out);
  `test/html.test.ts`. _Enforced (main)_ for status content (sanitized once by the
  Worker before it is stored, the converted text of an Article or Page included) and profile field values (read from
  the stored actor document and sanitized when presented, at most 16 fields): the same `sanitizeRemoteHtml`;
  `test/inbox-statuses.test.ts` ("sanitizes content by allowlist with http(s) links only", "shows PropertyValue fields
  with sanitized values").
  The web UI sanitizes again at the sink: bios, status content and field values reach a page only as the sanitizer's
  output (`SafeHtml` in `src/web/safe-html.ts`), whatever the Store holds. _Enforced (main):_ `test/web-pages.test.ts`
  ("sanitizes stored HTML at the sink and drops non-http links").
  The operator's documents (the extended description, the privacy policy and the terms of service) are stored as the
  admin wrote them or the cutover converted them and sanitized once per sink: in the Store for the API
  (`instanceDocument` in `src/domain/instance.ts`), at the page for the web (`instanceDocumentSource`, then
  `SafeHtml`). At most 50,000 UTF-8 bytes each (RES-2), so the sanitizer's raw cap never cuts one, however sanitizing
  lengthens it. _Enforced (main):_ `test/instance-reads.test.ts` ("serves the privacy policy sanitized", "keeps the end
  of a document that sanitizing lengthens past the raw cap"), `test/web-pages.test.ts` ("serve the privacy policy and
  the terms of service as stored, sanitized at the sink", "shows the extended description sanitized at the sink").
- **HTML-2: local text becomes HTML only by escaping and linking.** Status text and bios are escaped, then absolute
  http(s) URLs, known mentions and hashtags are linked. Display names stay plain strings. _Enforced (main)_ for bios:
  `src/domain/plain-text.ts`; `test/accounts.test.ts` ("stores plain-text profile fields safely"). _Enforced (main)_ for status text: `src/domain/status-text.ts`; `test/status-text.test.ts`.
  Local profile fields are stored as plain text and presented escaped with http(s) URLs linked (`renderFieldValue`),
  in the API and as the actor's `PropertyValue` attachments: _Enforced (main):_ `renderFieldValue` in
  `src/domain/status-text.ts`; `test/web-session.test.ts` ("saves the profile"), `test/profile-fields.test.ts`
  ("publishes fields as PropertyValue attachments of the actor").
  _Enforced (main)_ for announcements: the Access admin's text is stored as plain text and rendered when presented, by
  the status pipeline (`parseStatusText`, `renderStatusHtml`: escaped, http(s) URLs, mentions of available accounts and
  hashtags linked), so an import can hold no HTML; `src/domain/announcements.ts`; `test/announcements.test.ts`
  ("presents a published announcement in Mastodon’s key order").
- **HTML-3: navigable URLs are http(s) only.** Before a profile URL, avatar, header, attachment URL, field link or app
  website is emitted, it is parsed and must be http or https; anything else becomes absent or the default. This applies
  to fetched and imported data too. _Enforced (main)_ for app websites at registration: `validWebsite` in
  `src/mastodon/oauth.ts` (_Gap: untested_). _Enforced (main)_ for the account presenter and
  local actor documents (profile URL, avatar, header, icon, image and aliases): `httpUrl` in `src/platform/http-url.ts`,
  used by `presentAccount` in `src/domain/accounts.ts` and `localActorObject` in `src/federation/federation.ts`;
  `test/accounts.test.ts`, `test/federation.test.ts`. _Enforced (main)_ for attachment URLs
  in the API and in Note attachments: `presentMedia` in `src/domain/status-presenter.ts`, `noteOf` in
  `src/domain/activities.ts` (_Gap: no test with a non-http stored attachment URL_). _Enforced (main)_ for remote actors at ingest (profile URL, avatar, header, inboxes) and links in remote
  HTML: `src/federation/remote-actor.ts`, `src/security/html.ts`; `test/inbox.test.ts` ("stores the remote actor"),
  `test/html.test.ts`. _Enforced (main)_ for field links and remote statuses at ingest
  (the status url and attachment and preview URLs, which are dropped unless http(s)); `src/federation/remote-status.ts`;
  `test/inbox-statuses.test.ts` ("keeps only http(s) media (HTML-1, HTML-3)", "http(s) links only").
  _Enforced (main)_ for custom emoji: an emoji's `url` and `static_url` pass `emojiHref` (http(s), serialized, within
  512 bytes and `EMOJI_URL_ALPHABET`) when an `Emoji` tag is read and again whenever a snapshot is presented, so an
  imported row is normalized too and an entry whose URL does not pass is dropped (`src/domain/custom-emojis.ts`,
  `src/federation/remote-emoji.ts`); the stored-bound triggers refuse any other scheme (RES-2);
  `test/custom-emojis.test.ts` ("drops what the trigger would refuse and still stores the status", "normalizes stored
  urls again, drops one that does not pass, and cuts at the presented bound"), `test/emoji-bounds.test.ts`.
  _Enforced (main)_ for local emoji: their URLs pass `emojiHref` when a snapshot is taken
  (`localEmojiSnapshot`), in the list and in `icon.url`; the category is judged again on every presentation
  (`presentedCategory`), so an imported value that is not well-formed UTF-8 is left out (`test/local-emoji-api.test.ts`).
  Web UI pages emit only local paths and http(s) URLs (avatars, headers, media, field and app links, the parent of a
  reply); field links carry `rel="me"`: _Enforced (main):_ `src/web/pages.tsx`; `test/web-pages.test.ts`.

### Media (MEDIA)

- **MEDIA-1: only the owner uses an attachment.** Only the uploader may update, delete or attach an attachment, and only
  while it is unattached or attached to the status being edited; media an edit drops stays attached to its status,
  not shown, so only a later edit of that status may attach it again; attaching refuses anything else (422, one
  message for every reason). _Enforced (main)_ for attaching: `mediaToAttach` in `src/domain/statuses.ts`;
  `test/statuses.test.ts` ("attaches own unattached media", "media_ids").
  _Enforced (main)_ for reading, updating and deleting: `src/domain/media.ts` (an upload is
  read or updated only by its owner while unattached; it is deleted only through its owner's status with
  `delete_media`, by its owner while unattached and not held by a scheduled status (`deleteMedia`), or by the sweep
  after its grace period, and a doomed or still-processing upload cannot be attached);
  `test/media.test.ts` ("shows and updates own unattached media only", "deletes own unattached media with its R2
  objects, and nobody else’s").
  _Enforced (main)_ for custom emoji images (MEDIA-5): an emoji's image is an upload of the OAuth admin, but it is
  never read, updated, deleted, attached, scheduled or made a profile image through the API: `liveMediaSql` excludes
  every `custom_emojis` row (`notEmojiSql` in `src/domain/media.ts`); `test/media-reconcile.test.ts` ("keeps both emoji
  and their files").
- **MEDIA-2: R2 keys are server-made.** Keys derive from server-generated ids and stored records; no filename, path
  segment or encoded separator from a request selects or overwrites a key. Originals are not publicly readable.
  _Enforced (main):_ `src/platform/media-files.ts` (originals at `originals/<id>`, served
  files at `files/<token>/<variant>`; the serving route builds only `files/` keys from a token of the server's form);
  the Store holds a row for every key before it is written, and the sweep deletes a row only after its objects. A write
  started before the upload's deadline can still land after the sweep, so the sweep leaves a tombstone
  (`media_orphans`) for each upload that never completed, and reconciliation (the cron, `reconcileMedia` in
  `src/mastodon/media.ts`) deletes its keys again a day after the deadline. Reconciliation deletes only recorded
  tombstones, never an object because no row names it, and neither it nor the sweep runs during maintenance, a dump,
  an import, or before setup; tombstones are not dumped, so a restored or imported Store starts with none and deletes
  nothing it restores. `test/image-bytes.test.ts` ("media keys"), `test/media.test.ts` ("serves only well-formed paths
  of served files"), `test/media-reconcile.test.ts` ("deletes nothing from R2 for a Store that knows nothing of it",
  "deletes nothing during maintenance, an import, or before setup", "deletes a late write of a failed upload").
  The media rebuild (`kopje-admin media-rebuild`, `src/mastodon/media-rebuild.ts`) builds its keys the same way, from the
  row's id and token only, and writes only while nothing deletes media: while a verified import is unpublished (the
  import began on an empty Store and every write has been refused since, so no deletion was ever decided for a row it
  brought), or once the Store's readonly maintenance has lasted 20 minutes (`REBUILD_SETTLE_MS`: longer than a cron
  invocation, at most 15 minutes, or the sweep after an API delete, at most 30 seconds after its response, can still
  run with a batch fetched before maintenance began). Otherwise it is refused (`rebuild-needs-readonly`,
  `rebuild-settling`); the env `MAINTENANCE` alone is not enough, since the Store records no start for it, and the
  operator must not change it during a rebuild. In those states `delete_media`, the sweep, reconciliation and an
  upload's cleanup are refused at their first Store write, before any R2 delete; while the rebuild's lease is live they
  are refused whatever the flags say (operation kind `media-delete`), and so is leaving maintenance. One call runs at a
  time under that lease, kept at the Store's clock: renewed before each row and, while an R2 write is pending, every
  minute; R2 writes and deletes are never given up but awaited to completion, so the lease cannot end under a write
  the call started while the call runs, and each starts only after the Store confirms the lease is still the call's
  (once a renewal or that check fails, no further write starts, the call reports `lease-overrun` and the lease is not
  released). A PITR restore is refused while the lease is live, and the lease while a restore is being scheduled
  (`pitr_restoring`); since a restore rewinds the maintenance start and the unpublished flag, the Store records each
  restore outside its database (an R2 object named by its id, `restoreMarkerKey` in `src/platform/media-files.ts`,
  never served) before scheduling it, and the
  rebuild counts readiness only from it: an unpublished flag from before it is not ready, and maintenance settles from
  the later of its start and the restore. An import reset or cutover reset never writes the maintenance flag, so they
  leave no stale start. Per row the other steps are bounded: two R2 reads, five Images calls and five Store calls, each given up
  a minute before the renewed 10-minute lease ends. As defence in depth the rebuild records the row before it writes
  the files and, once both writes have completed, asks whether the row is still live, deleting the files it wrote if
  not. It deletes nothing else. `test/media-rebuild.test.ts` ("leaves out remote, doomed and unfinished rows", "runs
  only where delete_media, the sweep and reconciliation cannot delete media", "is refused in a writable Store and
  under the env maintenance alone", "waits for maintenance to settle", "refuses leaving maintenance and every
  media-deleting write while the lease is live", "awaits a pending write past the deadline", "deletes the files it
  wrote for a row that went while it wrote them", "refuses a restore while the lease is live", "counts the settle
  period again from a restore"). Accepted residual risk: a Worker terminated in the middle of an R2 write leaves no
  heartbeat and no record, and that one write may land after the lease expired; it is bounded to a put already in
  flight at termination, and its file lands under the capability URL of a row that existed when the rebuild started.
  A custom emoji upload (`kopje-admin emoji add`, `src/mastodon/emoji-upload.ts`) builds its keys as every upload's,
  from a reservation the Store records before any write (`reserveEmoji` in `src/domain/local-emojis.ts`); completion
  and promotion are one transaction (`completeEmoji`: the row is kept, gc_at NULL, with its emoji row), and a failure
  abandons the reservation (`abandonEmoji`, only that id and token), whose keys go only when the Store does not keep
  it. The sweep, the purge and `profileReleaseSql` exclude emoji images, and the foreign key of `custom_emojis`
  refuses deleting one; `test/local-emojis.test.ts` ("emoji completion").
- **MEDIA-3: served images are re-encoded.** An image is served only as Images output with location metadata removed; if
  transformation fails, the upload is refused and original bytes are never served. _Enforced (main):_ outputs are PNG or WebP only, for which Images discards all metadata (the binding has no
  metadata option, and JPEG output would keep the EXIF copyright tag); `processImage` in `src/platform/images.ts` then
  checks every output with `retainedMetadata` (`src/platform/image-bytes.ts`), which refuses any EXIF, XMP, IPTC,
  comment, text chunk or unknown JPEG application segment and keeps only colour profiles, and refuses the upload
  otherwise; `test/image-bytes.test.ts` ("refuses every EXIF block", "refuses XMP, IPTC, comments"),
  `test/media.test.ts` ("re-encodes an image without its location", "refuses a failed transformation", "refuses an
  output that keeps …"). Tests use Miniflare's local Images binding (sharp); the production binding's output is
  verified on a deployed instance. The media rebuild, which makes the served files of restored or moved
  media from their originals, goes through the same `processImage` and writes nothing for an original that fails, and
  never serves an original instead; it refuses an original whose served type differs from the row's (its URLs name that
  type). `test/media-rebuild.test.ts` ("makes both files … and corrects meta", "reports a missing original and a type
  mismatch").
  Custom emoji (`src/platform/emoji-image.ts`): an input is PNG, GIF or WebP by signature, below 262,144 bytes, with
  edges of at most 1,024 read by the free `info()` before anything is charged; the published `full` is below 262,144
  bytes (what Mastodon downloads, `CustomEmoji::LIMIT`) and `small` at most 524,288, judged before any R2 write. The
  media rebuild applies the same checks before charging and before writing, and checks an emoji's existing files by
  size and, in a real run, its served image's actual edges and type (`emoji-actual`); each failure is a per-row
  problem that writes and deletes nothing. An imported emoji's image must record edges of at most 1,024 (the 0055
  trigger checks the recorded `meta.original` only; the rebuild checks the files). `test/local-emojis.test.ts` ("emoji
  upload"), `test/media-rebuild.test.ts` ("media rebuild of custom emoji images").
- **MEDIA-4: media cannot run as instance content.** Uploads are accepted by detected type from an allowlist and served
  with their stored type and `nosniff`; HTML, SVG and other active types are never served from the instance origin.
  _Enforced (main):_ `sniffImageType` (JPEG, PNG, GIF, WebP, AVIF by signature, and Images
  must read the same type); `SERVED_TYPES` and `src/web/media.ts` (JPEG, PNG and WebP only, `nosniff`, `sandbox` CSP);
  video and audio are refused; `test/media.test.ts` ("refuses active and unsupported types by their bytes", "never
  serves a stored object of another type").
- **MEDIA-5: a custom emoji's image is never deleted, disabled emoji included.** Its media row has the emoji's id,
  which the foreign key of `custom_emojis` holds (no cascade), the 0055 image trigger requires a kept upload, and every
  destructive or API selection excludes it (MEDIA-1, MEDIA-2). _Enforced (main):_ `src/domain/media.ts`
  (`notEmojiSql`), migration `0055_local_custom_emojis`; `test/media-reconcile.test.ts` ("custom emoji images after
  every grace period", with an expiring upload and a due tombstone as controls), `test/migrations.test.ts` (0055).

### Web Push and polls (PUSH, POLL)

- **PUSH-1: a subscription belongs to its token.** Subscription operations require the `push` scope and select the
  subscription by the authenticated token, never by an id from the request. _Enforced (main):_ the four routes declare
  `{ scope: 'push' }` (`src/mastodon/routes.ts`), and every operation selects by the viewer's `tokenHash`
  (`src/domain/push.ts`); `test/push.test.ts` ("PUSH-1: another token, of another user or the same one, cannot read,
  change or delete a subscription", "requires the push scope and a user").
- **PUSH-2: endpoints are outbound sinks.** A push endpoint passes NET-3 at registration and at every send. At
  registration the rules that need no lookup (https, no credentials, no literal IP, no local or single-label name, at
  most 2,048 characters); at every send the delivery sink, which adds the DNS check, refuses redirects and keeps the
  delivery budget, as for an inbox. _Enforced (main):_ `src/mastodon/push.ts`, `sendPush` in `src/jobs/push.ts`;
  `test/push.test.ts` ("NET-3: refuses endpoints that are not public https URLs"), `test/push-send.test.ts` ("PUSH-2:
  the endpoint is an outbound sink at every send").
- **PUSH-3: push reveals no more than notifications.** A push is sent only for a VIS-10 notification the recipient may
  still see when sending. Revoking the token or suspending the account deletes its subscriptions. A push is recorded
  only for a new notification and a subscription whose alert and policy want it. The claim checks again, in its
  transaction, that the notification exists and is shown to its recipient (the notification rule, judged at the time
  of the check: a mute that has begun or expired since counts as it stands, and so does the rule for mentions of a
  blocked or muted account), that the
  subscription still wants it with a valid token of an unsuspended account, and that it is at most 48 hours old; and
  the same check runs once more after the host check, right before the POST, under the claim's lease (so the
  subscription is the same one). What is sent is read at that last check, never carried from the claim; a push that
  fails either check is dropped unsent. The payload carries only what the notification shows: the sender's name and
  avatar, and the status's content warning or text (at most 140 characters), or the sender's note. Subscriptions and
  their pending pushes cascade from the token, so revocation and suspension, which delete the tokens, delete them.
  _Enforced (main):_ `claimPushes` and `confirmPush` in `src/domain/push.ts`, `sendPush` in `src/jobs/push.ts`,
  `migrations/0002_web_push.sql`; `test/push-send.test.ts` ("PUSH-3: a push reveals no more than the notification",
  including "PUSH-3: sends nothing when … while the host check runs", "PUSH-3: applies the mention rule at sending",
  "PUSH-3: judges a mute at the time of sending"), `test/push.test.ts` ("PUSH-3: revoking the token
  or suspending the account deletes its subscriptions").
- **POLL-1: votes are the voter's own.** Only the poll's author changes its definition or results. A vote is attributed
  to the verified voter, names a valid option of that poll, respects expiry and single or multiple choice, and a replay
  counts once. _Enforced (main):_ a local poll is changed only by its author's edit (`editPoll`, through
  `editStatus`'s own-status check) and a remote one only by its author's Create or Update (`storeRemotePoll`, behind
  ID-6's author and origin checks); a local vote is the authenticated viewer's (`vote`), a remote one the signed
  actor's, a Note naming a choice in reply to a local poll (`receiveVote`): open, a choice it has, not the author's
  own, not again (`UNIQUE (poll_id, account_id, choice)` and VoteValidator's rules); counts change only with a vote
  written. `src/domain/polls.ts`, `migrations/0013_polls.sql`; `test/polls.test.ts` ("refuses a vote as Mastodon's
  VoteValidator does"), `test/polls-federation.test.ts` ("counts once, as Mastodon counts it, and is never stored as a
  status", "takes the counts … of an Update(Question) that names no new version, but not new choices").
- **POLL-2: a poll shows no more than its status, and never who voted (VIS).** A poll is read and voted on only by
  whoever may see its status by itself (R3), and a vote needs R27 (`mayVoteSql`: the voter blocks neither the
  author nor its domain); otherwise 404 (403 for a voter who blocks the author, as Mastodon). Only counts and the viewer's own votes
  are shown; `hide_totals` hides each choice's count from everyone until the poll ends, in the API and in the
  Question (no `totalItems`). `poll_votes` is read in `polls.ts` alone (`test-node/policy-boundary.test.ts`, R27). A
  remote vote passes the same rule (Mastodon checks none). _Enforced (main):_ `test/polls.test.ts` ("shows a poll only
  to whoever may see its status", "refuses a voter who blocks the author (R27)", "hides the counts … from everyone"),
  `test/polls-federation.test.ts` ("is refused from an account the author blocks (R27)").
- **POLL-3: polls cost bounded work (RES).** Presenting reads each poll's row and the viewer's own votes, never the
  votes; the cron ends at most 25 polls and records at most 25 Updates of counts a run, through partial indexes; the
  Update of a local poll's counts is debounced (3 minutes after the first vote since the last one sent, one Update for
  all, superseding any still waiting), never one per vote; a remote poll keeps at most 100 choices of at most 1,000 code
  units (Mastodon's and Misskey's own choices fit whole; a vote in a choice cut to that is refused, as its name would
  match nothing); a status's or account's votes go in bounded batches of a purge, and the votes an edit drops (a new
  generation of the poll) in bounded rounds of the cron. _Enforced (main):_
  `test/policy-bounds.test.ts` ("polls are presented from their counts, not their votes"), `test/polls.test.ts`
  ("ends at most … polls a run", "falls due a while after the first vote", "RES-6: votes go in bounded batches").
- **POLL-4: polls federate as Mastodon's (AP).** A local poll's status is a Question (`oneOf`/`anyOf`, `endTime`,
  `closed` once ended, `votersCount`, each choice's `replies.totalItems`) in its Create, Update and served object; a
  local vote in a remote poll is a Create of a Note (`name`, `inReplyTo`, to the author) to the author alone, through
  the delivery queue; an inbound Question is stored with its poll, an implicit Update refreshes only counts, end and
  voters, and a vote Note is never a status. _Enforced (main):_ `test/polls-federation.test.ts`.

### Resources (RES)

- **RES-1: input is bounded before it is parsed.** API parameter bodies and inbox bodies stop at 1 MiB, by
  `Content-Length` or while streaming. Each text field has a raw cap before parsing or counting (status text: 10,000
  code units). Media uploads have their own limit. _Enforced (main)_ for bodies: `src/platform/body.ts`,
  `src/mastodon/params.ts`; `test/gate.test.ts` ("refuses an inbox body over 1 MiB", "stops reading a streamed inbox
  body"). _Enforced (main)_ for API bodies: a route's body stops at its limit (1 MiB unless the route sets one), and a
  route that reads files (`readParams`' file rule: `update_credentials`' avatar and header, the settings page's
  image) takes a multipart body of the limit plus each file and its part headers (17,858,560 bytes for
  `update_credentials`), chosen from `Content-Type` before any byte is read, while its text stays within the limit in
  UTF-8 bytes; a JSON body is refused past 10,000 generated parameter paths (object members, array objects and empty
  arrays) or 2,097,152 UTF-16 code units of all its keys, charged before each key is built, and past 32 levels of
  nesting; `update_credentials` checks the token before reading a multipart
  body; `test/params.test.ts`, `test/profile-images.test.ts` ("takes a multipart body up to the text limit plus two
  files and refuses one byte more", "answers an invalid or under-scoped token without reading a multipart body"). _Enforced (main)_ for status text: `test/status-text.test.ts`
  ("raw input bound"). _Enforced (main)_ for search terms (500 characters) and media (16 MB
  and 16,777,216 pixels, read with the body bound before parsing): `src/mastodon/search.ts`, `src/mastodon/media.ts`;
  `test/search.test.ts` ("bounds the query"), `test/media.test.ts` ("refuses a file over 16 MB"). _Enforced (main)_ for remote profiles: bios are cut at 50,000 code units before sanitizing and
  display names at 2,048 (`src/security/html.ts`, `src/federation/remote-actor.ts`). _Enforced (main):_ a timeline marker's `last_read_id` stops at 255 characters, which Mastodon bounds as a bigint (`src/domain/markers.ts`; `test/markers.test.ts` ("answers 422 with Mastodon's validation message")). _Enforced (main)_ for scheduled statuses: `scheduled_at` is read only up to 64 characters, and a scheduled status's params are a JSON object of a fixed shape built from checked fields (the status text's raw bound, at most four media ids), refused over 128 KiB in the Store and by the schema (migration `0011_scheduled_statuses`); `test/migrations.test.ts`, `test/scheduled-statuses.test.ts`. `scheduled_at` must name a date and time the calendar has (Ruby's `DateTime.parse`: no February 29 outside leap years, no 31st of a 30-day month, minutes and hours in range), checked before its offset applies. Other query strings: _Gap._
  _Enforced (main)_ for status text a remote server sends: content is stored within `STATUS_CONTENT_BYTES` (128 KiB)
  as a JSON string, the sanitized form of a shorter raw prefix when the whole does not fit, so it stays sanitizer
  output (`sanitizeRemoteContent` in `src/security/html.ts`, the search `sanitizeRemoteBio` uses); a content warning
  within `SPOILER_BYTES` (16 KiB), cut at a code point (`cutJsonString`); a media URL or preview over
  `MEDIA_URL_LIMIT` (2,048) is not stored (`src/federation/remote-status.ts`). A local post or edit whose rendered
  content or warning passes those bounds, which only hundreds of mentions of accounts with long profile URLs reach, is
  refused with Mastodon's length error (`src/domain/statuses.ts`; `test/status-bounds.test.ts`).
  _Enforced (main)_ for custom emoji: at most `MAX_EMOJI_TAGS` (64) `Emoji` tags of an object are examined, each url
  at most `MAX_URL_LENGTH` as received (`emojiCandidates` in `src/federation/remote-emoji.ts`);
  `test/custom-emojis.test.ts` ("keeps the first valid tag of a name, examines 64 tags only, and stops at the first that does not fit").
  _Enforced (main)_ for a custom emoji upload: a JSON body of at most 1 MiB, an image below 262,144 decoded bytes in
  strict base64, its edges read before any transformation (`src/mastodon/emoji-upload.ts`).
  _Enforced (main)_ for announcements: an admin body of at most 1 MiB (`JSON_BODY_LIMIT`), a text of at most 10,000
  UTF-8 bytes (`ANNOUNCEMENT_TEXT_BYTES`), and a reaction name judged within 128 bytes before the emoji pattern runs
  (`isUnicodeEmoji` in `src/platform/emoji-names.ts`); `test/admin-announcements.test.ts`, `test/emoji-names.test.ts`.
  _Enforced (main)_ for trends: `Accept-Language` is read within its first 1,024 code units; a review's hashtag name is
  a hashtag name normalized within the stored name rule (1,024 bytes, 256 characters); `src/mastodon/trends.ts`,
  `src/domain/trends.ts`; `test/trends.test.ts`, `test/admin-trends.test.ts`.
- **RES-2: parsing work is bounded.** Every regex, parser and normalization over input at the RES-1 cap has an
  adversarial fixture with a time bound. _Enforced (main)_ for status text:
  `test/statuses.test.ts` ("handles the worst case at the bound within a generous time"). _Enforced (main)_ for the image metadata walk: `test/image-bytes.test.ts` ("walks a worst-case file at the upload
  bound"). Remote HTML: _Enforced (main):_ `test/html.test.ts` ("at the raw cap
  within a generous time"). _Enforced (main)_ for JSON-LD processing and inbound JSON:
  every inbound activity and every fetched document must stay within 10,000 values and 32 levels of nesting before
  anything reads it or hands it to JSON-LD (`withinJsonBounds` in `src/platform/json-bounds.ts`, applied by
  `parseActivity` and by the loaders of `createRemoteLoaders`); JSON-LD contexts too, before they are cached and again
  on every cache hit (an entry may predate the check; `boundedContexts` in `src/federation/federation.ts`); and one
  request fetches at most 8 documents (the fetch budget), so one activity's JSON-LD work is at most 8 bounded
  documents and their bounded contexts; the Store asks the Worker for documents at most 3 times per activity;
  statuses are read as compacted JSON, without JSON-LD, as Mastodon reads them; `test/inbox-statuses.test.ts`
  ("refuses an activity or a fetched document past the JSON bounds before reading it", "caps the attachments, tags
  and content one status stores"), `test/inbox-statuses-edge.test.ts` ("RES-2: JSON-LD contexts past the JSON
  bounds", "the Store asks for documents at most three times"). _Enforced (main)_ for stored values: each column of
  `STORED_COLUMNS` in `src/platform/stored-bounds.ts` holds a fixed point of its projection P, in the bound's own unit.
  Writers store such values; migration `0048_stored_bounds` set every existing value to P(x) without a copy (an
  uploaded media URL past 2,048 bytes fails it first, by the check `tokened_media_url_within_2048_bytes`); and the
  triggers `<table>_bounds_insert` and `<table>_bounds_update` (`migrations/0048_stored_bounds.sql`) abort any write
  where `P(NEW.x) IS NOT NEW.x`. Reads take these columns as stored: since P(P(x)) = P(x), a rewritten row presents
  what a read through P presented before. The columns that keep read-time projections are listed at `STORED_COLUMNS`.
  `test/stored-bounds.test.ts` ("P is idempotent and the writer's output is its fixed point", "answers every converted row after the rewrite"), `test/migrations.test.ts` (0048: "stores each covered value as P(x)", "refuses a value one past its
  bound on insert and update", "fails by its check on an uploaded media URL past the bound"),
  `test/dump-import.test.ts` ("restores a dump taken before 0048_stored_bounds"),
  `test-node/cutover-stored-bounds.test.ts`. _Enforced (main)_ for the instance's public settings: each name of
  `INSTANCE_SETTING_BOUNDS` in `src/platform/stored-bounds.ts` has a projection P (no row where it keeps none) and a
  writer; migration `0049_instance_bounds` cut titles and descriptions and deleted every other row past its bound or
  blank, and the triggers `instance_settings_bounds_insert` and `instance_settings_bounds_update` abort a write where
  `P(NEW.value) IS NOT NEW.value`. The admin write refuses what its writer would change; the cutover's conversion and
  verification store the writer's output. Rules are a JSON array of at most 64 KiB, which `parseRules` parses.
  `test/stored-bounds.test.ts` ("P is idempotent, the writer's output its fixed point, and on normalized input they
  agree"), `test/migrations.test.ts` (0049: "stores each covered value as P(x)", "refuses a value one past its
  bound on insert and update"), `test/dump-import.test.ts` ("restores a dump taken before 0049_instance_bounds"),
  `test/admin-instance.test.ts` ("accepts each value at its bound in its unit"),
  `test-node/cutover-stored-bounds.test.ts` ("cuts or drops values past their bounds as truncations"). _Enforced
  (main)_ for emoji snapshots: `statuses.emojis`, `status_edits.emojis` and `accounts.emojis` hold NULL or a snapshot
  within the form and bounds of `EMOJI_COLUMNS` in `src/platform/stored-bounds.ts` (docs/dump-format.md): in its
  stored bytes and in the presented JSON bytes of its entities, so a presented entry needs no escape, and with no NUL
  anywhere (SQLite's JSON functions stop at one). The triggers
  `<table>_emojis_insert` and `<table>_emojis_update` of migration `0053_custom_emoji_snapshots` refuse any other
  value, imports included (`emojisPastBoundSql`, whose JS twin is `emojisValid`). The writer (`emojiSnapshot` in
  `src/domain/custom-emojis.ts`) shares `emojiHref` and the url alphabet with them, so ingestion drops an emoji the
  triggers would refuse and the write succeeds; it keeps the tagged emoji the object's final texts reference, found by
  `shortcodesIn`, a split on `:` that is linear and builds no pattern from data. An edit's snapshot is copied in SQL
  (`recordEdit`). `test/emoji-bounds.test.ts` (the predicate and its twin over a hand-written table of inputs, each
  with its own verdict), `test/migrations.test.ts` (0053), `test/custom-emojis.test.ts` ("writes only what the trigger
  accepts, at every bound", "scans adversarial texts in linear time"), `test/dump-import.test.ts` ("restores a dump
  taken before 0053_custom_emoji_snapshots, and round-trips snapshots at their caps"), `test/cutover-import.test.ts`
  ("fails the check on a converted row holding an emoji snapshot, counting them by table").
  _Enforced (main)_ for reports (migration `0054_remote_reports`): CHECKs hold every stored report, an imported one
  included, to a uri within 4,096 JSON-escaped UTF-8 bytes (`report_uri_within_4096_json_bytes`), `status_ids` of at most 100
  ids within 2,101 UTF-8 bytes (100 quoted 18-digit status ids, commas and brackets;
  `report_status_ids_within_100_ids_and_2101_bytes`) and a comment within 20,000 UTF-8 bytes and, up to its first NUL
  (SQLite's `length` stops there), 5,000 code points (`report_comment_within_20000_bytes`); Kopje's writers keep 5,000
  code points with a NUL too (`reportComment`, a lone surrogate read as U+FFFD), where other text writers remove NUL
  (accepted: the comment is plain text, never rendered as HTML, and its JSON is at most about 120 KB). A Flag's comment
  that is not a string reads as none (`test/inbox-flag.test.ts` ("Flag: bounds"), `test/migrations.test.ts` (0054)).
  _Enforced (main)_ for local emoji: local emoji rows, imports included, meet the
  [stored bounds](dump-format.md#stored-bounds), enforced by migration `0055_local_custom_emojis`. The local writer
  shares `emojiSnapshot` and `emojiHref`, looks up at most 1,024 names and resolves at most 64 tokens, each by
  index (`src/domain/custom-emojis.ts`); `test/local-emojis.test.ts` ("reads each production query through its
  index").
  _Enforced (main)_ for announcements: announcement rows, imports included, meet the
  [stored bounds](dump-format.md#stored-bounds), enforced by migration `0056_announcements`; writers share
  `storedAnnouncementText` and `isUnicodeEmoji`. A text within its bytes is within the parser's raw bound once decoded,
  and the rendering measures each segment's HTML as it is built (text, escapes and paragraph markup included) and stops
  at the first that passes the content budget, so what is built past the budget is one segment, at most 310,064 bytes of
  JSON (a hashtag of 3,333 U+FDFA, NFKC-expanded and URL-encoded); `test/migrations.test.ts` ("0056_announcements"),
  `test/announcement-bounds.test.ts`.
  _Enforced (main)_ for trends: trend rows, reviews and settings, imports included, meet the
  [stored bounds](dump-format.md#stored-bounds), enforced by migration `0057_trends`; the round filters names by the
  stored rule (`trendTagNameCheckSql`), admits only names that are well-formed UTF-8
  and their own normalized form (so a listed name is the one its review and history take), and drops a stored row of
  any other; `test/migrations.test.ts` ("0057_trends"), `test/trends-round.test.ts` ("imported rows"),
  `test/trend-dump.test.ts`.
  _Enforced (main)_ for account moves: `accounts.moved_to_account_id` holds NULL or the 18-digit id of another
  account, on a remote row only; the triggers `accounts_moved_to_insert` and `accounts_moved_to_update` of migration
  `0060_account_moves` refuse any other value, imports included, judged by storage class, bytes, NUL, digits, then the
  row (`movedToPastBoundSql` in `src/platform/stored-bounds.ts`). Both writers store an account's id or NULL; the
  nested account is read through `MOVED_ACCOUNT_COLUMNS` (RES-3), so no value past its caps leaves SQLite
  (`test/migrations.test.ts` ("0060_account_moves"), `test/dump-import.test.ts` ("round-trips moved_to_account_id")).
- **RES-3: lists are bounded.** Pageable lists return at most 80 items; relationships read at most 100 ids; any other
  collection names its count and byte bound. _Enforced (main):_ `src/mastodon/pagination.ts`, `MAX_RELATIONSHIP_IDS` in
  `src/domain/accounts.ts`. _Gap: neither cap is tested._ _Enforced (main)_ for search: at
  most 40 results per type (80 for the account search), and offsets past 10,000 answer an empty page;
  `test/search.test.ts` ("bounds the query, the limit and the offset"). _Enforced (main):_
  the domain block list (`GET /api/v1/domain_blocks`) returns at most 200 domains, as Mastodon's does
  (`src/mastodon/blocks.ts`). _Enforced (main):_ `GET /api/v1/instance/peers` lists at most
  10,000 domains (`MAX_PEERS` in `src/domain/instance.ts`); `GET /api/v1/instance/domain_blocks` admits whole
  blocks in domain order within `ANSWER_BYTES`, with no continuation, each block at most 6,378 JSON bytes (a
  255-character domain, its digest and a public comment of `MAX_BLOCK_COMMENT` control characters;
  `publicDomainBlocks` in `src/domain/instance-domain-blocks.ts`); `familiar_followers` reads at most 20 ids and shows at
  most 80 accounts for each (`src/domain/accounts.ts`); `test/instance-reads.test.ts` ("bounds the peers", "admits
  whole blocks in domain order within ANSWER_BYTES"),
  `test/account-reads.test.ts` ("bounds the ids and the accounts shown"). _Enforced (main):_ follow suggestions answer
  at most 40 accounts (`SUGGESTIONS_KEPT`) within `ANSWER_BYTES` in both versions, v2's wrapper counted with each
  account (`src/domain/suggestions.ts`); `test/suggestions-bounds.test.ts` ("answers SUGGESTIONS_KEPT accounts at
  their bounds"). _Enforced (main)_ for the profile fields
  of each presented account: a remote account's row carries at most 16 fields, each name and value cut, 32 KiB of
  JSON in all, chosen in SQL from the stored actor document; the presenter then shows only the leading fields whose
  sanitized names and values fit 32 KiB once serialized as JSON, dropping the rest whole. So one account answers at
  most 32 KiB of fields whatever its document (`REMOTE_ATTACHMENT_SQL` and `remoteFields` in `src/domain/accounts.ts`;
  `test/remote-fields-bound.test.ts`). _Enforced (main)_ for each presented account: a remote bio is stored within
  `REMOTE_BIO_BYTES` (64 KiB) as a JSON string, cut by sanitizing a shorter raw prefix so it stays sanitized HTML
  (`sanitizeRemoteBio` in `src/security/html.ts`, which the cutover's converter and verification share); a remote
  profile URL (`url`, icon, image) over `PROFILE_URL_LIMIT` (2,048) is not stored; the display name is cut at 2,048 code
  points, and a username over 255 is refused. Converted rows hold the same bounds (RES-2, stored values), so
  `ACCOUNT_COLUMN_MAP` reads the bio, display name and URLs as stored and cuts the username at 255 code points; mentions
  read the username through the same projection (`src/domain/profile-bounds.ts`) and derive `acct` and a fallback url
  from the cut username; the admin account search reads candidates' ids and flags only and tests their text in SQL. The actor URI is
  bounded as stored (`ACTOR_URI_LIMIT`), read through `actorUriSql`, and refused at the cutover; the account's `uri`
  shows it only while its JSON is within `ACTOR_URI_LIMIT` bytes too (`withinIdentityBound`), and '' otherwise. An
  account that moved shows the account it moved to one level deep, read through `MOVED_ACCOUNT_COLUMNS`
  (`src/domain/accounts.ts`): every text cut in SQL by its raw bytes and in the presenter by its decoded limit (the
  display name at 100 code points), URLs and actor id within 512 bytes, no note or fields, and the emojis its display
  name references within 2,048 bytes of JSON; one such row reads at most 10,094 bytes from SQLite (20,764 of heap) and
  presents at most 11,021 bytes of JSON, a target past every profile bound included (`test/status-bounds.test.ts`
  ("the moved-to account"), `test/account-moved.test.ts`). The chunk's targets are read in one query, each account
  presented with its target only when admission reaches it. One account is then at most the account occurrence of
  "Maxima of presented units" below, so a page of 80 serializes to at most 11.46 MB; realistic bios (Mastodon's 500
  characters, Misskey's 1,500, Pleroma's and GoToSocial's 5,000 of
  Japanese with links) render to at most about 28 KB. Windowed account reads (followers, following, follow requests,
  `favourited_by`, `reblogged_by`) select ids for their window and read the profiles of the page only
  (`test/account-answer-bytes.test.ts`, `test/admin-accounts.test.ts`). _Enforced (main)_ for answers of many accounts
  (a list's members and endorsements with `limit=0`, familiar followers): the whole response body is at most
  `ANSWER_BYTES` (8 MiB, `src/domain/answer-budget.ts`), its own JSON reserved first, only an answer's first account
  standing alone past it; accounts are read in chunks of 50 that stop once it is reached, so at most one chunk (6.67 MB
  with the accounts they moved to) is read past it. A
  `limit=0` answer cut there links `next` to the rest with `max_id`, a deliberate deviation (Mastodon ignores `max_id`
  with `limit=0`). Familiar followers share the bytes among the requested accounts with followers to show, in rounds
  that pass what one leaves unused to the others, so the answer does not depend on their order (`presentAccountsWithin`
  and `familiarFollowers` in `src/domain/accounts.ts`, `unlimitedResponse` in `src/mastodon/pagination.ts`;
  `test/account-answer-bytes.test.ts`).
  _Enforced (main)_ for every answer that presents statuses, accounts or
  notifications: the Store operation that returns it owns one budget of `ANSWER_BYTES` (8 MiB of the answer's JSON,
  containers included) or a stated unit or count bound, and admits items whole in traversal order, the first whatever
  its size, so what is held past the admitted answer is one chunk of rows and one item at their maxima ("Heap at 8 MiB
  per answer"). _Gap:_ under that section's heap model, a page of grouped notifications or of admin reports passes half of
  the Store isolate's 128 MB, below 128 MB (the peaks table there): their single item dominates, so no chunk target or cap lowers it. A measured factor for presented objects and the strings they
  share with rows, or lower unit maxima, would close it. Each operation's mechanism, continuation and admission rules,
  and the ActivityPub collections, are in [response-inventory.md](response-inventory.md). One presentation per answer
  compiles the viewer's filters once and fixes the filter text level (`MAX_FILTER_REQUEST_TEXT`) over the answer's
  candidates in a preparation pass, so chunked presentation matches as one whole presentation does, and matches each status and quoted status once. When the viewer has keyword
  filters, that pass reads every candidate's searchable text (content, source, poll choices, media descriptions) in
  chunks of 4 statuses: its memory is one chunk, and its work is bounded by the candidate caps (a context's 8,192),
  not by the answer budget (`src/domain/answer-budget.ts`, `presentation` and `presentStatusesWithin` in
  `src/domain/status-presenter.ts`, `src/domain/status-rows.ts`; `test/answer-budgets.test.ts`, `test/status-rows.test.ts`, `test/notification-budgets.test.ts`,
  `test/notification-group-budgets.test.ts`, `test/conversation-budgets.test.ts`, `test/account-page-budgets.test.ts`,
  `test/activitypub-budgets.test.ts`, `test/admin-reports.test.ts`). Streaming events stay one unit each, and an event
  over 512 KiB is skipped whole. The raw presenters (`present` and `hydrate` in status-presenter.ts,
  `presentAccountsById` and `presentAccount` in accounts.ts) are not exported, so the compiler refuses direct use
  outside their module; the exported paths present one unit or admit within a budget.
  _Enforced (main)_ for each presented status: the status columns of `STORED_COLUMNS` hold their stored bounds (RES-2)
  and are read as stored: content and source text within 128 KiB as a JSON string, a content warning within 16 KiB, a
  status url within 4,096 bytes, attachment URLs within 2,048, descriptions within 10,000 code points and meta within
  1 KiB, and an edit's content, warning and choices the same. Columns that keep a read-time projection are read through
  their helper in `src/domain/status-bounds.ts` (accounts and actor ids through `src/domain/profile-bounds.ts`): a uri
  over 4,096 bytes reads as ''; at most 4 attachments per status; at most 200 mentions and 70 hashtags (of the 100
  stored) per status, the first by account id and by name; at most 100 poll choices of 1,000 code points; each
  edit-history snapshot's first 4 attachments rebuilt through the attachment bounds and '[]' over 288 KiB; a conversation presents its first 12 participants in stored
  order, cut in SQL. Every presented URL stays within its bound as serialized, derived or stored: a profile URL, avatar
  or header within 2,048 (a profile URL falls back from the stored one to the actor's origin and to this instance's
  `/@acct` page, and to '' when none fits), a media URL within 2,048. Each per-status cap reads at most its own number
  of rows, each status once, through an index that holds only the rows it shows: media_attachments_status (shown
  attachments), status_mentions_shown (mentions that are not silent, migration `0047_status_mentions_shown`) and
  status_tags. A hashtag name over 256 code units or 1 KiB among a status's first names read is left out rather than
  replaced by a later one, so such a status shows one fewer: a remote status stores none, and a local post records one
  as Mastodon does (Mastodon 4.5 sets no length), which costs it a presented hashtag only when it sorts before more than
  70 others, a corner case within 500 characters (`test/status-bounds.test.ts`). A remote username is Mastodon's remote
  format (ASCII), so its JSON is its length; a stored one holding any other character or a NUL (only a row converted
  before the cutover refused such usernames) is cut at 42 code points, which escape to at most 255 bytes. Identities are
  bounded by `src/platform/identity-bounds.ts`, which ingestion, the cutover's conversion and its verification share: an
  actor id whose serialized URL or stored spelling is over 2,048 bytes, or a status uri over 4,096, is refused, never
  cut, and reads as '' where a converted row holds one. `test-node/bounded-columns.test.ts` fails when a column that
  keeps a read-time projection (uris included) is read outside its helper in `src/domain` or a helper is given another
  column; its header states what it checks, where it fails closed, and its known gaps. It is an architectural aid; the aggregate response tests prove
  the budgets. Maxima of each presented shape: "Maxima of presented units" below (`test/status-bounds.test.ts`).
  _Enforced (main)_ for announcements: the list holds at most 16 (every published one), each within its derived
  conservative maximum of 248,997 JSON bytes ("Maxima of presented units"), admitted within `ARRAY_ANSWER_BYTES` as a
  backstop that never cuts; the Access admin's page holds at most 50; `test/announcement-bounds.test.ts`.
  _Enforced (main)_ for trends: `GET /api/v1/trends/tags` holds at most 20 hashtags (Count), `/statuses` at most 40
  statuses within the answer budget, continued at the statuses it consumed (Budget, Offset); the Access admin's pages
  hold at most 20 hashtags and 40 statuses, each field through its bounded projection; `test/trends-maxima.test.ts`,
  `test/trends.test.ts` ("reaches every status once").
- **RES-4: stored derived data is bounded.** Snapshots, the KV cache, the spool and deliveries each have a size cap, a
  count cap or an expiry with a sweeper. _Enforced (main)_ for remote statuses: one
  status stores at most 4 attachments (Mastodon's limit) with 10,000 code points of description each, 100 hashtags
  of at most 256 code units, 200 `status_mentions` rows (local accounts first; 100 `Mention` tags and 1,000 `to` and
  `cc` entries are read; a redelivery to a personal inbox keeps the bound, its owner taking a remote recipient's
  place, and so does an edit of a public or unlisted status that newly mentions and addresses a local account), 10,000 code units of content warning, and content cut at 50,000 code units before sanitizing; its history
  at most 100 versions (the newest edit replaces the last); an arriving parent links at most 100 replies that came
  before it; a boost at most 200 recipients; profiles show at most 16 fields. A deleted status is removed by a job
  (`inbound_jobs` kind `delete`) in batches of at most 500 rows, measured with `total_changes()`; the first batch hides
  it (its mentions, then its content and audience) within that budget. `src/domain/remote-statuses.ts`;
  `test/inbox-statuses.test.ts` ("caps the attachments, tags and content one status stores", "deletes a status with
  many children in bounded batches"), `test/inbox-statuses-edge.test.ts` ("RES-4: bounds at their limits", "writes at
  most … rows per batch, hiding included"). _Enforced (main)_ for snapshots: `test/snapshot.test.ts` ("snapshot caps"). KV
  cache: _Planned (KV sweep):_ its entries expire (NET-4), but expired rows are never deleted, so the table has no count
  or size cap. Spool: _Enforced (main):_ a request is spooled only within one Queue message (`SPOOL_MESSAGE_LIMIT`), and
  only while the Queue's backlog, as last read, is under `SPOOL_BACKLOG_MESSAGES` (10,000) and `SPOOL_BACKLOG_BYTES`
  (256 MiB); a backlog that cannot be read admits nothing (`createAdmission` in `src/federation/spool.ts`). Each isolate
  reads the backlog at most every 10 s and does not count what it sends in between, so the backlog is a budget, not a
  hard ceiling: it can overshoot by what all isolates spool within one interval. `test/gate.test.ts` ("answers 503 when
  the deflated request does not fit one message"), `test/maintenance-worker.test.ts` ("in Kopje's own maintenance gate:
  the same budget, failing closed"). Deliveries: _Enforced (main):_ delivered rows are deleted
  at once and given-up rows after 30 days by the 5-minute cron (`sweepDeliveries`), except a given-up row of a
  superseded follow answer, which nothing may send again: the next sweep deletes it, within the same 500 rows; receipts belong to their status
  (foreign key) and are dropped when its retraction is recorded; a lane holds at most 500 and the Store 10,000 active
  rows, and a row over either cap is written as `gave_up` with `backlog full`, visible in `kopje-admin deliveries`.
  Retractions (`Delete`, `Undo`, and a `Reject` ending a follow we had accepted) are exempt: they clean up what was
  already sent and are bounded by it, so they are never refused. A `Reject` of a Follow never accepted (a refused
  request, a blocked follower) is new work and passes admission; refused, it is given up, and the remote can ask again
  (`test/inbox-verify2.test.ts`). Operator retries pass the same admission, and a retry over a cap stays given up (`refused`);
  `test/deliveries.test.ts` ("lists given-up deliveries for the operator, retries them, and sweeps them after 30
  days"), `test/delivery-regressions.test.ts` ("gives up new work for a lane over its cap", "gives up new work once
  the whole backlog is at its cap").
  Retractions: _Enforced (main):_ they expire after 30 days, each
  inbound activity sweeps 100 expired rows, and an actor has at most 10,000 live rows. Finished inbound jobs (and
  with them deleted actors' tombstones) expire 30 days after they finish. `test/inbox.test.ts`,
  `test/inbox-regressions.test.ts`.
  _Enforced (main)_ for announcements: at most 1,000 kept and 16 published or scheduled (triggers and writers), 8
  reaction names per announcement, so reactions grow at most 8 rows and dismissals one per local account and
  announcement; `test/migrations.test.ts`,
  `test/admin-announcements.test.ts`.
  _Enforced (main)_ for trends: at most 250 rows in each trend table (200 allowed and 50 for review, so rows not allowed
  never push allowed ones out), 3 statuses per author and 10,000 decisions per review table, each cap refusing only a
  new key; the round orders its writes delete, update, insert; `test/migrations.test.ts` ("0057_trends"),
  `test/trends-round.test.ts` ("retention", "caps").
- **RES-5: retries are bounded, but maintenance is not a failure.** Waiting out maintenance consumes no processing
  retry; real processing errors count against `max_retries`. _Enforced (main):_ `src/jobs/queue.ts`; `test/gate.test.ts`
  ("spool consumer"). Deliveries give up after 15 attempts (`min(30s·2^n, 12h)`, n the attempts so far) or at once on a
  permanent answer (Mastodon's rule: 4xx except 401, 408 and 429, and 501), and are listed and retried through
  `/admin/deliveries` and `kopje-admin deliveries`; in maintenance nothing is claimed, so no attempt is counted. An
  activity a later one about the same object follows (an `Undo`, `Delete` or `Update`) is superseded and never sent
  again: naming it answers 409 `superseded`, and `--all` skips it, choosing eligible rows before its batch limit and
  continuing from the cursor it returns (`test/delivery-regressions.test.ts` ("refuses to retry a Like that its Undo
  has superseded"); `test/delivery-verify.test.ts` ("operator retries", "the `all` cursor")). So is a follow answer
  that a later `Follow` of its pair left exposed, and one it cancelled is gone (`test/follow-answers.test.ts`).
  _Enforced (main):_ `src/domain/deliveries.ts`, `src/jobs/deliver.ts`;
  `test/deliveries.test.ts` ("retries after min(30 s·2^n, 12 h)"), `test/delivery-post.test.ts` ("RES-5: claims
  nothing and counts no attempt in maintenance"), `test/cli.test.ts`. Spool messages: _Enforced (main):_ a message whose
  retries run out goes to the dead-letter queue (OPS-10), where it is kept for inspection, and a request refused for
  good (401, 404, 415) is dropped as the live inbox answers it (`handleQueue` in `src/jobs/queue.ts`, the consumer's
  `dead_letter_queue` in `wrangler.jsonc`); `test/gate.test.ts` ("retries, and so counts against max_retries, only on
  real processing errors"). Web Push: _Enforced (main):_ the deliveries' schedule and limit,
  a push older than 48 hours is dropped, a 4xx other than 408 and 429 (or an endpoint the sink refuses outright)
  deletes the subscription and its pending pushes, as Mastodon 4.5 does, and nothing is claimed in maintenance or
  without a `VAPID_JWK`; at most 1,000 pushes wait (`MAX_PUSH_BACKLOG`): a notification gets only the room left,
  counted in its transaction, however many subscriptions want it (RES-4). `src/domain/push.ts`, `src/jobs/push.ts`,
  `queuePushes` in `src/domain/notifications.ts`; `test/push-send.test.ts` ("retries a failure with the deliveries’
  backoff and gives up after their limit", "deletes the subscription and its pending pushes when the push service
  answers", "keeps the subscription and retries when the push service answers", "sends pushes from the delivery
  doorbell, and not without a VAPID_JWK or in maintenance", "RES-4: a notification fanned out to several
  subscriptions fills the backlog only up to its cap", "records no push beyond the backlog cap").
  _Enforced (main)_ for local emoji: `GET /api/v1/custom_emojis` holds at most 1,000 entries of at most 1,489 JSON
  bytes each with its separator, 1,489,001 bytes in all, admitted whole within `ARRAY_ANSWER_BYTES`
  (`test/local-emoji-api.test.ts` measures it); `GET /admin/emojis` pages hold at most 200.
- **RES-6: one request cannot trigger unbounded work.** An inbound activity has fixed limits on dereferences,
  recipients, collection expansion and notifications. Delivery backlog and concurrency are bounded. Anonymous app
  registration, inbox spooling and media transformations have rate or storage budgets with a visible refusal. Inbox
  spooling: _Enforced (main):_ the spool's budget (RES-4), refused with 503 (`createAdmission` in
  `src/federation/spool.ts`; `test/maintenance-worker.test.ts` ("in Kopje's own maintenance gate: the same budget,
  failing closed")). Domain blocks: _Enforced (main):_ a domain block's cleanup scans at most 500 follows
  per batch and does at most 4 batches a round, its first batch in the request, so blocking a domain stays bounded
  however many follows the user has, and always succeeds (VIS-15, `test/blocks.test.ts`). Local suspension:
  _Enforced (main):_ the suspension's transaction writes a fixed number of rows whatever the
  account's history; its work runs in durable `moderation_jobs` rounds with the inbound jobs, the jobs taking turns, at
  most 4 rounds a run. The tokens job deletes an earlier epoch's token's push deliveries, then its subscription, then the token
  (`TOKEN_CHILDREN`, which the cascade guard keeps complete), so no delete cascades, at most 200 rows a round
  (`total_changes()`, its own row included). The suspension job resolves at most 100 reports a round, then stages the
  `Update`'s audience (its followers, its reporters, the accounts it mentioned and followed) into `moderation_reach`
  from indexed ranges, 500 rows a round, each source capped as Mastodon's
  `AccountReachFinder` caps it, then writes the inboxes as the `Update`'s targets and deletes their staging rows, 500 a
  round; every round writes at most 600 rows, and each cursor is persisted, so every round makes progress
  (`src/domain/suspension.ts`; `test/admin-suspension.test.ts`: a history of 600 tokens, 250 subscriptions and 650
  pushes, and 10,000 followers, each round within its budget). App registration: _Enforced (main):_ `POST /api/v1/apps` is limited to 5 per minute per client IP by the Workers
  Rate Limiting binding before its body is read (429), and the Store keeps at most 500 never-authorized apps (no token or
  code of a user); when full it first removes unused apps (no token of any kind) older than a day, then the oldest
  never-authorized apps older than an hour (app tokens and all), and otherwise refuses with 429. Only a user's token or
  code protects an app: anyone can get an app token without a user, so app tokens cannot hold a slot for good. The cron removes unused apps after a day,
  as Mastodon's `ApplicationsVacuum` does, and expired codes and web sessions, 500 of each per run. `registerApp` and
  `sweepOAuth` in `src/domain/oauth.ts`, `src/mastodon/oauth.ts`; `test/apps-budget.test.ts`. Avatar and header
  uploads, from `update_credentials` and the settings page alike, go through the media budgets below, one reservation
  and two transformations each, at most 8 MB each. Unlocking an account: _Enforced (main):_ the update starts a cursor
  job (`local_accounts.accept_requests_after`) instead of accepting in the request; each job round authorizes at most
  20 requests, each in its own transaction through the single authorize path (its delivery admission and recount
  included), and every step advances or clears the cursor (`src/domain/unlock-accepts.ts`;
  `test/unlock-accepts.test.ts`: 250 requests in rounds of at most 20).
  Activity: _Enforced (main):_ after the response of an authenticated request (below 400) or of `GET /settings`, the
  Worker sends `noteActivity` unless its memo shows the token already sent one that UTC day. The memo is best-effort
  suppression only: it holds at most 1,024 tokens, is cleared at the day change and at that cap, forgets a failed call
  and is lost with the isolate, so a token may send again. The guarantee is the Store's: its conditional UPDATE writes
  an account's `active_on` at most once per UTC day and never backwards, by key only (the token, its client and the
  account, the join order pinned), and starts no stream turn (`src/domain/auth.ts`, `src/mastodon/activity.ts`;
  `test/activity.test.ts` ("sends no call until the next day", "writes one row per account and day whichever token
  asks", "seeks the token, its client and the account by key"), `test/streaming/activity.test.ts` ("asks for no turn")).
  _Enforced (main)_ for scheduled statuses: an account holds at most 300, at most 25 on one UTC day, each at least 5
  minutes ahead (Mastodon's limits, 422 with its messages); the cron publishes at most 25 a run, the earliest due first,
  each in its own transaction that deletes the row as it writes the status, so overlapping runs and retries publish it
  once. Never-attempted schedules come first; one whose publication fails with an error is rolled back, its attempt
  recorded in a transaction of its own and retried after 5, 15, 60 and 240 minutes, through a separate index, and
  dropped (its media detached) after 5 attempts, so failures back off and never hold back what is newly due. Nothing is published while
  the Store is in maintenance or readonly; what is due waits. `publishScheduled` in `src/store.ts`,
  `src/domain/scheduled-statuses.ts`, `src/jobs/scheduled.ts`; `test/scheduled-statuses.test.ts` ("publishes a due
  status once", "publishes at most … a run", "backs off what keeps failing", "waits while the Store is readonly").
  _Enforced (main)_ for media: before the body is read or Images is called, the Store
  counts upload attempts (deleted and failed ones included) to at most 30 per 30 minutes per account (Mastodon's
  limit) and checks the monthly budgets; right before Images is called it revalidates the reservation with fresh time
  and charges two transformations to the month they run in, against an instance budget per UTC month (`IMAGES_MONTHLY_TRANSFORMS`,
  default 4,000, under the 5,000 of the Images free plan) and against the account's monthly share of it
  (`IMAGES_ACCOUNT_MONTHLY_TRANSFORMS`, default a tenth), so one account (R4) cannot lock the others out; every refusal
  answers 429, and a used-up Images allowance answers 503. Unattached uploads are deleted after a day by a sweep of at most 100 per run. `reserveMedia` in
  `src/domain/media.ts`; `test/media.test.ts` ("counts upload attempts", "counts failed uploads too", "stops all
  uploads once the monthly Images budget is reserved", "stops one account at its monthly share", "answers 503 when the
  transformation allowance is used up"), `test/media-reconcile.test.ts` ("spends no transformation on a reservation
  that expired", "charges the budgets of the month the transformations run in").
  Delivery: _Enforced (main):_ an activity's targets are expanded 100 at a time, oldest
  activity first, in the recording transaction and then in each claim; a claim reads at most 16 lane heads (only heads
  are due); a Queue batch runs one round however many doorbells it holds; the consumer runs at most 4 batches at once
  (`max_concurrency`); the backlog has the RES-4 caps. `test/deliveries.test.ts` ("bounds a claim to its limit"),
  `test/delivery-post.test.ts` ("runs one round for a batch of doorbells"), `test/delivery-regressions.test.ts`
  ("expands a large audience in bounded steps"). An intent's targets are stored in chunks (`outbound_targets`) of at most
  100 targets (one expansion step) and 512 KiB, each read from its own cursor, so no row grows with the audience (a
  Durable Object row or string is limited to 2 MB, and an audience over it would fail to record on every retry). A
  target too large for a chunk on its own is left out, counted and logged without its value. By Kopje's own
  interoperability policy, not another server's behaviour, an actor id and an inbox or shared inbox URL from a remote
  actor document are at most 2,048 bytes (`ACTOR_URI_LIMIT` and `INBOX_URL_LIMIT` in
  `src/federation/remote-actor.ts`): an over-long id or inbox makes the actor unusable, and an over-long shared inbox
  is ignored. Mastodon sets no length limit; Misskey stores inbox URLs in 512-character columns.
  `test/inbox-verify4.test.ts` ("enqueues and fully expands an audience whose targets exceed what one row can hold",
  "refuses an actor whose inbox URL is over the cap", "refuses an actor whose id is over the cap"),
  `test/delivery-chunks.test.ts` (the chunk boundary, lane order across intents, an Update replacing a partly expanded
  intent, a claim failing at a chunk transition, a dump and import of a partly expanded intent, an oversized target). _Gap: computing an
  activity's targets reads all of the signer's remote followers in one transaction (a read, then one row per
  chunk)._
  _Enforced (main)_ for relationship activities: one request's fetches share a budget of 8 fetches
  (documents, JSON-LD contexts and each redirect hop), 2 MiB and 15 seconds (`requestBudget` in
  `src/federation/loader.ts`; cached contexts cost nothing; icons are taken only when embedded). Running out of the budget is retryable: the
  request answers 503, records nothing and its spooled copy is retried; a document refused for itself stays a permanent
  refusal. A key an actor lists by reference is taken from the verification that just resolved it, not fetched again.
  A `Follow` reads at most 33 unsettled answers of its pair, of them at most 65 delivery rows, including exposed rows,
  and 33 unexpanded chunks, and cancels at most those (NET-2); over any bound it answers 503 and writes nothing
  (`followAnswersOf` in `src/domain/deliveries.ts`). The bound clears as the answers deliver, or once given up
  and superseded, at the next sweep (RES-4); a server whose own retries of the `Follow` run out before then needs its
  user to follow again `test/follow-answers.test.ts` ("bounds and refusals"). A Move moves 100
  followers per batch and carries at most 100 blocks and mutes; a deleted actor's purge writes at most 500 rows per batch in all, every
  write counted (SQLite's `total_changes()`): deletions, counter recounts (`followers_count`, `following_count`,
  `statuses_count`, status counters) and the Undo intent of a withdrawn boost with its target chunks. The account is
  unavailable from the first batch's transaction on (VIS-1), so the order of the steps shows nothing of it, and no
  boost of its statuses is accepted and no status of it fetched while it lasts. Its follows, notifications, mentions
  and other relationships go first; then local boosts of its statuses, each withdrawn once: the Undo intent is recorded, then its targets
  (the boost's receipts among them) are staged a chunk per row over as many batches as they need, the receipts kept
  until all are written (`beginRetraction` and `stageRetraction` in `src/domain/deliveries.ts`); the delivery rounds
  expand them 100 at a time; then the purge deletes the receipts a batch at a time before the boost and its
  booster's recount; then its statuses, each
  deleted only after its children (edits, media, mentions, tags, favourites, bookmarks, notifications, receipts,
  boosts, reply links), so no delete cascades. A favourite's tracked `Like` ids go before it, read from a window of
  the account's or the status's first favourites, at most `MAX_TRACKED_LIKES` each; a local status's own delete
  cascades at most that many per favourite, a bound a trigger holds for imported rows too;
  `test/inbox-reactions.test.ts` ("RES-6: tracked Like ids in bounded deletions"). The child tables of a status and of
  a purged account are each one list in
  `src/domain/inbox.ts` (`STATUS_CHILDREN`, `PURGED_ACCOUNT_CHILDREN`; each foreign key naming the account has its own
  check); the references no foreign key holds (`PURGED_ACCOUNT_REFERENCES`: other accounts' moves to it) are cleared
  with its relationships, each row by its key through a partial index, and the completion check keeps the account row
  while any remains (`test/inbox.test.ts` ("clears the references to a purged account")); and the account's reports
  (of it and by it) and its other notifications go child-first: each from a window of
  their first rows, the pushes of a notification before it and a report's notifications before the report, so no delete
  cascades and the whole batch, the job's completion included, stays within `PURGE_BATCH` (`test/report-notifications.test.ts`
  ("a remote reporter's purge")). `test/cascade-guard.test.ts` checks the lists
  against the schema's cascading foreign keys; the same test requires every trigger that writes to be named with
  where a batch that fires it counts its writes. Blocks and mutes of the account go last, once nothing they filter is
  left (`test/inbox-regressions.test.ts` ("keeps filtering a post that mentions the actor")). A user's own unboost takes the ordinary delivery path. Local media is detached
  for the media sweep (MEDIA-1), never deleted from R2 here. Both are durable jobs in the Store (`inbound_jobs`), continued by the Queue and by cron, so neither a lost
  Queue message nor maintenance stops them, and waiting out maintenance spends no retry. `test/inbox.test.ts`,
  `test/inbox-regressions.test.ts`, `test/inbox-verify4.test.ts` ("writes the targets of a withdrawal that needs more
  than a batch of rows, every batch within the budget", "reaches every target when purge batches and delivery claims
  interleave", "when the purge completes before any expansion"). _Gap:_ the batch budget bounds the rows a withdrawal
  writes, not the work it does: each staging call reads every receipt of the boost and every follower of its booster
  and sorts all the targets left, so a boost's withdrawal (by a purge, or by a remote author's `Delete` of the boosted
  status) costs work proportional to its audience in every batch until it is staged. Receipt enumeration has this in
  common with follower enumeration.
  _Enforced (main)_ for received quotes: a quote's verification goes in stages of one
  document each (the quoted status, its author when Kopje lacks it, the status again, the stamp), each through loaders
  of its own, so no stage reads another's fetch; between stages only the author's address is kept, never a fetched
  document, so the status is stored only from a fresh fetch. Each stage's outcome applies only to the generation of
  the work it read (a number drawn anew whenever the quote's target, stamp, stage or outcome changes), so a late or
  concurrent outcome is discarded. Only job rounds verify quotes: an inbox request that makes work due only asks the
  Queue for a round, and a round leases what it claims, so nothing else touches the work meanwhile; a relayed `Delete`
  without the author's proof renews only idle work, leaves work that is due or backing off as it is, and only marks a
  leased one to be checked once more, so replays never keep a genuine 404 from applying. A job round (Queue or cron)
  verifies at most 10 quotes, each stage with a whole budget of its own (8 fetches, redirect hops and contexts included), so a heavy or
  failing quote starves no other, and charges every failure of a stage, a budget or deadline that ran out included, as
  it does a stage the Store cannot apply: a stage that never fits a budget is given up after the last attempt, and a
  round that only failed asks for no other (the backoff says when the work is due). A status stored for a
  verification gets one hop less of work, so one traversal stops two levels below the status that arrived, however
  long a chain of quotes; a failed verification is retried five times (1, 5, 30, 120 and 720 minutes later), then given
  up until its status arrives
  again. A stamp's `Delete` writes one `quote_revocations` row and changes the quotes naming it in batches of at most
  500 rows counted with `total_changes()` (a row and its count trigger), the first in the request and the rest in the
  inbound job rounds. A newly stored status links at most 100 unresolved quotes naming it. `src/domain/quotes.ts`,
  `src/federation/quotes.ts`; `test/quotes.test.ts` ("verifies a chain two levels below the status that arrived",
  "processes … quotes naming the stamp in bounded batches"), `test/cascade-guard.test.ts` (a purged status's
  accepted quote within the exact budget), `test/policy-bounds.test.ts` ("received quotes cost their work a bounded
  read").
  QuoteRequests: one fetch (the instrument, between Store rounds, which write nothing) and one answer per request id,
  kept 30 days in `quote_requests` and at most 100 live per actor (503 past the cap, nothing evicted); the sweep
  removes at most 100 expired rows a call. A revoke records one signed `Delete` and at most 100 `Reject`s (the quoting
  author's answered requests). A Delete of a quoting status retires its one authorization before its batches (three
  rows); a purge's batch deletes a quote holding one within a third of the rows left. `test/quote-requests.test.ts`,
  `test/cascade-guard.test.ts`.
  Streaming (VIS-26): _Enforced (main):_ at most 16 sockets per account (429) and 256 per
  instance (503); 16 subscriptions per socket, 16 stream keys per account and a socket's attachment at most 12 KiB
  (`Too many subscriptions`, 429); incoming messages text only (1003), at most 4 KiB and 120 a minute (1008). The
  fan-out runs in turns, one at a time, each an incoming request to the Store's own stub, which restores the CPU
  allowance: a turn spends at most 512 checks, 64 presentations, 4 MiB of presented payload and 4,096 sends, runs a
  unit only while what is left covers a unit's worst case (35 checks: 16 tokens, home, the mention, one for each of 16
  keys (lists and feeds) and the feeds' mention filter; one presentation, 256 sends) and leaves the
  rest to the next turn; a payload over 512 KiB is skipped and logged. The journal records nothing once it spans 4,096
  ids, and is pruned behind the position, at most 500 rows a call: the finished journal rows first, so the span shrinks
  at once, then a delete's capture rows, in further turns until none is left. A turn that read anything moves the
  position, also past what it read with nothing to send, before it stops for its budget. a delete's capture is one journal row and at most one row per account in the registry (256),
  each at most 16 KiB (40 boosts); a row over it drops boosts, then list ids, and is logged, and the delete goes on.
  A unit is one subject (the status, or one captured boost) for one viewer, so a delete with 40 boosts is 41 units for
  each viewer, each within a unit's worst case; the position names the viewer and the subject within the event. The status and edit
  triggers write one journal row per status write, under the same span, and no batched delete or purge fires them.
  a delete's capture also holds each viewer's lists (at most 16 for the
  status and each boost, within the same 16 KiB); a list's check is one narrowed read. A conversation's change moves its owner's mark,
  which journals one 'conversation' event for the owner unless one is still ahead of the position, so a burst is one
  row and a busy owner waits behind the others (FIFO); its units are the owner's newest 20 changes up to a
  ceiling fixed (with the position) when the fan-out enters the event, read through an index, each its own unit under
  the persisted position, older ones skipped; a change written after that goes to the owner's next row, so an event
  ends however fast its owner writes. A conversation's last status moved back by
  a status's removal writes the owner's mark and that journal row too, so the batched delete of a status's conversation
  links takes a fourth of the rows left (`LIMIT ?2 / 4`). `notifications_merged` is one journal
  row per transition, under the span. a public status's delete adds one
  tombstone row of at most 27 KiB (100 hashtags, each a subscribed key's of at most 256 bytes; over it, the last
  hashtags are dropped and logged, and the delete goes on), and a viewer row without boosts for each account listening
  on feeds alone; `streamPrune` deletes tombstones after the viewer rows, in the same 500-row calls. A hashtag `tag` is
  at most 256 bytes as sent and normalized (400 `Invalid parameter`). The status and edit triggers also fire for a
  public status that is not a boost while some account listens on a feed, on the same writes as before. Every public
  status can reach every socket (256 accounts on `public`): it is a unit per account, each within a unit's worst case,
  over as many turns as the budget needs, and a turn that resumes an event goes on from the persisted account
  (`test/streaming/public.test.ts`, 256 sockets on distinct tokens). Every stream event kind must pass
  `test/streaming/split.test.ts`, which splits one event of the kind (or, for a kind of one unit per event, a batch of
  them) across turns by the budget's own constants and checks that each listener gets it exactly once and the others
  nothing, that it finishes within a bounded number of turns while writes of its kind land between turns, that the
  cron's turn resumes it from the persisted position after a lost continuation, and that a drain after the barrier runs
  no turn; a new event kind joins its table (`KINDS`). `src/stream-hub.ts`, `src/domain/streaming.ts`;
  `test/streaming/streaming.test.ts`. _Gap:_ the budgets count work, not CPU time; a turn at the limits is to be
  measured on a deployed instance, as is how long a hibernated idle socket stays open.
  A custom emoji upload charges two transformations to the instance's monthly budget (429 past it). Disabled emoji
  versions are kept: their storage, a backup copy to every new destination and two rebuild transformations each after
  a restore are paid indefinitely ([backup.md](backup.md)).
  _Enforced (main)_ for announcements: the cron's round (`announcementRound`) publishes at most the 16 due and takes
  down at most the 16 ended, in one transaction, so one round does all that is due; `test/admin-announcements.test.ts`
  ("the cron’s round"). An announcement's delete removes its reactions and dismissals before the row and counts every
  row it writes with `total_changes()` within `ANNOUNCEMENT_DELETE_ROWS` (4,096), refused before it writes past it;
  `test/admin-announcements.test.ts` ("an announcement’s delete").
  _Enforced (main)_ for trends: the cron's round (`trendsRound`) deletes and writes at most 500 rows of each trend table
  in one transaction, and its reads are metered against `TREND_ROW_CAPS.round` (8,222,200 bytes of row heap, which the
  widest rows fill exactly: 1,600 hashtag groups of 1,024-byte names among them); a status's batched delete reserves its
  trend row and review (6 + after) and an account's final delete its review (3); `test/trends-bounds.test.ts` ("meters
  the round’s rows"), `test/cascade-guard.test.ts` ("trend rows within a batch").
- **RES-7: query work is bounded, not only the rows returned.** Feeds apply visibility and filters in the query before
  `LIMIT`. Context traversal visits a bounded number of statuses before sorting. A status keeps a bounded number and
  size of edits. _Enforced (main)_ for filtering before `LIMIT`: `src/domain/timelines.ts` (_Gap:
  untested_); the tag feed's candidates are the hashtags of public statuses (`status_tags.public`, through a partial
  index), so it never reads the tag's unlisted, private, direct or limited statuses, and it reads each requested tag
  (at most five) in id order from the cursor until it has a page, so a page reads the same rows however long the tag's
  history (`test/policy-bounds.test.ts`, `test/tag-timeline.test.ts`). _Enforced (main)_ for read bounds: every paged
  read whose rule hides rows reads an indexed candidate window from its cursor and applies the rule to it alone
  (`src/domain/windows.ts`), so a hidden range costs a window per request however long, and a page may be short or
  empty with its next link moving on by the window. A row hidden by its own visibility or audience is never a
  candidate (`audienceSql`), so it never supplies a cursor or any other id. The streams, the windows and what each
  may skip, and migration `0043_read_window_indexes`: docs/visibility.md "Read bounds"; `test/read-windows.test.ts`
  checks bounds, continuation and non-disclosure. _Gap:_ the number of streams is the viewer's follows (their own
  choice); rows hidden by visibility are walked past, not windowed (account statuses read by a non-follower of an
  account that posts mostly to followers: a remote account's private statuses are stored only while a local account
  follows it, so no outside party can grow it at will; accepted).
  _Enforced (main)_ for search: statuses pass `listableSql` before `LIMIT`, each library source reads at most 2,500 rows through an index ordered by the status id it returns (cursors applied
  inside it), hashtags come from at most 500 entries per library source plus the newest 2,000 public statuses, and an
  account search matches the exact address (always), at most 1,000 username-prefix candidates, the 5,000 newest
  accounts and the local ones, or with `following` the exact address and up to 5,000 accepted follows through a
  partial index (pending follows are never read)
  (`src/domain/search.ts`, `findAccounts` in `src/domain/accounts.ts`); `test/search.test.ts` ("filters before
  LIMIT"), `test/search-edge.test.ts` (rows read stay flat as favourites, bookmarks, accounts and tagged statuses grow
  fourfold, pending follows included; `max_id` reaches past each window; an exact address outside every window is
  found). _Enforced (main):_ the peers list seeks each next domain on the (domain,
  username) index, so it reads rows by domain returned, not by account known; the public block list reads the suspend
  blocks in chunks of 500 from the partial index `instance_domain_blocks_public` (migration `0049_instance_bounds`),
  so its rows read are the admitted blocks and at most one chunk more, whatever the noop blocks
  (`test/instance-reads.test.ts` ("reads the same rows whatever the noop blocks")); a tag's history reads its public statuses
  received in the last seven days only, a range of the (name, status_id) index of public hashtags cut by status id, so
  the work follows the instance's own receive volume (ids carry publication time, or receipt time where a cutover kept them); the rules
  read only their setting; familiar followers reads at most 10,000 of the viewer's accepted follows (above
  Mastodon's default follow limit of 7,500) and checks each against the account through the pair index; suggestions
  read fixed windows of follow ids as index ranges and judge at most 10,000 distinct candidates (docs/visibility.md,
  "Suggestions" and "Read bounds"; `test/suggestions-bounds.test.ts`); `test/instance-reads.test.ts`, `test/tags.test.ts`,
  `test/account-reads.test.ts` (rows read stay flat as accounts per domain, accounts known, statuses outside the
  window, and the account's other followers grow). _Enforced (main)_ for scheduled statuses: a page reads the
  account's own index by id, and a publication round reads the due ones through the index by time, so neither grows
  with the accounts that schedule or their scheduled statuses (`test/policy-bounds.test.ts` ("however many accounts
  schedule")). _Enforced (main)_ for grouped notifications: a page of groups walks the viewer's notifications from the
  cursor, as the list does, and reads at most 2,000 of those the rule shows; each group's count, samples and ends are
  read through the `(account_id, group_key, id)` index, at most 400 notifications per group; a group's accounts are
  paged through the same index; so none grows with the notifications of one group (`test/policy-bounds.test.ts`
  ("however many notifications a group holds")). Accepted: a group of more than 400 counts 400, and a page whose walk
  meets more than 2,000 notifications of the groups it found (one group that large, in practice) ends with those groups,
  its Link going on from the last notification read. Clearing notifications and dismissing a group hide what they
  remove from every read at once and delete it in bounded batches: the request records the highest id removed
  (migration `0023_notification_clears`) and deletes at most 2,000 notifications, newest first, and each round of the
  inbound jobs up to 2,000 more; every read of an account's notifications starts above its clear, and every read of
  one group above its dismissal (`keptFloorSql` in `src/domain/audience.ts`), so neither the request, a round nor such
  a read grows with what is hidden (`test/policy-bounds.test.ts` ("touch a bounded batch");
  `test/notification-clears.test.ts`). _Gap:_ until the rounds have deleted a dismissed group larger than the request
  deletes, a walk of all the account's notifications (the lists, the grouped walk, the unread counts) that reaches what
  is left of it passes over each with a key lookup, as it passes over notifications R15 hides for other reasons (a
  muted sender's); a clear has no such gap. Context traversal and edit history: _Enforced (main):_ a context reads at most
  8,192 replies of the tree (240 for an anonymous viewer), breadth first, before the list rule and the order apply
  (`CONTEXT_LIMITS` in `src/domain/statuses.ts`), and a status keeps at most `MAX_STATUS_EDITS` (100) versions, each
  within the status text's bound (RES-1); `test/context-work.test.ts` ("a tree several times wider costs about the
  same", "a chain twice as deep costs about the same"), `test/statuses.test.ts` ("bounds the edit history at write
  time"), `test/inbox-statuses-edge.test.ts` ("versions of history: the 101st replaces the newest").
  The streaming fan-out reads a window of the journal from its position (64 events, each bound of the journal one
  seek) and each unit's notification by key, positioned at it, so neither grows with the journal, the recipient's
  notifications or anyone else's (`test/policy-bounds.test.ts` ("a streamed notification reads its item")).
  _Enforced (main):_ a streamed status's checks are narrowed to it: home positioned at it
  reads its author's window alone, the exclusive-list exclusion for that author from the viewer's lists (at most 50),
  and the viewer's followed hashtags among the status's own by key; the mention reference is one key lookup
  (`notifications_natural`). They read the same rows however many statuses an author has, however many accounts,
  exclusive-list members and hashtags the viewer follows, and however many notifications they have; a delete's
  capture reads, for each listening account, the smaller side: the status's boosts (read once, at most 2,000, each
  booster checked against the account's follows by key), or past that the account's follows, one key lookup each
  (`test/policy-bounds.test.ts` ("a streamed status reads its item" and "R32: a delete's capture")). A turn reads a
  delete's units eight viewers at a time from the position, each page charged to the turn, never the whole capture.
  _Gap:_ a status with more than 2,000 boosts costs each listening account its follows (at most 256 accounts, each
  within the follow limit). _Enforced (main):_ a feed's check is the public or the hashtag's
  timeline positioned at the status, read by the status's key (the hashtag's by the status's row of it); the mention
  filter reads the status's mentions by its key, each checked by key; an event's feed listeners are the `public*`
  keys' (one range of `stream_subscriptions_key` a scan) and one seek per hashtag of the status; a tombstone reads the
  status's hashtags by its key. They read the same rows however many statuses the author, others, the hashtag or the
  accounts the viewer filters have (`test/policy-bounds.test.ts` ("streamed public and hashtag statuses")).
  Quotes (R35, VIS-27): a response reads its statuses' quote rows by key in one query and the quoted statuses' in a
  second, each over the response's ids, and embeds one level only, so a page reads the same rows however many quotes
  its quoted statuses have and however long the chain they start (`test/policy-bounds.test.ts` ("statuses with quotes
  are presented from their quote rows")). The quotes list reads one window of the status's accepted quotes from its
  cursor through the partial index `quotes_accepted` (migration `0036_quotes_list`), at most `limit`, and applies the
  rule to that window alone, whatever the count of quotes in any state; when the rule hides the window, the page is
  empty and its next link moves on by the window, so hidden quotes cost a request one window
  (`test/policy-bounds.test.ts` ("the quotes list reads a window")). A client that stops at an empty page sees fewer
  quotes than exist, as on Mastodon (accepted). The stamp endpoint is one read by its id's unique index; a request's
  cap reads at most 100 rows of its actor; a revoke's `Reject`s read at most 100 rows of the quoting author by one
  seek of `quote_requests_instrument`, whatever other actors' requests name the same instrument; quoters' reach reads
  the accepted quotes of the status through `quotes_accepted`, as its boosts are read.
  _Enforced (main)_ for inbound `Flag`s (R34): at most `MAX_FLAG_OBJECTS` (101) object entries are read, each by key;
  one remote actor may have at most `MAX_UNRESOLVED_REMOTE_REPORTS` (100) unresolved reports, counted by one bounded
  range of `reports_account_state` and checked against the Flag's new reports before any is written (per actor, not per
  server: a server's several actors each have theirs; a server-wide quota is not kept); whether the reported account
  has a follower on the reporter's server is two probes of at most `FOLLOWER_PROBE` (1,000) rows each (its followers,
  the server's accounts), so a private status of an account with more followers, on a server with more stored
  accounts, none of them in either window, is not attached (accepted). The admin's list filtered by reporter and
  reported account reads `reports_pair_state` (no residual, however many others report the account), and a local
  suspension's reach reads the account's reporters a round of `REPORTER_ROUND` (250) at a time, a seek and an account
  read each, resumed by account id (`test/inbox-flag.test.ts`, `test/policy-bounds.test.ts`,
  `test/admin-suspension.test.ts` ("the account's reporters")).
  _Enforced (main)_ for trends (MD-5): the round reads the newest 4,000 public originals from yesterday 00:00 UTC, at
  most 100 hashtag rows of each and 8,000 in all, cut raw before any rule (materialized), returns at most 1,600 hashtag
  groups (each takes 5 of the 8,000 rows), keeps the first 400 whose names are well-formed and in their own normalized
  form, and scores at most 400 + 250 statuses; measured at saturation (100 active suspend blocks, every author on its
  own eight-label domain with its actor id on another eight-label host, 4,000 distinct authors or 40 authors of 100
  statuses, every candidate quoting another, each review table at 10,000, and a status of 10,000 rejected hashtag rows)
  it reads 272,587 rows with distinct authors and 100,435 with repeated ones (its writes' reads included), the same with
  10,000 or 1,000,000 older statuses and 0 or 100,000 hidden ones in the window (`test/trends-cost.test.ts`, ceiling
  275,000). `GET /api/v1/trends/tags` reads 68,062 rows for 20 hashtags with 201 or 10,000 public statuses each, half of
  them by unavailable authors, on the same kind of accounts and full review tables (`test/trends-maxima.test.ts`). Each
  plan is of the production statement as it runs, with statistics taken before the data grew. Review lookups are key
  seeks; `coveredSql` uses `CROSS JOIN` to keep instance-block matches as domain seeks even with stale statistics.
  _Enforced (main)_ for reads from bounded inputs: the presenter's status graph, R, its authors, polls, votes, media
  and filter rules, the visibility rule's account lookups, status and account search candidates, relationship and
  account batches, mention resolution, media attachment, inbound addressing and lane promotion drive key seeks from
  their inputs (`CROSS JOIN`, `INDEXED BY` on the inner side), so statistics older than the Store's growth, even taken
  with one account and one poll, cannot turn them into scans. Each witness plans the production statement on a Store
  grown after `ANALYZE` and checks the seek and flat rows read (`test/status-rows.test.ts`,
  `test/filters.test.ts`, `test/search-edge.test.ts`, `test/account-relations.test.ts`, `test/statuses.test.ts`,
  `test/inbox-statuses.test.ts`, `test/deliveries.test.ts`). So do context and conversation reads, remote featured-tag
  counts, tag history, login, outbound reach (the status, its parent, quoters and followers), the send-time check, the
  personal-inbox fallback, receipts, inbound Flag objects and follow-answer discovery (`test/context-work.test.ts`,
  `test/conversations.test.ts`, `test/featured-tags.test.ts`, `test/tags.test.ts`, `test/oauth.test.ts`,
  `test/delivery-send-check.test.ts`, `test/inbox-flag.test.ts`, `test/follow-answers.test.ts`). Bounded writes seek
  their targets too: a write of an INTEGER PRIMARY KEY table runs one statement per row its bounded selection returns
  (`src/db/by-ids.ts`), a text-keyed target names its key index, and an OR of two columns is two probes, each through
  its own index. An account's moved-to accounts are read by key from the chunk's ids, a document's `movedTo` is
  resolved through the actor id's index and the move written by the source's key, and a purge clears and checks the
  moves to its account through `accounts_moved_to` (`test/account-moved.test.ts` ("query plans of moves"),
  `test/status-rows.test.ts` ("reads statuses, media, votes and filters by key")). A purge, the stale-vote sweep, the
  domain job's clearing walk and a suspension's report resolution are planned this way (`test/purge-plans.test.ts`,
  `test/moderation-plans.test.ts`, `test/domain-job.test.ts`); the
  purge writes the same rows per batch as before, within PURGE_BATCH (RES-6).

#### Maxima of presented units (RES-3)

The maxima are per column: each column a shape reads at the largest value its stored bound (RES-2: the stored-bound
triggers and the schema's CHECKs) allows, and each column that no CHECK bounds at the largest its writers produce
(writers' invariants: `polls.tallies` holds one integer count per choice, which the poll writers in
`src/domain/polls.ts` keep; no CHECK bounds its elements' type or size).
`test/status-bounds.test.ts` ("the table of maxima") builds every part at its bound and measures what one read takes
out of SQLite and what it presents, four ways: the escaped-text fill, using characters JSON escapes to six bytes; the
same with mentioned accounts that have no stored url, so their url is derived; filled with what reads the most
bytes for each bound (ASCII where the bound is in bytes, four-byte characters where it is in characters: a 10,000
character description reads 40,000 bytes); and the escaped fill with each poll's choices referencing the status's
emoji in the fewest characters (37), so each poll shows all of them. Emoji arrays are at their presented bounds
(12,288 and 6,144 JSON bytes) in the escaped and derived fills, and their stored values padded to the same bounds in
the raw fill; the boost's own row holds one too, which is not read.
The parts include the source text of each status row, the boost's own
row (all but its content, which the CHECK keeps empty, with its own attachments, mentions, hashtags and poll, which
are not read), the viewer's profile, her votes in every choice of both polls shown and every flag of hers included, each remote profile's fields at the largest list a read takes (32 KiB
of JSON), with accounts on
2,000-character domains (the longest an actor id of 2,048 holds), hashtag names of four-byte characters, and the
viewer's filters at theirs: 50 filters in every context, each with a 256-character title and 20 keywords of 512
characters, the first held by the status, and naming the statuses read, so every status carries 50 filter results
(about 0.24 MB each set) and every read takes the 1,000 keywords. SQLite bytes are the UTF-8 bytes of every value read
(8 per number); nodes are the objects, arrays and strings presented. Measured shapes are read through the Store operation. No
one fill holds a status's emoji arrays and its polls' at their bounds at once (the references a poll's choices need
displace escaped characters), so the conservative JSON of a shape is the escaped fill's plus 12,286 bytes for each
poll it shows, at least every fill's (`test/status-bounds.test.ts` ("keeps the conservative JSON of every shape within
85%, above every fill")); shares are of it. Each remote account of the fills carries its actor id (`uri`) at its bound,
2,048 bytes as JSON, the most it presents. A local account also shows `noindex` and `roles`, at most the Owner's badge: the
account occurrence's conservative JSON adds those keys (63 bytes) to the remote one measured, whose 32 KiB of fields
alone pass a local account's four. Every presented account but the viewer's moved to an account of its own at the
nested caps (a display name referencing emojis that fill 2,048 bytes, URLs at 512 bytes, a 253-byte domain), and each
nested account counts at its derived 11,021 bytes in the conservative JSON (14 in the conversation, 10 in the group).
Through the real Store
RPC, a public timeline page, a context and a search answer of statuses of about 0.98 MB each, each cut at the budget,
return 7.82 MB of JSON each (`test/answer-budgets.test.ts` ("the Store RPC returns a maximal answer")), and the boost
of a quote above, alone or as the one status a lookup of it, the quote and the quoted status admits, returns 5.66 MB
(escaped fill) and 4.62 MB (raw fill, the largest SQLite read) (`test/status-bounds.test.ts`), well under the 32 MiB
RPC limit.

| Shape                                                            | Most SQLite bytes | Most JSON bytes | Conservative JSON | Rows read | Nodes | Share of 8 MiB |
| ---------------------------------------------------------------- | ----------------- | --------------- | ----------------- | --------- | ----- | -------------- |
| Account occurrence, with the account it moved to                 | 123,233           | 140,447         | 143,188           | 1         | 92    | 1.7%           |
| Moved-to account (nested), derived from its caps                 | 10,094            | 8,343           | 11,021            | 1         |       | 0.1%           |
| Status                                                           | 4,444,672         | 2,638,854       | 2,641,717         | 1,485     | 2,419 | 31.5%          |
| Quote (the status and its quoted status)                         | 6,818,387         | 5,277,741       | 5,283,467         | 1,918     | 4,840 | 63.0%          |
| Boost of a quote                                                 | 7,112,944         | 5,686,692       | 5,695,096         | 1,975     | 5,799 | 67.9%          |
| Conversation: 12 participants presented, its last status a quote | 8,495,535         | 6,963,074       | 7,000,936         | 1,944     | 5,935 | 83.5%          |
| Notification group: 8 sample accounts, its status a quote        | 7,879,797         | 6,401,741       | 6,428,891         | 1,953     | 5,588 | 76.6%          |
| Report: its first status a quote past the 2 MiB allowance        | 7,198,257         | 5,874,208       | 5,885,290         | 1,933     | 5,155 | 70.2%          |
| An admin.report notification of that report                      | 2,360,505         | 403,298         | 408,654           | 1,061     | 294   | 4.9%           |
| ActivityPub Note: a local status at its bounds, 1,000 addressed  | 3,697,315         | 4,235,143       |                   | 1,337     | 3,165 | 50.5%          |
| Its Create (the Note and its addressing again)                   |                   | 6,291,204       |                   |           |       | 75.0%          |
| Announcement: each part derived from its caps                    |                   | 121,774         | 248,997           |           |       | 3.0%           |
| Trending hashtag (Tag with history), derived from its caps       |                   | 4,508           | 4,572             |           |       | 0.1%           |
| Access admin's trending hashtag, derived from its caps           |                   | 4,551           | 4,625             |           |       | 0.1%           |
| Access admin's trending status, derived from its caps            |                   | 27,748          | 29,060            |           |       | 0.3%           |

The most JSON is the emoji-poll fill's, the most SQLite bytes the raw fill's; the escaped fill presents the
conversation in 6,938,872 bytes. The Note's local emoji snapshot is at its 12,288-byte bound with as many entries as
fit (61, every url at its shortest), resolved to 14,850 bytes of `Emoji` tags (at most 64 × 44 bytes past the
snapshot); an actor's at 6,144 bytes resolves to 30 tags of 7,404 bytes (`test/local-emoji-api.test.ts`).

The trends shapes are derived the same way (`test/trends-maxima.test.ts`): a hashtag of a 1,024-byte name with its
URL percent-encoded (three bytes a byte) and seven history days at 200 uses; an admin status of a 4,096-byte URL, a
username and a domain cut on bytes at 255 and 253 (SQLite's character cuts pass malformed bytes whole), each byte
escaped to six bytes (a malformed one decodes to a three-byte U+FFFD), a 200-unit excerpt escaped the same, a
supported language and a 24-byte time. Pages: 20 hashtags (91,461 bytes at most; 90,180 filled through the Store
RPC), 20 admin hashtags, 40 admin statuses (1,162,440 at most; 1,093,041 filled through the Store RPC by imported
rows whose parents pass every bound, half of them with malformed bytes in the username, domain and content).

An announcement's maxima are derived from caps, not from fills: each part's conservative JSON is computed by
`test/announcement-bounds.test.ts` (`derivedAnnouncementMaxima` in `test/announcement-helpers.ts`) from the stored and
presented caps of its columns, each at its worst JSON escaping. Mentions: 16 entries of an 18-digit id, a 255-byte
username (twice, also in `acct`), a 2,048-byte profile URL escaped to two bytes a byte, and a looked-up domain of
2,040 bytes (107,329). Hashtags: 16 names of 256 three-byte code units with their percent-encoded URLs on a 253-byte
host (53,761). Emoji: the 12,288-byte presented bound. Reactions: 8 custom emoji of 128-byte shortcodes with two
512-byte images and a count of `Number.MAX_SAFE_INTEGER` (9,801). Content: the 65,536-byte budget. Keys, id, times and
flags: 282. One announcement is at most 248,997 bytes (3.0% of 8 MiB), the list at most 3,983,969, a stream payload
double-encoded at most 497,996, under 512 KiB. The fills in `test/announcement-bounds.test.ts` and
`test/streaming/announcements.test.ts` exercise escaping, IDNA, NFKC expansion and Store RPC/stream delivery within
these bounds. The rows the list reads are bounded from per-column maxima (`ANNOUNCEMENT_ROW_CAPS` in
`src/domain/announcements.ts`, which a RowMeter enforces as they are read): 333,440 bytes for the list and its
dismissals, held throughout, and 5,493,376 for one presentation's mention, emoji and reaction rows (64, 1,024 and 8
rows at their widest columns); past the cap an announcement is shown escaped with nothing read for it. With the
derived answer at three times its JSON and one rendering at a time (the budget, the one segment built past it, at
most 310,064 bytes, and the fallback), the list's heap is at most about 20.1 MB.

Mentions whose url is derived read and present less (the conversation: 5,492,118 and 6,119,672 bytes): a derived url
within the bound is at most the stored bound, and a longer one presents as ''.

A Note shows what the Status entity shows: its hashtags and mentions are read through the same projections and
its text and attachments as stored (`statusFacts` in `src/domain/activities.ts`), so a converted row's hashtag past its bound is left out of
both. A Note's addressing (to, cc) keeps every recipient, and the Create repeats it: a local status addresses at most
`MAX_LOCAL_ADDRESSED` (1,000) accounts, which a post's 500 characters (about 170 mentions) never reach and the
cutover's conversion refuses past, naming the status (`src/platform/identity-bounds.ts`). With every part at its bound
and 1,000 actor ids of 2,048 bytes, the Create is 75% of `OUTBOX_BYTES`; five such Notes are not within 8 MiB, so the
featured collection shows its Notes within `OUTBOX_BYTES` and the pins past them by uri (4.41 MB with one Note whole,
`test/status-bounds.test.ts`). A group's status is the owner's own (favourites and boosts group), so it is at most a quote. A report's statuses after
the first stop at 2 MiB, so a report is at most its accounts, its first status (a quote) and nothing more, or a small
first status and 2 MiB; its staff accounts are local, and its reporter (a remote one, from a `Flag`) and its comment
are at their bounds: the comment's CHECK (migration `0054_remote_reports`) holds 20,000 bytes, which a stored NUL
followed by U+0001 makes about 120 KB of JSON (Kopje's writers make about 30 KB: 5,000 code points). Every shape
stays within 85% of an answer of 8 MiB with filter results included, measured and conservative alike, so an answer
that admits whole items always fits its first. The 85% ceiling accommodates the conversation's 14 account arrays and
four status/poll arrays, allowing 40 typical emoji per status and 20 per profile. Through the real Store RPC,
maximal answers of plain notifications, grouped notifications, conversations, admin reports and the directory return
7.83, 7.82, 7.83, 7.14 and 8.30 MB of JSON (`test/rpc-budgets.test.ts`).

Heap at 8 MiB per answer. Assumptions: one request at a time per isolate; the answer's JSON is at most 8 MiB, since
every item is below it. The model:

- Rows. SQLite bytes are UTF-8 bytes; a JavaScript string with any character above U+00FF stores two bytes per code
  unit, so text counts at twice its UTF-8 bytes (at least twice its UTF-16 code units), and each row adds 64 B for its
  object and 32 B per value. Peaks add 25% headroom to rows.
- Presented objects take at most three times their JSON bytes (a string takes no more than its JSON bytes, since JSON
  only adds escapes, and the rest is per-object overhead; an assumption, as workerd exposes no heap to measure): the
  admitted answer's 25.2 MB, the first rejected item's three times its JSON. Rows and presented objects often share
  the same string instances, which the model does not credit.
- An item is measured without building its JSON (`jsonBytes` in `src/domain/answer-budget.ts`): a string of several
  MB, which takes up to two bytes a character once one character is wider than Latin-1, is never made.

Chunks. `statusStream` (`src/domain/status-presenter.ts`) reads an answer's statuses in chunks of consecutive statuses,
each presented and measured only when admission reaches it, so while the first rejected status is measured the admitted
answer, one chunk's rows and the rejected status's objects coexist. A chunk is planned by R, an upper bound on the heap
that the rows of one status take as the meter below counts it (per row 64 B, and per value 32 B and twice its UTF-8
bytes, which are at least its UTF-16 code units): the status, its boosted original, and the quoted status of the status
or, for a boost, of its original (a boost has no quote of its own, R35, and its own attachments, mentions, hashtags
and poll are neither read nor shown, as on Mastodon). One query per window of 80 statuses computes it
(`statusRowBoundSql` in `src/domain/status-rows.ts`) from the same column maps that generate every hydrate query's
select list (`src/db/columns.ts`), so it cannot drift from what is read; it counts a row whether or not the viewer is
shown it. Each status row whose author has a stored move also counts the moved-to account's row at its caps
(`MOVED_ACCOUNT_COLUMNS`), whether or not the author is available. An item with a local author, or an author moved to
a local account, also counts the OAuth admin's lookup whole (the `admin_email` row and, while it is set, the scan of
the operator-sized `local_accounts`, each account sought by key: `OAUTH_ADMIN_HEAP_SQL` in
`src/domain/admin-authority.ts`), which a local account's Owner role reads at most once per operation, in whichever
chunk first shows one; R reads neither for an answer without one. A chunk holds
statuses while their R sums to at most its target, at most 80 and at least one: 768 KiB of heap for pages, contexts,
search, histories and lookups (`PAGE_CHUNKS`), and 1 MiB for grouped notifications and admin reports
(`LARGE_ITEM_CHUNKS`). A chunk of several is read through a `RowMeter` (`src/db/sql.ts`), which adds each
row's heap under the model as the cursor returns it (workerd's cursor runs the statement lazily, one row ahead of the
one it returns) and throws past its cap, which equals the target, so only a term R misses passes it. The chunk is then
dropped, `kopje.presenter.row-cap-exceeded` is logged with its ids, and its statuses are read one at a time. A status
alone is not capped: its rows are bounded as a unit (the maxima above). The meter bounds the row objects and strings a
chunk's queries return, past the cap by at most the row that passed it (at most 1.20 MB, measured: a poll of 100 choices of 1,000
characters JSON escapes to six bytes, read as ASCII); it does not bound SQLite's page cache, statement and
sorter scratch, the parsing buffers of `json_each` and the `json_*` functions, the conversion of the current row, or
garbage awaiting collection. No hydrate query sorts a chunk's payload: media, mentions and hashtags are put in order in
JavaScript, and a temporary B-tree holds only ids (own votes, sorted by id, carry ids and choices only), the two host
names of one account in the visibility rule, or one row's value (an actor document's attachment entries, at most 2 MiB
fetched and 16 kept; a poll's at most 100 choices). `test/status-rows.test.ts` ("steps lazily, one row ahead", "is at
least the meter's count of each status alone and of each chunk, for mixed sizes", "plans 40 boosts of statuses with 200
mentions and 70 hashtags without the backstop", "take their columns from the registered maps", "sort no chunk-wide
payload", "reads a chunk past its cap again one status at a time, with the same answer") and
`test/status-bounds.test.ts` ("bounds the rows each shape reads by R") pin these. R counts a value's UTF-8 bytes twice
where the meter counts its UTF-16 code units twice, so it overstates text that is not ASCII (up to three times for CJK)
and plans such chunks smaller than the cap; it never understates.

A page of 40 statuses, each with 3 Misskey-shaped emoji and its author with 2, presented through `presentation` and
`presentStatusesWithin`, mean of two sets of 20 runs at a load average of 6 (planned at 768 KiB);
`test/status-rows.test.ts`
("read an ordinary page of 40 statuses in one chunk of at most 13 queries", "a context of 200 statuses reads its
statuses in planned chunks", "a page of 80 groups reads its statuses in planned chunks") holds the planned queries to
their ceilings:

| Page                                                                    | Chunks of 2          | Planned             | One chunk          |
| ----------------------------------------------------------------------- | -------------------- | ------------------- | ------------------ |
| Ordinary: short posts with a hashtag and a mention, every other a quote | 220 queries, 9.1 ms  | 12 queries, 6.8 ms  | 11 queries, 5.6 ms |
| Realistic: 5,000 Japanese characters, a poll of 4, 4 described media    | 200 queries, 11.3 ms | 41 queries, 10.1 ms | 10 queries, 8.6 ms |

The ordinary page's R is 410,480 bytes (349,640 without emoji), one chunk. With every status and author at the
stored emoji caps it is 2,561,480 (at most 85,316 a status, far below the target), planned in 4 chunks of at most
768,444 bytes, as few as the target allows, with the backstop never fired ("read a saturated page of 40 statuses in
planned chunks").

R takes about 0.7 ms a window of 40 statuses. It is 1.2 to 1.5 times the meter's count for an ordinary status (its
constant terms count rows that may not exist), 2.4 for the realistic one (Japanese text), 1.02 for a status with 200
short mentions and 70 hashtags, and 1.15 at the maxima.

Peaks, as `test/status-bounds.test.ts` ("keeps the peaks of the heap model within their bounds, from the maxima per
column") computes them, per column: an item's rows are, for each query and column its read returns, the most heap
any fill gives that column under the model, summed (so poll choices count as escaped and the other text as raw), with
25% headroom; the largest single row sums each column's largest value the same way (1.20 MB, the escaped poll row,
which is at least RowMeter's count); the rejected item is three times the item's conservative JSON (above); the
admitted answer three times 8 MiB (25.17 MB). The test measures its own maxima,
whatever runs before it, and asserts the timelines' peaks within half of the Store isolate's 128 MB, and the groups'
and reports' within the whole.

| Item                                           | Rows, with 25% headroom | Rejected-item objects |
| ---------------------------------------------- | ----------------------- | --------------------- |
| Boost of a quote (the largest timeline item)   | 19.24 MB                | 17.09 MB              |
| Group: its status (a quote), 8 sample accounts | 21.18 MB                | 19.29 MB              |
| Report: its status and 4 accounts              | 19.45 MB                | 17.66 MB              |

Groups and reports also keep the presentation's state: the compiled filters (50 filters of 20 keywords, about
0.5 MB) and the filter results cached by status (at most 50 results of about 1.2 KB each, 60 KB a status) for the
statuses and quoted statuses a page presents: 160 for a page of groups (80 groups, each with its status and a quoted
one; a re-admission pass presents its own groups' statuses again, matched once, and holds nothing else of an earlier
pass, and the passes are at most four), 200 for a page of reports (its at most 100 statuses and their quoted ones):
10.1 and 12.5 MB.

| Answer (Store isolate)                      | Normal   | Backstop fired, the dropped chunk still live | A single item |
| ------------------------------------------- | -------- | -------------------------------------------- | ------------- |
| Timelines (largest item a boost of a quote) | 61.51 MB | 64.00 MB (63,996,282 bytes)                  | 61.51 MB      |
| Groups                                      | 75.75 MB | 78.56 MB                                     | 75.75 MB      |
| Reports                                     | 74.79 MB | 77.60 MB                                     | 74.79 MB      |

A chunk of several takes at most its target of heap: 768 KiB (0.79 MB) for timelines, 1 MiB (1.05 MB) for groups and
reports. Normal: the rows are the larger of 1.25 × the target and the item's rows, plus the admitted answer, the
rejected item and, for groups and reports, their state. With the backstop fired, 1.25 × (the target + 1.20 MB) of
dropped rows more. The 768 KiB timeline cap keeps the fallback below half the isolate's memory even while the dropped
chunk remains live, with 3,718 bytes to spare: each moved-to account's row counts at its 20,764-byte heap cap and its
JSON at 11,021 bytes, and its emojis' presentation holds one entry past those it admits at a time (18,060 bytes at
three times its literals, decoded strings and the larger of its entity and an href normalization makes before
rejecting it: `referencedEmojis` in `src/domain/custom-emojis.ts`), counted once per answer. Every row term carries
25% headroom; the peak test rejects growth past that boundary. The backstop-fired figures bound the fallback whenever
the dropped rows are collected. A boost that showed a quote, attachments, mentions, hashtags or a
poll of its own (a legacy row may hold them) would make a timeline's largest item pass half at a chunk of one; it shows
none.

| Phase                                             | Store isolate | Worker isolate |
| ------------------------------------------------- | ------------- | -------------- |
| RPC copy (serialized; deserialized in the Worker) | 8.4 MB        | 25.2 MB        |
| The Worker's JSON string and the body             |               | 25.2 MB        |
| Peak                                              | 61.3 MB       | 50 MB          |

The Store's peak is the timelines' (above), while an item is admitted; the RPC copy comes after it. The Worker's JSON
string is counted at two bytes a character (16.8 MB) and the body at its UTF-8 bytes. Timelines stay within half of
the Store isolate's 128 MB, and the Worker within half of its own. One isolate holding both sides at
once, the Store's objects alive while the Worker's are built, would reach about 107 MB; it stays within half (61.3 MB)
when the Store drops its objects once they are serialized. Groups and reports pass half of the Store isolate (RES-3,
the Gap note on their heap).

### Data and keys (DATA)

- **DATA-1: private keys stay wrapped outside cryptographic use.** Actor and instance keys are stored wrapped with
  `USER_KEK` in the legacy format. They are unwrapped per call in the Worker, only to sign and for the health key check,
  are never cached, and never appear in responses or logs. _Enforced (main):_ `src/security/key-wrap.ts`,
  `src/security/keyring.ts`; `test/keyring.test.ts`, `test/health-keys.test.ts`.
- **DATA-2: VAPID keys are never regenerated implicitly.** `VAPID_JWK` is a secret that Kopje only reads; an invalid
  value, one without its private scalar included, is a misconfiguration, and without one Web Push is unavailable
  rather than keyed anew. _Enforced (main):_ `src/platform/vapid.ts`, `src/platform/config.ts`, `src/mastodon/push.ts`;
  `test/instance.test.ts` ("refuses an invalid VAPID_JWK as misconfiguration"), `test/push.test.ts` ("DATA-2: without a
  VAPID_JWK, push is unavailable and no key is made", "refuses a VAPID_JWK without its private key as
  misconfiguration (DATA-2)").
- **DATA-3: dumps are exact and verified.** A dump keeps exact bytes and storage classes. Import accepts only exact
  template statements with bound literals, into an empty Store with the same schema, and verification recomputes the
  digests from the imported rows. Of `kopje_state` it restores only the names the dump declares, which must be among
  the Store's (`last_local_id`, `profile_updates`). _Enforced (main):_ `src/platform/store-dump.ts`,
  `src/platform/store-import.ts`, `docs/dump-format.md`; `test/dump-import.test.ts`, `test/ops-regressions.test.ts`,
  `test/dump-format.test.ts`. Media tombstones (`media_orphans`) are left out of dumps (`src/platform/dump-catalog.ts`):
  they name R2 objects to delete, which a restored Store must not act on. Each import call's work is bounded by what it
  writes, not by the bytes it receives, so a large instance imports within the Durable Object's CPU limit: a chunk by
  statements and bytes, and links, which rewrite whole rows, are staged and applied in verify steps bounded by the
  bytes they rewrite, as is a reset's unlinking (`docs/dump-format.md`, "Bounded work"); `test/dump-import.test.ts`
  ("import work per call"), `test/ops-reset-bound.test.ts`, `test/dump-format.test.ts`.
- **DATA-4: backups leave Cloudflare only encrypted.** Dump chunks, R2 originals, media indexes and manifests are
  age-encrypted (typage, `age-encryption`) to the run's pinned recipients before upload; the identity never reaches
  Cloudflare. A media copy counts only for the bucket and recipients it was made under, so a key change re-encrypts
  everything. _Enforced (main):_ `src/jobs/backup.ts`, `src/platform/backup-crypto.ts`;
  `test/backup.test.ts` ("writes the dump, the originals the dump references": every body the bucket receives is age
  ciphertext without plaintext markers; "abandons a run whose recipients changed").
- **DATA-5: logs carry no secrets or content.** Log entries are structured events. They never include request bodies,
  post content, tokens, keys, Access assertions or URLs with credentials. A log entry never includes text that a request
  supplied: errors are logged by class, standard error name and known Store reason, and requests by standard method (else
  `OTHER`), route template and status. Diagnostic
  detail produced inside the Store from no request input is allowed, such as the raw SQLite or migration error in
  `kopje.store.upgrade.failed`, which reaches only logs and the admin health report. Tests inject marker values into
  errors and assert they are absent. _Enforced (main):_ `errorFields` in
  `src/platform/error-message.ts`, used by `app.onError` (`src/app/app.ts`), the queue and spool handlers, the snapshot
  saver and the Store kernel; `test/log-redaction.test.ts`. Access failures log only jose's error code, and the
  CLI never prints secrets (`test/cli.test.ts`).
- **DATA-6: ids stay strings end to end.** Ids never pass through JS numbers. INTEGER edge and notification ids are read
  with `CAST(id AS TEXT)` and compared with `CAST(? AS INTEGER)`. 18-digit TEXT status ids compare as TEXT; a shorter
  client cursor is zero-padded first. _Enforced (main)_ for edges: `listFollows` in `src/domain/accounts.ts`;
  `test/accounts.test.ts` ("edge ids beyond 2^53", "keeps 18-digit ids exact"). _Enforced (main)_
  for status cursors: `statusCursor` in `src/domain/statuses.ts` (_Gap: untested_).
- **DATA-7: the instance key signs only recipient-neutral fetches and the instance actor's own activities.** Fetches
  without a specific recipient are signed by the instance actor; fetches for a personal inbox by the recipient's key;
  fetches on a remote account's behalf (a sync of its featured and featuredTags collections in the background job
  rounds, and the pinned status an `Add` names) by the key of a local account that follows it, as Mastodon signs them
  with `local_follower`, else by the instance actor, never by a personal inbox's recipient. The follower is named by
  its account id and the remote account's, and its key is loaded only while it is available and still follows the
  remote account, which is checked again then; otherwise the instance actor signs (`localFollower` in
  `src/domain/remote-collections.ts`, `getFollowerKey` in `src/domain/actors.ts`, `src/federation/collections.ts`,
  `receiveInbound` in `src/federation/inbound.ts`; `test/remote-collections.test.ts`);
  activities by their author's key. The instance key never signs an activity attributed to a user: the one activity it
  signs is a forwarded report's `Flag`, whose actor is the instance actor (Mastodon's `Account.representative`).
  _Enforced (main)_ for fetches: `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("signed fetches").
  Activities: _Enforced (main):_ a delivery is signed with the key of its lane's account, unwrapped once per round
  (`src/jobs/deliver.ts`); `test/delivery-post.test.ts` ("signs the activity with its author key"). _Enforced (main):_ an intent recorded with `signedBy: 'instance'` (only `flagActivity` in
  `src/domain/activities.ts` makes one, with the instance actor as its actor) is signed with the instance key, which the
  delivery round loads through `instanceActorKey` (`src/federation/federation.ts`, the race-safe initialization signed
  fetches and `/actor` use), creating it if nothing has yet (`deliveryRound` in `src/jobs/deliver.ts`);
  `test/reports.test.ts` ("posts the Flag signed with the instance actor’s key", "creates the instance actor’s key
  when no fetch has yet").
- **DATA-9: backup credentials stay out of the Store, logs and reports, and are scoped.** The S3 key is a Worker
  secret, read apart from the main config so a bad backup setting stops only the backup. Config issues name the
  variable, never its value. Failures are recorded and logged as fixed reason codes (`s3-<op>-<status|timeout>`,
  Store refusal codes), never an error message, a response body, a URL or a signature. The Store keeps only keys,
  upload ids, fingerprints, sizes and digests. The documented policy grants put under the prefix, delete and abort only
  under `backups/` (never `media/`), and prefix-conditioned listing; multipart listing, which cannot be
  prefix-conditioned, is optional (`docs/backup.md`). _Enforced (main):_
  `src/platform/backup-config.ts`, `src/platform/s3.ts`, `failureReason` in `src/jobs/backup.ts`;
  `test/backup.test.ts` ("never logs, saves or reports a secret", "refuses invalid settings without naming their
  values"). The S3 test double verifies every SigV4 signature with an independent implementation checked against AWS's
  published examples ("SigV4 (independent vectors)", "a wrong signing region is refused").
- **DATA-10: a backup is complete only with its manifest, and restore checks the whole restore set.** The manifest is
  written last. It carries the size and SHA-256 (before and after encryption) of the dump and of the run's media index,
  with the schema and Kopje versions. The index is complete, not incremental: it lists every original the dump
  references, with its object and digests, or why it is missing (`pending`, `absent`). The membership is replaced in
  the Store transaction that completes the dump, while its freeze still holds, so it is exactly the dump's, also after
  a restarted dump. Retention can therefore delete
  older backups without losing the integrity evidence for originals they copied. The Store keeps the cumulative index
  (`backup_media`, one row per original, pruned to what the last success needs), so the job never reads objects back.
  The SHA-256 of the encrypted manifest is recorded outside the bucket (Store state, health, Workers Logs), because
  age encryption to a public key gives no authenticity. Restore authenticates before it uses anything (`docs/backup.md`):
  the manifest against the recorded digest, then the dump and the index against the manifest with `kopje-admin
backup-verify` (index-only before any media is downloaded). `backup-verify` stops at the first mismatch and rejects
  any index entry whose source is not exactly `originals/<18-digit id>` or whose object is not under its run's
  `media/` prefix. The runbook builds local paths only from validated ids, in a new directory. It reports incomplete
  media coverage with exit code 3. The import re-checks the dump's own trailer. _Enforced (main):_ `src/jobs/backup.ts`,
  `src/platform/backup-state.ts`, `verifyBackup` in `cli/lib/commands.js`; `test/backup.test.ts` ("verifies the whole
  restore set after retention removed the backup that copied an original", "reports incomplete media coverage",
  "verifies the index alone before any media is downloaded", "rejects index entries that name anything but
  originals/<id>", "a restarted dump replaces the membership", "round-trips"). Gap: comparing `manifestSha256` is a manual step of the restore runbook (DATA-8).
- **DATA-8: a restore has selected authority.** Restore uses a manifest the operator selected by digest, checks schema
  version, domain and every referenced component before use, and before leaving maintenance invalidates OAuth grants
  restored from the checkpoint and reconciles suspension and admin state. _Planned (restore):_ a restore is the
  runbook in `docs/backup.md`: the operator compares the manifest's digest by hand (DATA-10), and the import requires an
  empty Store of the same schema (DATA-3). Nothing yet invalidates the OAuth grants a restored dump brings back or
  reconciles suspension and admin state before publication.
- **DATA-11: the conversion runs on the operator's machine and never writes the source.** `kopje-admin convert` and
  `verify-conversion` read export files only and make no network request; bridging the legacy schema runs the canonical
  migrations on a local copy, never on the legacy D1. Nothing from the export runs as written: a strict grammar accepts
  only validated `CREATE TABLE` (never `AS SELECT`; its default, check and generated expressions must equal the canonical
  ones before it runs, in an empty scratch database; bookkeeping tables never get the export's DDL), `INSERT ...
VALUES` of literal values, decoded within nesting and size bounds and bound, and D1's `DELETE FROM sqlite_sequence`
  reset, exactly so, once, before that table's rows, which runs nowhere; any other statement, `INSERT ... SELECT` or function in `VALUES` stops with a fixed code.
  Columns are compared by name; the only variance accepted is a column nullable in the export where the canonical one
  is `NOT NULL`, and then a `NULL` in it stops the load (`null-in-not-null-column`); rows always go into the canonical
  schema by column name.
  Outputs are created exclusively under temporary names with mode 0600 and published with `link(2)`, so no existing
  file or symbolic link is followed or reused. _Enforced (main):_
  `cli/lib/cutover/sql-script.js`, `cli/lib/cutover/legacy-load.js`, `cli/lib/cutover/run.js`;
  `test-node/cutover-safety.test.ts` ("the export grammar", "outputs"), `test-node/cutover-load.test.ts`.
- **DATA-12: a conversion is verified independently, record by record.** The expected records come from the legacy
  data by a code path that shares no mapping with the converter (`verify-expect.js`), with audiences from the addressing
  captured before the bridge; the actual records come from a Kopje dump, the converted one or one taken from the Store
  after the import (`verify-actual.js`). Records are compared as exact values keyed by AP URIs: content, source, raw,
  edits, attachments, profiles, keys, recipients per status, reply links, remote proxy aliases, the notification
  counter, relationships with their preferences, list policies, settings and client scopes. Missing content, content
  rewritten to the same length, a dropped relationship, a removed or added recipient, a widened visibility, a dropped
  reply link and any count difference FAIL, as does HTML cut by the sanitizer unless accepted. The sanitizer the two
  sides share is pinned by a hand-written expectation. _Enforced (main):_
  `test-node/cutover-convert.test.ts` ("the check fails on damage", one tampered dump per kind),
  `test-node/cutover-safety.test.ts` ("HTML is never cut silently"), `test/cutover-import.test.ts` (the check passes
  on the Store's own dump after a real import).
- **DATA-13: conversion reports carry aggregates only, on failure too.** What the commands print and the manifest holds
  are counts, fixed codes and messages, SHA-256 digests and table checksums; never rows, keys, emails, URIs, the domain
  (only its digest) or KEK values, which the CLI also redacts. An untrusted name (a table, an object type) appears only
  as a digest prefix, and a parser or database error only as its class. _Enforced (main):_ `test-node/cutover-safety.test.ts` ("failure reports carry codes, counts and digests only",
  through the real CLI), `test-node/cutover-convert.test.ts` ("runs from the real CLI under Node").
- **DATA-16: cutover fingerprints and preflight reports are aggregate or configuration only.** A fingerprint holds,
  per table of an export, the row count and a SHA-256 over its rows' hashes, plus the notification counter;
  `fingerprint compare` prints table names, counts and the changed tables. `cutover-preflight` prints binding names,
  resource identifiers, variable names and types and the writers it sees, never a secret value (the API does not return
  them, and a value in the file is not read) and no instance data but the public `DOMAIN`. `maintenance-worker` reports
  counts, KEK candidate names and digests. _Enforced (main):_ `cli/lib/cutover/fingerprint.js`,
  `cli/lib/cutover/preflight.js`, `cli/lib/cutover/maintenance.js`; `test-node/cutover-fingerprint.test.ts` ("holds
  table names, counts and digests only (DATA-16)", "through the real CLI"), `test-node/cutover-maintenance.test.ts`
  ("reports aggregates", "finds the resources from the bindings").
- **DATA-17: the move out of Cloudflare Images keeps its token and the originals private.** `kopje-admin
images-export` reads the Images API token from the environment only (`CF_IMAGES_TOKEN`; the CLI takes no token
  argument), sends it only to the Images API and never with a redirect, adds it to the CLI's redaction list, and
  writes it to no file; what it prints is counts. The originals it downloads, and the copies `convert --images` writes
  for R2, may carry EXIF and location data: they are created with mode 0600 like the dump, go only to
  `originals/<media id>` in R2, which no route serves (MEDIA-2), and are served only through Kopje's re-encoding
  (MEDIA-3). Each is checked by its signature against the upload path's types and limits before it is recorded, and
  against its SHA-256 before it is copied. Each media row the converter makes has a file token of its own,
  HMAC-SHA256 under a per-image secret that only `images.json` holds, so a token cannot be derived from the public
  URIs and image ids, and the per-row sweep never deletes the files of another row showing the same image. _Enforced (main):_
  `cli/lib/cutover/images-export.js`, `cli/lib/main.js`; `test-node/cutover-images.test.ts` ("uses the Images API with
  the token when given an account id", "runs from the CLI with the token from the environment only, and never prints
  it", "marks a 404, a wrong type, an oversized file and too many pixels missing"), `test/cutover-images-lifecycle.test.ts`.
- **DATA-14: legacy keys are carried over as bytes, under one KEK.** Wrapped private keys, salts and public keys move
  unchanged (DATA-1; no re-wrapping, the owner's decision). The converter stops unless one KEK candidate (empty,
  `userKEK`, `USER_KEY`) unwraps every local key and verifies against its public key, reports which candidate by name,
  and flags an empty KEK. _Enforced (main):_ `cli/lib/cutover/kek.js`;
  `test-node/cutover-convert.test.ts` ("checks that one KEK candidate unwraps every key", "keeps wrapped keys byte for
  byte"). `USER_KEK` starts as the KEK the converter named. After publication the operator moves the keys to a new KEK
  with `kopje-admin keys rewrap` (docs/setup.md, "Rotating the KEK"): the same key pairs, nothing announced to other
  servers. Each key that `USER_KEK_PREVIOUS` (unset: the empty KEK) unwraps and that verifies against its stored public
  key is wrapped again in the Worker under `USER_KEK` with a fresh salt, checked again, and written by the Store only
  over the exact bytes that were read; a key already under `USER_KEK` is left alone, so a rerun is a no-op, and any
  other key is reported by owner with a fixed reason and left unchanged. The Store reads bounded pages and checks the
  Access admin where it writes; the response carries counts, owners and reason codes only (DATA-1, DATA-5). It
  refuses an empty `USER_KEK` and one equal to the previous KEK. There is no fallback in the keyring, so keys under the
  previous KEK cannot sign until the rewrap has run (deliveries retry; the procedure holds them with
  `MAINTENANCE=readonly`). _Enforced (main):_ `src/app/key-rewrap.ts`, `src/domain/actors.ts`
  (`listRewrapKeys`, `rewrapLocalKey`), `cli/lib/main.js`; `test/key-rewrap.test.ts`. Backups, dumps and
  cutover exports made before the rewrap still hold the keys under the previous KEK; the operator deletes them or
  accepts that (accepted risk below).
- **DATA-15: the cutover never widens an audience.** A converted status is visible to exactly whom legacy Wildebeest
  let read it (`packages/backend/src/mastodon/status_visibility.ts`, `isVisible`), from the object's own `to`/`cc` and
  its stored author's followers collection as exported, never from values a bridge migration filled in or rewrote (0002
  and 0016 for outbox addressing, 0021 for the author). Addresses follow legacy's `getApId`, the author's followers value is compared as
  legacy spells it (stopping where a normalized comparison would decide otherwise), and an address legacy could not
  read stops the conversion. A direct status's recipients are exactly the known accounts in its `to`; a
  followers-only status gets no recipient rows, so only an accepted follow, checked when it is read, grants access, as in
  legacy; a Mention tag or `cc` entry outside these sets is no recipient (counted, kept in `raw`). A non-public status
  whose author a bridge migration changed, conflicting outbox addressing, and a boost with no exported audience stop the
  conversion instead of being guessed. Legacy `/ap/o/<uuid>` aliases answer only for what VIS-4 serves: a remote proxy
  moves to a public original, an image shows with a servable status. _Enforced (main):_
  `cli/lib/cutover/convert.js`, `getLegacyObject` in `src/domain/activities.ts`, `src/federation/routes.ts`;
  `test-node/cutover-audience.test.ts` ("the audience never widens", "legacy address semantics (getApId), pinned by
  hand"), `test-node/cutover-convert.test.ts` (recipient, author and visibility tampering, boosts included),
  `test/cutover-import.test.ts` ("lets a follow, checked when read, decide who reads a migrated followers-only status",
  "keeps legacy /ap/o aliases without showing more than their status").

### Operations (OPS)

- **OPS-1: an accepted inbox request is never lost.** An inbox answers 202 only after the Store commits or the Queue
  accepts the spooled request; otherwise it answers an explicit failure (413 over the cap, 503 when it cannot spool).
  Maintenance is the maximum of the env flag and the Store flag: `readonly` admits reads and sessions and refuses other
  writes with 503; `full` also refuses reads and sessions, except always-served routes. A body that is not
  ActivityStreams (415) and a personal inbox of no local account (404) are refused before anything is spooled.
  _Enforced (main):_
  `src/app/app.ts`, `src/app/gate.ts`, `src/federation/spool.ts`; `test/gate.test.ts` ("maintenance gate"). A PITR
  restore requires env `MAINTENANCE=full`: _Enforced (main)_ (`test/admin.test.ts` ("restores
  only under MAINTENANCE=full")). Replay that verifies the signature against the spool time:
  _Enforced (main):_ `src/jobs/queue.ts`, `src/federation/inbound.ts`; `test/inbox.test.ts`
  ("OPS-1"), `test/gate.test.ts` ("refuses a personal inbox of nobody").
- **OPS-2: no upgrade runs under a dump freeze or an import.** Migrations wait while either exists. The freeze also
  stops session writes and alarm work. _Enforced (main):_ `src/platform/store-kernel.ts`,
  `src/platform/store-flags.ts`; `test/dump-import.test.ts`, `test/ops-authority.test.ts` ("upgrades during an import").
- **OPS-3: an unknown outcome is reconciled, not assumed.** A migration failure re-reads durable bookkeeping. Other
  operations that a client may retry after a lost response carry a stable idempotency key. _Enforced (main)_ for
  migrations: `test/migrations.test.ts` ("re-reads bookkeeping"). _Enforced (main)_ for posts, a repeat within the
  hour (`Idempotency-Key`, `test/statuses.test.ts`, `test/scheduled-statuses.test.ts`) and for import chunks
  (`test/dump-import.test.ts`).
  Deliveries: _Enforced (main):_ a claim or completion whose response is lost leaves the row
  leased until the lease ends, then it is claimed and POSTed again (the receiver deduplicates by activity id); a
  repeated completion is stale and records nothing twice; `test/deliveries.test.ts` ("OPS-3: a claim or completion
  whose response is lost"), `test/delivery-post.test.ts` ("OPS-3: a lost completion"). Push: _Enforced (main):_ the
  same leases and completions (`claimPushes`, `completePush` in `src/domain/push.ts`), so a client may get a push
  twice; `test/push-send.test.ts` ("OPS-3: a lost completion leaves the push leased until the lease ends").
- **OPS-5: the backup never leaves the Store frozen or a recorded backup inconsistent.**
    - **Freeze.** The dump freeze ends as soon as the last chunk is read, before the remaining parts are uploaded, in
      the Store transaction that checks the freeze lease by the Store's clock and records the media membership. If the
      lease had expired, the dump is refused and taken again. On any failure the freeze is released first, by the
      run's opId, before the stream and the upload are cleaned up, even when dumpStart's answer was lost (`dumpAbort`
      never starts a dump). If the Worker dies, the 3-minute dump lease ends it, and the next run releases it again.
    - **Fencing.** One invocation holds a run. The runner lease is taken, renewed and checked in the Store transaction,
      on every save and before every upload step. Every object an invocation writes is named
      `<run>/<attempt>`, so an invocation that lost the lease can only finish writes into its own names, never into the
      backup the Store recorded.
    - **Bindings.** A run is bound to its bucket and recipients, and abandoned when they change. A day at or before the
      last successful backup's day never starts a run.
    - **Interruptions.** An interrupted dump is restarted (age's stream state cannot be saved). Its upload, and any
      upload under `backups/` that can be listed, is aborted. Media, index and manifest stages resume. Every request ends
      by the invocation's deadline, a stalled response body included, with time kept for a checkpoint. Each invocation
      encrypts at most 512 MiB of plaintext, sized to the cron's CPU limit. Media and the index wait for the next cron
      at the budget; a dump that cannot fit fails as `dump-too-large`.
    - **Retention.** Retention selects backups by manifest only. It deletes only the job's names under `backups/`, only
      runs older than the newest `BACKUP_RETENTION` complete ones, and manifests first. Nothing is deleted from R2 or
      `media/`.

    _Enforced (main):_ `src/jobs/backup.ts`, `src/platform/backup-state.ts`,
    `dumpAbort` in `src/platform/store-admin.ts`; `test/backup.test.ts` ("backup fencing", "backup resumption",
    "backup deadline", "backup destination and recipients", "ends the freeze as soon as the last chunk is read",
    "releases the freeze before it cleans up the upload", "restarts a dump whose freeze ended before its last step",
    "backup retention").

- **OPS-4: cutover never writes the source and never goes back.** The legacy source stays read-only: every tool reads
  files, and every route-changing step is an operator action in the runbook (`docs/cutover-runbook.md`). A write
  barrier closes every writer of the legacy D1 before the final export (workflows and jobs, preview deployments and
  their binding, deployment URLs, the production routes, the legacy consumer after its drain); the preflight lists the
  writers it can see. On top of the barrier, two exports taken apart must have equal fingerprints, every row hashed
  whole and bound to its key, `sqlite_sequence` included, and again before publication; the conversion manifest must
  match the fingerprinted export's counts and notification counter; publication requires the independent per-row
  verification (DATA-12) on the converted dump and on the Store's own dump. After publication, recovery uses the
  Store, PITR and backups. _Enforced (main):_ `cli/lib/cutover/fingerprint.js`,
  `cli/lib/cutover/preflight.js`, `docs/cutover-runbook.md`; `test-node/cutover-fingerprint.test.ts` (an insert, a
  delete, a short value changed at the same length, values swapped between rows, two characters swapped inside a long
  value, emptied content and a moved notification counter all FAIL; a missing counter, an incomplete manifest and
  other counts are refused; an export with the notifications table but no sqlite_sequence is refused even when the
  table is empty; a manifest with a missing or an extra table key fails). Gap: closing writers outside the Pages project and reconciling the legacy DLQ are go/no-go
  checks the operator makes; the tools cannot see them.
- **OPS-6: the maintenance worker accepts no write but the spool.** The cutover's Pages `_worker.js` answers actor and
  WebFinger GETs from its snapshot and spools every inbox POST (shared and personal) to Kopje's Queue through Kopje's
  own code (`src/federation/inbox-request.ts`, `src/federation/spool.ts`): the same refusals before spooling (413, 415, 404 for
  a personal inbox of no local account by its exact username), the same message format and size limit, 202 only after
  the Queue accepted the message, 503 when it cannot spool. Every other request, any method, is 503 with
  `Retry-After`. It reads no legacy binding and imports no runtime module, so it runs on the legacy project's
  compatibility settings. The spooled request keeps its URL, headers and body as received and the time it arrived, so
  Kopje's replay verifies the signature against that time (OPS-1). _Enforced (main):_
  `src/maintenance.ts`, `scripts/build-maintenance.mjs`; `test/maintenance-worker.test.ts` ("refuses every other
  write with 503 and touches no legacy binding", "refuses before spooling what Kopje refuses", "answers 503 rather than
  202 when it cannot spool", "spools a signed Follow … and Kopje replays it" with the replaying clock a day later,
  "a request altered in the spool is refused on replay", the generated file itself),
  `test-node/cutover-maintenance.test.ts` (the bundle imports no runtime module and exports its handler only),
  `test-node/maintenance-legacy-runtime.test.ts` (the generated file on the legacy compatibility date and flags,
  through a real Queue). Admission: only requests with an HTTP signature naming an https key are spooled (401
  otherwise), within an optional per-IP rate limit (429) and a backlog budget read from the Queue's metrics (503),
  which fails closed when the backlog cannot be read; Kopje's own maintenance spool applies the same budget.
  `test/maintenance-worker.test.ts` ("the spool admits only signed requests, within its budget", "admission fails
  closed when the backlog cannot be read").
- **OPS-7: the maintenance snapshot serves only the real keys.** The snapshot is rendered from the converted legacy
  export by Kopje's own Store query and Fedify dispatchers, keyed as Kopje keys its snapshots, and served by Kopje's
  snapshot rule; `maintenance-worker` refuses unless one KEK unwraps every local key and verifies against its public key
  (DATA-14), and every actor document publishes exactly its legacy public key, under `<actor>#main-key`, owned by that
  actor, at that actor's path, for every local actor. The snapshot holds no private key, no email and no instance
  actor (its key does not exist before the import; `/actor` is 503). _Enforced (main):_
  `src/maintenance-render.ts`, `cli/lib/cutover/maintenance.js`; `test/maintenance-worker.test.ts` ("serves byte for
  byte what the Store serves after the import, keys included"), `test-node/cutover-maintenance.test.ts` ("refuses a
  snapshot with …": another public key, key id, owner or actor at the path; "leaves a local actor out", mixed KEKs, another domain,
  "the snapshot is fresh when it is deployed": a profile changed or keys swapped make `maintenance-worker-check` say
  stale).
- **OPS-8: nothing an import brought is written or delivered before publication, and a cutover is reset only
  before it.** A verified import leaves the Store unpublished; the kernel gate then refuses every write operation, as in
  readonly, whatever the env `MAINTENANCE` says: replayed inbox requests stay in the Queue, deliveries and jobs wait,
  HTTP writes get 503 (no federation side effects). An inbound request, live or replayed, is checked against the Store's
  write admission before any loader is made or anything fetched, so nothing is signed with an imported key, and it is
  held as in maintenance (spooled, or requeued without counting a retry); the write's own transaction checks again. The
  scheduled backup's runner lease is refused in its transaction, so cron makes no S3 call and takes no dump freeze
  (an operator's rescue dump still works). Reads and sessions pass, so imported data can be read and the owner can sign
  in for the checks before publication. `publish` (an Access admin, or `IMPORT_TOKEN` while the Store has no
  usable admin access, so a restore without Access completes) clears that state and sets the published mark in one
  transaction, which also records the `Update(Person)` of each local profile a cutover conversion changed (the
  `profile_updates` row, at most 100 distinct ids, deleted with it, so a repeated publish records none;
  `test/cutover-profile-updates.test.ts`); it is refused while a dump holds its freeze, while a drain holds its lease or the journal holds requests, and on a Store that never had
  a verified import, and an import never begins into a published Store, so the two marks never coexist. `cutover
reset` takes such a
  Store back to empty through the bounded import reset, keeping its configuration: only an Access admin, only under env
  `MAINTENANCE=full`, only while unpublished (never while the published mark exists, whatever else is set, never for a
  Store that had no import), never during
  an import or a dump, never while the journal holds requests; once published every rollback command is refused.
  One exemption, by its own operation kind (`media-rebuild` in `src/platform/store-kernel.ts`): the media rebuild's
  writes, its lease, the instance's Images transformation counter and the `meta` sizes of the row it rebuilds, pass
  readonly maintenance and an unpublished import, so the images are served at publication. They federate nothing and
  enqueue nothing, a cutover reset removes them with the rest, an import or a dump in progress still refuses them, and
  each checks the Access admin again in its transaction (the import token and sessions are refused). The rebuild
  writes only in those states (after a 20-minute settle for maintenance, MEDIA-2) and under its lease, which the Store
  takes, renews and checks at its own clock, whatever time a request carries; while the lease is live the Store
  refuses to begin or reset an import, reset a cutover, publish or leave maintenance (`rebuild-in-progress`), and every
  media-deleting write, so the rows cannot change under a call. `test/media-rebuild.test.ts` ("admits only the
  rebuild", "rebuilds in a Store that is unpublished or in readonly maintenance, where other writes stay refused", "is
  refused while a dump holds the Store", "is for the Access admin only", "has the Store check the admin again", "keeps
  the lease until it expires", "keeps its lease by the Store clock", "fences imports, resets and publication while the
  lease is held").
  _Enforced (main):_ `src/platform/store-flags.ts` (`admitFlags`),
  `src/platform/store-admin.ts` (`publish`, `importBegin`, `cutoverReset`), `inboxWritable` in
  `src/federation/inbox.ts`, `backupClaim` in `src/store.ts`, `src/app/admin.ts`; `test/cutover-rollback.test.ts` ("the
  cutover reset after a completed import": publish without an import, import into a published Store, both marks at
  once; "an import stays readonly until it is published": queue replay and deliveries refused with `MAINTENANCE=off`,
  no fetch and no retry for a live or replayed request, publication letting them through, a restore without Access, a
  Store without an import untouched; "a rollback in progress blocks publication"), `test/backup.test.ts` ("starts
  nothing while a verified import is unpublished").
- **OPS-9: a rollback hands every spooled request to the legacy instance, in order, and leaves none to replay.** With
  `CUTOVER_ROLLBACK=journal` the Queue consumer keeps spooled requests in the Store's journal, keyed by the spool
  message's digest, within count and byte quotas (when full the request stays in the Queue, whose backlog bounds
  admission; refused once published or during an import). `cutover drain` hands them off through an ordered lane:
  nothing is sent while Kopje's Queue holds any message (the collection barrier, so a request held with the requeue
  delay cannot arrive after a newer one), and the next request only once the legacy Queue's backlog is 0 (the legacy
  consumer acknowledged the previous one, retries included); a message in the legacy dead-letter queue stops it. A
  backlog counts as empty only when both its message count and its byte count are 0 (Queues leaves a delayed message
  out of the count), and every backlog reading fails closed, also on a missing or malformed field. Each request is verified against its spool time without the Store (Kopje's signature
  and key-ownership rule) and goes to a legacy local account from the operator's snapshot, never one the request alone
  names; one that fails for good, or has no legacy recipient, is kept until the operator discards it. The drain hands
  on only what Kopje's inbox would read (the shared activity envelope: context, id, type, actor), reads the legacy
  Queue before its dead-letter queue, and runs alone under a Store lease; every awaited call of a round (Queue readings,
  Store calls, key fetches) is given up at the round's deadline, after which the round sends nothing, and a send that
  does not finish in 10 seconds is given up; either way the lease is kept until it expires. A record is marked before its send and sent again
  after a crash. A handed-off request leaves a receipt in `kopje_state`, outside dumped, imported and reset data,
  consulted before journaling and before any replay, until the operator closes the rollback with Kopje's Queue and its
  dead-letter queue empty. _Enforced (main):_
  `src/app/cutover.ts`, `src/federation/legacy-inbox.ts`, the journal in `src/platform/store-admin.ts`,
  `verifySpooledRequest` in `src/federation/inbound.ts`; `test/cutover-rollback.test.ts` ("the rollback drain": a
  delayed Follow before its Undo and a delayed Create before its Delete, a legacy retry holding the next request, the
  legacy DLQ and unreadable backlogs stopping it, a concurrent drain, a crash while sending, a late redelivery,
  recipients, a flood against the quotas; "Rollback A from the first attempt"; "handoff receipts outlive the journal,
  an import and a reset"; "the drain lane holds under timing faults": a suspended send, a message dead-lettered between
  the readings, activities without context or id, valid requests over the quota; "a Queue holding only delayed
  messages is not empty": a reading of 0 messages with bytes holding the barrier and the legacy lane, stopping on the
  legacy DLQ and refusing `cutover close`, a legacy retry with a delay holding the next request, and a missing or
  malformed field failing closed), `test/queue-sim.ts` (a message sent or retried with a delay counted in the bytes
  only, as Queues reports it),
  `packages/consumer/test/rollback-drain.test.ts` (drained Follow/Undo and Create/Delete, a Follow retried after a
  failed Accept then its Undo, a missing recipient through the legacy consumer). Residuals: delivery is at least once
  (a crash between the send and its record repeats one request); a send given up at its timeout may still reach the
  legacy Queue after the lease expired, and so after a later drain's send, and the legacy consumer does not
  deduplicate (fixing that needs a change to the legacy runtime, which this cutover does not make); while the legacy
  routes come back, requests spooled
  just before and the legacy instance's first direct requests can interleave, as deliveries from different servers can
  at any time; the order also relies on the legacy Queue's backlog (its message count or its byte count) showing a message until it
  is acknowledged. Gap:
  when valid requests alone exceed the journal's quota while the collection barrier waits for the rest, the drain
  stops with `journal-full` and the operator raises `CUTOVER_JOURNAL_MAX_*` (up to the Store's ceilings) or discards
  kept requests, with the spool rate limit on; if neither frees room (at the ceilings, with only valid requests), the
  operator's `cutover drain --unordered --yes` sends the journal's head past the barrier (the Store accepts it only
  after a recorded `journal-full` stop with the journal in the same state since), so the journal is never stuck
  for good, at the cost of ordinary delivery reordering for the requests still in the Queue; there is no protocol that
  drains a bounded journal in full order before the barrier closes.
- **OPS-10: no accepted message is dropped by Kopje's Queue.** The consumer has a dead-letter queue in the package's and
  the template's configuration; the runbook inspects, reconciles and redrives it. _Enforced (main):_ `wrangler.jsonc`, `/deploy/wrangler.jsonc`, `/scripts/check-kopje-package.mjs`.

## Negative cases by stage

Each stage ships tests for these cases, named with the invariant IDs.

| Stage                      | Required negative cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1b inbound                | Wrong signer or actor; foreign activity id; same-origin different actor; unauthorized Undo, Accept, Update, Delete; duplicate and reordered Delete and Create; non-AS media type; private and unlisted object fetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B2 delivery                | Redirect of a private activity; recipient outside the audience; duplicate inbox; expired lease; stale completion; commit followed by response loss (`test/deliveries.test.ts`, `test/delivery-post.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B4 statuses, media, search | Edit, source or history of another's status; history seen by a recipient added later; private boost in `reblogged_by`; hidden parent in reply fields; DM moving `last_status_at`; unbounded edits or reply tree; boost or quote of an invisible status; foreign attachment; unsafe R2 key; retained EXIF; failed transform; active media type; private status in search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B5 UI and setup            | Missing, `null` and foreign Origin; framing headers; unsafe return path; session fixation and reuse after logout (`test/web-session.test.ts`, `test/web-images.test.ts`, `test/web-pages.test.ts`); reused setup token, concurrent bootstrap, missing, `null` and foreign Origin on `/setup` (`test/setup.test.ts`, B5b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B6b backup and restore     | Plaintext dump, media or manifest egress; interrupted upload; missing component; unselected manifest; restored obsolete credentials (`test/backup.test.ts` covers egress, interrupted uploads and changed components; selection and credential invalidation are DATA-8, planned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| B8 cutover                 | Wrong target resources, domain or keys; writes to the source; an alternate Pages route still writable; unreconciled Queue or DLQ; changed content with unchanged length. B8a conversion (`test-node/cutover-*.test.ts`, `test/cutover-import.test.ts`): the audience never widens (a DM made public by bridge defaults; an author rewritten by 0021; an href-only address; a followers value spelled differently from its address; a followers-only mention that outlives an unfollow; a recipient added to a private boost; a tag or cc outside `to` made a recipient; a non-follower recipient of a followers-only status; conflicting or missing addressing); missing, emptied or same-length rewritten content; a removed or added recipient; a widened visibility; a dropped reply link, alias, follow, boost, notification or list member; a changed source, raw, edit, attachment, profile, key, setting, preference, policy, scope or counter; an extra row; an image moved to another owner or status; a lost or taken legacy id; a lost notification high-water mark; mixed KEKs; unaccepted deletions or truncation; `INSERT ... SELECT`, functions in `VALUES`, `CREATE TABLE ... AS SELECT`, non-canonical default or check expressions, bookkeeping DDL, nested or oversized `replace` expansion and stray statements; content in failure reports; an existing output file or link; an oversized export, total or dump; alias requests for hidden statuses and their images; B8b operations (`test/maintenance-worker.test.ts`, `test/cutover-token.test.ts`, `test-node/cutover-fingerprint.test.ts`, `test-node/cutover-maintenance.test.ts`): a write through the maintenance worker (any method, API, outbox, actor path), a personal inbox of nobody or under another case, a non-AS body, an oversized or undeflatable body, a missing or failing spool Queue, a legacy binding touched, a spooled request altered before replay, a replay a day after the signature, a snapshot key, key id, owner or actor that is not the legacy one, a local actor left out, mixed KEKs, another domain, a second import or a configuration change with `IMPORT_TOKEN` after the first import or once Access is set, a fingerprint after an insert, a delete, a same-length update of a short value, values swapped between rows, an edit inside a long value, emptied content or a moved notification counter, an export without the counter, an incomplete manifest, an export whose counts differ from the fingerprinted database, a secret or instance data in a report; an unsigned or oddly signed spool request, the rate limit, a full backlog; a stale snapshot; a cutover reset after publication, without MAINTENANCE=full, by the import token, during an import or with a non-empty journal; a drain past a request that may verify later, a forged request drained, a drain without the legacy binding, journaling after publication (`test/cutover-rollback.test.ts`); an isolate that first saw an empty Store, a delayed request overtaken by a newer one, a legacy retry overtaken, a dead-lettered legacy message, unreadable backlogs in the drain and in admission, a concurrent drain, a crash while sending, a late redelivery, a missing recipient, a flood against the journal quotas, Rollback A from bootstrap, an emptied notifications table without its counter, a manifest with a missing or extra zero-count table; a failing mark RPC, an import completing while the Worker served, publication with a journal, a drain after publication, re-import after Rollback A, redelivery after a reset and after the mode is removed, a suspended send past its lease, dead-lettering between readings, activities without context or id, valid requests over the quota, bookkeeping keys in a manifest; queue replay and deliveries of an unpublished import with MAINTENANCE=off, a restore published without Access, a mark answered after the lease ran out, a handed-off copy in Kopje's DLQ at close, bookkeeping keys with matching counts, a journal-full stop through a transient key failure and the CLI deadline, the unordered escape; a Queue reading that outlasts the round, a report that outlasts the lease, a live or replayed request while unpublished (no fetch, no retry), a scheduled backup before publication, a publication without an import, an import into a published Store, both publication marks at once, an unordered drain without a reported stop |

## IDs to check by change type

- **Mastodon API endpoint:** AUTH-1, AUTH-2, AUTH-6, VIS-1, VIS-5, VIS-12, RES-1, RES-3, RES-7, DATA-6. Test a wrong
  scope, a revoked token, another account's resource, and a status the viewer may not see.
- **Inbound activity handler:** ID-1, ID-3, ID-6, ID-7, ID-8, VIS-2, HTML-1, RES-1, RES-2, RES-6, OPS-1; the inbox
  precheck and the spool also OPS-6 (the cutover's maintenance worker shares them).
- **Outbound activity or delivery:** VIS-3, VIS-30, NET-2, NET-3, DATA-1, DATA-7, RES-5, RES-6.
- **Fetch of a remote URL:** NET-1, NET-3, NET-4, ID-2, ID-8. Use a sink client, never `fetch` directly.
- **Rendered field or HTML page:** HTML-1, HTML-2, HTML-3, WEB-2, WEB-5. Run the vector suites.
- **Web UI, consent or setup:** WEB-1 to WEB-5, AUTH-8, VIS-4, HTML-1 to HTML-3, SETUP-1 to SETUP-4.
- **Media:** MEDIA-1 to MEDIA-4, NET-3, VIS-1, RES-1, RES-6.
- **Web Push:** PUSH-1 to PUSH-3, AUTH-7, DATA-2, NET-3, VIS-10.
- **Store operation or migration:** AUTH-1, OPS-2, OPS-3, DATA-6. Migrations are append-only after the first release and
  never recreate a parent table (that cascades deletes into child tables).
- **Admin, dump, import, backup or CLI:** AUTH-4, AUTH-5, DATA-3, DATA-4, DATA-5, DATA-8, DATA-9, DATA-10, DATA-11 to
  DATA-17 (cutover), OPS-2, OPS-4 to OPS-10 (cutover), OPS-5.
- **New dependency:** prefer a maintained, widely used library over custom security code. Record its version, age (at
  least 3 days, per `minimumReleaseAge`), license and bundle size in the PR.

## Verification sources

Custom code is cross-checked against external vectors: RFC 7636 Appendix B and the RFC 6749 and RFC 7009 examples
(`test/vectors.test.ts`); Fedify's draft-cavage vector and a pinned Mastodon-shaped signature
(`test/http-signature.test.ts`); NIST SHA-256 vectors (`test/dump-format.test.ts`); the DOMPurify,
OWASP, html5sec and sanitize-html vectors in `packages/backend`; Mastodon's `StatusPolicy`, `StatusFilter` and inbound
activity specs, cited in test names.

## Accepted risks

| Risk                                                                                                                                                                                                                                                                                                         | Why accepted                                                                                                                                                                                                                                                               | Revisit when                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| An announcement whose rendering passes 64 KiB after it was written (a mentioned account's URL grew) is shown with no link | The text is still shown in full, escaped; a write past the budget is refused (MD-4) | announcements need richer rendering |
| An announcement's mentions follow the accounts as they are when read, as Mastodon's do | Mastodon resolves them live too; unavailable accounts are never linked (R1) | — |
| Which new emoji a reaction may name is decided by workerd's ICU (`\p{RGI_Emoji}`) | Names already stored are unaffected; every name of Mastodon's emoji map passes | the runtime's ICU lags Mastodon's map |
| Trends count only the newest 4,000 public originals of the last two days, so past that the oldest are not counted, which lowers `expected` and raises scores (MD-5)                                                                                                                                                                                                                                                         | The window keeps the round's cost flat; the constants shrink with no schema change                                                                                                                                                                                         | an instance receives more than 4,000 public posts in two days        |
| Spam can fill the 50-row review pool and hide newer candidates from review                                                                                                                                                                                                                                                                                                                                                  | It cannot push out allowed trends (separate pools)                                                                                                                                                                                                                         | the review pool stays full of spam                                   |
| A trending hashtag's `history` counts at most its newest 200 public posts of the 7 days (MD-5)                                                                                                                                                                                                                                                                                                                              | It bounds the anonymous list's reads; `GET /api/v1/tags/:id` keeps the full history                                                                                                                                                                                        | a client needs the full counts in the list                           |
| An announcement taken down by its end time sends no `announcement.delete`, and a scheduled one is published up to 5 minutes late | Mastodon's scheduler does the same (MD-4); REST is authoritative | clients rely on the event |
| Duplicate keys in a JSON OAuth body are not rejected; the last one wins                                                                                                                                                                                                                                      | RFC 6749 defines form bodies only, and Doorkeeper behaves the same                                                                                                                                                                                                         | a client depends on JSON bodies                                      |
| Fedify 2.4.2 signs draft-cavage `(request-target)` without the query string                                                                                                                                                                                                                                  | Mastodon accepts it; reported upstream                                                                                                                                                                                                                                     | a peer rejects signed GETs to URLs with a query                      |
| Backups, dumps and cutover exports made before a KEK rewrap hold the local keys under the previous KEK (unprotected when it was empty), so R5 with one of them and that KEK can unwrap the keys                                                                                                              | The rewrap cannot change copies outside the Store; the rotation procedure tells the operator to delete them or accept this (DATA-14); health warns on an empty KEK                                                                                                         | a key leak, or backups are re-encrypted per key                      |
| Signed-fetch cache entries may outlive a remote block or key change by up to 5 minutes                                                                                                                                                                                                                       | Measured CPU savings on personal inboxes                                                                                                                                                                                                                                   | blocks must apply at once                                            |
| OAuth client secrets are stored in plaintext, so R5 can act as any registered app (no user scopes)                                                                                                                                                                                                           | Matches Mastodon; app tokens carry no user authority                                                                                                                                                                                                                       | app tokens gain user-level powers                                    |
| Aggregate counters (`reblogs_count`, `favourites_count`, `replies_count`) include interactions the viewer cannot see                                                                                                                                                                                         | Mastodon parity; clients rely on the counts                                                                                                                                                                                                                                | counters must hide private interactions                              |
| An inbound `Flag` differs from Mastodon's: one whose id is not on its actor's server is ignored (Mastodon files it without a uri); a redelivery files nothing (one report per Flag id and account, where Mastodon files one per delivery); a status's own mention admits it, where Mastodon's mention term is any mention of the domain (`report_service.rb:89`); only originals are attached; at most 101 objects are read | Each keeps a report tied to one signed activity of its server, and the uncorrelated term would attach any status once one mentions the domain | Mastodon changes its `Flag` handling |
| One remote actor may have at most 100 unresolved reports, not one server: a server with several actors that send Flags has 100 for each | Mastodon and Misskey send Flags from one instance or system actor; a server-wide quota would need its own counter | a server is seen spreading reports over actors |
| The follower probe (two windows of 1,000 rows) can leave out a private status of an account with more followers when the reporter's server has more stored accounts and neither window holds a follower there | It bounds the work of a Flag (RES-7); the report is still filed with its other statuses | such reports are seen missing statuses |
| The admin is shown a report's statuses only while its reporter may still see them, and a remote report's `status_ids` keep the ids admitted when it was filed; a remote report's comment (which may hold a NUL, Mastodon's PostgreSQL stores none) is kept until its reporter's or its target's purge | The rule the report was made under (R37); the comment is plain text the admin alone reads | Mastodon changes what it shows |
| `GET /api/v1/instance/peers` lists the domain of every known remote account, including one known only from a direct or limited status, a follow or a search                                                                                                                                                  | Mastodon parity (`Instance.searchable`); the instance's `domain_count` already counts the same set                                                                                                                                                                         | peers must hide how a domain became known                            |
| `GET /api/v1/accounts/familiar_followers` does not show a match past the viewer's first 10,000 accepted follows (in account id order)                                                                                                                                                                        | The window is above Mastodon's default follow limit (7,500); a complete intersection would need maintained overlap data                                                                                                                                                    | a viewer follows more than 10,000 accounts                           |
| `GET /api/v1/lists/:id/accounts?limit=0`, which Mastodon answers with every member, answers the newest 1,000 by account id, and at most 8 MiB of accounts, linking `next` to the rest                                                                                                                        | One answer presents whole accounts (remote bios included), and 1,000 and 8 MiB keep it well within the isolate's 128 MB; the answer stays bounded (RES-3)                                                                                                                  | a list holds more than 1,000 members and a client relies on limit=0  |
| Non-public media is readable by anyone holding its unguessable URL; cached copies outlive deletion                                                                                                                                                                                                           | Clients and peers fetch media without credentials; URLs appear only under VIS-1                                                                                                                                                                                            | authenticated media fetch becomes interoperable                      |
| A write of a failed upload that lands after the sweep stays a day; one landing after its tombstone stays for good                                                                                                                                                                                            | An HTTP Worker has no fixed wall-time limit; deleting unrecorded objects would destroy media after a restore                                                                                                                                                               | R2 offers conditional writes bound to a Store record                 |
| R2 originals keep the uploaded bytes, EXIF and location included                                                                                                                                                                                                                                             | Never served (MEDIA-2); backups restore from them; they are A8                                                                                                                                                                                                             | backups can be rebuilt from re-encoded files                         |
| Remote servers' copies of statuses from before the cutover lose their images once the legacy images are deleted from Cloudflare Images                                                                                                                                                                       | Kopje sends no `Update` for old statuses, which Mastodon would mark as edited; the runbook keeps the images for 30 days first                                                                                                                                              | send `Update` for the old statuses                                   |
| Service tokens are recognized by Access's claim shape (no email, empty `sub`, `common_name`)                                                                                                                                                                                                                 | The admin application's policy decides which identities reach it                                                                                                                                                                                                           | the admin application admits mTLS or Access changes the claims       |
| A delivery whose completion was lost is POSTed again after its lease (at-least-once)                                                                                                                                                                                                                         | Receivers deduplicate by activity id; exactly-once needs the receiver's cooperation                                                                                                                                                                                        | a receiver is seen to apply a repeat                                 |
| Misskey with several silent recipients of one status on one server: only the first copy Misskey processes sets the note's audience, so the other silent recipients there cannot see it. Supported: one silent recipient per Misskey server                                                                   | Misskey keeps the first `Create` of a note; a combined copy would name the recipients to each other, and recipient-specific object ids would split the status                                                                                                              | Misskey honours a later copy, or a peer needs it                     |
| A purge's Undo of a local boost staged over several batches misses a follower whose inbox changes, between two batches, to a key the staging has already passed                                                                                                                                              | Staging spans batches only when a batch's remaining rows can't hold the targets, and the boosted status was deleted by its author, whose `Delete` already makes other servers drop boosts of it; tracking every staged target durably would cost a row per target          | staging is seen to span many batches in practice                     |
| An untyped `Undo` whose object is a pair-shaped id (`/follows/<a>/<b>`) that matches nothing is not recorded as retracted, so a `Block` with that id arriving after it applies                                                                                                                               | Such an id names every generation of a Misskey follow and must not be recorded; Misskey's Block ids are `/blocks/<id>`, so only an unusual server that gives a Block a pair-shaped id and reorders its delivery is affected                                                | a server is seen to send pair-shaped Block ids                       |
| A lease taken just before maintenance and not completed counts one attempt when it expires                                                                                                                                                                                                                   | Bounded by one attempt per lease; maintenance itself claims nothing (RES-5)                                                                                                                                                                                                | maintenance windows become frequent                                  |
| Fedify's own fetch-failure logs include response headers; they are silent only because logtape is unconfigured                                                                                                                                                                                               | Kopje configures no logtape sink (DATA-5); a sink without redaction must not be added                                                                                                                                                                                      | Kopje configures logtape                                             |
| Remote HTML is sanitized by sanitize-html, whose htmlparser2 is a tokenizer rather than an HTML5 tree builder                                                                                                                                                                                                | It emits only allowlisted tags with quoted, escaped attributes and escapes all other text; the parse5-checked vector suites pass                                                                                                                                           | a vector fails, or a maintained tree-based sanitizer fits the budget |
| Backup media copies are never pruned, so an original deleted from R2 stays in the bucket (and copies from abandoned or stale attempts stay too); served `files/` variants are not backed up                                                                                                                  | Copies are reused across backups and the kept indexes refer to them; originals are the source of the variants (the media rebuild, MEDIA-2)                                                                                                                                 | a restore tool re-encodes variants, or backups track deletions       |
| The backup's S3 credentials can delete backups under `backups/` (not `media/`)                                                                                                                                                                                                                               | Retention needs delete; versioning or object lock on the bucket is the documented protection                                                                                                                                                                               | the job can work with put-only credentials                           |
| Activities signed by someone other than their actor (forwarded, with LD signatures) are refused                                                                                                                                                                                                              | ID-1. Replies that reach Kopje only by forwarding (to a collection the author cannot deliver to) and deliveries through relays are missed                                                                                                                                  | relays or forwarded replies must be supported                        |
| The app registration limit is approximate: the Rate Limiting binding counts per Cloudflare location and is eventually consistent, and many addresses together can fill the 500 never-authorized slots, evicting never-authorized apps older than an hour or refusing registration for an hour at most        | The Store's bound holds exactly whatever the limiter lets through, and every refusal is visible (429); Workers offers no exact global limiter without a paid product                                                                                                       | registrations are seen to be refused or evicted in practice          |
| An app token (`client_credentials`) of an app no user has authorized may stop working under registration pressure: the app is evicted with its tokens                                                                                                                                                        | Anyone can get an app token without a user; letting app tokens protect an app would let them fill the budget for good. Clients re-register, as after Mastodon's vacuum                                                                                                     | logged-out clients are seen to lose their app tokens                 |
| Two first sign-ins of one browser that overlap (the second starts before the first's session cookie arrives) leave two sessions; signing out ends only the one in the cookie                                                                                                                                 | Both belong to the same person in the same browser, the other token is in no cookie or response any more, and it expires with its 7-day lifetime; binding them would need a server-side browser identity before sign-in                                                    | a session token is seen to leak this way                             |
| A web session lasts its 7 days even if the person's Access session ends or the Access policy changes                                                                                                                                                                                                         | Access verifies the person at sign-in only (design); suspension, sign-out and "sign out other sessions" end sessions at once                                                                                                                                               | sessions must follow Access policy changes                           |
| Notifications written before a block, a mute or a domain block are hidden while it lasts, not deleted as Mastodon deletes them, so they show again after it ends                                                                                                                                             | The one notification rule hides them at read time (VIS-13 to VIS-15); deleting them would be unbounded work in the request                                                                                                                                                 | a user expects them gone after an unblock                            |
| A local block of a remote actor at its retraction cap does not record the ended Follow as retracted, so after an unblock a redelivery of that Follow is accepted as a new one                                                                                                                                | The block must apply whatever the blocked actor did to its own cap; while the block lasts its Follows are refused (VIS-13)                                                                                                                                                 | redelivered Follows are seen after unblocks                          |
| Deliveries queued before a block or a domain block (retries of them included) are still sent as queued, to the blocked account's inboxes too                                                                                                                                                                 | Mastodon does not rewrite deliveries already queued either; a re-check at claim cannot tell, for a shared inbox or a follower target, which recipients it serves (VIS-13, VIS-15)                                                                                          | deliveries keep their recipients                                     |
| A follow answer (`Accept`, `Reject`) a delivery claim took is still sent after the follower follows again; a server matching answers by account pair may apply it to the new request, so the sides can disagree (NET-2). The new `Follow` also cancels an untaken withdrawing `Reject` that would counter it | A server's application of a POSTed answer cannot be observed: servers queue, process concurrently and retry. A new `Follow` makes earlier answers stale by policy; Kopje's follow of a locked account stays pending until authorized. Recovery: the follower follows again | a server offers answer correlation, or such a disagreement is seen   |
| Clients load custom emoji images from the remote hosts the tags name, as they load avatars and media                                                                                                                                                                                                         | Kopje fetches no remote image (NET-3); the URLs are http(s) and bounded (HTML-3, RES-2)                                                                                                                                                                                    | a media proxy or cache is added                                      |
| An emoji snapshot goes stale until its object is delivered again: an emoji the author's server changes or removes keeps its old URL                                                                                                                                                                          | Each object keeps what it tagged; a global (shortcode, domain) registry, as Mastodon keeps, is not stored                                                                                                                                                                  | emoji are kept in a registry                                         |
| `static_url` is the same as `url`, so an animated emoji stays animated where a client asked for still images                                                                                                                                                                                                 | Mastodon serves a still image it generates; Kopje processes no remote image                                                                                                                                                                                                | remote images are processed                                          |
| Rows stored before migration `0053_custom_emoji_snapshots`, and converted ones, show no emoji: an account until its next refresh, a status until its next Update                                                                                                                                             | Backfilling from the stored documents would put the upgrade's time budget at risk                                                                                                                                                                                          | a backfill fits the upgrade budget                                   |
| A disabled local emoji keeps showing in the posts and profiles that used it, and in their Notes and actors; Mastodon hides it (`EntityCache#emoji`) | A snapshot shows what was posted; the image is never deleted (MEDIA-5) | disabling must withdraw an emoji |
| Replacing an emoji changes the image peers show on earlier posts (they key emoji by shortcode); a delayed Create of an old post, or a peer's first fetch of one, switches that shortcode back to the old image until a newer object arrives. Edits carry the current image; poll-count Updates change nothing | Nothing is re-delivered on disable, enable or replace, as Mastodon | peers key emoji by id or url |
| Local emoji too have `static_url` equal to `url`, and a status's snapshot shows `visible_in_picker: true` for an unlisted local emoji | Kopje makes no still rendition; the snapshot keeps two elements | clients need still images |
| Disabled emoji versions' files, backup copies and rebuild transformations are kept and paid indefinitely | Emoji are never deleted (owner decision); the cost is documented in backup.md | the cost matters |
| An imported emoji whose existing `full` is 256 KiB or more, or whose actual edges pass 1,024 while its recorded ones do not, is served until `kopje-admin media-rebuild` reports it | The Store never sees file bytes; a restore always runs the rebuild | imports come from untrusted dumps |
| An account's `avatar_static` and `header_static` equal `avatar` and `header`, so an animated profile image stays animated where a client asked for a still one | Kopje makes no still rendition of profile images, local or remote | still renditions are built |
| After an unlock, a request from an unavailable requester, or from one the account blocks or whose domain it blocks, stays pending | Accepting it would make a follower R1 or R21 refuses; the account can still reject it | Mastodon's handling of such requests is matched |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a Codex or human review checks the IDs listed for the change type above, plus
  anything this model is missing. The other lenses (correctness, design, tests) use their own criteria.
- **Tests** name the invariant in the test name or a comment where practical (for example `// VIS-4`), so `grep -rn
'VIS-4' packages/kopje/test` shows its coverage.
- This document covers security only. It is not a correctness or design checklist.
