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

Planned topics: the KV sweep (expired signed-fetch cache rows: NET-4, RES-4) and restore (DATA-8).

## Deployment assumptions

- One operator, one Cloudflare account and domain, up to about 10 local accounts (which does not bound remote traffic,
  RES-6).
- One Worker does HTTP, Access and signature verification, fetching, sanitizing, delivery and the Queue. One SQLite
  Durable Object, the Store, holds all state; each operation runs in `transactionSync` with no external I/O.
- Access protects only `/oauth/authorize` and `/admin/*`, each with its own application; the Worker verifies the JWT.
- Media originals live in R2 and are re-encoded by Images; cached remote files live in R2 under `remote/`, verified
  but not re-encoded (MEDIA-6, MEDIA-7). Backups are age-encrypted to an offline key.

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

| Entry point                                                                 | Reached by | Authenticated by                                                       | Status and code                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /inbox`, `/ap/users/:username/inbox`, `/actor/inbox`                  | R1, R2     | HTTP signature, also on replay from the spool                          | main: `src/federation/inbound.ts`                                                                                                                                                                                                                                                                            |
| Actor, `/actor`, WebFinger, NodeInfo, followers and following               | R1, R2     | none (public)                                                          | main: `src/federation/*`                                                                                                                                                                                                                                                                                     |
| `/ap/o/:uuid`, status documents and the outbox                              | R1, R2     | none (VIS-4)                                                           | main: `src/federation/federation.ts`                                                                                                                                                                                                                                                                         |
| Outbound document fetches                                                   | R1 answers | final URL and parsed id (ID-2)                                         | main: `src/federation/loader.ts`                                                                                                                                                                                                                                                                             |
| Deliveries, remote media fetches, Web Push POSTs                            | R1 answers | sink policy (NET-3)                                                    | main: `src/federation/delivery.ts`, `src/jobs/push.ts`, `src/federation/remote-file.ts`, `src/federation/remote-media.ts`                                                                                                                                                                                    |
| Outbound web page fetches (link verification, link cards, oEmbed endpoints) | R1 answers | sink policy (NET-3)                                                    | main: `src/federation/web-page.ts`, `src/platform/html-scan.ts`, `src/federation/field-links.ts`, `src/domain/remote-field-links.ts`, `src/federation/link-cards.ts`                                                                                                                                         |
| Mastodon API `/api/*`                                                       | R2–R4, R7  | bearer token and route access                                          | main: `src/mastodon/*`, `src/domain/auth.ts`                                                                                                                                                                                                                                                                 |
| Mastodon admin API `/api/v1/admin/*`, `/api/v2/admin/*`                     | R2–R4      | bearer token with an admin scope, of the OAuth admin (VIS-29)          | main: `src/mastodon/admin.ts`, `src/domain/auth.ts`, `src/domain/admin-authority.ts`, `src/domain/reports.ts`, `src/domain/admin-*.ts`, `src/domain/suspension.ts`                                                                                                                                           |
| `/oauth/authorize`                                                          | R2, R6, R7 | instance host, Access JWT, Origin, consent                             | main: `src/app/authorize.tsx`                                                                                                                                                                                                                                                                                |
| `/oauth/token`, `/oauth/revoke`                                             | R2, R3     | client credentials                                                     | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/oauth/userinfo`                                                           | R2, R3     | bearer token with `profile`                                            | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/.well-known/oauth-authorization-server`                                   | R2         | none (public)                                                          | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                                                                                                |
| `/admin/*` and the `kopje-admin` CLI                                        | R2, R6     | admin Access JWT, service token, `IMPORT_TOKEN`, session               | main: `src/app/admin.ts`                                                                                                                                                                                                                                                                                     |
| `/setup` and its Cloudflare API calls                                       | R2, R7     | `SETUP_TOKEN`, then the admin's web session (SETUP-2)                  | main: `src/app/setup.tsx`, `src/platform/cloudflare-api.ts`                                                                                                                                                                                                                                                  |
| Web UI (profiles, hashtags, follow lists, posts, settings)                  | R2, R4, R7 | session (AUTH-8), Origin and form token (WEB-4)                        | main: `src/app/web.tsx`, `src/app/public-pages.tsx`, `src/domain/web-pages/*`, `src/web/*`                                                                                                                                                                                                                   |
| Threads                                                                     | R2, R4, R7 | none: an anonymous viewer (VIS-4)                                      | main: `src/domain/web-pages/status.ts`                                                                                                                                                                                                                                                                       |
| Interaction lists                                                           | R2, R4, R7 | none: an anonymous viewer (VIS-4)                                      | main: `src/domain/web-pages/status.ts`                                                                                                                                                                                                                                                                       |
| `/actor/outbox`                                                             | R1, R2     | none (public)                                                          | main: `src/federation/federation.ts`                                                                                                                                                                                                                                                                         |
| `/authorize_interaction`                                                    | R2, R4, R7 | none for GET; session (AUTH-8), Origin and form token (WEB-4) for POST | main: `src/app/interaction.tsx`, `src/domain/interaction.ts`                                                                                                                                                                                                                                                 |
| Media upload and serving, Images transformation                             | R2–R4      | bearer token; capability URL for reads                                 | main: `src/mastodon/media.ts`                                                                                                                                                                                                                                                                                |
| Cached remote media `/media/r/:token/:file`                                 | R2–R4      | none; capability URL (MEDIA-7)                                         | main: `src/web/media.ts`, `src/platform/media-files.ts`                                                                                                                                                                                                                                                      |
| Web Push registration                                                       | R3         | bearer token with `push`                                               | main: `src/mastodon/push.ts`, `src/domain/push.ts`                                                                                                                                                                                                                                                           |
| Streaming API `/api/v1/streaming` (WebSocket)                               | R2–R4      | bearer token or subprotocol (VIS-26)                                   | main: `src/mastodon/streaming.ts`, `src/stream-hub.ts`, `src/domain/streaming.ts`                                                                                                                                                                                                                            |
| Queue consumer, alarms, cron                                                | internal   | —                                                                      | main: `src/jobs/queue.ts`, `src/platform/store-kernel.ts`                                                                                                                                                                                                                                                    |
| Delivery doorbell and cron (`src/jobs/deliver.ts`)                          | internal   | —                                                                      | main: `src/jobs/deliver.ts`                                                                                                                                                                                                                                                                                  |
| Dump import, backup restore, cutover tools                                  | R5, R8     | admin authority, then digest chain and manifest                        | main: `src/platform/store-import.ts`, `cli/lib/commands.js`, `cli/lib/cutover/*`, `src/app/cutover.ts` (import, `backup-verify`, `convert`, `verify-conversion`, `cutover-preflight`, `maintenance-worker`, `fingerprint`, `cutover`: DATA-10 to DATA-16, OPS-4, OPS-7 to OPS-10); Planned (restore: DATA-8) |
| Cutover maintenance worker (the legacy Pages routes, step 3)                | R1, R2     | none; inbox requests as above, on replay (OPS-1)                       | main: `src/maintenance.ts` (OPS-6, OPS-7)                                                                                                                                                                                                                                                                    |
| Backup bucket (S3-compatible, outside Cloudflare) and its cron              | R5, R8     | SigV4 credentials scoped to the prefix (DATA-9)                        | main: `src/jobs/backup.ts`                                                                                                                                                                                                                                                                                   |

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
  ("stored keys, rotation and ownership"). A stored key list (with the profile, `movedTo` and routing beside it) is
  replaced only by a document fetched after the last one stored: every store of a remote actor's document issues a new
  Store revision (`accounts.document_revision`, never the same value twice in a row, so an imported maximum does not
  stop it), and every writer that fetches a whole document reads the revision before the fetch and stores the document
  only while it still holds, compared in the transaction that would store it. Those writers are the inbox sender in
  every Store round of its request (a later round never stores its document again), its routing while it is suspended
  (VIS-30), a relayed `Delete`'s actor (by the actor's revision, not the signer's), a `Move` target, search resolution
  (which fetches a URL's actor document again after reading the revision, so its probe is never stored), and the
  refresh of a stale boosted or quoted author (the revision read when the refresh was decided travels with the need or
  the quote's work; staleness stays the refresh policy, since a `Move` changes the revision but not `fetched_at`). A
  document stored under an expectation is fetched after it was read: an expectation read before the request's first
  fetch (the inbox gate's, a quote stage's) pairs with the request's loaders, and one read later (a refresh need's, a
  search resolution's) takes a document loader with a memo of its own (`afterRevisionRead` in
  `src/federation/federation.ts`), so no response cached before the read is stored under it. A superseded sender
  document leaves the activity to apply with the stored row: the activity was verified earlier, against the key and
  document it was served, which a newer store may have replaced since. An `Update(Person)` then answers 503 and stores
  nothing; a superseded `Move` target answers 503; search and the author refresh use the stored row. Each such attempt
  is atomic, and whether a sender retries, and whether a retry finds its key still authorized and its document
  current, is outside Kopje. Writers that store an author only while no row of it exists (a boosted or quoted author
  Kopje does not know) keep that absence check, in the same transaction, instead of an expectation, and issue a
  revision too. _Enforced (main):_ `upsertRemoteActor`, `applyRefresh`, `receive` and `inboxGate` in
  `src/domain/inbox.ts`, `quoteWork` in `src/domain/quotes.ts`, `resolveSearch` in `src/domain/remote-statuses.ts`,
  `src/federation/resolve.ts`; `test/inbox-actor-revision.test.ts`, `test/quotes.test.ts` ("keeps a Move committed
  during a stale-author stage’s fetch"). A second exception: a `Delete` another server relays (a quoting server
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
  A remote author's own `Delete` of a status that local accounts boosted is forwarded (VIS-3) only once that proof
  verifies the same way; a proof that is present but does not verify, or none, forwards nothing, and the `Delete`
  applies as its actor's (`test/forward-delete.test.ts` ("an invalid proof deletes and forwards nothing", "an FEP-8b32
  proof forwards too")).
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
  processed; followers move only on a verified `Move` (`upsertRemoteActor` in `src/domain/remote-actors.ts` and `move`
  in `src/domain/inbox.ts`; `test/inbox.test.ts` ("account moves")). Setting it issues a new revision of the source
  (ID-1), so a document of the source fetched before the `Move` committed never clears it, a stale-author refresh
  included; a target stored after its revision was read answers 503, having written nothing
  (`test/inbox-actor-revision.test.ts`).
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
  own (its `attributedTo` the author, its id on the author's origin), with one hop less of work. `revokeStamp` and
  `verifyQuote` in `src/domain/quotes.ts`; `test/quotes.test.ts` ("is not taken from anyone but the quoted author",
  "leaves a quote pending when its stamp is …", "wins over a quote that arrives after it"). For locally authored quotes
  of remote statuses, `Accept`/`Reject` must come from the quoted author and name our request by id or inline it with
  our quoting status as instrument and their status as object. An `Accept`'s `result` must share their origin;
  `test/quote-authoring.test.ts` ("7: Accept and Reject are each one compare-and-set"). _Enforced (main)_ for `Flag`
  (a row of the same table): the actor is the reporter, available and not covered by a domain block (the inbox gate),
  and a domain block with `reject_reports` refuses it; the reported accounts are local ones named by exact actor id, or
  stored remote ones only with a named status of theirs replying to a local account (Mastodon's `flag.rb:15-17`),
  available (R1); a named status is attached only when it is the reported account's original and passes the remote
  reporter rule (R34, `remoteReportableSql`). Nothing is fetched. `fileRemoteReports` in `src/domain/reports.ts`;
  `test/inbox.test.ts` ("Flag: the actor is the reporter"), `test/inbox-flag.test.ts`.
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
  Reject is recorded twice; an answer's id derives from the Follow it answers; a new generation cancels the earlier
  generations' answers that are not leased and supersedes a leased one (NET-2). A Move is a job keyed by its id that
  never moves a follow made after it. The Store rounds of one request carry the same actor document and revision, and
  only the first round that finds the revision stores the document (ID-1). An actor's deletion is a tombstone
  (`inbound_jobs`) independent of the retraction cap and TTL, honoured by every upsert and by every Move batch, and
  recorded even for a verified Delete of an actor never stored. A generation change whose retraction cannot be recorded
  (the per-actor cap) is not made: a Block, and a local reject of a request (which records the remote Follow as
  retracted and answers 503 if it cannot), change nothing then. Misskey's pair-shaped
  Follow id (`/follows/<a>/<b>`) is never recorded as retracted, whether the Undo or the stored edge carries it, so the
  same pair can undo a later generation; the exception applies only to a Follow: an Undo decides the undone type first
  (embedded, or a stored block with that id), and a Block id is always recorded whatever its shape (an untyped pair-shaped id that matches nothing is not: see the accepted risks); a `Reject` with a pair id matches our follow whatever its uri. Every Follow retraction (Undo,
  Block, a refused or superseded Follow, a local reject) goes through one helper (`retractFollow`) that never records a
  pair id, so on the reject path too a redelivered pair Follow asks again. A Block that takes a new id records its old
  id as retracted first (and changes nothing if it cannot), so a redelivered old Block does not come back after an
  Undo of the new one (and at the retraction cap the Block keeps its id, edges and deliveries). The limit is
  that a redelivered pair Undo or Reject after a new Follow cannot be told from a new one. `test/inbox.test.ts` ("ID-7: replay changes nothing twice", "OPS-1"), `test/inbox-regressions.test.ts`,
  `test/inbox-verify4.test.ts` ("keeps a Block with a pair-shaped id undone", "changes nothing when a Block takes a new
  id at the retraction cap"), `test/follow-lifecycle.test.ts` (generated sequences of both sides' follows, blocks,
  answers and deliveries, checked after every step against the rules in `test/follow-model.ts` and, once settled,
  against a Mastodon v4.5.11 peer). A change to a follow-lifecycle rule here changes `test/follow-model.ts` with it.
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
  itself goes once its deliveries settle; both jobs wait for the intent's staging before they delete the boost. A
  local user's unboost (unreblog, or the `DELETE` of a boost) sets the same marker in one compare-and-set, in the
  transaction that finds the kept boost: a second unboost finds none and writes nothing, a second `DELETE` of the
  boost answers 404, and an unreblog, unfavourite or unbookmark by a withdrawn boost's id answers 404 before its
  original is read (Mastodon's kept scope), so a retry cannot reach a newer boost; a new boost of the original is a
  new kept key (`statuses_account_reblogs_kept`, migration 0075, unique), and the original's removal continues the
  withdrawn boost's `Undo` instead of recording another (`test/unboost.test.ts`). While
  an original's removal runs (its hide, which marks `statuses.withdrawn`, is done: by a local status's `DELETE`, or by
  a remote status's `Delete` in its own transaction; or its author's purge started: `removalBegunSql` in
  `src/domain/audience.ts`), its local boosters cannot undo their boosts: an unreblog of it and a `DELETE` of a boost
  of it answer 404 before any write (as Mastodon's unreblog of a discarded status does), so no second `Undo` is
  recorded and no receipt is deleted before the removal's own `Undo` has taken it as a target
  (`test/remote-delete-cleanup.test.ts`). `test/inbox-statuses.test.ts` ("ID-7: duplicate and reordered Create and Delete", "ignores an Update that is not
  newer"), `test/inbox-statuses-edge.test.ts` ("ID-7: the Update watermark", "leaves nothing for every order of
  Create, Update and Delete", "ID-7: retractions at the per-actor cap", "removes only its own id", "withdraws a local
  boost once", "ID-7: a retryable refusal commits nothing", "ID-6, ID-7: a deleted status is not created again by anyone",
  "after its deliveries are done"), `test/inbox-reactions.test.ts` (every arrival order of three reactions and their
  Undos, a burst retried after its 503s, "is retired by the Store’s clock", "Like ids are unique instance-wide, and bounded", "Undos at the
  retraction cap", "records no
  tombstone, unless a stored favourite needs it removed", "a legacy favourite of a local status").
  `test/status-delete.test.ts` (generated sequences of a remote author's `Create`, `Update` and `Delete`, local
  favourites and boosts, job rounds and deliveries, checked after every step against the rules in
  `test/status-delete-model.ts` and, once settled, against the author's final state as a Mastodon v4.5.11 sender holds
  it). A change to a status `Create`, `Update` or `Delete` rule here changes `test/status-delete-model.ts` with it.
  A proven `Delete` of a status delivered again records no second forward (VIS-3): the job's key, read before the
  proof is asked for, fences it, and two deliveries held at their proofs record one set (`test/forward-delete.test.ts`
  ("mid-job ask for no proof", "two proven requests held at their proof record one set")).
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
  author (a suspended local account, or a remote account whose deletion has started) are seen by nobody; nor is a
  withdrawn status (`statuses.withdrawn`: its removal runs in a job, its `Delete` or `Undo` recorded or, for an identity
  past its stored bound, skipped), its author included (it stays a candidate of its author's reads, where the rule hides
  it: the cursor rule in `docs/visibility.md`); the author sees all else of their own; an author who blocks the viewer
  hides everything from them; `public`
  and `unlisted` are seen by everyone else; `private` by accepted followers and the mentioned (silent included);
  `direct` and `limited` by the mentioned (silent included) only. Every read path uses the same SQL rule, from the one
  policy module (`docs/visibility.md`; `test-node/policy-boundary.test.ts` keeps the rule out of other modules). A
  remote account is unavailable from the first transaction of its purge (`accounts.deleted_at`), so nothing of it is
  shown while the purge's batches remove its relationships and statuses (`test/inbox-regressions.test.ts` ("shows
  nothing of the actor from the Delete on")). A remote status its author deletes is hidden in the `Delete`'s own
  transaction, before any batch removes a mention, so no read and no new local boost sees it from then on
  (`test/forward-delete.test.ts` ("hides an imported status with 500 mentions at once")). _Enforced (main):_
  `src/domain/audience.ts` (`visibleSql`, `canView`); `test/audience.test.ts`, `test/visibility.test.ts` (single status,
  context, history, source, `favourited_by`, timelines, account statuses, notifications, bookmarks, favourites).
  _Enforced (main)_ for search: `src/domain/search.ts`; `test/search.test.ts` ("never returns a status the viewer may
  not see", "drops a boosted status that became inaccessible", hashtags only where a status with them is visible),
  `test/search-edge.test.ts` (hashtag candidates pass the rule before ranking and truncation, so hidden statuses neither
  hide nor crowd out a visible tag, hidden mentions included). Hashtag search is recent autocomplete over the viewer's
  own library windows and the newest public statuses, not a catalogue: a tag outside the windows is not found. _Gap:_ a
  status the viewer saved that later became hidden still takes a slot of the viewer's own window, which reveals that
  something changed, not what. Media URLs appear only in statuses that pass the rule (see the capability URL accepted
  risk). The object endpoint serves only what VIS-4 allows. The web UI's public pages apply the rule with no viewer:
  _Enforced (main):_ `src/domain/web-pages/profile.ts`, `src/domain/web-pages/status.ts`; `test/web-pages.test.ts`.
  oEmbed (`GET /api/oembed`) and the embed page take the status page's read: `test/oembed.test.ts`.
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
  included), and never any other. A local original's `DELETE` records its `Delete` over a snapshot read before the
  hide (its visibility, whether it was public or unlisted, its first `MAX_DELETE_NAMED` named mentions within
  `ACTOR_URI_LIMIT`), its audience naming the status, whose accounts are read when its job stages the targets: every
  mention (silent included), and only for a status public or unlisted before the hide its remote boosters, accepted
  quoters, parent's remote author and its poll's voters (removed and earlier generations excluded). Its job keeps
  those rows, the receipts and the earlier activities' rows until the `Delete` is staged, then records an
  `Undo(Announce)` for each local boost of it, with the targets of the boost (a booster's followers may never have
  received the original, so its `Delete` would not reach them), before it deletes the boosts and their receipts.
  No producer records content about a withdrawn status (edits, policies and pins through `ownStatus` and the read rule,
  poll rounds, quote answers), and a delivery of any activity but a retraction about a withdrawn status records a
  receipt, so the `Delete` targets every inbox with delivery evidence of the status when its staging reads it
  (receipts, earlier activities' rows in any state and their unexpanded targets) and the reach rows (mentions, boosts,
  accepted quotes, votes, the parent) that exist then; in each lane (signer, origin) the earlier content goes before
  the `Delete`, the intents' rows being claimed in id order. _Gap (accepted):_ a reach row removed before the
  staging reads it (a remote booster's `Undo`, a remote quote's retirement, a purge) leaves its inbox without the
  `Delete` when no other reach row or delivery evidence names that inbox; Mastodon's `RemovalWorker` computes its
  reach in the worker too, but discards the boosts in the request, finds an `Undo`'s boost through the kept scope and
  counts the discarded boosts in its reach (`status_reach_finder.rb:70`), so its race is narrower. A server that only
  fetched the status is never reached either, and an imported status whose uri, or whose author's actor id, is past
  its stored bound records no `Delete`, so a server that received it under that id keeps it. _Gap:_ a claim that drops
  an exposed row through the send-time refusals loses that inbox's evidence. `test/local-delete.test.ts`. Receipts
  belong to their status, and none is written once the status is gone or a retraction is pending (a retraction still
  staging its targets over a purge's batches reads them from the receipts, so they are still written until it is
  staged). An edit goes as an `Update` only to servers that have the object (a receipt or a `Create` in flight there);
  any other server gets a `Create` of the current version, which
  replaces a `Create` or `Update` still waiting for it. An `Update` supersedes earlier `Update`s only. `src/domain/deliveries.ts`; `test/deliveries.test.ts` ("VIS-3, VIS-7: a silent recipient",
  "VIS-3: a Delete reaches the inboxes that received the status"), `test/delivery-regressions.test.ts` ("sends a Delete
  to inboxes whose Create is still leased", "retires the receipts of local boosts"), `test/delivery-verify.test.ts`
  ("boosts that cascade with their original", "a destination that never received the Create", "retraction targets in
  every state"). Peer limitation: Misskey ignores `Update` of a Note, so edits do not reach Misskey users.
  A local boost's unboost records its `Undo` with no targets and hides the boost; its job stages the targets (the
  receipts, kept until then, the earlier activities' rows in any state and their unexpanded targets, and the
  booster's followers at that time), then deletes the receipts and the boost (`test/unboost.test.ts`). _Gap
  (accepted):_ as for a local status's `Delete`, a follower who unfollows, or whose inbox changes, between the unboost
  and the staging, and who has no delivery evidence of the boost, misses the `Undo`; so does a server that learned of
  the boost only from the outbox.
  A remote author's `Delete` of its own public or unlisted original, its author proof verified (ID-1), is forwarded
  as received by each local account holding a kept boost of it that is not direct or limited (a converted one, which
  its booster's followers may not see, forwards nothing), at most `MAX_FORWARD_OWNERS` (16, the first by account
  id; a suspended booster's too), for a body of at most `FORWARD_BODY_MAX` (65,536) UTF-8 bytes as serialized holding
  no number JSON cannot carry: one immutable intent per booster, signed by it in its own lanes (NET-2), recorded in the
  `Delete`'s first transaction, whose hide fixes the kept boosts (VIS-1), its audience the boost (`Audience.shares`).
  The status's job, or its author's purge, stages it before any boost of the status is withdrawn: the booster's
  followers by shared inbox as its `Announce` went, and the boost's receipts and the rows and unexpanded targets of its
  earlier activities, whatever the forwarded `to` says. In each lane the `Announce` goes before the forward, and the
  forward before the boost's `Undo` (an `Announce` still unsent may be dropped once the original is gone). A forward has
  a subject of its own: it neither supersedes nor is superseded by another activity, the stamp's forward (VIS-28) or a
  withdrawing `Reject` of a `Follow` with the same id included. Its shared-inbox fallback (NET-2) moves a row only when
  the row's provenance names exactly one recipient behind that inbox with a personal inbox on the same origin; a row
  serving several recipients, more than 16, or unknown ones (an inbox the boost reached already, or whose delivery of
  it gave up and is kept) gives up visibly. _Gap (accepted):_ a server that has the boost only from the outbox or a
  fetch is not reached, nor is a quote's server (only boosts forward). The staging resolves the shares one at a time and
  reads the followers once after them (RES-6). _Enforced (main):_ `deleteObject`, `recordForwards`, `stageForwards` and
  `withdrawLocalBoosts` in `src/domain/inbox.ts`, `shareReaches`, `stagedList` and `stagedBoost` in
  `src/domain/audience.ts`, `targetsOf`, `stageRetraction` and `forwardFallback` in `src/domain/deliveries.ts`;
  `test/forward-delete.test.ts` ("one intent by the booster", "stages every forward before its boost is withdrawn",
  "moves a row in place only for one recipient", "both forwards deliver in full", "forwards nothing through a converted
  limited boost").
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
  `src/domain/local-notes.ts`, the object and outbox dispatchers in `src/federation/federation.ts`;
  `test/object-endpoint.test.ts`. Legacy aliases the cutover kept answer by the same rule (DATA-15): a remote proxy
  moves to a public original, a legacy image shows only with a servable status. Boosts (`Announce` ids) answer 404; Mastodon serves them. The permalink `/@user/:id`
  shows the same set as HTML, and answers every other case (private, direct, limited, a boost, a remote status, another
  author, a suspended author, no status) with the same 404 page; with an ActivityPub `Accept` it serves the object
  endpoint's Note. A profile page lists only the account's public and unlisted statuses. _Enforced (main):_
  `webStatusPage` and `webProfilePage` in `src/domain/web-pages/`; `test/web-pages.test.ts` ("answers the same 404
  for private, direct, limited, boosts, remote, another author and nothing", "hides the statuses of a suspended
  account"). Public pages: _Enforced (main):_ every public page reads as an anonymous viewer, whatever session the
  browser holds: its one Store call is a page read whose input has no credential, and its routes read no cookie, so a
  page is the same with and without a session. A reply's parent is linked only when an anonymous viewer may see it,
  and a hidden parent leaves nothing in the page. Every path of a page's shape that no page serves answers the same
  404 page as a hidden case. The profile's posts tab leaves out replies to others and lists the account's boosts whose
  boost and original an anonymous viewer may see (VIS-6), its first page led by the pins an anonymous viewer may see;
  its posts-and-replies tab lists replies but no boosts, its media tab posts with media, and its tagged tab includes
  replies. Each tab pages both ways by the ids of the read's candidates or by a boundary derived from the request
  alone ([visibility.md](visibility.md), "Read bounds"), so a status hidden by its visibility never supplies a cursor.
  `/tags/:name` lists the hashtag's local public statuses only, replies included and boosts not, by the hashtag
  timeline's rule for an anonymous viewer, paged the same way. A hashtag whose posts are all hidden shows none of
  them: no hidden post, its text or its author's name appears, though its pager may move on by the id of a public post
  whose author is unavailable, as any window does (RES-7).
  The followers and following pages are listed under VIS-8 and page both ways by follow id. The Featured tab
  (`/@user/featured`) shows the account's featured hashtags as the API lists them, at most ten, and the accounts it
  endorses that R28 lists (VIS-19), paged both ways by account id as the API pages them; its pager may move on by the
  id of an endorsed account that is unavailable, as the API's `Link` header does (RES-7), and shows nothing else of
  it. A status page shows its thread: the ancestors an anonymous viewer may see among the 40 nearest (the walk goes on
  past those it hides, and a hidden one leaves no id, URL or text in the page), and its direct replies that are public
  or unlisted and that the rule passes, oldest first, paged both ways by the ids of the replies' candidates (never a
  private, direct or limited reply's) or by a boundary derived from the request alone. Its other tabs read as the API's lists read for an anonymous client, by the same bodies: who
  boosted it, of its public and unlisted boosts that are not withdrawn (VIS-6), and who favourited it, each of the
  accounts R12 lists; and its accepted quotes whose quoting status is public or unlisted and passes the list rule
  (VIS-27, VIS-28), a quote's reply-to line only when its parent is visible. Each pages both ways by the API's own
  cursor (the boost's status id, the favourite's id, the quoting status's id), or by a boundary derived from the
  request alone, so its pager may move on by the cursor of a row the rule hides, as the API's `Link` header does
  (RES-7), and shows nothing else of it; a private, direct or limited boost, a quote in another state or by a status
  the anonymous audience does not reach is never a candidate, and leaves no id in the page.
  `src/domain/web-pages/`, `src/app/public-pages.tsx`;
  `test-node/web-pages-boundary.test.ts` ("keeps the page reads anonymous and the web layer off the Store"),
  `test/web-read-seam.test.ts` ("serves the same page with and without a session", "links only the parents an
  anonymous viewer may see", "answers the same 404 bytes for every hidden or unknown page"),
  `test/web-profile-tabs.test.ts` ("walks every tab to both ends, each in the order seeded, past hidden ranges longer
  than a window"), `test/web-tag-page.test.ts` ("walks to both ends in the order seeded, and names nothing hidden",
  "shows nothing of a hashtag whose posts are all hidden"), `test/web-thread.test.ts` ("walks to both ends in the order
  seeded, and names nothing hidden", "shows the visible among the 40 nearest, and each one’s page goes on up", "leaves
  out a hidden parent, and links nothing of it"), `test/web-interaction-tabs.test.ts` ("walk to both ends in the order
  seeded, past runs of left-out accounts longer than two windows, naming nothing hidden", "leave out a withdrawn boost,
  as the API does", "walks to both ends in the order seeded, and names nothing hidden"), `test/web-follow-lists.test.ts`
  ("walk both lists to both ends in follow order, past runs of left-out members longer than two windows"),
  `test/web-featured-page.test.ts` ("walk to both ends in account id order, past runs of left-out accounts longer than
  two windows"), `test/policy-endpoints.test.ts` (the profile tabs, the hashtag page, the status page's thread and tabs,
  the follow lists, the endorsements and the Featured tab against the model). The remote-interaction look-up
  (`/authorize_interaction`) shows a remote account only while it is available, and a status only when an anonymous
  viewer may see it, whatever the instance actor was answered with: `resolveInteraction` in
  `src/domain/interaction.ts`; `test/interaction.test.ts` ("shows a status only when an anonymous viewer may see it").
  A post's quote (R35) is shown as the presenter shows it to an anonymous viewer: the quoted post nested only for an
  accepted quote of a post the viewer may see by itself, and otherwise only its state as text (pending, removed by
  its author, or not available), so no hidden post's text, author or id reaches a page. `src/web/view/post.ts`;
  `test/web-status-content.test.ts` ("never shows a post the anonymous viewer may not see, on the status page, the
  profile or the embed").
  A status page's edit history shows the recorded versions of the status the page itself shows (VIS-11: its audience is
  the status's), newest first, each with its own content warning, sensitive flag and emoji and sanitized at the sink
  (HTML-1); the embed shows none. Which versions fit is the page budget's
  ([response-inventory.md](response-inventory.md), the status page's edit history), and the page says how many older
  ones are left out. `webStatusPage` in `src/domain/web-pages/status.ts`, `src/web/view/history.ts`;
  `test/web-edit-history.test.ts` ("shows the versions only of a status an anonymous viewer may see, and nothing of any
  other", "shows no history on the embed, and reads none for it", "sanitizes each version at the sink, with its own
  emoji"), `test/web-page-maxima.test.ts` ("the edit history at the maxima").
  Home, notifications, compose, personal lists and the federated timeline stay in clients, as do private, direct and
  limited posts. No page browses remote accounts or posts; remote items link to their origin.
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
  with it"), `test/statuses.test.ts` ("refuses to boost direct and others’ private statuses"). A profile's posts tab
  shows a boost only while an anonymous viewer may see the boost and its original, never one of a private original or
  of an unavailable author's post, and a boost's card or stub names its original (VIS-4): _Enforced (main):_
  `webProfilePage` in `src/domain/web-pages/profile.ts` (accountStatuses, R11); `test/web-profile-tabs.test.ts`,
  `test/web-read-seam.test.ts` ("stubs a boost by its original, local or remote"). A quote embeds its
  quoted status only as VIS-27 allows. _Enforced (main)_ for
  inbound boosts: an `Announce` is stored only for an original that is public, unlisted or the booster's own, decided
  before anything is stored, so a boost of a private, direct, limited or unfetchable object stores nothing (neither
  the boost nor the fetched original); a stale stored author is refreshed first; a refresh is not content; a gone
  author refuses the original; an embedded copy of someone else's object is never trusted (it is fetched); a
  boost of an unlisted original stays out of the public timelines. The boost's own audience is kept: the known
  accounts its `to` and `cc` address are its silent recipients (bounded like a status's), so the audience rule
  decides who sees the wrapper, and a reblog notification is written and shown only while its recipient may see the
  sender's boost as well as the original (`shownSql` in `src/domain/audience.ts`, for local boosts too);
  `test/inbox-statuses.test.ts` ("VIS-6: a boost of a private, direct or unfetchable object stores nothing", "VIS-6:
  a boost of an unlisted object stays out of the public timelines"), `test/inbox-stale-authors.test.ts` ("VIS-6: a
  private original by a stale author stores no status or boost; the author is refreshed"),
  `test/inbox-statuses-edge.test.ts` ("notifies a
  local author of a private boost only if they may see the boost", "hides an already written notification once its
  recipient may no longer see the boost").
- **VIS-7: silent recipients see, but are not mentioned.** A silent mention grants VIS-1 access only. It never appears
  in `mentions` and never produces a mention notification. _Enforced (main):_
  `src/domain/status-presenter.ts`, `src/domain/notifications.ts`; `test/visibility.test.ts` ("none for a silent
  recipient").
- **VIS-8: a pending follow grants nothing.** A follow of a locked local account or of any remote account starts
  `pending`; only `accepted` follows count, appear in follower lists, or grant `private` access. _Enforced (main):_
  `follow` in `src/domain/account-actions.ts`; `test/accounts.test.ts` ("requests a locked or remote account", "lists
  following without pending requests"). `GET /api/v1/accounts/familiar_followers` reads accepted follows on both sides
  only, leaves out suspended accounts and the followers the viewer filters out of lists (VIS-5, VIS-14, VIS-15: blocks,
  mutes while they apply, domain blocks; `filteredForSql`), and shows no follow that the followers and following lists
  would not show the same viewer: _Enforced (main):_ `familiarFollowers` in
  `src/domain/accounts.ts`; `test/account-reads.test.ts` ("counts accepted follows only (VIS-8)", "leaves out
  accounts the viewer blocks or mutes", "shows a follower whose mute has expired, and hides one on a domain the viewer
  blocks", "shows no more than the followers and following lists show"). The followers and following lists
  (`GET /api/v1/accounts/:id/followers` and `/following`, Mastodon 4.5's `FollowerAccountsController` and
  `FollowingAccountsController`) read the viewer from an optional token and list nothing when the account is suspended,
  or, to anyone but the account itself, when it hides its network (`hide_collections`, set through `update_credentials`)
  or blocks the viewer; other viewers do not see the accounts they block, mute (while the mute applies) or are blocked
  by. The public followers and following pages read the same lists as an anonymous viewer and leave out an unavailable
  member, which the API lists redacted; an account that hides its network, which its settings page sets too (WEB-4),
  shows its counts and no list: _Enforced (main):_ `webFollowsPage` in `src/domain/web-pages/follows.ts`
  (`listFollowsWithin`); `test/web-follow-lists.test.ts` ("is set from the settings page, with its anti-forgery token,
  and then the lists show only their counts"). Familiar followers show no followers of an account that hides its
  network, to anyone, the account itself included, and leave out a follower that hides its own (Mastodon's
  `FamiliarFollowersPresenter`). The ActivityPub followers and following collections of a suspended actor answer 404,
  and those of an actor that hides its network show `totalItems` only and answer a page with 403. A remote account's
  setting is learned as Mastodon's ProcessAccountService learns it (its followers or following collection shows no first
  page) and hides its lists the same way; one Kopje has not learned yet hides nothing, and a collection that cannot be
  read for now leaves what was learned unless the other one is known to hide its items. Both collections are fetched in
  every sync, the followers even once the following hides (for their counts, as Mastodon fetches them); one past the
  network part's caps (`NETWORK_CAPS`, RES-6) is unreadable and hides, as any collection that cannot be read does
  (`src/federation/collections.ts`, `accounts.hide_collections`; `test/remote-collections.test.ts`). _Enforced (main):_
  `followListsShownSql` and `followListedSql` in
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
  account's own authorize call; a pending remote follow only by an `Accept` that passes ID-6. _Enforced (main):_
  `answerFollowRequest` in `src/domain/account-actions.ts` (`POST /api/v1/follow_requests/:id/authorize` and
  `/reject`, the viewer from the credential; a remote requester gets the Accept or Reject at its shared inbox, or its
  personal inbox without one), and the inbound `Accept`, matched first by the `follows.uri` of our Follow;
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
  `src/domain/statuses.ts`, `ACCOUNT_COLUMN_MAP` in `src/domain/account-columns.ts`; `test/statuses.test.ts` ("review
  regressions"). A tag's `history` is an anonymous public aggregate: it counts only public originals (as Mastodon's
  `Trends::Tags`) of available accounts, the same for every viewer whatever they block or mute (an author the caller
  blocks still counts), so it counts no status the caller may not see. `GET /api/v1/tags/:id` and the writes on one
  hashtag apply the rule in the query with no row limit, so hidden statuses cannot change the public counts. The
  lists (v2 search hashtags, `followed_tags`, `featured_tags/suggestions`) count the newest 20 entries of the hashtag's
  public range of the 7 days, raw, before the rule (`LISTED_HISTORY_ROWS`), and the trends lists the newest 200
  (`TREND_HISTORY_ROWS`): newer public boosts and public statuses of unavailable authors take slots and make a list
  undercount (one counted status behind more than the cap of those lists 0, the single hashtag 1), never count what
  is hidden. _Enforced (main):_ `tagHistory` in `src/domain/tags.ts`; `test/tags.test.ts` ("shows a tag with seven
  days of history", "leaves out the statuses of a suspended account", "keeps the public history whatever hidden
  statuses the window holds", "counts public statuses only"), `test/tag-history.test.ts` (every endpoint against
  written-out arrays and the model's `historyModel`; the caps; the undercount), `test/policy-endpoints.test.ts` (the
  history on every endpoint for every viewer against `PolicyModel.tagHistory`).
  The trends lists (R41) are bounded the same way: hashtag trends are counted by the cron's round from public
  originals of available accounts only, and a trending status passes the anonymous public
  timeline's rule (`trendableStatusSql`) and then R8 for the viewer. Link trends count plain public originals of
  available authors and their public boosts by available boosters, by publication day, and a link's `history` the
  newest 200 public copies of the 7 days and 20 public boosts of each, 200 in all, raw, before the rule (MD-5); every
  walk of a link's copies and of an original's boosts reads a public-only index (`status_cards_public_link`,
  `statuses_public_boosts`), so unlisted, private, direct and limited activity changes no score, admission, history
  or card shown, and newer unlisted rows never take a raw slot. `status_cards.public` is 1 only on an attached card
  with a final URL whose status is public (migration `0071_link_trends`'s triggers, imports included); every walk also
  checks `visibility = 'public'` and `reblog_of_id IS NULL` live, since an import links `reblog_of_id` after its rows.
  A listed link shows its qualifying public copy's card, the same for everyone. Its timeline answers only while trends
  are on and the link is listed and allowed now, and reads a window of its public copies through the same index, then
  R8 (R2 with no viewer) and public originals by discoverable authors who have not moved. _Enforced (main):_
  `src/domain/trends.ts` (`trendsRound`, `trendingStatuses`, `trendingLinks`, `linkHistory`, `listedTrendLinkSql`),
  `linkTimeline` in `src/domain/timelines.ts`; `test/link-timeline.test.ts`; `test/trends-round.test.ts`,
  `test/trend-links-round.test.ts` ("who counts", "what unlisted activity cannot change", "a remote delete’s hide
  step"), `test/trend-dump.test.ts` ("link trends in dumps"), `test/policy-endpoints.test.ts` ("shows no viewer a
  status the model does not allow, and lists exactly what it allows": the trends list for every viewer, the anonymous
  one within the anonymous public timeline, the trend links with their copies and history against
  `PolicyModel.trendingLinks` and `linkHistory`, and each link's timeline, every way, against `linkTimeline`).
  The instance activity (`GET /api/v1/instance/activity`) is an anonymous public aggregate too, the same answer for
  every caller: `statuses` counts each local public or unlisted status and boost when it is created (Mastodon's
  `Status#distributable?`), never a private, direct or limited one, and a later deletion takes nothing back;
  `logins` and `registrations` count local accounts per window and name none (`activity_logins` holds account ids and
  is never presented). What weekly logins tell of a small instance is an accepted risk. _Enforced (main):_
  `src/domain/instance-activity.ts`; `test/instance-activity.test.ts` ("counts local public and unlisted statuses
  and boosts once, at creation, and nothing else"), `test/setup.test.ts` ("records the account's registration and its
  first login with the bootstrap", "a failure at the first login's insert, after the registration is counted, rolls it
  back"); `test-node/activity-writers.test.ts` is the inventory of the writers of local statuses and accounts, so a new
  one needs a witness of its own.
- **VIS-13: a block cuts both ways, as Mastodon's does.** A local block ends the follows between the two accounts in
  both directions and in either state. A remote `Block` (one that passes ID-6) does what Mastodon's
  `ActivityPub::Activity::Block` does (`block.rb:14-16`): it ends the blocker's accepted follow with a `Reject` that
  withdraws it (`UnfollowService`, `unfollow_service.rb:35-36`; an `Accept` of it not yet sent is superseded and never
  sent, NET-2, except for a follow stored without an id, as an import may leave it, whose `Accept` is not superseded, as
  a local block's is not: one waiting in the `Reject`'s lane goes before it, and one given up may still be retried
  by the operator) and the local account's follow and request of the blocker, and keeps the blocker's pending request;
  if the ended follow's id cannot be recorded as retracted (ID-7), the `Block` changes nothing. While a block lasts the
  blocked account may not start a follow of the blocker (a remote `Follow` from it is answered with a `Reject`). The
  blocker's kept request may still be authorized or rejected by the local owner, and unlocking authorizes it, as
  Mastodon's `AuthorizeFollowService` and `FollowRequest#authorize!` check no block; a `Follow` from a remote blocker
  is taken as any other, since it may arrive after its `Block` and Mastodon's `follow.rb:18` refuses only a follower
  the target blocks. Once such a follow is accepted, the local account's statuses reach the blocker as any follower's,
  and the blocker's still do not reach the local account. The blocked account sees nothing of the blocker
  (VIS-1) and cannot favourite or boost the blocker's statuses (an inbound `Like` or `Announce` of one is ignored,
  where Mastodon stores it and only filters its notification), and nothing from the blocked account reaches a local
  blocker: no list shows it (VIS-5), and no notification of it is written or shown, including a mention or reply
  that mentions or answers it and a post notification (`notify`) of a status that mentions it. Relationships show `blocking` and `blocked_by`. A local block of a remote account
  sends, in order, the `Undo` of our follow, a `Reject` of theirs (one that withdraws it if it was accepted) and the
  `Block`; an unblock sends the `Block`'s `Undo`. A `Block` still waiting is sent all the same, ahead of its `Undo` in
  the lane: the `Undo` supersedes it only so that an operator's retry of it is refused. All go to the blocked
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
  "sends a remote account Undo Follow, Reject and Block", "applies an inbound Block and its Undo", "an inbound Block
  by a follower", "blocked recipients", "mentions of blocked and muted accounts", "names and reaches the author in the Undo of a boost"),
  `test/inbox.test.ts` ("records a Block, ends both follows"), `test/follow-answers.test.ts` ("an inbound Block by an
  accepted follower sends one withdrawing Reject and no Accept of it"), `test/policy-writes.test.ts` (the outbound and
  notification rules on generated worlds), `test/inbox-statuses.test.ts` ("ignores a Like by an actor the author
  blocks", "ignores a boost by an actor the author blocks"), `test/follow-lifecycle.test.ts` (blocks in each direction
  and state, a repeated remote Block, a block and unblock racing a new Follow, and Undos a Mastodon peer matches by the
  account pair).
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
  each scan 500 follows (RES-6, RES-7): the first in the request, the rest in the jobs rounds the Queue and the cron
  run (a family of its own, RES-5), until done; the next cleanup is picked through an index
  (`domain_block_cleanups_next`). Until then, followers there are left out of the targets of anything that carries
  content recorded after the block; a profile `Update`, a `Delete` or an `Undo` still reaches them, as Mastodon 4.5
  sends those to `followers.inboxes`. An unblock
  stops the cleanup: what it removed stays removed. The domain is normalized (lowercase, punycode, no trailing dot or
  slash) and this instance's own domain is refused. _Enforced (main):_ `blockDomain` and
  `runDomainBlockCleanups` in `src/domain/blocks.ts`, `jobsRound` in `src/jobs/queue.ts`, `audienceTargets` in
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
  deep in a long status of a very large response may be missed, while filter statuses always match). The level is set
  from each status's stored measure (`statuses.filter_text_units`), or for an unmeasured one from an upper bound of its
  text in bytes, so an answer of unmeasured statuses may be cut where its texts would fit; each cut is charged once,
  when it is fixed, and is also bounded by what is left of the 400,000, so the answer stays within it whatever the
  stored figures say (`test/filter-text-units.test.ts`). Each keyword is an
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
  is available, leaving out unavailable endorsed accounts (R28), through the API and the profile's Featured tab alike
  (`accountEndorsementsWithin`). They are not federated (Mastodon 4.5's actor has no
  endorsements collection). A remote account's purge deletes the endorsements of it and the notes on it within its
  batches (RES-6). _Enforced (main):_ `src/domain/endorsements.ts`, `setNote` and
  `relationshipsOf` in `src/domain/accounts.ts`, `removeFromFollowers` in `src/domain/blocks.ts`, `purgeRelationships`
  in `src/domain/inbox.ts`, migration `0014_account_notes_and_pins` (trigger `account_pins_follow_ended`);
  `test/account-relations.test.ts`, `test/inbox.test.ts` ("endorsements and inbound activities"),
  `test/inbox-regressions.test.ts`, `test/migrations.test.ts`, `test/policy-oracle.test.ts`,
  `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`, `test/policy-endpoints.test.ts` (the endorsements and the
  Featured tab against the model).
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
  (RES-6). _Enforced (main):_ `src/domain/status-actions.ts`, `getFeatured` in `src/domain/local-notes.ts`,
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
  accepted. A read that shows it (`include_filtered`, `account_id`, or by id) presents it with `filtered: true`
  (`REST::NotificationSerializer`), and only a row whose stored value is integer 1 reads as filtered; every other
  notification, the grouped ones, the requests and the streaming `notification` event (VIS-26) carry no `filtered`. A
  request (`NotificationRequest`) names the sender, how many of its mentions were filtered (at most 100) and the last
  one's status, shown only if the owner may still see it (R2); it, the policy, its permissions
  (`NotificationPermission`) and the work an answer leaves are read and answered only by their owner, and anyone else's
  request is not found. Blocking the sender deletes the pair's request and permission (Mastodon's
  `BlockService` and `AfterBlockService`); a domain block keeps the permissions, which a sender there cannot use while
  the block lasts (R15). Nothing of them is federated: the sender cannot tell a filtered or dropped notification
  from a shown one. Their cost is bounded (RES-6, RES-7): the lists and counts read the partial index of unfiltered
  notifications (`notifications_unfiltered`), so a sender's filtered notifications cost them nothing; the requests are
  paged by their index and the summary reads at most 100; a request's count is kept as it is written; the private
  mention walk reads at most 101 statuses; answering a request, or a bulk form of at most 100 ids, walks at most 2,000
  of the senders' notifications in the request and the rest in the inbound job rounds; and a remote sender's purge
  deletes its requests, permissions and jobs within its batches. _Enforced (main):_
  `notificationPolicySql` and `UNFILTERED_SQL` in `src/domain/audience.ts`, `notify`, `NOTIFICATION_COLUMNS` and
  `notificationStream` in `src/domain/notifications.ts`, `src/domain/notification-requests.ts`,
  `src/domain/notification-groups.ts`, `src/domain/push.ts`, `purgeRelationships` and `STATUS_CHILDREN` in
  `src/domain/inbox.ts`, migration `0020_notification_policies`; `test/notification-policy.test.ts`,
  `test/streaming/streaming.test.ts`, `test/policy-endpoints.test.ts`, `test/policy-writes.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`, `test/cascade-guard.test.ts`.

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
  `Authorization` header or the subprotocol, never from the URL (Mastodon also takes `access_token`; a query token
  alone answers 401 as none does). The subprotocol is a request header that the platform's invocation logs would
  record verbatim, so the shipped `observability` block turns them off and removes query strings from them (DATA-5).
  The Worker sends only the token's sha256 to the Store, which validates it (DATA-5). Each subscription
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
  `test/streaming-oracle.test.ts`, `test/stream-delete.test.ts`, `test/inbound-job-isolation.test.ts` (the capture
  kept when a first batch fails, none for a redelivered `Delete` whose job exists), `test/policy-bounds.test.ts`,
  `test/migrations.test.ts`, `test/cascade-guard.test.ts`; `test-node/layering.test.ts` is the inventory of the four
  capture sites. _Enforced (main):_ lists, direct and merged: `listStatus` in `src/domain/timelines.ts`,
  `streamedConversation`
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
  as Mastodon's. `streamAnnouncement` in `src/domain/stream-journal.ts`, `streamedAnnouncement` and
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
  `test-node/policy-boundary.test.ts`, `test/migrations.test.ts`. A remote quoting status's `Delete` ends its accepted
  quote in the `Delete`'s own transaction, with or without an authorization of Kopje's (an imported quote holds none),
  so it leaves its target's quotes list and count before the removal's batches (`retireQuoteOf` in
  `src/domain/quotes.ts`; `test/remote-delete-cleanup.test.ts`).

- **VIS-28: a quote is approved only by the quoted author, and a revoked approval never becomes valid again.** A quote
  is `accepted` only as a self-quote, by a remote stamp that passes every check (`completeQuote` in
  `src/domain/quotes.ts`), or, for a local quoted status, by Kopje's answer to a QuoteRequest, decided by R36
  (`mayQuoteSql`) in the inbox's final Store round and never by a verification round. Each transition into `accepted`
  draws a fresh 128-bit random authorization id; the id exists exactly while the quote is accepted (a CHECK), and every way out of `accepted` (a
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
  by its local author, as a retraction (FEP-044f "Handling a revocation"), an intent apart from the forward of a status
  whose uri the stamp's id equals (VIS-3): neither supersedes the other. No verification round ever decides a local
  quote. _Enforced (main):_ `recordLocalQuote`, `acceptOurQuote`, `rejectOurQuote` and `revokeStamp` in
  `src/domain/quotes.ts`, `preparePost` in `src/domain/statuses.ts`, migration `0039_quotes_local`;
  `test/quote-authoring.test.ts`.

- **VIS-29: admin views and actions disclose and change only through the admin account.** Only the OAuth admin, through
  a token covering the route's admin scope, reads or acts through `/api/v1/admin/*` and `/api/v2/admin/*` (R37, reserved
  for the admin API's rule). The OAuth admin is the one local account whose email matches `admin_email` by the sign-in's
  rule (AUTH-9); the match fails closed: no admin when `admin_email` is unset or empty, when no local account matches,
  when the match is suspended, or when two accounts match. It is checked in the transaction of each admin operation, so existing tokens follow the current
  match, and the role's permissions are exactly the route groups Kopje serves. No admin action targets the admin's own
  account; a suspension fences the account's tokens; every admin write is logged; and the OAuth admin never holds A5
  (AUTH-5). `ADMIN_PERMISSIONS` is 1080 (manage_reports, manage_users, manage_federation, view_dashboard); every other
  admin route answers as Mastodon answers a role without the permission.
  _Enforced (main):_ the match and the check: `oauthAdmin` and `adminAccountId` in `src/domain/admin-authority.ts`,
  `adminReadOperation` and `adminWriteOperation` in `src/domain/auth.ts`, setup's admin in `src/domain/setup.ts`;
  `test/admin-api.test.ts`, `test/setup-access.test.ts`. Reports (manage_reports): anyone but the OAuth admin is refused
  before a report is read, so not even its existence is disclosed; the admin sees every report with its accounts (local
  emails included) and only the statuses its reporter may still see (R37); every admin write, and every Access repair
  below, writes its moderation log row (`admin_actions`, actor, account and client or Access identity, newest 10,000
  kept) in its own transaction, read only through Access (`GET /admin/moderation-log`). `listAdminReports`,
  `getAdminReport`, `updateAdminReport` and `actOnReport` in `src/domain/reports.ts`, `adminAccountStream` in
  `src/domain/admin-account-presenter.ts`, `src/domain/moderation-log.ts`, migration `0029_admin_reports`;
  `test/admin-reports.test.ts`, `test/admin-api.test.ts`, `test/policy-bounds.test.ts`, `test/migrations.test.ts`.
  Accounts (manage_users): only the OAuth admin lists every account, local and remote, with each local account's email,
  shows one, and logs the actions that change nothing (`enable`, `unsilence`, `unsensitive`), while `approve` and
  `reject` are refused for every account. Each list reads a bounded set (the local accounts, at most 2,000 search
  candidates, or an id-ordered range) and answers 422 rather than an unordered or empty page. `listAdminAccounts`,
  `getAdminAccount` and `actOnAdminAccount` in `src/domain/admin-accounts.ts`, `src/mastodon/admin.ts`, migrations
  `0030_admin_accounts` and `0031_admin_accounts_available`; `test/admin-accounts.test.ts`,
  `test/policy-bounds.test.ts`, `test/migrations.test.ts`. Local suspension, self-protection and the credential epoch:
  the OAuth admin's `action` (`none`, which warns a local target (VIS-31) and resolves the report it names, and
  `suspend`) and `unsuspend`; `disable`, `sensitive` and `silence` answer 422, a `text` past 10,000 UTF-8 bytes or with
  a NUL 422, any non-blank `warning_preset_id` (Kopje has no presets) and an unknown report 404, each before any
  write, and any action on the admin's own account 403 (remote suspension is VIS-30's). Every warning stored is logged
  (`create AccountWarning`) in the action's transaction, before the report's resolution. A
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
  a delivery confirmed before the suspension committed may still be sent (VIS-30's boundary). The suspension also
  clears a pending or open profile link check, and the epoch fences out what a running round would record (NET-3), so
  an unsuspension resumes none. `actOnAccount` and
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
  `test/report-notifications.test.ts`, `test/policy-oracle.test.ts`, `test/migrations.test.ts`. The account action's
  parameters, refusals and log rows: `actOnAccount` in `src/domain/admin-accounts.ts`, `accountAction` in
  `src/mastodon/admin.ts`, `writeAccountWarning` in `src/domain/account-warnings.ts`; `test/admin-suspension.test.ts`
  ("account warnings"). Domain blocks and allows
  (manage_federation): the block API of VIS-30; domain allows list none, and their create answers 403 to everyone. The
  measures (view_dashboard) are counts, never rows: each served key's walk is bounded (docs/visibility.md, the admin
  measures) and answers 422 beyond its bound, never an undercount, and the keys Kopje does not serve answer 422
  (MD-2); dimensions and retention answer `[]`. Every caller gets the request's 400 and 422 that Mastodon answers
  before its policy, nothing else.
  `src/domain/admin-domain-blocks.ts`, `src/domain/admin-measures.ts`; `test/admin-domain-blocks.test.ts`,
  `test/admin-measures.test.ts`, `test/admin-measures-keys.test.ts`, `test/admin-measures-bounds.test.ts`,
  `test/admin-domain-blocks-replay.test.ts`.
  Announcements are the Access admin's (AUTH-5), never the OAuth admin's; each write logs its row in its own transaction
  (`test/admin-announcements.test.ts`, `test/cli.test.ts`).
  Trends reviews are the Access admin's too (`/admin/trends`, `kopje-admin trends`: AUTH-5), hashtags, statuses, links
  and publishers alike; through the Mastodon admin API the OAuth admin is shown the public trends and its approve and
  reject, and the link publishers' list and reviews, answer 403 (MD-2). Each review logs its row in its own transaction
  (a link as `PreviewCard`, a publisher as `PreviewCardProvider`; `test/admin-trends.test.ts`, `test/cli.test.ts`,
  `test/trends.test.ts`, `test/trend-links.test.ts`).
- **VIS-30: an instance-suspended account is shown to nobody and gets no new content.** An account the instance
  suspended (R38) is unavailable (R1) from the suspension's commit: shown to nobody (as any unavailable account), sent
  nothing but retractions (a forwarded `Delete` of a remote original it boosted among them, VIS-3), and its inbound
  activity is not applied but for its `Delete`, `DeleteActor`, `Undo` and
  `Reject`, after a routing refresh of its inbox from a verified document (fenced by its revision as any document,
  ID-1); no path refreshes its profile, keys or domain, or stores a status of it. Its follows of local accounts are
  severed in bounded, generation-bound rounds (R38), each accepted one with a withdrawing `Reject` to the follower's
  current inbox alone, as Mastodon sends it (a retraction, never refused, but not sent to the earlier receivers of what
  it withdraws); local follows of it are kept.
  An instance domain block of severity `suspend` (R38) covers a host by its longest matching block (a child `noop`
  exempts its subdomains), with at most `MAX_BLOCK_LABELS` (8) labels per stored block; a covered account (by its stored
  domain or its actor host) is unavailable from the block's commit, read live; nothing is fetched from a covered host
  (advisory: the writes refuse to store a covered account or its statuses, and refresh no covered row). The verdict for
  the first request after a Store answer that decided the fetch (`inboxGate`, a `receiveActivity` need) comes with
  that answer and is spent on that request alone; every other request, redirect hops included, reads it anew
  (`fetchPreparation` in `src/domain/inbox.ts`, `refusesHost` in `src/federation/federation.ts`;
  `test/signed-fetch.test.ts` "fetch preparations in the loaders", `test/inbox.test.ts` "Store calls on the inbox cold
  path"). Its inbound
  activity is ignored before any fetch but `Delete`, `DeleteActor`, `Undo` and `Reject` verified with a key already
  stored. A block's `reject_media`, whatever its severity, keeps media out of the remote media cache (MEDIA-7;
  [visibility.md](visibility.md), "Instance domain blocks"). It is judged by the account's stored domain only, as
  Mastodon's `reject_media?(account.domain)`, so a rule naming only the actor's host leaves that account's media
  cached, while suspend coverage judges both the stored domain and the actor host and refuses requests to a covered
  host at every hop. The OAuth admin creates, changes and deletes blocks through the Mastodon admin API (VIS-29). Each
  change into or out of `suspend` resets the domain job, whose bounded rounds mark the covered accounts and sever their
  follows both ways up to a frozen follow bound, and clear the marks a block no longer covers; the admin's `active` and
  `suspended` lists answer 503 while it runs (docs/visibility.md, "Instance domain blocks"). Each staged target records
  the recipients behind it (merged across followers, addressed accounts, silent recipients, poll voters and other
  statuses' reach before deduplication by inbox): up to 16 account ids, the hosts of their actor ids (none for a
  retraction staged in bounded steps, RES-6, which the check exempts), or `many` above 16, meaning "not all
  unavailable"; expansion copies them onto the delivery row. A row that is not a retraction (by its persisted
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
  REST::AccountSerializer does (`test/account-moved.test.ts`). _Enforced (main)._ Implementation, for accounts:
  `src/domain/remote-suspension.ts`, `actOnAccount` and `unsuspendAdminAccount` in `src/domain/admin-accounts.ts`,
  `availableSql` in `src/domain/audience.ts`, the gate in `receive` in `src/domain/inbox.ts`, `upsertRemoteActor` in
  `src/domain/remote-actors.ts`, `storeRemoteStatus` in `src/domain/remote-statuses.ts`, migration
  `0045_remote_suspension`; `test/remote-suspension.test.ts`, `test/remote-suspension-deliveries.test.ts`,
  `test/remote-suspension-inbound.test.ts`, `test/policy-oracle.test.ts` and `test/policy-writes.test.ts` (against
  `available` and `sends` in `test/policy-model.ts`). For the delivery part: `targetsOf`, `sendRefused`,
  `claimDeliveries` and `confirmDelivery` in `src/domain/deliveries.ts`, `recipientsFor` in `src/domain/audience.ts`,
  `deliveryRound` in `src/jobs/deliver.ts`, migration `0044_delivery_provenance`; `test/delivery-send-check.test.ts`,
  `test/policy-writes.test.ts` (provenance and the send-time rule against `sends` in `test/policy-model.ts`),
  `test/migrations.test.ts`. For domains: `src/domain/instance-domain-blocks.ts`, `hostCoveredSql` and `availableSql` in
  `src/domain/audience.ts`, the fetch policy in `src/federation/loader.ts`, the inbound path in
  `src/federation/inbound.ts`, the domain job in `src/domain/remote-suspension.ts`, the admin API in
  `src/domain/admin-domain-blocks.ts`, `mediaRejectedSql` in `src/domain/audience.ts` and `slotEligibleSql` in
  `src/domain/remote-media.ts` for `reject_media`, migration `0046_instance_domain_blocks`;
  `test/instance-domain-blocks.test.ts`, `test/remote-media-reject.test.ts`,
  `test/domain-job.test.ts`, `test/admin-domain-blocks-replay.test.ts`, `test/instance-domain-blocks-inbound.test.ts`,
  `test/read-windows.test.ts`, `test/policy-oracle.test.ts` (against `available` and `covered` in
  `test/policy-model.ts`).
- **VIS-31: an account warning is its target's alone.** A warning (R42, `account_warnings`, migration
  `0062_account_warnings`) is written by the OAuth admin's account action of type `none` (VIS-29) for a local target
  with `send_email_notification` set, with a `moderation_warning` notification written to the target and sent by the
  target in the same transaction (one per warning: `notifications_account_warning`, and the natural key with the
  warning, `0063_account_warning_notifications_key`). It is read only through that notification, by its recipient, in
  v1, v2 and streaming alike: R15 (`shownSql`) shows it only when it is sent by its recipient and names a warning of
  that recipient, by the warning's key, and the presenter checks both again, so a restored notification linked to
  another account's warning, or to none, is in no read or count. R15 writes none for a target unavailable at the action
  (the warning is kept unnotified) and hides it while the target is unavailable. No other read, the admin API included,
  exposes a warning, as in Mastodon, where strikes are shown only in its web pages. Its `status_ids` are ids copied from
  the report the admin named, which may name statuses the target cannot see (an accepted, admin-directed disclosure of
  ids, no content, as in Mastodon); a copy the stored bound would refuse is dropped to `NULL`. The text is plain text,
  never rendered as HTML. Clearing or dismissing the notification leaves the warning, which nothing reads afterwards.
  Bounds: the text at most 10,000 UTF-8 bytes with no NUL, and `status_ids` NULL or at most 100 18-digit ids in
  2,101 bytes, held by CHECKs and triggers for imports too (RES-2); the presenter reads one row by key per notification
  and reuses the presented sender for `target_account` (RES-7). _Enforced (main):_ `src/domain/account-warnings.ts`,
  `warningOf` in `src/domain/notifications.ts`, the groups in `src/domain/notification-groups.ts`, `shownSql` in
  `src/domain/audience.ts`, `storedWarningText` and `storedWarningStatusIds` in `src/platform/stored-bounds.ts`,
  migrations `0062_account_warnings` and `0063_account_warning_notifications_key`; `test/moderation-warnings.test.ts`,
  `test/admin-suspension.test.ts`, `test/migrations.test.ts`, `test/policy-oracle.test.ts` (against `shown` in
  `test/policy-model.ts`), `test-node/policy-boundary.test.ts`, `test/status-bounds.test.ts` (the table of maxima),
  `test/account-warning-dump.test.ts`.

- **VIS-32: a link card is fetched and held only for a public or unlisted original.** A status's card (R43,
  `status_cards`, migration `0067_status_cards`) is enqueued, claimed and recorded only while `cardEligibleSql` holds
  (an original, public or unlisted, by an available author, with no shown attachment and no quote), so no private,
  direct or limited status's link is ever requested (Mastodon fetches every visibility: docs/mastodon-deviations.md,
  "Link previews"). The one place a stored status becomes ineligible by visibility, the hide step of a remote delete,
  deletes its row in the same step; edits never change a visibility. The linked site learns that the instance holds a
  public status naming it, as a reader of that status would. A card is presented only on a public or unlisted status,
  whatever a row holds (an import's), never on a boost's own row or a quoted status, and with each text and URL judged
  as decoded (`presentCard` in `src/domain/status-presenter.ts`). _Enforced (main):_ `cardEligibleSql` in
  `src/domain/audience.ts`, `src/domain/link-cards.ts`, `deleteStatusBatch` in `src/domain/inbox.ts`;
  `test/link-cards.test.ts` ("enqueues public and unlisted posts only, and resets on a text edit", "enqueues a remote
  status on creation, resets it on a significant update only, never a private one", "deletes the card with the hide
  when %i rows are left", "shows no card on a status that is not public or unlisted, even from an imported row"),
  `test/policy-oracle.test.ts` (against `cardEligible` in `test/policy-model.ts`),
  `test-node/policy-boundary.test.ts`.

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
  - Every authorization answer goes in the query, whatever `response_mode` says (`docs/mastodon-deviations.md`,
    OAuth); `test/oauth.test.ts` ("response_mode and lang").
  - Token info and introspection (RFC 7662) answer only from `authorize()`, read no parameter from the URL, and
    never say why a token is inactive. Introspection requires client authentication, which sees only that client's
    tokens, or a valid bearer token, which sees only other tokens of its own client and never itself; `inspectToken`
    and `introspectToken` in `src/domain/oauth.ts`; `test/oauth.test.ts` ("token info", "introspect").
- **AUTH-4: Access JWTs are verified with jose.** RS256 only; issuer, audience and `exp` required; at most 60 s clock
  tolerance; a fetched key set used for at most 7 days. Sign-in requires an email claim. _Enforced (main):_
  `src/security/access-jwt.ts`; `test/oauth.test.ts` ("Access assertion").
- **AUTH-5: admin authority comes only from the target's own configuration.** _Enforced (main):_
  `src/app/admin.ts`, `src/platform/store-admin.ts`, `src/platform/access-settings.ts`; `test/ops-authority.test.ts`,
  `test/admin.test.ts`, `test/dump-import.test.ts`. - Configuration is every name `/admin/config` accepts: `domain`,
  `access_aud`, `access_team_domain`, `access_admin_aud`, `admin_email`, `access_service_token_client_id`. A verified
  import restores the target's values exactly; an imported value never replaces them and an absent name stays absent. -
  An admin is an identity whose email matches the configured `admin_email` by the sign-in's rule (AUTH-9), or a
  service token with no email, `sub === ""` and `common_name` equal to the configured client id. - `IMPORT_TOKEN` only
  begins an import into an empty Store without usable admin access, or configures the Store while admin access is not
  usable. The Store checks this, not only the Worker. - A token import continues only with the one-time session
  credential `begin` returned; the Store keeps its SHA-256 only. An unverified token import idle for 15 minutes may be
  reset with `IMPORT_TOKEN`; an Access import never. In the cutover the token only configures the Store (domain and Access values) and is deleted before the import, which runs through Access; it
  begins one import into an empty Store and nothing after it (`test/cutover-token.test.ts`). - Secrets are compared as
  fixed-size SHA-256 digests, in time independent of their contents and lengths: `constantTimeEqual` in
  `src/security/tokens.ts` and `sessionMatches` in `src/platform/store-admin.ts`; `test/ops-authority.test.ts`
  ("constantTimeEqual"). - The OAuth admin of the Mastodon admin API (VIS-29) is not an admin here: it never
  holds an `ImportAuthority`, and `/api/v1/admin/*` is outside the Access application's `/admin` path. Its diagnostic
  state (why there is or is not an OAuth admin, and a suspended match's username) is shown only to Access, as
  `oauthAdmin` in `GET /admin/health`. _Enforced (main):_ `src/app/admin.ts`; `test/admin-api.test.ts`
  ("GET /admin/health: oauthAdmin"). Which account it is, while it is one, is public, as Mastodon shows it: that
  account's `roles` holds the Owner's badge (id, name and color, no permissions) wherever it is presented, and every
  other local account's holds none (`presentAccount` in `src/domain/accounts.ts`, read once per operation through
  `adminAccountIdOnce`; `test/account-entity-fields.test.ts`). The instance's contact account is configured apart and
  need not be it. The operations that repair the OAuth admin, setting an account's email and unsuspending an account,
  are Access-only. _Enforced (main)_ for setting an email (`POST /admin/accounts/email`, `setAccountEmail` in
  `src/domain/admin-accounts.ts`, checked with `accessAdminRefusal` in its transaction, refusing an email that another
  local account's matches by that rule;
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
  Account invitations (`/admin/invitations`, `kopje-admin invitation`: list, add, remove) are the same: Access-only,
  checked with `accessAdminRefusal` in the Store transaction and logged with the Access identity (`AccountInvitation`
  targets); the import token and import sessions never reach them. They are data, not configuration: a dump carries
  them and an import replaces them (AUTH-9); `src/domain/account-invitations.ts`; `test/account-invitations.test.ts`
  ("refuses every authority but the Access admin, writing nothing"), `test/cli.test.ts`.
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
  before publication"). _Enforced (main)_ for a status's app: the app a post records is the validated credential's
  client (a scheduled status's, taken when it was scheduled), never a field of the body (`postStatus` in
  `src/domain/scheduled-statuses.ts`; `test/statuses.test.ts` ("ignores an application or application_id the request
  sends")).
- **AUTH-7: opaque credentials are unguessable and stored as digests.** Client ids and secrets, codes and access tokens
  are 32 random bytes. Codes and access tokens are stored and looked up only by their full SHA-256, at token info and
  introspection too, so a lookup reveals no prefix; a hit and a miss do not take the same time, and what keeps a token
  from being found by trying is its entropy, not the client authentication (app registration is anonymous).
  _Enforced (main):_ `src/security/tokens.ts`, `src/domain/oauth.ts`; `test/oauth.test.ts` ("stores only digests of
  tokens and codes").
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
  and one account form a family: a new session deletes the family's live one and every session the browser presented,
  and a session of another account, or a family that records no account, ends the family and starts its own, so a
  retired session cannot sign it out; sign-out deletes the presented and the live session and ends the family, so a
  sign-in started before it installs nothing.
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
  "signs out the other sessions only", "lists the authorized apps and revokes one"). The remote-interaction follow:
  _Enforced (main):_ the web client's scopes include `write:follows`; a session issued without it signs in again
  rather than gaining it, keeping its cookie through the sign-in so the callback retires it as it replaces it (the
  old token then fails as a cookie and as a bearer token); a session that is gone is dropped. `WEB_SCOPES` in
  `src/domain/web-session.ts`, `src/app/interaction.tsx`; `test/interaction.test.ts` ("sends a session without
  write:follows to sign in again before fetching anything, and retires it", "starts a family of its own when the
  upgrade signs in another account", "never reuses a family recorded without its account", "drops a revoked, expired
  or suspended session", "sends a session without write:follows, or none, to sign in and back to the look-up").
- **AUTH-9: an account is made only by setup or by its invited identity's own sign-in.** Registration through the API
  stays closed (MD-1), and passing the sign-in application's Access policy makes no account. The Access admin invites an
  email with a username (at most 10 pending; an email or username a local account or another invitation has is refused).
  Every stage that matches an email uses the sign-in's one rule, SQLite's `lower()` (ASCII case only, no trim;
  `loginEmailMatchSql` in SQL and `sameLoginEmail` in code, both in `src/platform/login-email.ts`): the sign-in, the
  invitations, the OAuth admin's match and set-email (VIS-29), the Access admin (AUTH-5) and setup's admin email checks.
  A Unicode case variant is another email, and the account takes the invitation's email. An identity that two local
  accounts match (`local_accounts.email` is unique only byte for byte, so an import can hold emails that differ in ASCII
  case) signs in to neither. The approval `POST /oauth/authorize` of an identity with no account, after the Access
  assertion (AUTH-4) and the `Origin` (WEB-1) are verified, reads the identity's account or invitation in one Store
  read, makes the key pair, and makes the account in one Store transaction that checks again that the identity has no
  account and exactly one invitation and that the username is free, then removes the invitation; the consent page writes
  nothing. Making an account is a write: under the env's `MAINTENANCE` (which the Store does not see) it is refused
  before the key is made, and under the Store's own flag where it writes (OPS-1, the maximum of both), while existing
  accounts still sign in. An identity that has an account by the read or by that transaction (an overlapping first
  sign-in) is signed in to it: one identity makes one account. The account is made by the same code as the setup's admin
  (`insertLocalAccount`). _Enforced (main):_ `src/app/authorize.tsx`, `createInvitedAccount` in
  `src/domain/account-invitations.ts`, `insertLocalAccount` in `src/domain/setup.ts`; `test/account-invitations.test.ts`
  ("refuses an identity without an invitation, and keeps registration through the API closed", "refuses an invited email
  without a valid Access assertion, making nothing", "refuses a decision posted from another origin, making nothing
  (WEB-1)", "refuses, writing nothing, when a local account took the username after the invitation", "makes one account
  when two first sign-ins of the same identity overlap", "matches an email by ASCII case only, as the login does, and
  gives the account the invitation’s spelling", "signs in to the account another first sign-in made after its code found
  none", "makes no account under maintenance, from the env or the Store, while an existing account signs in", "rolls the
  whole account back when its last write fails, and works on the next sign-in"); `test/login-email.test.ts`,
  `test/oauth.test.ts` ("refuses an identity that two local accounts match, picking neither"). An invitation in a
  restored dump is honoured like one the admin added; the dump could add a local account with any email anyway (R8), and
  the person must still pass Access.

### Web (WEB)

- **WEB-1: the consent decision cannot be forged cross-site.** Both methods of `/oauth/authorize` answer only on the
  instance domain, read from the Store with the Access settings and compared with the request URL's host (no header is
  read; setup and `/admin/config` store the domain as one canonical host, [dump-format.md](dump-format.md)): on any
  other host the Worker answers on (its workers.dev address, another route, a port) they show a 403 page, with no
  redirect to the client, before the Access assertion is verified, so the consent page names the instance domain and the
  instance origin is the request's. `GET /oauth/authorize` issues nothing. The `POST` requires a valid Access identity,
  an `Origin` equal to the instance origin (missing, `null` or foreign answers 403), and `decision=approve`; the Store
  revalidates client, redirect URI, scopes and account when it writes the code. _Enforced (main):_
  `src/app/authorize.tsx`, `authorizeContext` and `issueCode` in `src/domain/oauth.ts`, `normalizeDomain` in `setConfig`
  (`src/platform/store-admin.ts`); `test/oauth.test.ts` ("shows the consent page on the instance domain only, before
  verifying Access (WEB-1)", "refuses a decision posted on another host, issuing nothing (WEB-1)", "judges the host by
  the request URL, never by a Host header (WEB-1)", "shows the consent page when the domain was configured by hand in
  another spelling (WEB-1)", "refuses a decision posted from another origin, a null origin or none (WEB-1)", "refuses an
  account suspended between the consent page and approval"), `test/ops-authority.test.ts` ("stores the domain as setup
  does, lowercase and IDNA to ASCII, and refuses a value that is not a domain").
- **WEB-2: Kopje's HTML pages cannot be framed, scripted or cached.** The consent and code pages and the messages of
  `/oauth/authorize` send the private pages' headers (`PRIVATE_HEADERS`, the web UI pages' policy below), and render
  every value escaped. The consent page alone has no `form-action` (`CONSENT_HEADERS`), as Mastodon's authorization
  pages have none: browsers check `form-action` on every redirect of a form submission, and the decision's 302 to the
  app's redirect URI may lead on to origins and schemes Kopje cannot know. A missing `form-action` cannot be used to
  post elsewhere: the page holds only Kopje's own form, which posts to this origin, no script and no user HTML.
  _Enforced (main):_ `src/app/authorize.tsx`, `src/app/web-headers.ts`, `src/web/pages/oauth.tsx`;
  `test/oauth-pages.test.ts` (every header asserted; "send the consent page without form-action, its form carrying the
  verified redirect URI"), `browser/pages.spec.ts` ("consent: approving follows the app's redirect on to …", and the
  control "consent: under form-action self, the redirect to the app is blocked"), `test/oauth.test.ts` ("logs in through
  Access and calls the API with the token", escaping).
  The error pages a browser's page request gets for 404, 500 and 503 (`src/app/error-pages.tsx`, chosen in
  `src/app/negotiation.ts`): the public pages' headers for 404, the private pages' with `Vary: Accept` for 500 and 503;
  only page routes and paths outside the document namespaces negotiate; `test/error-pages.test.ts`. Web UI pages:
  _Enforced (main):_ a CSP of `default-src 'none'` with only `style-src 'self'` (the stylesheet is a static asset),
  `img-src 'self' https:`, `form-action 'self'` (none on the consent page, above), `base-uri 'none'` and
  `frame-ancestors 'none'` (no script source at all), `X-Frame-Options: DENY`; pages of a signed-in user and the
  sign-in flow send `Cache-Control: no-store` and `Referrer-Policy: same-origin`; public pages may be kept 60 s and vary
  with `Accept`. Public pages, with the L1 bundle or without, and the embed add `media-src 'self' https:`, so a post's
  video and audio play inline from where their images load; they ask for nothing before they are played
  (`preload="none"`, no autoplay), and no other page's CSP has `media-src` (`/authorize_interaction` shows a found
  post's video and audio as links). `src/app/web-headers.ts`; `test/web-pages.test.ts` ("sends a CSP naming only the
  L1 bundle … and none on the others"), `test/web-session.test.ts` ("is never cached, framed or opened to other
  origins"), `test/web-read-seam.test.ts` ("preloads the fingerprinted stylesheet each page links, and keeps the CSP
  and caching"). The one exception is the embed page, `/@username/:id/embed`, which oEmbed names for other sites to
  frame, as Mastodon's: it sends neither `frame-ancestors` nor `X-Frame-Options`, its CSP allows exactly one script
  (`script-src` naming `/assets/embed-status.js`, which only answers the embedding page's height request), and it may be
  kept 180 s. It shows only the status its status page shows (VIS-4), has no form and no signed-in state, and links open
  outside the frame; its 404 is the ordinary framing-denied page. `src/app/public-pages.tsx`; `test/oembed.test.ts`
  ("may be framed by any site", "leaves every other page unframable"). `/setup`: _Enforced (main):_ the same CSP,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control: no-store` on every page. Not
  `no-referrer`: under it browsers post a same-origin form with `Origin: null`, which WEB-1's Origin check refuses;
  `same-origin` still sends no referrer to other origins; `src/app/setup.tsx`; `test/setup.test.ts` ("WEB-2, WEB-3,
  WEB-5: is never cached, framed, scripted or opened to other origins"). Remote interaction: _Enforced (main):_
  `/authorize_interaction` uses the web UI's script-free CSP and sends `Cache-Control: no-store` on its form, result and
  POST responses, signed in or not. `src/app/interaction.tsx`; `test/interaction.test.ts` ("renders the look-up form,
  prefilled and with the session’s token", "refuses a missing, null or foreign Origin and a missing or wrong token,
  writing and fetching nothing"). Public pages that load the L1 bundle ([web-pages.md](web-pages.md)): _Enforced
  (main):_ the profile tabs, the status page's tabs and the hashtag page link one deferred script, and their CSP adds
  exactly `script-src` with that file's URL (never `'self'`, inline or `unsafe-*`) and `require-trusted-types-for
  'script'; trusted-types 'none'`; the page's `<script>` and its CSP come from the same build value (`L1_SCRIPT`), set
  together by one route helper. The bundle writes no HTML, script or script URL, and is served directly (no redirect) as
  JavaScript with `nosniff`. Their 404 and 410 pages and every other page keep the script-free CSP.
  `src/app/web-headers.ts`, `src/app/public-pages.tsx`, `scripts/build-assets.mjs`; `test/web-pages.test.ts` ("sends a
  CSP naming only the L1 bundle"), `test/web-interaction-tabs.test.ts` ("mark a page with a cursor noindex, follow, with
  the tab’s cursor-less URL canonical, and load the L1 bundle"), `test-node/client-assets.test.ts` ("is committed as the
  bytes a rebuild gives"), `test-node/stylesheet.test.ts` ("serves the fingerprinted assets as immutable"). The copy
  control: _Enforced (main):_ every public page reads, links and submits its forms without script, and the bundle's one
  control is the copy button of a handle, a status URL or embed code ([web-pages.md](web-pages.md)): rendered `hidden`
  with its value and its result texts in `data-*` attributes from the catalogue, shown by the bundle only where the
  Clipboard API exists, it calls `navigator.clipboard.writeText` and writes the result into its field's `role="status"`
  element as text (`textContent`), so the bundle holds no UI text, fetches nothing and needs no Trusted Types policy.
  The handoff pages (WEB-4) are script-free, so their copy button stays hidden. Its other DOM writes are the local times
  (`src/client/local-time.ts`: elements, text and `title` built with `createElement` and `textContent`, no HTML sink)
  and focus: when a dialog opened from a closed popover closes, it focuses the popover's trigger (`focus()` only;
  `src/client/dialogs.ts`, browser job). `src/client/copy.ts`, `src/web/components/remote.tsx`; `test-node/copy.test.ts`
  ("shows each control and copies its value, writing the page’s result text, again on every click", "writes the page’s
  failure text when the clipboard refuses", "leaves the controls hidden without the Clipboard API, and a control without
  a status element"), `test-node/client-assets.test.ts` ("holds no UI text of the catalogue"), and the browser job under
  the production CSP.
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
  another origin, a null origin or none"). `/authorize_interaction`: _Enforced (main):_ a GET fetches,
  stores and follows nothing, signed in or not. The look-up and the follow are POSTs checked as above (a foreign
  `Origin` before the body is read). A session that is gone or lacks `write:follows`, or a Store that refuses writes
  (503), is refused before anything is fetched, and judged again after the fetch in the transaction that stores it.
  Resolution goes through the resolver and the outbound loader (ID-2, NET-1, NET-3, VIS-30), and what it shows
  follows VIS-4. The target is kept across sign-in in the server-side attempt, never in the return path, and every
  redirect stays local. Following goes through the follow service; replies, favourites and boosts stay in clients.
  `src/app/interaction.tsx`, `src/domain/interaction.ts`, `src/domain/web-session.ts`, `src/app/web.tsx`;
  `test/interaction.test.ts` ("renders the look-up form", "keeps a URL target with an encoded slash through sign-in",
  "stores no target that is not a bounded URL or address", "refuses a missing, null or foreign Origin and a missing or
  wrong token, writing and fetching nothing", "refuses a missing, null or foreign Origin and a missing or wrong token,
  writing and waking nothing", "refuses a session revoked while the target was fetched", "refuses a session that expires
  while the target is fetched", "answers 503 before any fetch while the Store refuses writes", "answers the Origin
  before reading the body", "keeps an encoded-slash target through a cancelled sign-in", "finds this instance’s accounts
  and posts by address, profile URL and permalink", "tells apart followed, already requested, refused and not found").
  Following from the viewer's server: _Enforced (main):_ the follow and interact dialogs on a profile or status page
  hold a same-origin GET form to its handoff page (`/@user/interact`, `/@user/:id/interact`), which answers 200: a page
  that names the destination host and links to `https://<host>/authorize_interaction?uri=<target>`, never a redirect
  to that host. The host must be a DNS name of at least two LDH labels, at most 253 ASCII octets after IDNA and 63 in
  each label, with no IP literal, credentials, port, path, query or fragment (`serverDomain` in
  `src/platform/domain-name.ts`); anything else answers 400 with the form again, the same bytes whatever was given. The
  target is read as its page reads it, so anything an anonymous viewer may not see, a suspended account included, is
  the ordinary 404 (VIS-4): the account's ActivityPub actor URI for following, the status's URI for interaction,
  percent-encoded as the `uri` value. The page reads no session, fetches, stores and signs in nothing, is script-free
  with the web UI's CSP (`form-action 'self'` stays), and sends `Cache-Control: private, no-cache`: no shared cache
  keeps it, and the browser revalidates it but may keep it for its back button. It still shows the address to search
  for, for servers whose interaction path is another. `src/app/public-pages.tsx`, `src/domain/web-pages/interact.ts`,
  `src/web/pages/handoff.tsx`; `test/web-handoff.test.ts` ("render the dialog’s form without a server: script-free,
  never kept by a shared cache", "link to the server’s /authorize_interaction with the read’s actor or status URI,
  writing and fetching nothing", "refuse every server that is not a bounded DNS name with the same 400 bytes, showing
  nothing given", "answer the ordinary 404 for every target its page would not show, a suspended account’s included",
  "read no session: the same answer with and without one").
- **WEB-5: responses declare their type.** API and federation responses carry their exact JSON media type and
  `X-Content-Type-Options: nosniff`. _Enforced (main):_ one middleware sets `nosniff`
  on every response (API, federation, inbox, media, errors and maintenance answers), and API and federation bodies
  are written by Hono's `c.json` and Fedify with their JSON types; `src/app/app.ts`; `test/inbox-statuses.test.ts`
  ("WEB-5: responses declare their type").
  Web UI pages: _Enforced (main):_ `text/html; charset=UTF-8` and `nosniff` on every page and error page; static
  assets get `nosniff` from `public/_headers`;
  `test/web-pages.test.ts`, `test/web-session.test.ts`, `test/error-pages.test.ts`, `test-node/stylesheet.test.ts`.

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
  signals. _Enforced (main):_ `src/federation/loader.ts`; `test/loader.test.ts`. Every global `fetch()` (documents,
  deliveries, Web Push, backups, the Access and Cloudflare APIs) is also strictly public: the compatibility flag
  `global_fetch_strictly_public` routes it through Cloudflare's front door like a request from the Internet, so a host
  in the instance's own zone gets the Workers and security settings of its route instead of reaching the zone's origin
  directly, a routing the host and DNS checks cannot see (Cloudflare docs, Compatibility flags, "Global fetch()
  strictly public"). Durable Object stub and in-process `app.fetch` calls are not global fetches. _Enforced (main):_
  the flag in `wrangler.jsonc` and `/deploy/wrangler.jsonc`; `test-node/wrangler-configs.test.ts` ("shipped Kopje
  Worker configs"). A running Worker without the flag fails the health report's `runtime` check (`src/app/health.ts`);
  `test/health-runtime.test.ts` ("runtime check in healthReport").
- **NET-2: deliveries reach only the audience's inboxes.** Inboxes come from the stored audience and are deduplicated by
  shared inbox; an activity without `to` (a Like, Follow, Accept, Reject, Block or their Undo, each naming its recipient
  through its object) goes to the recipient's shared inbox when it has one, and moves to its distinct personal inbox on
  the same origin (same lane, within the row's attempts) if the shared inbox answers 404, 405 or 410; targets pass
  NET-3; a non-public activity is never sent to a redirect target. Claims serialize each lane; the POST timeout (30 s)
  is shorter than the lease (60 s), and completion requires the current lease token, so a stale completion cannot settle
  a later claim. A lane is `(actor, inbox origin)`: everything an actor sends one server, to shared and personal inboxes
  alike, arrives in order, so a later `Update` or `Delete` cannot overtake the `Create`. A forwarded `Delete` (VIS-3) is
  one intent per local booster, signed by it in its own lanes, never by one booster for another's audience; its
  shared-inbox fallback moves a row in place, keeping its place in the lane, for a single recipient behind the inbox
  only. The whole path from claim to POST (key loading, DNS, signing, the POST) runs under one absolute deadline, the
  earlier of 30 s and 10 s before the lease ends; the clock is checked against it after the key is loaded and right
  before the POST, so a late timer cannot let a POST through. _Enforced (main):_
  `src/domain/deliveries.ts` (expansion, lanes, claims, completions), `src/federation/delivery.ts` (the POST);
  `test/deliveries.test.ts` ("NET-2: delivers a public status once per shared inbox", "NET-2: a recipient outside the
  audience gets nothing", "NET-2: an expired lease is claimed again", "moves a Follow and its Undo to the personal
  inbox once when the shared inbox answers 404"), `test/delivery-post.test.ts` ("NET-2: never
  follows a redirect", "NET-2: times out the POST before the lease ends"), `test/delivery-regressions.test.ts` ("keeps a
  Create to a server's shared inbox ahead of an Update", "counts slow DNS and slow key loading against the budget",
  "refuses to send once the lease budget has run out"). A remote `Follow` cancels, in its receive transaction, every
  `Accept` and `Reject` of its pair that is not leased (queued, pending a retry or given up, whether or not a claim
  took it before: a pending row's attempt has completed) or that is still unexpanded, for interoperability with
  servers that match answers by account pair (Mastodon 4.5's `Accept` and `Reject` fall back to the pair; Misskey
  2026.10.0 resolves a `Reject` to the pair's request and following, ignoring the `Follow` id): the follower's server
  gets only the new generation's answer. A leased answer is kept and holds its lane, so the new answer waits behind
  it when both share that lane (an answer to a follower whose inbox origin has changed since is in another lane, and
  is not held); its intent is superseded, and from then on it gets no further attempt and no failure backoff, the
  decision reading only `follow_pair` and `superseded`, never the activity's JSON: the claim after its lease expires,
  its confirmation and a failed completion (transient, permanent, the personal-inbox fallback, the last attempt)
  delete it and promote the lane instead of leasing, sending, retrying or giving it up. The same holds
  for an `Accept` that a block's withdrawing `Reject` superseded. Only a POST whose confirmation was granted before
  the `Follow` committed still goes (see the accepted risks); `kopje.delivery.stale_follow_answer` records each answer
  caught and each such one delivered (`sent_in_flight`), by type and step only (DATA-5). A `Follow` the target
  refuses because it blocks the follower records its `Reject` and cancels nothing. `cancelFollowAnswers` and
  `STALE_ANSWER` in `src/domain/deliveries.ts`; `test/follow-answers.test.ts` (each renewal path; "a renewal cancels
  every answer of the pair that is not leased, claimed before or not"; "a superseded answer under lease gets no
  further attempt"; "a superseded imported answer without an activity type gets no further attempt"; "the
  follow-answer check leaves other superseded activities alone"; both serialized orders against a claim and an
  expansion, and a POST held in flight), `test/follow-lifecycle.test.ts` (claims, confirmations and completions as
  separate generated steps, stale attempts and stale answers among them, and an answer in flight applied to the next
  generation).
- **NET-3: every outbound sink has its own policy.** Any URL derived from remote or user input is fetched only through a
  sink client that applies NET-1's host rules (https, public address, re-checked hops, a hop limit) plus its own budget:
  documents as NET-1; remote media unsigned, at most 3 redirects to any origin, never the instance's own host, a size
  cap per kind, positively recognized types and 30 s; web pages unsigned, at most 3 redirects to any origin, a 1 MiB
  prefix and 10 s; Web Push and deliveries no redirects.
  Credentials and signatures never follow a redirect to another origin. Fedify's sending and queueing are not used.
  _Enforced (main)_ for documents and the Fedify rule: `test-node/fedify-usage.test.ts` ("never sends or queues through
  Fedify"). Deliveries: _Enforced (main):_ `assertPublicShape` and the DNS check before every
  POST, no redirects, 30 s (`postActivity` in `src/federation/delivery.ts`); `test/delivery-post.test.ts` ("NET-3:
  refuses inboxes that fail the public-host rules"). Web Push: _Enforced (main):_ the same sink before every POST
  (`sendPush` in `src/jobs/push.ts`), and the rules that need no lookup at registration (`publicShapeRefusal` in
  `src/platform/http-url.ts`, shared with `assertPublicShape`); `test/push.test.ts` ("NET-3: refuses endpoints that are
  not public https URLs"), `test/push-send.test.ts` ("PUSH-2: the endpoint is an outbound sink at every send", "never
  follows a redirect, and retries instead"). Web pages (for link verification and link cards):
  _Enforced (main):_ `fetchWebPage` and `probeRedirect` in `src/federation/web-page.ts`. Every hop, the HEAD probe's
  included, passes the URL rules (https, the default port, no credentials, literal IP, local, single-label or
  trailing-dot host, at most 2,048 characters), the domain policy and the DNS check before its request; the request
  carries only accept, user-agent and a bounded accept-language, with redirect `manual`. A call is bounded by a
  deadline (10 s GET, 5 s HEAD) checked after every await, per-call ceilings (12 subrequests and 4 Store calls for a
  GET, 3 and 1 for a HEAD) and a caller's shared budget, charged before each step and never refunded. Only a 200
  `text/html` or `application/xhtml+xml` body whose Content-Encoding workerd decodes (absent, `identity`, exactly
  `gzip` or `br`) is read, as a 1 MiB prefix after decoding (`readBodyPrefix` in `src/platform/body.ts`), and scanned
  by `src/platform/html-scan.ts` within fixed output caps (698,432 UTF-16 code units); a failure names a closed kind
  and the hostname only, with nothing partial. `test/web-page.test.ts` ("NET-3: refuses web page URLs that fail the
  public-host rules before any request", "NET-3: reads the domain policy and the DNS check before every hop, the HEAD
  probe included", "NET-3: follows at most 3 redirects across origins, each hop re-checked and charged", "NET-3: never
  requests a redirect target that is not public https", "NET-3: sends only the allowlisted headers and never lets
  fetch follow", "NET-3: counts decoded bytes, stops past the cap and cancels the body", "NET-3: ends the whole call at
  its deadline, a stalled DNS check or body included", "NET-3: a domain-policy answer after the deadline starts
  nothing", "NET-3: charges DNS lookups, requests and Store calls against a shared budget without overspending",
  "NET-3: the HEAD probe never follows and returns the raw Location whatever the status", "NET-3: scans only 200
  text/html or application/xhtml+xml and cancels other bodies", "NET-3: an unparsable page is a failure with no
  partial scan", "NET-3: a scan still pumping at the deadline returns timeout, publishes no scan and stops", "NET-3:
  failures carry the host only"), `test/web-page-encoding.test.ts` ("NET-3: decodes compressed bodies through
  workerd's fetch path and cancels them at the cap"), `test/html-scan.test.ts` ("never finds a rel=me the
  scripting-off parser does not", "refuses the counterexample", "collects no rel=me after a noscript start tag",
  "collects no rel=me after a select start tag", "collects no rel=me after an svg or math start tag"),
  `test/html-rewriter-facts.test.ts` (the HTMLRewriter facts the scan rests on). A rel=me candidate has the token
  "me" among all its rel tokens, ASCII case-insensitively, as Mastodon's `NokogiriHandler.link_rel_include` downcases
  both; a rel past 2,048 decoded characters is not tokenized and no rel=me at or after it is collected, so a later
  anchor never stands first where Mastodon finds an earlier one (`test/html-scan.test.ts` ("finds the token me past
  the first relTokens tokens of a rel", "collects no rel=me at or after a rel past REL_CHARS")); `links[].rel` is
  lowercased for card extraction. The DNS check does not pin the address the request connects to: protection against
  DNS rebinding rests on production `deps.fetch` being the Worker's global fetch, never a service binding, which NET-1
  makes strictly public. Each caller's differences from Mastodon's parser are listed in docs/mastodon-deviations.md.
  Local profile link verification (`src/federation/field-links.ts`) runs only from the cron, one claimed account a
  round, within the budgets and deadlines RES-6 states; its scan collects rel=me hrefs, the title and lang only, and
  its logs carry the failure kind and the hostname only. Its hops are admitted as status cards' are (below,
  `webHopRefused` before and after each DNS check, the GET's hops and the HEAD's alike); a policy read that fails at
  either point leaves the value unchecked, checked again after the claim's hold, with no value the claim checked. Its
  records and finish are writes fenced by the claim token, the credential epoch and availability, so a suspension or the
  Store's maintenance during a round lets nothing be stamped; a request already under way for the claimed account may
  still be sent (Mastodon does not fence it either). `test/field-links.test.ts`
  ("refuses hosts and redirects the sink refuses before any request, and logs the host only", "never contacts a host
  the domain policy refuses", "sends no HEAD when the first rel=me href is %s", "stamps nothing for an account suspended
  during a GET, nor once it is unsuspended", "retries a round the Store refused during a GET once its hold ends",
  "discards a late record and finish from an older claim", "starts no request and follows no redirect once
  maintenance is entered during a DNS check", "leaves a value unchecked when a policy RPC fails %s the DNS check").
  The same round serves remote accounts' fields (`src/domain/remote-field-links.ts`) after local accounts: up to 4
  hrefs a remote actor's document chose (attacker-chosen URLs, under the same sink, budgets and hop admission), checked
  against the account's profile URL or actor id, and the round's User-Agent names the instance's origin. Their records
  and finish are writes fenced by the claim token, an open claim, the row's generation (drawn fresh on every insert and
  bumped by every change of the links or the link back, so a claim made before an actor update, a deletion or a
  recreation records nothing) and availability now (R1: suspension, deletion and domain coverage), so a suspension
  needs no write of its own (`test/remote-field-link-rounds.test.ts` ("refuses an old claim’s record and finish once
  the candidates were removed and the row recreated", "records nothing after %s during a GET, and stops the round",
  "leaves a value whose policy read failed unchecked, and checks it after the hold")).
  Status cards (`src/federation/link-cards.ts`, R43) also run only from the cron, at most 6 claims a round, 3 at a time,
  each in at most two GET chains (the page then the oEmbed endpoint it declares, or a host's cached endpoint then the
  page),
  within the budgets and deadlines RES-6 states. A claim's URL that the sink's rules refuse (a port, a literal IP, a
  local name) is no card before any network or cache step. An endpoint is fetched by the sink's JSON mode
  (`fetchWebJson`: the same hops, redirects, deadline and ceilings, only the User-Agent sent, a 200 of any content type
  read whole within 64 KiB after decoding and refused past it unparsed, fatal UTF-8, `JSON.parse` and the JSON caps of
  RES-2); a discovered endpoint is resolved against the page, upgraded from http to https, and not tried when the
  sink's URL rules refuse it; a cached template is expanded only when its length, computed before it is built, is
  within 2,048 bytes and the result passes the same rules, before any policy or DNS step
  (`src/federation/card-oembed.ts`). Every hop's domain policy is `webHopRefused`, a Store write, which the Store refuses
  in any maintenance (read-only included) and during a dump or import: the sink reads it before each DNS check, and the
  round's `checkHost` again after it, so no redirect, DNS check or request starts once maintenance is entered. A
  policy read that fails at either point marks the claim, which is released unattempted, while a host the policy
  refuses is no card. Its scan collects the metas, the `<link>` elements, the JSON-LD scripts, the first title and lang
  only (632,896 UTF-16 code units at most), the request carries `Accept-Language: en, *;q=0.5`, and its logs carry the failure kind
  and reason, the chain and the hostname only. Its records are writes fenced by the claim token, the row's generation (a reset
  draws a new one), an open claim, a pending row and the status's eligibility now (`cardEligibleSql`, R43), so an edit,
  a delete, a hide or a suspension still in force at the record lets nothing be attached (one lifted within the round
  is an accepted risk). `test/link-card-rounds.test.ts` ("gives
  no card for a blank title, a failed fetch or a refused URL, without retrying", "drops the record of a claim whose
  status was edited or deleted during the fetch", "drops the record of a status suspended during the fetch", "starts no
  fetch and follows no redirect once maintenance is entered during a DNS check", "releases a claim unattempted when a
  policy RPC fails %s the DNS check", "gives no card for a host the domain policy refuses, before or after redirects",
  "discards a late record of an older claim", "starts no endpoint request once maintenance is entered during chain
  2's DNS check", "releases a claim unattempted when a policy RPC of chain 2 fails %s its DNS check", "upgrades an http
  endpoint to https, and tries none of another scheme or one the sink refuses", "refuses a claim URL the sink refuses
  before any network or cache work"), `test/web-page.test.ts` ("NET-3: parses a 200 of any content type,
  sending only the User-Agent", "NET-3: reads the whole body within WEB_JSON_BODY_LIMIT bytes and refuses one byte
  more unparsed", "NET-3: shares the hop rules"), `test/card-oembed.test.ts` ("computes the expansion length before
  building it"). The third caller, card images (`src/federation/card-images.ts`), runs only from the cron, at most 3
  claims a round, one at a time: the sink's image mode (`fetchWebImage`: the same hops, redirects, deadline and
  ceilings, only the User-Agent sent, a final 200 of any content type, a body below 8 MiB read into one buffer without a
  copy and refused at the first byte past it), a source the sink's rules refuse being no image before any network step,
  every hop admitted by `webHopRefused` as above, and the bytes judged by their signature (JPEG, PNG, GIF or WebP)
  before the Images binding reads them. Kopje decodes no image in the Worker: the blurhash's pixels are a second Images
  output of the same input and transformation as raw RGBA, read within 4 × w × h bytes of the checked WebP's size,
  refused while read past it and at any other length. A local upload's blurhash is read the same way, from the RGBA
  output of its preview's input and transformation within 4 × w × h of the checked preview (at most
  `PREVIEW_RGBA_LIMIT`, 1,638,400 bytes; `processImage` in `src/platform/images.ts`, `test/images-codec.test.ts`
  ("processImage, the preview blurhash")). That output and every read of it are given up `RGBA_CALL_MS` (5 seconds)
  after it starts, or a minute before the upload's writer deadline (`UPLOAD_SAVE_RESERVE_MS`), whichever is first, and
  not started with less than `RGBA_MIN_CALL_MS` left, so it delays the upload's save (or a rebuilt row's record) by at
  most `RGBA_CALL_MS`; a failure or a give-up keeps the upload without a blurhash. This is the bound, not a promise that
  the upload never fails: a save that misses the writer deadline still answers 422. _Enforced (main):_
  `test/web-page.test.ts` ("NET-3: reads a 200 of any content type within maxBytes", "NET-3: keeps a body of exactly
  maxBytes and refuses one byte more", "NET-3: shares the hop rules, the status rule"), `test/card-image-rounds.test.ts`
  ("refuses a source the sink refuses", "a policy RPC failure leaves the claim unattempted",
  "follows no redirect and starts no request once maintenance is entered during a held DNS check"),
  `test/card-image-process.test.ts` ("the RGBA output is of the same input and transformation as the WebP, read at
  its header size", "encodeRgba refuses a size past its limit or empty before any call", "reads the RGBA within 4 × w ×
  h bytes, refusing one more while it is read"); the package check at the repository root refuses a bundle that carries
  a wasm module. Remote media: the sink, _Enforced (main):_ `fetchRemoteFile` in
  `src/federation/remote-file.ts`, over the sink's media mode (`fetchWebMedia` and `streamWebMedia` in
  `src/federation/web-page.ts`). A URL the sink's rules refuse, or one on the instance's own host, fails before any
  network step; every hop is admitted by `webHopRefused` before and after its DNS check as above, the own host refused
  at every hop as a blocked host; the request is unsigned, carries only the User-Agent
  `Kopje/<version> (+https://<domain>/)` (and `accept-encoding: identity` when streamed) and has redirect `manual`; the
  whole call, the reading of a returned stream included, ends at the file's deadline, at most `WEB_MEDIA_TIMEOUT_MS`
  (30 s), and the hops' hosts are returned on success only. An image is read whole within its kind's cap (avatars,
  headers and thumbnails below 2 MiB, emoji below 256 KiB, attachment images below 16 MiB), counted after workerd's
  Content-Encoding decoding and refused at the first byte past it, then judged without decoding a pixel
  (`src/platform/remote-media-bytes.ts`): its type by its signature (the remote Content-Type is never read), a walk of
  its whole container (a JPEG's scans up to EOI), at most 16,777,216 pixels as its headers state them, a non-identity
  orientation refused, its metadata stripped in place and the output checked again; a still of an animated one is
  remuxed within a still cap, never decoded (`src/platform/image-still.ts`). Video and audio are streamed only with a
  Content-Length below 40 MiB and no Content-Encoding but identity, recognized from their first 1 MiB (MP4 and M4A
  without HEIF or QuickTime brands, WebM, MP3, FLAC, WAV; Ogg refused) before anything past it is read; the stream
  errors on any other byte count, and holds back the bytes that complete the length until the end is confirmed. A
  failure names a closed kind and the hostname only. `test/remote-file.test.ts` ("NET-3: refuses a URL the sink or the
  own-host rule refuses before any network step", "NET-3: admits every hop before and after its DNS check, follows at
  most 3 redirects, never lets fetch follow", "NET-3: refuses the own host on a redirect as a blocked host", "NET-3: a
  host the policy refuses, before or after its DNS check, is blocked and never requested", "NET-3: cancels a body at
  its kind cap", "NET-3: ends at the file deadline, a stalled DNS check or body included", "NET-3: a returned stream
  errors at the file deadline while its consumer is still reading", "classifies failures as permanent or transient,
  each with the host only", "refuses a stream without a length, past the cap or encoded, before reading it", "refuses
  Ogg, a category mismatch and an image from the prefix, cancelling the rest unread", "stores a streamed file whole in
  R2, and nothing of a short or long one"), `test/web-page.test.ts` ("NET-3: reads a 200 whole within maxBytes and
  returns every hop host, sending only the User-Agent", "NET-3: allows the whole call WEB_MEDIA_TIMEOUT_MS", "NET-3:
  streams exactly the declared length after its prefix, asking for identity", "NET-3: the streamed mode refuses",
  "NET-3: a streamed body shorter or longer than its length errors", "NET-3: a returned stream errors at the deadline
  while its consumer is still reading"), `test/web-page-encoding.test.ts` ("NET-3: the streamed mode asks for identity
  and gets it from an origin that negotiates", "NET-3: the streamed mode refuses an origin that answers gzip although
  identity was asked for"), `test/remote-media-bytes.test.ts` ("accepts every image type with its real structure",
  "strips APP1, APP13 and COM between scans and after the last scan, and data after EOI", "refuses orientation",
  "refuses an AVIF with a non-identity irot or any imir", "refuses an image past the pixel limit", "recognizes video
  and audio by their containers", "refuses Ogg whatever it carries", "never reads out of bounds or throws on
  truncated or mutated files"), `test/image-still.test.ts` ("makes none past the still cap", "handles a hostile 16
  MiB GIF in linear time"). Remote avatars, headers, custom emoji and attachments: _Enforced (main):_ only the cron's
  round fetches them, through this sink alone (`remoteMediaRound` in `src/federation/remote-media.ts`, the Store's part
  in `src/domain/remote-media.ts`). A slot is claimed only while it is eligible (`slotEligibleSql`: an avatar or header
  of a stored remote account that is available, whose current URL is the slot's byte for byte; a custom emoji of the
  domain whose snapshot named it, keyed by that domain and its URL, the domain covered by no block; an attachment's
  file or icon of a remote attachment row whose current URL is the slot's byte for byte (and, for the file, whose type
  gives the slot's category), of an available author, whose status is not withdrawn and has no delete job waiting,
  that arrived within `MEDIA_CACHE_RETENTION_DAYS`; any of them on a host no domain block covers), and its admission
  before each put and its record are fenced by the claim, the slot's generation, the token reserved for it and that
  eligibility again, with no recorded redirect host covered by a block. A round has one deadline (240 s): its
  maintenance first (45 s), then at most 30 files (24 in lane 0, three at a time; 6 attachment files in lane 1, one at
  a time, beside them), each started only when its 30 s fits before 220 s, then the records; every external operation
  starts only when its own budget fits what is left of its allocation. A streamed video or audio file is admitted, then
  put to R2 as it is read, exactly its declared length, under the file's deadline; its body is cancelled when it is not
  admitted. `test/remote-media.test.ts` ("fetches, verifies and puts a still profile image, and an animated one with its
  still", "fails a file the sink or the verification refuses, recording each failure", "records nothing for a claim
  whose URL changed, whose account was suspended or blocked, or an older claim", "records nothing for a redirect host
  the domain policy covers, nor for another category", "records nothing once the reservation expired, nor for another
  generation of the same claim"), `test/remote-media-rounds.test.ts` ("makes the derived own Store calls and puts
  through a full round of files with stills", "starts no request once maintenance is entered during a held DNS check",
  "starts no operation whose budget does not fit what is left of its allocation").
  Emoji: `test/remote-emoji.test.ts` ("enqueue the emoji of a stored Note, a newer Update and an Update(Person)",
  "keeps one slot a domain and url, in either arrival order, and a block of one domain retires only its own",
  "enqueues nothing for a local or unset domain, a covered host or a URL the fetch refuses", "stores an emoji with its
  still, and fails a JPEG one for good"). Attachments: `test/remote-attachments.test.ts` ("enqueues each attachment’s
  file in lane 1 by its category and its icon in lane 0", "resets the file of an attachment whose type changes at the
  same URL", "claims no file of an attachment whose status is hidden or has a delete job waiting", "stores a streamed
  video just under 40 MiB whole, exactly its length, and charges it", "cancels a streamed body its admission refuses,
  putting nothing", "gives up a streamed put at the file deadline, keeps the call outstanding, and dooms what lands
  late", "reads one attachment file at a time while profile images go on beside it").
  Kopje fetches nothing for local emoji; peers fetch `/media/…` and `/emojis/:id`.
- **NET-4: signed fetches stay with their signer.** A document fetched with a signature is cached under a key that
  includes the signing key id and is never served to another key or to the unsigned path. _Enforced (main):_
  `signedLoader` in `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("caches signed documents per signing
  key"). Expiry within 5 minutes: _Enforced (main):_ an entry carries Fedify `kvCache`'s default lifetime of 5
  minutes, and the KV store reads an expired entry as absent (`src/federation/kv-store.ts`, `src/domain/fedify-kv.ts`);
  `test/kv-store.test.ts` ("honors expires_at with the injected clock"). _Gap:_ no test pins the 5 minutes, Fedify's
  default. A sweep of expired rows: _Planned (KV sweep):_ nothing deletes expired `fedify_kv` rows yet.
  _Enforced (main)_ for the fetches of inbound processing and search:
  the original of a boost (and its author, or that author's refresh) is fetched as the request's other fetches are,
  with the personal inbox
  owner's key or the instance actor's, never from the signed-document cache; search with `resolve=true`
  (`GET /api/v2/search`, and `GET /api/v1/accounts/search` for addresses) fetches as the instance actor only, for a
  request whose token is valid, has the scope and names a user (401, 403 or 422 otherwise, before anything is fetched),
  with WebFinger unsigned; the search after the fetch judges the token again at its own time. An account's canonical
  address is decided as Mastodon 4.7.3's `ActivityPub::ProcessAccountService#check_webfinger!` and
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
  existing actor) finds the account by its actor id and never sets or replaces its address. One helper (`accountDomain`
  in `src/domain/remote-actors.ts`) decides the stored domain for every path. _Gap:_ inbound activities do not look up
  WebFinger, so an account first seen inbound shows its actor's host until it is resolved, and a renamed
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
  Custom emoji in that HTML are added in the same pass (`sanitizedWithEmoji`): sanitize-html hands each run of text it
  keeps, already escaped, to a filter whose output it writes unescaped, and the filter keeps the text as given and adds
  only an image whose attributes it escapes, for a shortcode within `EMOJI_SHORTCODE` and a url that passes the
  stored bounds again at the sink; attribute values and dropped elements never reach it. In names, warnings, field
  names and poll choices, which are text, an emoji is an element hono/jsx escapes. _Enforced (main):_
  `src/security/html.ts` (`sanitizeRemoteHtmlFiltered`), `src/web/view/emoji.ts`; `test/web-emoji.test.ts` ("gets
  each run of text escaped and writes what it returns unescaped", "are refused at the sink for a shortcode or url the
  stored bounds would refuse").
  The operator's documents (the extended description, the privacy policy and the terms of service) are stored as the
  admin wrote them or the cutover converted them and sanitized once per sink by `sanitizeDocumentHtml`, the same
  allowlist with h2 to h4 kept as headings, without attributes ([mastodon-deviations.md](mastodon-deviations.md),
  Instance and apps): in the Store for the API (`instanceDocument` in `src/domain/instance.ts`), at the page for the
  web (`webDocument`, then `SafeHtml`). A link that is not absolute http(s) loses its href and stays as text (HTML-3).
  At most 50,000 UTF-8 bytes each (RES-2), so the sanitizer's raw cap never cuts one, however sanitizing lengthens it.
  _Enforced (main):_ `test/html.test.ts` (the vector suites through it too, "keeps headings as h2 to h4, without
  attributes, under the page’s own h1"), `test/instance-reads.test.ts` ("keeps a document’s headings in the API, as the
  pages show them", "serves the privacy policy sanitized", "keeps the end of a document that sanitizing lengthens past
  the raw cap"), `test/web-pages.test.ts` ("serve the privacy policy and
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
  to fetched and imported data too. The one other scheme a page emits is the about page's `mailto:` for the operator's
  contact email, only for an address of one plain local part and domain (no space, `?`, `#`, `%`, `/`, `:` or second
  `@`, so it adds no header or recipient), its local part and domain percent-encoded (RFC 6068 §6.1); anything else is
  shown as text (`src/web/pages/about.tsx`, `test/web-pages.test.ts`). _Enforced (main)_ for app websites at
  registration: `isAppWebsite` in `src/platform/stored-bounds.ts` (_Gap: untested_). _Enforced (main)_ for the account
  presenter and local actor documents (profile URL, avatar, header, icon, image and aliases): `httpUrl` in
  `src/platform/http-url.ts`, used by `presentAccount` in `src/domain/accounts.ts` and `localActorObject` in
  `src/federation/federation.ts`; `test/accounts.test.ts`, `test/federation.test.ts`. _Enforced (main)_ for attachment
  URLs in the API and in Note attachments: `presentMedia` in `src/domain/status-presenter.ts`, `noteOf` in
  `src/domain/activities.ts` (_Gap: no test with a non-http stored attachment URL_); a remote attachment's
  `remote_url` and `preview_remote_url` are the same values as its `url` and its icon. _Enforced (main)_ for edit
  history: every URL of a recorded attachment passes `presentedMediaUrl`, the rule live media pass too: as decoded,
  within 2,048 UTF-8 bytes, well-formed and without NUL, other C0 controls, DEL or U+FFFD, then normalized within
  2,048 bytes and 4,098 JSON bytes (`snapshotMedia` in `src/domain/statuses.ts`; `test/status-bounds.test.ts`
  ("judges a media URL as decoded, then as normalized", "judges an imported snapshot's URLs and blurhash as live
  media")). _Enforced (main)_ for remote actors at ingest (profile URL, avatar, header, inboxes) and links in remote
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
  reply); a link goes through `linkTo`, which keeps a URL of another host, or a same-host path starting with `//`,
  absolute; field links carry `rel="me"`: _Enforced (main):_ `src/web/view/link.ts`, `src/web/view/account.ts`;
  `test/web-pages.test.ts`, `test/web-contracts.test.ts`. An attachment whose url is not http(s) is left out, a poster
  is an attachment's own http(s) preview and never its file, and an attachment of a type the page does
  not play is a link through `linkTo`, its stored type never written: `src/web/view/media.ts`;
  `test/web-status-content.test.ts` ("shows an attachment of another type as a link, and nothing of a URL that is not
  http(s)").
  _Enforced (main)_ for a card's video: its `html` is never a remote markup but Kopje's fixed iframe template
  (`cardIframe` in `src/domain/status-presenter.ts`: `allowfullscreen`, `scrolling` and `frameborder` forced, a fixed
  sandbox), from its src alone, which passes `presentedEmbedSrc` (`src/platform/stored-bounds.ts`) when it is kept and
  again when it is presented: an absolute http(s) URL as decoded (no base, no protocol-relative form, none of
  ``"<>\^`{|}``, controls or whitespace), within 512 bytes normalized and 512 once its `&` is escaped, which it is
  exactly once, at render; a src that does not pass makes a link without html. `embed_url` is always `''`.
  `test/link-cards.test.ts` ("presents a video from its fixed template, a photo without an image, and judges each
  stored value again"), `test/card-oembed.test.ts` ("keeps a src only as an absolute http(s) URL within its bounds").
  _Enforced (main)_ for a card's `image`: the instance builds it from the stored image's server token on its own
  origin (`presentedCardImageUrl` in `src/domain/status-presenter.ts`, through `presentedMediaUrl`, within 342 bytes),
  never from the remote source URL, which is never presented; `test/link-cards.test.ts` ("presents a stored image on
  the instance origin with its blurhash").
  _Enforced (main)_ for cached profile images: a remote account's `avatar`, `avatar_static`, `header` and
  `header_static` are paths on the instance origin built from the cached object's server token and stored type
  (`cachedImageUrls` in `src/domain/remote-media.ts`), shown only while the slot's URL is the account's current one
  (`slotOwnsSql`, read once a presentation chunk by `cachedImagesOf`); otherwise the stored http(s) URLs as above;
  `test/remote-media-presenter.test.ts` ("show the cached files of the current URLs, the still as the static, and the
  remote URLs otherwise", "show the cache for a moved-to account and for a partial account", "never shows a slot for a
  local account (ID-3)").
  _Enforced (main)_ for cached custom emoji: of a remote snapshot's first 16 entries (`EMOJI_CACHE_LIMIT`), one whose
  (domain, url) slot holds a stored file shows paths on the instance origin built from its server token and stored
  types (its still as `static_url`), read with its row (`emojiCacheSql` in `src/platform/stored-bounds.ts`, presented by
  `emojiCacheOf` and `presentEmojis` in `src/domain/custom-emojis.ts` through `cachedImageUrls`); every other entry its
  stored http(s) URL as above; `test/remote-emoji.test.ts` ("show the cached file and its still for the first entries,
  the remote URL past them or uncached", "reads an entry past the limit, or a malformed cache, as the remote URL").

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
  files at `files/<token>/<variant>`; the serving route builds only `files/` keys from a token of the server's form; a
  card image is `files/<token>/full` of a token the Worker generated and the Store accepted as held by no other owner,
  `src/domain/card-images.ts`; a cached remote file is `remote/<token>/full` or `remote/<token>/still` of a token the
  Store reserved in its ledger, `remote_media_objects`, before any key exists, `remoteFileKey` and `keyOfRemotePath`
  in `src/platform/media-files.ts`, `src/domain/remote-media.ts`);
  the Store holds a row for every key before it is written, and the sweep deletes a row only after its objects. A write
  started before the upload's deadline can still land after the sweep, so the sweep leaves a tombstone
  (`media_orphans`) for each upload that never completed, and reconciliation (the cron, `reconcileMedia` in
  `src/mastodon/media.ts`) deletes its keys again a day after the deadline. Reconciliation deletes only recorded
  tombstones, never an object because no row names it, and neither it nor the sweep runs during maintenance, a dump,
  an import, or before setup; tombstones are not dumped, so a restored or imported Store starts with none and deletes
  nothing it restores. The one exception is the cache's orphan sweep, which only ever lists and deletes under
  `remote/`, a disposable cache with no original (MEDIA-7): at most once an hour (the attempt recorded as the
  maintenance call hands it out), outside maintenance and a restore's settle period, it lists one page of at most
  1,000 keys and deletes those uploaded more than a day before whose token the ledger does not hold
  (`remoteMediaOrphans` in `src/domain/remote-media.ts`); since every token is reserved before its put, such a key is
  one a restore or an import left behind. A due sweep's whole budget is kept from that round's other maintenance, and
  its page cursor moves only after the page's delete returned (`remoteMediaSwept`), so a page whose delete failed is
  listed again an hour later and a sweep that keeps failing costs one round an hour. `test/remote-media.test.ts`
  ("sweeps only unknown objects older than a day, once an hour"), `test/remote-media-serving.test.ts` ("serves the
  same type map the cache stores, under remote/ only"). `test/image-bytes.test.ts` ("media keys"), `test/media.test.ts`
  ("serves only well-formed paths of served files"), `test/media-reconcile.test.ts` ("deletes nothing from R2 for a
  Store that knows nothing of it", "deletes nothing during maintenance, an import, or before setup", "deletes a late
  write of a failed upload"). The media rebuild (`kopje-admin media-rebuild`, `src/mastodon/media-rebuild.ts`) builds
  its keys the same way, from the row's id and token only, and writes only while nothing deletes media: while a verified
  import is unpublished (the import began on an empty Store and every write has been refused since, so no deletion was
  ever decided for a row it brought), or once the Store's readonly maintenance has lasted 20 minutes
  (`REBUILD_SETTLE_MS`: longer than a cron invocation, at most 15 minutes, or the sweep after an API delete, at most 30
  seconds after its response, can still run with a batch fetched before maintenance began). Otherwise it is refused
  (`rebuild-needs-readonly`, `rebuild-settling`); the env `MAINTENANCE` alone is not enough, since the Store records no
  start for it, and the operator must not change it during a rebuild. In those states `delete_media`, the sweep,
  reconciliation and an upload's cleanup are refused at their first Store write, before any R2 delete; while the
  rebuild's lease is live they are refused whatever the flags say (operation kind `media-delete`), and so is leaving
  maintenance. One call runs at a time under that lease, kept at the Store's clock: renewed before each row and, while
  an R2 write is pending, every minute; R2 writes and deletes are never given up but awaited to completion, so the lease
  cannot end under a write the call started while the call runs, and each starts only after the Store confirms the lease
  is still the call's (once a renewal or that check fails, no further write starts, the call reports `lease-overrun` and
  the lease is not released). A PITR restore is refused while the lease is live, and the lease while a restore is being
  scheduled (`pitr_restoring`); since a restore rewinds the maintenance start and the unpublished flag, the Store
  records each restore outside its database (an R2 object named by its id, `restoreMarkerKey` in
  `src/platform/media-files.ts`, never served) before scheduling it, and the
  rebuild counts readiness only from it: an unpublished flag from before it is not ready, and maintenance settles from
  the later of its start and the restore. An import reset or cutover reset never writes the maintenance flag, so they
  leave no stale start. Per row the other steps are bounded: two R2 reads, six Images calls and five Store calls, each given up
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
- **MEDIA-3: served images are re-encoded.** An uploaded image, and a card image, is served only as Images output with
  location metadata removed; if transformation fails, the upload is refused and original bytes are never served.
  Cached remote files are not transformed; MEDIA-6 holds for them.
  _Enforced (main):_ outputs are PNG or WebP only, for which Images discards all metadata (the binding has no
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
  mismatch"). The RGBA output of an upload's preview, from which its blurhash is computed, is only hashed: it is never
  stored or served.
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
  serves a stored object of another type"). A card image is only ever stored re-encoded, as a still WebP without
  metadata that Images made from a source of an accepted signature, its output checked before it is written
  (`src/federation/card-images.ts`; `test/card-image-process.test.ts` ("refuses a signature that is not JPEG, PNG,
  GIF or WebP", "refuses an output of CARD_IMAGE_OUTPUT_LIMIT + 1 bytes while it is read")). A cached remote file
  is served from a second type set, `REMOTE_SERVED_TYPES` (JPEG, PNG, GIF, WebP, AVIF, MP4, WebM, M4A, MP3, FLAC and
  WAV, each under one extension), by `serveRemoteMedia` in `src/web/media.ts`: only a `remote/` key of a server token,
  and only when the stored type is in the set and is the one the path's extension names, with `nosniff`, a `sandbox`
  CSP and no Store read; anything else answers 404. `test/remote-media-serving.test.ts` ("serves a stored file with
  exact headers, in maintenance and with no Store read", "answers 404 for a type mismatch, an unknown key and a path
  outside remote/", "answers ranges with 206, an unsatisfiable one with 416, and a multi-part one with the whole
  file").
- **MEDIA-5: a custom emoji's image is never deleted, disabled emoji included.** Its media row has the emoji's id,
  which the foreign key of `custom_emojis` holds (no cascade), the 0055 image trigger requires a kept upload, and every
  destructive or API selection excludes it (MEDIA-1, MEDIA-2). _Enforced (main):_ `src/domain/media.ts`
  (`notEmojiSql`), migration `0055_local_custom_emojis`; `test/media-reconcile.test.ts` ("custom emoji images after
  every grace period", with an expiring upload and a due tombstone as controls), `test/migrations.test.ts` (0055).
- **MEDIA-6: a cached remote file is verified bytes.** A remote file is cached only as the bytes the Worker recognized
  by their signature and walked whole within its kind's cap (NET-3), with metadata stripped and no non-identity
  orientation; its type is the recognized one, never the remote Content-Type, and a still is remuxed from it, never
  decoded. A video or audio file is cached only as a container the Worker recognized from its first 1 MiB (MP4 and
  M4A without HEIF or QuickTime brands, WebM, MP3, FLAC, WAV; Ogg is not cached), exactly its declared length, its
  bytes as served (no metadata is stripped from it, and nothing of it is decoded). _Enforced (main)_ for avatars,
  headers and custom emoji (PNG, GIF and WebP only), attachments' icons and images (JPEG, PNG, GIF, WebP and AVIF) and
  attachments' video and audio: the round puts only `fetchRemoteFile`'s output
  (`src/federation/remote-file.ts`, `src/platform/remote-media-bytes.ts`, `src/platform/image-still.ts`) and the
  Store records only a type of the served set (`src/platform/stored-bounds.ts`, migration `0077_remote_media`);
  `test/remote-media-bytes.test.ts` ("accepts every image type with its real structure", "refuses orientation"),
  `test/remote-media.test.ts` ("fails a file the sink or the verification refuses"), `test/remote-file.test.ts`
  ("refuses Ogg, a category mismatch and an image from the prefix, cancelling the rest unread").
- **MEDIA-7: the remote media cache is bounded and disposable.** It holds no original: every cached file can be
  fetched again or replaced by its remote URL. _Enforced (main)_ for avatars, headers, custom emoji and attachments'
  files and icons (`src/domain/remote-media.ts`, `src/federation/remote-media.ts`, migration `0077_remote_media`):
  - Bytes: every object is charged in `remote_media_usage` in the transaction that changes it: a reservation of its
    kind's file and still caps from its claim, its actual bytes once stored, and a doomed one until its delete is
    confirmed. A claim is admitted only while the charged bytes and its reservation stay within
    `REMOTE_MEDIA_CACHE_BYTES` (default 4 GiB), deferred otherwise, and reclamation dooms the oldest stored objects
    once the charge and the next claim's reservations (its at most 24 due slots of lane 0 and 6 of lane 1) pass the cap
    less 96 MiB (`LANE1_HEADROOM`), which lane 1 claims also stop at, so a round of lane 0 reservations always fits. The
    cap is 0, which turns caching off (no claim, no reclamation), or at least 256 MiB, so that threshold is positive;
    another value fails the configuration (`src/platform/config.ts`).
    The audit compares the row with the ledger in chunks, and a write between its chunks to an object it has counted
    is counted in the pass too. `test/remote-media.test.ts` ("admits a reservation exactly at the cap, defers one byte
    past it, and charges no attempt", "reclaims the oldest stored objects past the threshold, one large victim
    sufficing", "accepts a cap of 0 or at least 256 MiB", "reclaims nothing exactly at the threshold of the least cap",
    "with caching off (a cap of 0) claims nothing and reclaims nothing", "keeps the usage row equal to the ledger after
    any sequence of operations"), `test/remote-media-maintenance.test.ts` ("reports no drift for writes between the
    audit chunks").
  - Deletion: an object is doomed in the transaction that leaves it unused (a new URL, a failure, an ineligible slot,
    a purge), and leaves the ledger only once its R2 delete returned. An object that may still receive a put is doomed
    with its deletion due 75 minutes after its Store-recorded claim, longer than any cron invocation, so a put given up
    lands before it is deleted. A delete that failed, was given up or was not confirmed leaves the object doomed and
    charged, tried again after a backoff; one that keeps failing is tried in ever smaller groups until it is alone, so
    it holds back neither new deletions nor the others. The deletions never tried and the retried ones come from two
    seeks of their own partial indexes, each with its share of the batch, so no number of one hides the other. A
    round may delete a committed delete's files before it confirms them: until then the object stays doomed and
    charged. `test/remote-media.test.ts` ("confirms a deletion only after the delete returned", "dooms the object of a
    partial, a failure and a release LATE_PUT_MS after its claim"), `test/remote-media-maintenance.test.ts` ("keeps an
    object whose delete failed doomed and charged", "keeps an object whose delete was given up charged though the delete
    landed", "deletes again an object whose delete returned but whose confirmation failed", "keeps an object doomed and
    charged between its committed delete and the confirmation", "does not let a delete that fails every time hold back
    the others", "put given up and landed late only once LATE_PUT_MS has passed since its claim"),
    `test/remote-media.test.ts` ("takes a deletion never tried past DELETE_BATCH retried ones, each group by its own
    seek, after ANALYZE and growth"), `test/remote-media-rounds.test.ts` ("records a partial when maintenance is entered
    between the full put and the still put").
  - Eligibility: the validity walk, the suspended accounts and a purge retire the slots that are no longer eligible
    (NET-3), a slot whose account's stored domain (never its actor host: VIS-30) or emoji domain has a rule with
    `reject_media` among them, which also no enqueue, claim or record admits; the rule is sought by the blocks' domain
    index for each suffix, so a walk's reads grow with its slots, not with the blocks.
    `test/remote-media-reject.test.ts` ("enqueues nothing of an account, an attachment author or an emoji domain whose
    rule rejects media", "backfills nothing of a domain whose rule rejects media, in every phase", "claims nothing of a
    domain once its rule rejects media, and admits or records no claim made before it", "stores nothing of a domain
    whose rule came to reject media while the round held its fetch", "judges an account by its stored domain alone, not
    by its actor host", "retires in the validity walk every cached file of a domain whose rule came to reject media",
    "decides by the nearest block", "seeks the reject_media rule by domain for each slot the validity walk reads,
    however many blocks, after ANALYZE and growth"). A purge retires every slot of its account before anything else,
    writing nothing else of the account while a slot remains, and deletes the account only after the last. A slot never
    outlives the row it names: an attachment an edit drops has its slots retired before its row goes, the removal of a
    status retires its attachments' slots (within the batch's rows, at most five changes a slot, an audit pass's sums
    included, as progress of the job, from a window of 64 of its attachment rows that its completion check reads too,
    nothing for a local status) before their rows may go, and every delete of a remote attachment row keeps one a slot
    still names. `test/remote-media.test.ts` ("retires in the validity walk a slot whose account became unavailable or
    whose redirect host was blocked"),
    `test/remote-media-rounds.test.ts` ("resumes a retirement the batch budget cut short, writing nothing else first",
    "retires stored and reserved slots first, resuming over batches, and deletes the account after the last", "never
    clears a slot through the generic reference loop"), `test/remote-attachments.test.ts` ("resets a changed URL, dooms
    a dropped attachment’s files before its row goes", "costs SLOT_RETIRE_CHANGES, its most, to retire a pending slot
    with its reserved object mid-audit", "retires no more slots than … changes left allow mid-audit", "keeps each …
    batch within its rows, retiring stored and reserved files mid-audit, and resumes to the end", "reads a bounded
    window a batch for a status with many uncached attachments before a cached one, or many uploads", "retires
    every cached file of a deleted status before its attachment rows go, across batches", "keeps an attachment row
    while a slot names it", "retires the cached files of an account’s unattached attachments in its purge before the
    rows go"), `test/inbound-job-isolation.test.ts` ("advances a delete by retiring its attachments’ cached files
    alone, batch after batch, and finishes"), `test/cascade-guard.test.ts` ("retires each logical reference to a child
    before the child, through an index of its column").
  - Dumps, backups and restores: the three tables are not dumped (DATA-3) and `remote/` is not backed up. After a PITR
    restore (its marker, MEDIA-2) a round makes no write and no R2 operation for 20 minutes; then the reservations it
    restored are doomed and every stored object is checked with a head, a missing one reset to be fetched again; the
    orphan sweep (MEDIA-2) deletes what the restored ledger does not know. The walk's cursor belongs to its restore,
    so a restore to a bookmark taken mid-walk starts it again; a round heads an object only when all its heads fit
    before the record's own budget and records the prefix it completed; an object whose heads fail three times in a row
    is handled as missing. `test/remote-media.test.ts` ("settles after a restore with no write, then dooms the restored
    reservations and validates every variant", "starts the validation walk again for a restore to a bookmark taken
    mid-validation", "reads the validation batch in token order through its index, past a doomed prefix, after ANALYZE
    and growth"), `test/remote-media-maintenance.test.ts` ("records the prefix whose heads fit before the record, and
    resumes after it", "does not let an object whose heads fail every time hold back the walk", "after a restore during
    a held delete, confirms nothing restored and fetches the missing file again"), `src/platform/dump-catalog.ts`,
    `test-node/schema-coverage.test.ts`.
  - Walks across rounds: each records the progress it completed, and an item that fails every time holds back
    none behind it: the claims (a file that fails is retried later while the others are fetched), the backfill (an
    account whose URL is refused gets no slot, and the cursor moves past accounts already processed), the audit, the
    validation and the deletions (above), and the orphan sweep (a page checkpointed after its delete, MEDIA-2). Each
    walk's progress is written in the same Store call as the work it records, or after it.
    `test/remote-media-maintenance.test.ts` ("does not let a file that fails every time hold back the claims of the
    others", "backfills every account once though accounts change between its chunks", "keeps the time of a due sweep
    from both deletion groups", "lists a page again an hour after its orphan delete failed", "lets deletions and
    validation progress in the other rounds while the sweep fails every hour"), `test/remote-media.test.ts` ("sweeps
    only unknown objects older than a day, once an hour").
  - Presentation reads at most one slot an account and kind, in one statement a presentation chunk, one seek each,
    after ANALYZE and growth (RES-3): `test/remote-media-presenter.test.ts` ("reads one chunk with one statement of one
    seek a slot, after ANALYZE and growth"), `test/answer-budgets.test.ts` ("reads them with one statement a chunk,
    within ids × kinds × the packed cap").
  - Emoji: one slot a (domain, url), kept while a snapshot names it within 90 days (the validity walk retires it after;
    a sighting is recorded at most once a day), a block of its domain retiring it; a failed one is reset at a later
    sighting a day after, within the pending limit. The backfill (coverage version 3) walks the remote accounts' and,
    by a window of 1,000 ids a round with arrival (`created_at`) within `MEDIA_CACHE_RETENTION_DAYS` as a residual
    condition, the remote statuses' snapshots, recording the entry it stopped at the pending limit with the identity
    of the snapshot it walked and its domain: one an Update replaced, or whose account changed address, meanwhile is
    walked again from its first entry.
    `test/remote-emoji.test.ts` ("records a sighting at most once a day, and retires an emoji unseen for 90 days",
    "resets a failed emoji at a later sighting after a day, within the pending limit only", "starts again after the
    profile pass, covers emoji-only accounts and remote statuses arrived within retention", "stops inside a snapshot at
    the pending limit and resumes at the entry it stopped at", "walks a … whose … changed after the stop from its first
    entry", "reads the statuses phase by its id window, retention a residual condition, after ANALYZE and
    growth").
  - Attachments: a remote attachment's file (lane 1, by the category its type gives: an image with its still, or a
    streamed video or audio file) and its icon (lane 0) are enqueued by the status writer while it arrived within
    `MEDIA_CACHE_RETENTION_DAYS` (0 keeps every one), reset when the URL or the category changes, and doomed once
    stored longer than the retention (`aged`, at most 200 a round by the stored objects' index). The backfill (coverage
    version 3) walks, after the accounts, the remote attachments shown with their statuses by id (their arrival) within
    the retention, then the statuses' emoji. `test/remote-attachments.test.ts` ("enqueues nothing for an attachment
    that arrived longer ago than the retention, unless it is 0", "dooms stored attachment files and icons past the
    retention, newest kept, and nothing at 0", "walks the attachments shown with their statuses within the retention
    once the accounts are done", "reads the retention walk, the attachments phase and the lane 1 walk by their
    indexes, after ANALYZE and growth").

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
  whoever may see its status by itself (R3), and a vote needs R27 (`mayVoteSql`: the voter blocks neither the author nor
  its domain); otherwise 404 (403 for a voter who blocks the author, as Mastodon). Only counts and the viewer's own
  votes are shown; `hide_totals` hides each choice's count from everyone until the poll ends, in the API and in the
  Question (no `totalItems`). `poll_votes` is read, besides the policy module, in `polls.ts` and `poll-presenter.ts`,
  and in `status-rows.ts` only to count the viewer's own votes of the current generation
  (`test-node/policy-boundary.test.ts`, R27). A remote vote passes the same rule (Mastodon checks none). _Enforced
  (main):_ `test/polls.test.ts` ("shows a poll only to whoever may see its status", "refuses a voter who blocks the
  author (R27)", "hides the counts … from everyone"), `test/polls-federation.test.ts` ("is refused from an account the
  author blocks (R27)").
  Public pages: _Enforced (main):_ the status page, the feeds (profile tabs, hashtag page) and the embed show a post's
  poll as the presenter shows it to an anonymous viewer: each choice's share only when every choice's count is shown,
  so none while `hide_totals` holds, and never a vote form. `src/web/view/poll.ts`; `test/web-status-content.test.ts`
  ("holds every choice’s count until a hide_totals poll ends, and then shows them (whole page)").
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
  a hashtag name normalized within the stored name rule (1,024 bytes, 256 characters); a link review's URL passes the
  card URL rule (2,048 bytes of printable ASCII) and a publisher's domain is normalized by `blockedDomain` within 253
  bytes; `src/mastodon/trends.ts`, `src/domain/trends.ts`; `test/trends.test.ts`, `test/admin-trends.test.ts`.
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
  documents and their bounded contexts; the Store asks the Worker for documents at most 3 times per activity, and the
  revision fence (ID-1) adds no fetch beyond that budget (a stale-author refresh may fetch its actor again);
  statuses are read as compacted JSON, without JSON-LD, as Mastodon reads them; `test/inbox-statuses.test.ts`
  ("refuses an activity or a fetched document past the JSON bounds before reading it", "caps the attachments, tags
  and content one status stores"), `test/inbox-statuses-edge.test.ts` ("RES-2: JSON-LD contexts past the JSON
  bounds", "the Store asks for documents at most three times"). A card's oEmbed document is read whole within 64 KiB
  (`fetchWebJson` in `src/federation/web-page.ts`, refused unparsed past it) and kept only within the same 10,000
  values and 32 levels; its video `html` is read by htmlparser2's streaming parser for its one iframe's attributes,
  building no output (`oembedIframe` in `src/security/html.ts`); `test/web-page.test.ts` ("fails a document past
  MAX_JSON_NODES or MAX_JSON_DEPTH as unparsable json-bounds"), `test/card-oembed.test.ts` ("reads a long run of
  ampersands around the iframe without building any output"). _Enforced (main)_ for stored values: each column of
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
  `test/trend-dump.test.ts`. A card's `link_type`, `final_url` and `public`, and the `trend_links`,
  `link_trend_reviews` and `link_provider_reviews` rows, imports included, meet their stored bounds, enforced by
  migration `0071_link_trends`, with the membership invariant (`public` = 1 only on an attached row with a final URL
  whose status is public, judged against the parent the dump restores first); the card writers set `public` from the
  status and the final URL they write (`cardPublicSql`), never from a donor; `test/migrations.test.ts`
  ("0071_link_trends"), `test/link-card-rounds.test.ts` ("the trend identity of a card"), `test/trend-dump.test.ts`
  ("link trends in dumps").
  _Enforced (main)_ for remote field verification: `remote_field_links` rows, imports included, meet the
  [stored bounds](dump-format.md#stored-bounds), enforced by migration `0068_remote_field_verification`, whose triggers
  judge in order the storage classes, the raw bytes, a raw NUL, `json_valid` and the canonical form (no padding or
  escape), the shape and types, each decoded element (the href's bytes, NUL, characters and prefix; the time's 24-byte
  form) and then the invariants and counters; the writers drop what that rule (`remoteFieldLinksPastBoundSql`) refuses
  and never fail, and the presenter reads the column through its SQL projection (`REMOTE_VERIFIED_SQL`, at most 129
  bytes) and never throws; `test/migrations.test.ts` ("0068_remote_field_verification"),
  `test/remote-field-links.test.ts`.
  _Enforced (main)_ for local field verification: `local_accounts.verified_links` and `unverified_links`, imports
  included, meet the [stored bounds](dump-format.md#stored-bounds), enforced by migrations `0066_field_verification`
  and `0076_field_link_checks`, whose triggers judge in order the storage class, the raw bytes, a raw NUL, the
  structure, each decoded value (bytes, NUL, printable ASCII) and then each value once; the record writers rebuild the
  entries they keep in canonical form, limited to the current field values, and drop what that rule
  (`verifiedLinksPastBoundSql`, `unverifiedLinksPastBoundSql`) refuses of the exact value written, never failing;
  `test/migrations.test.ts` ("0066_field_verification", "0076_field_link_checks"), `test/field-links.test.ts`
  ("records a value beside imported entries escaped up to the bound").
  _Enforced (main)_ for account moves: `accounts.moved_to_account_id` holds NULL or the 18-digit id of another
  account, on a remote row only; the triggers `accounts_moved_to_insert` and `accounts_moved_to_update` of migration
  `0060_account_moves` refuse any other value, imports included, judged by storage class, bytes, NUL, digits, then the
  row (`movedToPastBoundSql` in `src/platform/stored-bounds.ts`). Both writers store an account's id or NULL; the
  nested account is read through `MOVED_ACCOUNT_COLUMNS` (RES-3), so no value past its caps leaves SQLite
  (`test/migrations.test.ts` ("0060_account_moves"), `test/dump-import.test.ts` ("round-trips moved_to_account_id")).
  _Enforced (main)_ for actor document revisions: `accounts.document_revision` holds an integer from 0 to 2^53 − 1;
  the triggers `accounts_document_revision_insert` and `accounts_document_revision_update` of migration
  `0073_actor_document_revision` refuse any other value, imports included (`documentRevisionPastBoundSql` in
  `src/platform/stored-bounds.ts`). The writers draw a new value within the bound in SQL (`nextDocumentRevisionSql`),
  so a write never fails on it, and the reads project it as an integer; it is never presented
  (`test/migrations.test.ts` ("0073_actor_document_revision"), `test/dump-import.test.ts` ("round-trips
  document_revision")).
  _Enforced (main)_ for static images: `accounts.avatar_static_url` and `header_static_url` hold NULL or text of at
  most 512 bytes without NUL, on a local row whose image is set; the triggers `accounts_static_images_insert` and
  `accounts_static_images_update` of migration `0061_account_static_images` refuse any other value, imports included,
  judged by storage class, bytes, NUL, then the structure (`staticImagesPastBoundSql` in
  `src/platform/stored-bounds.ts`). The only writer (`profileAssignSql` in `src/domain/media.ts`) copies an animated
  upload's preview URL in SQL, byte for byte, only where `staticUrlPastBoundSql` accepts it; each presenter shows a
  static only with its image, and each within its URL bound as JSON writes it (`test/migrations.test.ts`
  ("0061_account_static_images"), `test/account-static.test.ts`, `test/dump-import.test.ts` ("round-trips the static
  images")).
  _Enforced (main)_ for status applications: `statuses.application_id` holds NULL or 1 to 64 bytes of base64url
  characters, on a local original only; the triggers `statuses_application_insert` and `statuses_application_update`
  of migration `0064_status_applications` refuse any other value, imports included, judged by storage class, bytes,
  NUL, the characters, then the row (`applicationIdPastBoundSql` in `src/platform/stored-bounds.ts`). The writers
  (`writePost`, from the credential's client or a scheduled status's params) keep a value through
  `storedApplicationId`, which shares the acceptance rule, and write NULL for any other, so the post is never refused
  for it. No foreign key holds it: an id whose app is gone reads as no app (`test/migrations.test.ts`
  ("0064_status_applications"), `test/stored-bounds.test.ts` ("status applications"), `test/dump-import.test.ts`
  ("round-trips status apps")).
  _Enforced (main)_ for media BlurHash: `media_attachments.blurhash` holds NULL or 6 to 54 ASCII bytes of base83 whose
  size flag gives at most 5 by 5 components and whose length is the one they give (Mastodon's `supported_blurhash?`,
  checked over the whole string); the triggers `media_attachments_blurhash_insert` and
  `media_attachments_blurhash_update` of migration `0065_media_blurhash` refuse any other value, imports included,
  judged by storage class, bytes, NUL, the characters, then the size flag and length (`blurhashPastBoundSql` in
  `src/platform/stored-bounds.ts`). The writers (`mediaOf` in `src/federation/remote-status.ts` for remote media,
  `completeMedia` in `src/domain/media.ts` and `recordRebuild` in `src/domain/media-rebuild.ts` for a local upload's
  preview blurhash, in the Store) keep a value through `storedBlurhash`, which shares the acceptance rule, and store
  none for any other (the rebuild then keeps the stored one), so the row is never refused for it; the presenter applies
  `storedBlurhash` again to every stored and snapshot value (`test/migrations.test.ts` ("0065_media_blurhash"),
  `test/stored-bounds.test.ts` ("media blurhash"), `test/inbox-statuses.test.ts` ("remote media URLs and blurhash"),
  `test/dump-import.test.ts` ("round-trips media blurhash")).
  _Enforced (main)_ for filter text units: `statuses.filter_text_units` holds NULL or an integer from 0 to 10,000 (the
  UTF-16 code units of the status's searchable text, cut at `MAX_FILTER_TEXT`); the triggers
  `statuses_filter_text_insert` and `statuses_filter_text_update` of migration `0079_filter_text_units` refuse any other
  value, imports included (`filterTextUnitsPastBoundSql` in `src/platform/stored-bounds.ts`), and
  `statuses_filter_text_stale` clears a measure a change of the status's text leaves behind. Each writer of a status's
  text, poll choices or shown media (a local post or edit, a remote create or update) stores `measureFilterText`
  (`src/domain/status-presenter.ts`) after those writes, in its operation: the presenter's `searchableText` over the
  stored rows, or NULL when an input is not text after affinity (judged in SQL first, so no JavaScript runs on it); a
  text change clears the column in its own SET, so a hide fires no trigger. A stored figure never raises what is matched
  past the shared allowance (VIS-18). The measure decodes the same stored text as one presentation of the row does, so
  its cost is a presentation's: media descriptions are bounded in code points (0048), so a malformed UTF-8 run in an
  imported one may hold many bytes in few code points (`test/migrations.test.ts` ("0079_filter_text_units"),
  `test/filter-text-units.test.ts`). _Enforced (main)_ for account counts: `accounts.followers_count`, `following_count`
  and `statuses_count` have no stored bound (an INTEGER column, no CHECK or trigger; adding one would rewrite every
  account), so an imported or converted row may hold any value there. Writers store only integers from 0 to 2^53−1
  (`MAX_ACCOUNT_COUNT`): local recounts, and a remote account's learned `totalItems` (`totalItemsOf` in
  `src/federation/collections.ts`, then `storedCount` in `completeCollectionRead`, `src/domain/remote-collections.ts`, a
  count it refuses leaving the stored one), written only on a remote row. Every read that presents, ranks or sums a
  count takes `presentedCountSql` (0 for any other value, `src/platform/stored-bounds.ts`): the account and moved-to
  account maps, account search, suggestions, the follow limit, the outbox's `totalItems` and the instance's status
  count, so no stored value past it leaves SQLite (`test/account-counts.test.ts`, `test/remote-collections.test.ts`
  ("takes a JSON number’s integer part, a negative as 0, and keeps the count past MAX_ACCOUNT_COUNT or for a
  non-number", "stores only counts storedCount keeps, and only on the remote account the round claimed")). The maxima
  count each at 2^53−1, 16 JSON bytes (`test/status-bounds.test.ts`); a dump or converted row holding another value
  presents 0. _Enforced (main)_ for featured hashtags' counts: `featured_tags.statuses_count`'s CHECK (`>= 0`) admits a
  TEXT or REAL of any size under INTEGER affinity, and `last_status_at` has no bound. Every read of a featured hashtag
  takes the count through `presentedCountSql`, the rule of account counts: a count that is not an integer from 0 to
  2^53−1 is presented as 0, by the API (`statuses_count` `"0"`) as by the Featured tab, and `GET /api/v1/featured_tags`
  ranks by that presented count, then by id. The time is cut to its first 40 bytes (the 10 code points of the date it
  presents, `byteCut` to `LAST_STATUS_BYTES` in `src/domain/featured-tags.ts`). So an imported value of any size leaves
  SQLite within those bounds (`test/featured-tags.test.ts` ("ranks an imported count as it presents it")); a list of an
  account's hashtags reads them in id order through `featured_tags_account_id` (migration `0078_featured_tags_order`),
  so a read that stops after its first rows reads no more of an import's (`test/web-featured-page.test.ts` ("reads a
  stored count or time of any size within its bound, for the page and the API", "reads no more rows as the same owner’s
  imported hashtags grow, with stale statistics")).
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
  profile URL (`url`, icon, image) over `PROFILE_URL_LIMIT` (2,048) is not stored, and an image (`avatar`, `header`) or
  its static shows only while its JSON is within `PROFILE_URL_LIMIT` bytes too, both defaults otherwise; the display
  name is cut at 2,048 code points, and a username over 255 is refused. Converted rows hold the same bounds (RES-2,
  stored values), so `ACCOUNT_COLUMN_MAP` reads the bio, display name and URLs as stored and cuts the username at 255
  code points; mentions read the username through the same projection (`src/domain/profile-bounds.ts`) and derive `acct`
  and a fallback url from the cut username; the admin account search reads candidates' ids and flags only and tests
  their text in SQL. The actor URI is bounded as stored (`ACTOR_URI_LIMIT`), read through `actorUriSql`, and refused at
  the cutover; the account's `uri` shows it only while its JSON is within `ACTOR_URI_LIMIT` bytes too
  (`withinIdentityBound`), and '' otherwise. An account that moved shows the account it moved to one level deep, read
  through `MOVED_ACCOUNT_COLUMNS` (`src/domain/account-columns.ts`): every text cut in SQL by its raw bytes and in the
  presenter by its decoded limit (the display name at 100 code points), URLs and actor id within 512 bytes, no note or
  fields, and the emojis its display name references within 2,048 bytes of JSON; one such row reads at most 12,432 bytes
  from SQLite (25,536 of heap, its cached emoji included) and presents at most 11,021 bytes of JSON, a target past
  every profile bound included
  (`test/status-bounds.test.ts` ("the moved-to account"), `test/account-moved.test.ts`). The chunk's targets are read in
  one query, each account presented with its target only when admission reaches it. One account is then at most the
  account occurrence of "Maxima of presented units" below, so a page of 80 serializes to at most 11.84 MB; realistic
  bios (Mastodon's 500 characters, Misskey's 1,500, Pleroma's and GoToSocial's 5,000 of
  Japanese with links) render to at most about 28 KB. Windowed account reads (followers, following, follow requests,
  `favourited_by`, `reblogged_by`) select ids for their window and read the profiles of the page only
  (`test/account-answer-bytes.test.ts`, `test/admin-accounts.test.ts`). _Enforced (main)_ for answers of many accounts
  (a list's members and endorsements with `limit=0`, familiar followers): the whole response body is at most
  `ANSWER_BYTES` (8 MiB, `src/domain/answer-budget.ts`), its own JSON reserved first, only an answer's first account
  standing alone past it; accounts are read in chunks of 50 that stop once it is reached, so at most one chunk (6.78 MB
  with their static images, their remote verification times and the accounts they moved to) is read past it. A
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
  filters, that pass reads one figure per candidate in SQL, one seek of `statuses` by key each
  (`filterTextUnitsSql`): the stored measure, or, for an unmeasured status, a bound from the bytes of its texts, its
  poll's choices (at most 100 parsed) and its at most 4 shown descriptions; no text reaches the Worker, and its work is
  bounded by the candidate caps (a context's 8,192), not by the answer budget (`test/filter-text-units.test.ts` ("the
  level pass reads figures, never text"), `src/domain/answer-budget.ts`, `presentation` and `presentStatusesWithin` in
  `src/domain/status-presenter.ts`, `src/domain/status-rows.ts`; `test/answer-budgets.test.ts`, `test/status-rows.test.ts`, `test/notification-budgets.test.ts`,
  `test/notification-group-budgets.test.ts`, `test/conversation-budgets.test.ts`, `test/account-page-budgets.test.ts`,
  `test/activitypub-budgets.test.ts`, `test/admin-reports.test.ts`). Streaming events stay one unit each, and an event
  over 512 KiB is skipped whole. The raw presenters (`present` and `hydrate` in status-presenter.ts,
  `presentAccountsById` and `presentAccount` in accounts.ts) are not exported, so the compiler refuses direct use
  outside their module; the exported paths present one unit or admit within a budget.
  _Enforced (main)_ for each presented status: the status columns of `STORED_COLUMNS` hold their stored bounds (RES-2)
  and are read as stored: content and source text within 128 KiB as a JSON string, a content warning within 16 KiB, a
  status url within 4,096 bytes, attachment URLs within 2,048, descriptions within 10,000 code points and meta within
  1 KiB, a blurhash within 54 bytes, and an edit's content, warning and choices the same. Columns that keep a read-time
  projection are read through their helper in `src/domain/status-bounds.ts` (accounts and actor ids through
  `src/domain/profile-bounds.ts`): a uri over 4,096 bytes reads as ''; at most 4 attachments per status; at most 200
  mentions and 70 hashtags (of the 100 stored) per status, the first by account id and by name; at most 100 poll choices
  of 1,000 code points; each edit-history snapshot's first 4 attachments rebuilt through the attachment bounds and '[]'
  over 308 KiB (four entries at their caps, at the worst escaping, `EDIT_MEDIA_BYTES`); a conversation presents its
  first 12 participants in stored order, cut in SQL. Every presented URL stays within its bound as serialized, derived
  or stored: a profile URL, avatar or header within 2,048 (a profile URL falls back from the stored one to the actor's
  origin and to this instance's `/@acct` page, and to '' when none fits), each of an attachment's four URLs within 2,048
  (4,098 JSON bytes; a remote attachment's `remote_url` and `preview_remote_url` are its `url` and its icon, read with
  whether its account is remote by key through `sqlite_autoindex_accounts_1`), live or in an edit's snapshot. A local
  status's `application` reads its app's name and website as stored, within 240 and 2,000 bytes and only as text
  (`appNameSql` and `appWebsiteSql` in `src/platform/stored-bounds.ts`, by key through
  `sqlite_autoindex_oauth_clients_1`), and presents them as decoded: a name of at most 60 code points within 240 bytes
  and 362 JSON bytes, else `application: null`; a website that is well-formed, holds none of the characters that end
  or split an HTML attribute or a URL (listed in [mastodon-deviations.md](mastodon-deviations.md), Posting), is within
  2,000 bytes and parses as an http(s) URL with a host, shown as stored, else `website: null`; registration refuses the
  same websites after trimming surrounding whitespace (`isAppWebsite` in `src/platform/stored-bounds.ts`;
  `test/statuses.test.ts` ("application"), `test/status-bounds.test.ts` ("status applications")). Each per-status cap
  reads at most its own number of rows, each status once, through an index that holds only the rows it shows:
  media_attachments_status (shown attachments), status_mentions_shown (mentions that are not silent, migration
  `0047_status_mentions_shown`) and status_tags.
  A hashtag name over 256 code units or 1 KiB among a status's first names read is left out rather than
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
  statuses within the answer budget, continued at the statuses it consumed (Budget, Offset), `/links` at most 20 links
  of at most 10,268 bytes each (205,381 a page); the Access admin's pages hold at most 20 hashtags, 40 statuses, 20
  links and 100 publishers, each field through its bounded projection; `test/trends-maxima.test.ts`,
  `test/trends.test.ts` ("reaches every status once").
- **RES-4: stored derived data is bounded.** Snapshots, the KV cache, the spool and deliveries each have a size cap, a
  count cap or an expiry with a sweeper. _Enforced (main)_ for remote statuses: one
  status stores at most 4 attachments (Mastodon's limit) with 10,000 code points of description each, 100 hashtags
  of at most 256 code units, 200 `status_mentions` rows (local accounts first; 100 `Mention` tags and 1,000 `to` and
  `cc` entries are read; a redelivery to a personal inbox keeps the bound, its owner taking a remote recipient's
  place, and so does an edit of a public or unlisted status that newly mentions and addresses a local account), 10,000 code units of content warning, and content cut at 50,000 code units before sanitizing; its history
  at most 100 versions (the newest edit replaces the last); an arriving parent links at most 100 replies that came
  before it; a boost at most 200 recipients; profiles show at most 16 fields. A deleted status is removed by a job
  (`inbound_jobs` kind `delete`) in batches of at most 500 rows, measured with `total_changes()`; the `Delete`'s own
  transaction hides it (its content and audience; at most three rows, apart from the budget) and the batches remove its
  mentions; a job whose status is not hidden yet (one an upgrade carried over) is hidden by its first batch with room.
  `src/domain/remote-statuses.ts`;
  `test/inbox-statuses.test.ts` ("caps the attachments, tags and content one status stores", "deletes a status with
  many children in bounded batches"), `test/inbox-statuses-edge.test.ts` ("RES-4: bounds at their limits", "writes at
  most … rows per batch, hiding included"). _Enforced (main)_ for status cards: one `status_cards` row per status
  (its primary key), deleted with the status inside its final delete's reservation and by the hide step of a remote
  delete; a pending row is dropped a day after it was enqueued, at most 500 a claim (an open hold kept until it ends),
  and a claim that never finished is given up after 2 (`src/domain/link-cards.ts`; `test/link-card-rounds.test.ts`
  ("expires at most CARD_EXPIRE_BATCH rows a claim", "keeps an open hold past the expiry, so a later round still
  defers its URL"), `test/cascade-guard.test.ts` ("trend and card rows within a batch"),
  `test/link-cards.test.ts` ("deletes the card with the hide when %i rows are left")). Card images
  (`card_images`, migration `0070_card_images`): one row per image URL a card names, at most one written by a record;
  a pending row is dropped a day after it was enqueued (at most 500 a claim), when no card names it, or after 2 claims
  never finished; a stored row no card names is collected by the claim's GC, at most 64 a claim from a cursor, each
  given a tombstone due at once, and only while fewer than 100 tombstones are due (the reconciliation's batch), so
  the GC never holds the due backlog past 163 of its own and never delays an upload's tombstone by more than its pause
  (`src/domain/card-images.ts`; `test/card-images.test.ts` ("collects at most CARD_IMAGE_GC_WALK unreferenced stored
  rows a claim", "pauses while CARD_IMAGE_GC_BACKLOG tombstones are due", "reads at most CARD_IMAGE_GC_WALK stored rows
  past 100,000 pending ones"), `test/card-image-rounds.test.ts` ("pauses the GC at the backlog while upload and claim
  tombstones drain, then resumes")). Each claim inserts a tombstone due 24 hours after its 5-minute hold, deleted when
  the image is stored; a put still running past the claim is deleted by reconciliation through it
  (`test/card-image-rounds.test.ts` ("keeps a held claim’s tombstone and object until delete_after")). Uploads and
  claims stay within reconciliation's 28,800 tombstones a day for N local accounts when 1,440 N + 864 ≤ 28,800, that is
  N ≤ 19 (admin emoji reservations are not rate-limited). A row's card type and dimensions and its video's iframe src
  and dimensions (migration `0069_card_embeds`) are bounded by its triggers (a src of 512 bytes, 512 once escaped;
  integers within 0 to 65,535), for imports too. The oEmbed endpoint cache
  (`card_oembed_endpoints`) holds one row per host, written only by a record and only while it holds fewer than 2,048
  rows (counted over at most 2,048 index entries), each live for 24 hours; a claim deletes at most 100 rows by its
  expiry index, the expired first, then those written for past the window (an import's), so an import's excess
  expires too (`src/domain/link-cards.ts`; `test/link-card-rounds.test.ts` ("keeps at most OEMBED_ENDPOINTS_MAX rows",
  "expires at most OEMBED_EXPIRE_BATCH rows a claim, the expired first", "reads a bounded number of rows for the
  lookup, both expiry ends and the capacity, after ANALYZE and growth"), `test/migrations.test.ts`
  ("defaults the existing rows without rewriting them, then bounds every new column as stored")). The remote media
  cache (migration `0077_remote_media`, MEDIA-7): at most one slot per account and kind, and at most 20,000 pending
  slots (an enqueue past it waits for the backfill); a slot pending more than a week is dropped (at most 500 a claim);
  its bytes in R2 within `REMOTE_MEDIA_CACHE_BYTES`; each maintenance call does at most 500 deletions, 500 validity
  checks, 200 suspended slots, 200 reclaimed objects and 200 backfilled accounts (`src/domain/remote-media.ts`;
  `test/remote-media.test.ts` ("changes the pending count by the old-to-new state delta at the pending limit", "expires
  slots pending more than a week, never one under an open hold"), `test/migrations.test.ts` ("0077_remote_media")).
  _Enforced (main)_ for snapshots: `test/snapshot.test.ts` ("snapshot caps"). KV
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
  new key; the round orders its writes delete, update, insert; a stored link without a qualifying copy is dropped
  before the pools fill; `test/migrations.test.ts` ("0057_trends", "0071_link_trends"), `test/trends-round.test.ts`
  ("retention", "caps"), `test/trend-links-round.test.ts` ("allowance and the pools", "keeps 200 allowed and 50
  for review").
  _Enforced (main)_ for the instance activity: `activity_counts` and `activity_logins` keep today, the 184 days before
  it and tomorrow (186 days; Mastodon's 6-month expiry), so a Store whose prune has caught up holds at most 2 × 186
  counter rows and one login row per account and kept day; a restored or imported backlog stays until the prune reaches
  it. The 5-minute cron deletes at most 500 rows of each table outside those days a run, oldest first, each range read
  by the table's key, so an imported backlog of old or later days clears and a run that finds one deletes at least one;
  in the Store's maintenance or readonly state it waits. The day's answer is one `kopje_state` row (`activity_answer`,
  never dumped). `pruneActivity` in `src/domain/instance-activity.ts`; `test/instance-activity.test.ts` ("keeps today,
  the 184 days before it and tomorrow, and the cutoff moves with the day", "prunes by key at most 500 rows a table a run
  at the worst case, with stale statistics").
- **RES-5: retries are bounded, but maintenance is not a failure.** Waiting out maintenance consumes no processing
  retry; real processing errors count against `max_retries`. _Enforced (main):_ `src/jobs/queue.ts`; `test/gate.test.ts`
  ("spool consumer"). Deliveries give up after 15 attempts (`min(30s·2^n, 12h)`, n the attempts so far) or at once on a
  permanent answer (Mastodon's rule: 4xx except 401, 408 and 429, and 501), and are listed and retried through
  `/admin/deliveries` and `kopje-admin deliveries`; in maintenance nothing is claimed, so no attempt is counted. An
  activity a later one about the same object follows (an `Undo`, `Delete` or `Update`) is superseded and never sent
  again: naming it answers 409 `superseded`, and `--all` skips it, choosing eligible rows before its batch limit and
  continuing from the cursor it returns (`test/delivery-regressions.test.ts` ("refuses to retry a Like that its Undo
  has superseded"); `test/delivery-verify.test.ts` ("operator retries", "the `all` cursor")). So is a follow answer
  that a later `Follow` of its pair superseded under its lease (it is dropped, never given up), and one it cancelled
  is gone (`test/follow-answers.test.ts`).
  _Enforced (main):_ `src/domain/deliveries.ts`, `src/jobs/deliver.ts`;
  `test/deliveries.test.ts` ("retries after min(30 s·2^n, 12 h)"), `test/delivery-post.test.ts` ("RES-5: claims
  nothing and counts no attempt in maintenance"), `test/cli.test.ts`. Spool messages: _Enforced (main):_ a message whose
  retries run out goes to the dead-letter queue (OPS-10), where it is kept for inspection, and a request refused for
  good (401, 404, 415) is dropped as the live inbox answers it (`handleQueue` in `src/jobs/queue.ts`, the consumer's
  `dead_letter_queue` in `wrangler.jsonc`); `test/gate.test.ts` ("retries, and so counts against max_retries, only on
  real processing errors"). Jobs rounds: _Enforced (main):_ a jobs message is only a nudge, as the jobs and their
  progress are durable in the Store: it is acked and never retried, and a Queue batch runs at most one jobs round
  however many jobs messages and spool replays with pending jobs it holds, so it sends at most one jobs message for the
  next round (a live inbox request still sends its own). A round has seven error boundaries: five Store calls (the
  inbound jobs with the stamp revocations, the domain block cleanups, the notification request jobs, the local and
  remote moderation jobs in one, the unlock acceptances), then the Worker's collection syncs and quote verifications,
  each its own round of Store calls and fetches. The deliveries the Store calls recorded are rung once, before the
  Worker's fetches. A family that fails is logged (`kopje.jobs.family.failed`), counts as having no work left, and
  stops no other family (the next resolves a new stub); a Store refusal (maintenance, a retryable or reset error) ends
  the round and counts nothing, and cron runs the next. A call the platform terminates (a CPU or memory limit) fails
  its own family only, or ends the round when it surfaces as a retryable or reset error; either way that family's
  first item is selected again. `jobsRound` and `handleQueue` in `src/jobs/queue.ts`; `test/job-families.test.ts`
  ("failing stops no family outside its Store call", "ends the round at its first Store call while the Store is
  readonly", "runs one round and sends at most one jobs message for 3 jobs messages and 5 such replays", "keeps its own
  nudge, and its job runs in the next round", "runs the quote verifications when every Store family and the collection
  syncs throw", "rings for the Store calls’ deliveries before the collection syncs fetch", "ends the round at a
  retryable refusal after an earlier family reported pending", "gives the family after a failure a newly resolved
  stub"). Inbound jobs: _Enforced (main):_ each batch of a purge, `Move` or status deletion runs in its own savepoint
  (`runJobBatch` in `src/domain/inbox.ts`, `isolated` in `src/domain/job-attempts.ts`); a batch that throws a
  recoverable error (a JavaScript exception, or an SQLite statement error that leaves the transaction usable, as a
  `RAISE(ABORT)` or a CHECK does) is rolled back alone, and one that leaves work and moved nothing (a stall: no
  progress write changed a row, or a `Move`'s cursor did not advance, compared in SQL) is counted too. Either is
  recorded on the job (`inbound_jobs.attempts`, `due_at`): it runs again after 5, 10, 20, 40 and 80 minutes, and the 6th
  consecutive one parks it, never selected again; a batch that advances makes it fresh again. A round takes the first
  due retry, else the oldest fresh job, and runs no batch while every job is parked or backing off. The attempt is
  written in the enclosing Store operation's transaction after the savepoint rolled back, so it commits or rolls back
  with that operation: a request's own writes (its retraction, the status's hide, the job row) commit with a failed
  first batch, and an operation rolled back whole records no attempt. Waiting out maintenance counts none: a round
  refused by the Store runs no batch. Logged as `kopje.jobs.item.failed` (`outcome` `error` or `stall`, the count, and
  whether it parked) and `kopje.jobs.item.parked`, by family only (DATA-5). A parked job fails safe: a parked deletion
  keeps its status hidden (each batch hides it first, outside its savepoint), a parked purge keeps the actor's
  tombstone and its account unavailable. The exception is a deletion job that arrives already parked (an import's)
  naming a status never hidden: no round selects it, so the status stays shown until a delivery of its `Delete` hides
  it at once, or retry-all makes the job runnable and the next round hides it (`test/inbound-job-isolation.test.ts`
  ("leaves an imported parked job’s status shown until a delivery or retry-all")). Not guaranteed: a
  termination no code can catch (the CPU or memory limit, an isolate reset, an error after which SQLite rolled back
  the whole transaction) records nothing, so its batch is selected again in the next round; it is confined to its
  family's Store call (above). `kopje-admin jobs retry` (`POST /admin/jobs/retry`) makes every failing job fresh,
  100 a call until none is left, keeping the rest of its state (cursor, bound, tombstone), and asks for a jobs round
  when it reset any; run it after a fix for the jobs parked before it. `test/inbound-job-isolation.test.ts` ("parks a
  permanently failing first job after MAX_JOB_ATTEMPTS while a purge, a Move and a delete behind it finish", "runs
  imported retry states as stored, and the CHECKs refuse every other pair", "counts no attempt while the Store is in
  maintenance", "rolls a failing first batch back after its writes, and commits the Delete’s retraction and hide",
  "retry-all"), `test/cli.test.ts` ("makes every failing job fresh, a page at a time"). The other job families:
  _Enforced (main):_ each batch or round of a stamp revocation, a domain block cleanup, a notification request job, a
  clear's or group dismissal's removal and a local or remote moderation job runs in its own savepoint (`runJobItem`
  in `src/domain/job-attempts.ts`), with the same retry state on its row (migration `0084_family_job_attempts`): one
  that throws is rolled back alone and recorded, backs off and parks as an inbound job does, and the next item runs.
  Their batches always move a cursor, a phase or a row on, or end their item, so only a failure counts. An item's
  retry state writes one row after its batch (its attempt, or the reset of a due retry that runs through): the tokens
  and severing rounds and a revocation call reserve it within their row budgets (RES-6); a cleanup's, a request job's
  or a removal's batch writes it beside the rows it changes. Read as TEXT, bound back with `CAST` and compared in
  SQL (DATA-6), so an imported id past 2^53 neither names another row nor stalls or skips a batch: the integer keys of
  these job rows; a domain block cleanup's follow cursor and bound; the local and remote moderation jobs' follow bound,
  their followers' cursor and the severing cursor; a notification request job's cursor and the notification ids it
  reads; a clear's or dismissal's mark. A request job's cursor is inclusive, the highest notification id it still
  reads: it starts at the newest notification and goes on below its window's lowest, so no cursor passes an INTEGER's
  range. The other values these jobs carry (action bounds, credential epochs, subscription ids) are not covered here.
  A round takes the first due retry, else the oldest fresh item (the moderation tables taking turns, a call's fresh jobs
  each in turn), and asks for another only while one may run. A request's first batch is such an item, so its failure
  leaves the request committed and its item backing off: a domain block and its cleanup, the answered notification
  requests with their permissions and jobs, a clear's or a dismissal's mark (which R15 applies at once), a stamp's
  revocation and its `Delete`'s retraction. A parked item fails safe: a moderation job keeps its staged inboxes and its
  generation, and a parked domain job keeps the admin's lists answering 503 (R38); a removal keeps its mark; a cleanup
  keeps its block. A new decision makes a parked job fresh: an admin's suspension of the account, a domain block's
  transition into or out of suspend, a clear or dismissal raised to a newer notification; one that changes nothing (a
  block set to the severity it has, a clear with nothing newer) leaves it parked. An unlock acceptance keeps no retry
  state: an authorization that throws is rolled back alone and logged (`kopje.jobs.step.failed`), and its request, which
  the cursor has passed, stays pending for the account to authorize by hand, once. Retry-all walks every family's table,
  the inbound jobs first, at most 100 rows a call in all. `test/family-job-isolation.test.ts` ("parks a
  permanently failing first item after MAX_JOB_ATTEMPTS while the item behind it finishes", "runs imported retry states
  as stored", "a new decision on a parked job", "a due retry that runs through", "retry-all over every job table", "job
  ids past 2^53", "the selection order"), `test/job-families.test.ts` ("its first item failing is recorded on it, and
  stops no other item"), `test/unlock-accepts.test.ts` ("passes over its request, which stays pending", "authorizes a
  request once when"), `test/quotes.test.ts` ("commits the Delete and its revocation when the first batch fails", "ends
  3,000 completable revocations", "stops a run of revocations that each fail before any write"), `test/blocks.test.ts`
  ("records the block and its cleanup when the request’s batch fails"), `test/notification-policy.test.ts` ("commits the
  answers when one job’s first batch fails in a bulk accept"), `test/notification-clears.test.ts` ("commits the mark
  of", "makes a parked clear fresh when a newer notification raises it"). Web Push: _Enforced (main):_ the deliveries'
  schedule and limit, a push older than 48 hours is dropped, a 4xx other than 408 and 429 (or an endpoint the sink
  refuses outright) deletes the subscription and its pending pushes, as Mastodon 4.5 does, and nothing is claimed in
  maintenance or without a `VAPID_JWK`; at most 1,000 pushes wait (`MAX_PUSH_BACKLOG`): a notification gets only the
  room left, counted in its transaction, however many subscriptions want it (RES-4). `src/domain/push.ts`,
  `src/jobs/push.ts`, `queuePushes` in `src/domain/notifications.ts`; `test/push-send.test.ts` ("retries a failure with
  the deliveries’ backoff and gives up after their limit", "deletes the subscription and its pending pushes when the
  push service answers", "keeps the subscription and retries when the push service answers", "sends pushes from the
  delivery doorbell, and not without a VAPID_JWK or in maintenance", "RES-4: a notification fanned out to several
  subscriptions fills the backlog only up to its cap", "records no push beyond the backlog cap"). _Enforced (main)_ for
  local emoji: `GET /api/v1/custom_emojis` holds at most 1,000 entries of at most 1,489 JSON bytes each with its
  separator, 1,489,001 bytes in all, admitted whole within `ARRAY_ANSWER_BYTES` (`test/local-emoji-api.test.ts` measures
  it); `GET /admin/emojis` pages hold at most 200.
- **RES-6: one request cannot trigger unbounded work.** An inbound activity has fixed limits on dereferences,
  recipients, collection expansion and notifications. The revision fence (ID-1) adds no additional inbox receive
  round; a stale-author refresh fetches its actor again after reading the revision, within the fetch budget. Search
  resolution makes one more Store call (`actorRevision`) before each actor fetch, and fetches a URL's actor document a
  second time after it (within the request's fetch budget of 8). Every revision read is one seek by `accounts`' uri
  index, pinned with `INDEXED BY` (RES-7): the inbox gate's actor and `Move` target, a refresh need's and a quote's
  author stage's author, a search resolution's actor, and the comparison in the writing transaction
  (`test/inbox-actor-revision.test.ts`, "the revision reads’ plans"). Delivery backlog and concurrency are bounded.
  Anonymous app registration, inbox spooling and media transformations have rate or storage budgets with a visible
  refusal. Inbox spooling: _Enforced (main):_ the spool's budget (RES-4), refused with 503 (`createAdmission` in
  `src/federation/spool.ts`; `test/maintenance-worker.test.ts` ("in Kopje's own maintenance gate: the same budget,
  failing closed")). Domain blocks: _Enforced (main):_ a domain block's cleanup scans at most 500 follows
  per batch and does at most 4 batches a round, failed ones included, its first batch in the request, so blocking a
  domain stays bounded however many follows the user has, and always succeeds, also when that batch fails (RES-5;
  VIS-15, `test/blocks.test.ts`). Local suspension: _Enforced (main):_ the suspension's transaction writes a fixed
  number of rows whatever the account's history; its work runs in durable `moderation_jobs` rounds, the moderation
  family of the jobs round (its own Store call, RES-5), where local and remote jobs take turns, at most 4 rounds a run,
  failed ones included. The tokens job deletes an earlier epoch's token's push deliveries, then its subscription, then
  the token (`TOKEN_CHILDREN`, which the cascade guard keeps complete), so no delete cascades, at most 200 rows a round
  (`total_changes()`, its own row and its retry state's row included). The suspension job resolves at most 100 reports a
  round, then stages the `Update`'s audience (its followers, its reporters, the accounts it mentioned and followed) into
  `moderation_reach` from indexed ranges, 500 rows a round, each source capped as Mastodon's `AccountReachFinder` caps
  it, then writes the inboxes as the `Update`'s targets and deletes their staging rows, 500 a round; every round writes
  at most 600 rows, its retry state's row included (a severing round reserves it from its budget), and each cursor is
  persisted, so every round makes progress (`src/domain/suspension.ts`; `test/admin-suspension.test.ts`: a history of
  600 tokens, 250 subscriptions and 650 pushes, and 10,000 followers, each round within its budget, also as a due retry;
  `test/remote-suspension.test.ts` ("stays within the budget as a due retry", "stays within the budget when a round
  fails after its writes")). App registration: _Enforced (main):_ `POST /api/v1/apps` is limited to 5 per minute per
  client IP by the Workers Rate Limiting binding before its body is read (429), and the Store keeps at most 500
  never-authorized apps; when full it first removes unused ones (no token of any kind) older than a day, then the
  oldest never-authorized ones older than an hour (app tokens and all), and otherwise refuses with 429. An app is
  authorized once a user's code is issued for it (`oauth_clients.authorized`, migration `0086_authorized_apps`, set in
  the code's transaction), and stays so when its codes and tokens go (revocation, suspension, expiry): it is never
  counted, evicted or swept, as Mastodon 4.5.11 never removes an application, so a client that kept its `client_id`
  signs in with it again. Authorized apps need no cap: a code is issued only on a local user's consent behind a verified
  Access assertion (AUTH-4), so each is one user's action, and no request without a user marks an app; an app token
  (client_credentials) never does, since anyone can get one without a user and the budget could then be filled for
  good. The budget's count, removals and sweep walk the partial index `oauth_clients_pending` and remove each app by its
  key, so they read no authorized app (`test/apps-budget.test.ts` ("walks the pending apps by their partial index and
  marks an app by its key")). The cron removes unused never-authorized apps after a day (Kopje's own removal, which
  Mastodon 4.5.11 does not make: [mastodon-deviations.md](mastodon-deviations.md), Posting), and expired codes and web
  sessions, 500 of each per run. `registerApp` and `sweepOAuth` in `src/domain/oauth.ts`, `src/mastodon/oauth.ts`;
  `test/apps-budget.test.ts`. Avatar and header uploads, from `update_credentials` and the settings page alike, go
  through the media budgets below, one reservation and three transformations each, at most 8 MB each. Unlocking an
  account: _Enforced (main):_ the update starts a cursor job (`local_accounts.accept_requests_after`) instead of
  accepting in the request; each job round authorizes at most 20 requests, each in its own transaction through the
  single authorize path (its delivery admission and recount included), and every step advances or clears the cursor,
  also when its authorization throws (RES-5) (`src/domain/unlock-accepts.ts`; `test/unlock-accepts.test.ts`: 250
  requests in rounds of at most 20). Profile link verification: _Enforced (main):_ a save only arms a check
  (`local_accounts.links_due_at`); the cron runs one round per tick, which claims one account (at most one claim per
  account per 5 minutes, the claim's hold, which a save during it waits out) and reads at most 64 due rows to find it
  (no index: local accounts are operator-sized). Its at most 4 values share one budget of 60 subrequests (each value's
  GET and HEAD through the web-page sink at their ceilings, NET-3) and 20 pre-DNS policy reads, charged by the sink, and
  make at most 20 post-DNS admissions (one per hop) within 50 seconds, and its scan output is at most 67,648 UTF-16 code
  units; its own Store calls are one claim, at most 4 records and one finish, and the whole round ends within 60
  seconds (a Store call is not started past its deadline, and a result that arrives past it is not used). Every
  value a round checks is recorded, a value checked and not verified in `local_accounts.unverified_links`, which a
  save clears, so no later claim of the same save checks it again; a finish schedules a next check while a value is
  left, judged from the stored state. One value's check at its ceiling (15 seconds) fits the 50 seconds, so a round
  whose claim answers with that much and a record's time still left before the checks' deadline checks at least one
  value, and a save's values are all checked within 4 such claims, at least a hold apart; a claim that answers later
  leaves its values due again after the hold. A claim that never finishes is given up after 2
  (`src/domain/field-links.ts`, `src/federation/field-links.ts`; `test/field-links.test.ts` ("coalesces saves into one
  claim, at most one per account per hold", "runs a maximum round within its budget and deadline, %s bodies", "ends
  the whole round within 60 seconds, its finish included", "derives the scan output and the budgets of a round",
  "reads at most FIELD_LINK_CLAIM_WALK due rows a claim, each making progress", "gives up after two claims that never
  finished", "checks the values a round could not reach, and not those it checked, after the hold", "checks every
  value once per save when every value is slow and unverified", "checks every value once over imported columns full
  of values the fields do not hold", "keeps a value due when a save during the claim clears its negative")).
  Remote accounts' fields share that round, its budgets and its own Store calls: a store of a remote actor's document
  arms its row in its transaction with at most 2 statements and 1 row written (4 and 2 for a Move or an Announce, which
  store two actors); every claim first expires checks armed a day ago, reading at most 500 candidates by
  `remote_field_links_expiry` before the open-hold filter (a held candidate takes a slot and is kept, so a later expired
  row waits for a batch that reaches it, and the walk checks every row's age again), then walks the local accounts,
  and only when that walk found no work and did not read its whole 64 rows walks at most 64 due remote rows by
  `remote_field_links_due`, each row read disarmed, rescheduled to its hold, given up after 2 claims, deleted (a token
  past 2^53 − 1) or claimed: a claim writes at most 628 rows, after `ANALYZE` and growth alike
  (`test/remote-field-link-rounds.test.ts` ("expires the oldest REMOTE_LINK_EXPIRE_BATCH rows a call, and the walk the
  501st", "expires rows whose hold is NULL, and keeps an expired due row with an open hold and its claim",
  "expires remote rows while the local walk uses its whole allowance, and claims no remote row then", "reads at most
  REMOTE_LINK_CLAIM_WALK due rows a claim, each making progress", "seeks the expiry, the walk and the fences by their
  indexes and keys, after ANALYZE and growth"), `test/remote-field-links.test.ts` ("stores at most two actors’ rows in a
  Move, with at most two statements each")). At most 288 claims a day, shared with local accounts.
  Status cards: _Enforced (main):_ a write only enqueues its status's link (`status_cards`, in its own transaction);
  the cron runs one round per tick. Its claim expires at most 500 pending rows, then walks at most 64 due rows by
  `(due_at, status_id)` in order and stops at 6 claims, leaving the rest untouched; each row walked is deleted, attached
  from another status's fresh copy (an existence-gated update by key: no donor writes nothing), deferred to another
  row's open hold on its URL, or claimed for 5 minutes (twice the round); with at most 100 cached oEmbed endpoints
  expired, a claim writes at most 664 rows, and each claimed row reads its host's cached template by key. The URL
  lookups seek `status_cards_fresh` on `(url, fetched_at > cutoff)` and `status_cards_claimed` on `(url, due_at > now)`
  with the partial index's own predicate, so stale copies and expired holds of the URL are not read, after `ANALYZE`
  and growth alike. A claim makes at most two GET chains (up to eight HTTP GETs, each chain at most 3 redirects), 3
  claims at a time: 6 × 2 × 10 s ÷ 3 = 40 seconds within the
  fetches' 50. The claims share 144 DNS and HTTP subrequests (12 chains at `WEB_PAGE_MAX_SUBREQUESTS`: at most 48
  requests and 96 DNS lookups) and 48 pre-DNS policy reads, charged by the sink, and make at most 48 post-DNS
  admissions (one per hop); its own Store calls are one claim (the cache lookup inside it) and at most 6 records or
  releases (the cache write inside the record); the whole round ends within 60 seconds. At most 1,728 network claims a
  day, 3,456 GET chains and at most 13,824 HTTP GETs; attachments from a copy are not counted there. Memory per claim, as the round's test computes it,
  the larger of its two phases, which never overlap: the page (the 1 MiB prefix, the scan's strings: 632,896 code
  units with 64 links, 1,265,792 bytes; one JSON-LD script being parsed, 65,536 bytes, and its parsed value, 393,208
  bytes at its worst shape, a V8 size estimate: 2,773,112 bytes) or the endpoint (its 64 KiB body buffer and copy, the
  decoded text, its parsed value at its worst shape, 786,424 bytes, the iframe capture's input and captured
  attributes, the page's fields kept at their stored bounds with the endpoint and template, 9,239 code units, and the
  expanded URL: 1,205,335 bytes); 2,773,112 bytes a claim, 8,319,336 for the three at once; lol-html's native buffers,
  `JSON.parse`'s internals and htmlparser2's parser state are not counted, and the prefix's, the body's and the scan's
  caps are counted as they are read
  (`src/domain/link-cards.ts`, `src/federation/link-cards.ts`; `test/link-card-rounds.test.ts` ("claims the first
  CARD_ROUND_CLAIMS rows of seven and leaves the seventh untouched", "walks at most CARD_CLAIM_WALK due rows, deleting
  each one given up, the 65th left for the next claim", "defers a row whose URL another row holds, within one walk and
  across rounds", "deletes a row whose next token would pass SAFE_INTEGER_MAX, and claims one that reaches it", "reads
  a bounded number of rows for each lookup by URL, after ANALYZE and growth, hit and miss", "derives its budgets and
  hold", "computes the memory model of a round from its bounds", "the cold path: %s", "the cached path
  fetches the endpoint first, then on a fallback the page only, and never writes")).
  Card images: _Enforced (main):_ a record links its card's image in its own transaction (`status_cards.image_id`);
  the cron runs one round per tick (`src/federation/card-images.ts`). Its claim runs at every share
  (`IMAGES_CARD_MONTHLY_TRANSFORMS`, default 0: no fetch and no Images call, while the expiry and GC still run): it
  expires at most 500 pending rows, collects at most 64 stored ones (RES-4), then walks at most 64 due rows by
  `(due_at, id)` and stops at 3 claims, the tokens or the month's share. Each claim runs alone within 16 seconds (3 ×
  16 within the fetches' 50), every Store call and binding call and every output read under its deadline: one GET of
  at most 4 hops (12 subrequests, 4 policy reads before DNS and 4 after), four Images calls (a free preflight
  `info()`, the WebP output, its `info()`, and the RGBA output of the same input and transformation for the blurhash),
  one R2 put and five own Store calls (an admission before the preflight, a charge right before each output, one
  before the put, and the record, each a write the Store refuses in maintenance, the env's maintenance checked first).
  A 9422 from any Images call (after the WebP is checked, the image is kept without a blurhash), a lost claim, a share
  used up before either output, or a call given up at its deadline stops the round's further claims, which are
  released within the 10-second finish window; a call given up (Images or the put) keeps its memory, so no claim of
  this or a later round starts until it settles. Per round 36 subrequests (12 requests, 24 DNS lookups), 24 policy
  reads, 12 Images calls, 3 puts and 16 own Store calls; at most 864 claims a day, the month's capped by the share.
  Memory, as the test computes it from the bounds: a claim's body buffer (8,388,608 bytes), WebP output buffer
  (524,289), RGBA output buffer (1,048,577) and blurhash fit (40,000), 10,001,474 bytes (18,390,081 on the Blob path,
  which the local binding does not need), with the card round's 8,319,336, the field links' 2,232,449 and the remote
  media round's 31,457,276 (three lane 0 files, each a body buffer of 2,097,152 and a still of 2,097,151, and one lane 1
  file beside them: an attachment image's body buffer of 16,777,216 and still of 2,097,151, 18,874,367, more than a
  streamed file's 1,048,576-byte prefix, the rest of which goes to R2 as it is read; a put given up keeps its file's
  buffers, and no claim starts until it settles), 52,010,535 bytes in all (60,399,142 on the Blob path), within the
  64,000,000 allowed (`test/cron-memory.test.ts` ("stays within half the isolate", "reads the largest RGBA output a
  checked WebP allows into one buffer", "reads a remote file into one buffer of its kind's cap + 1 bytes, and its still
  within the still cap"), `test/remote-media-rounds.test.ts`
  ("starts no further claim in the round once a put was given up"),
  `test/card-image-process.test.ts` ("reads the RGBA within 4 × w × h bytes, refusing one more while it is
  read"), `test/card-image-rounds.test.ts` ("9422 leaves the claim unattempted", "9422 from the RGBA output keeps the
  image without a blurhash", "stores an image without a blurhash, and stops the round, when the share runs out between
  its outputs", "an RGBA output given up keeps its slot", "cancels an RGBA read given up", "a stalled
  put is unattempted", "starts nothing further once the Store enters maintenance at %s", "derives its budgets, windows
  and the daily claims")).
  The cron invocation (`src/worker.ts`) runs its tasks in parallel `waitUntil`s that share one invocation. The bounded
  contributors, a subtotal and not a bound of the invocation: field links at most 20 requests and 40 DNS lookups, 40
  policy reads and 6 own Store calls; status cards at most 48 requests and 96 DNS lookups, 96 policy reads and 7 own
  Store calls; card images at most 12 requests and 24 DNS lookups, 24 policy reads and 16 own Store calls, with 12
  Images calls and 3 R2 puts; remote media (`src/federation/remote-media.ts`) at most 120 requests and 240 DNS lookups
  (30 files of at most 4 hops: 24 in lane 0, 6 in lane 1), 240 policy reads and 96 own Store calls (6 a round and 3 a
  file), with 60 R2 puts, 100 heads, one list and three deletes; quote verification (`runScheduledJobs`) at most 400
  requests (`QUOTE_ROUND` 10 × `QUOTE_STAGES` 5 × `REQUEST_MAX_FETCHES` 8) and collection sync at most 16
  (`COLLECTION_SYNCS_PER_ROUND` 2 × 8): 616 requests, 400 DNS lookups, 400 policy reads and 125 own Store calls
  (`test/remote-media-rounds.test.ts` ("makes the derived own Store calls and puts through a full round of files with
  stills")). Contributors with no stated
  bound, not counted:
  the DNS lookups of
  quote verification and collection sync (the loader reads the policy and checks DNS before it charges a fetch,
  `src/federation/loader.ts`, so a load its budget refuses still looks up; at least two per request, 832 for their 416,
  with no counter on the rest), their Store calls (claims, work, completion, signing keys, policy reads), the other
  tasks' Store calls, the media sweep's R2 operations, Queue sends and the backup (which has no request counter). No
  invocation-wide counter is kept, so nothing here bounds the invocation's total against Workers Paid's 10,000
  subrequests.
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
  and charges three transformations (the full image, the preview and the preview's RGBA, which Images may bill as one
  with the preview, so the count is a ceiling) to the month they run in, against an instance budget per UTC month
  (`IMAGES_MONTHLY_TRANSFORMS`, default 4,000, under the 5,000 of the Images free plan) and against the account's
  monthly share of it (`IMAGES_ACCOUNT_MONTHLY_TRANSFORMS`, default a tenth), so one account (R4) cannot lock the
  others out; every refusal answers 429, and a used-up Images allowance answers 503 when it refuses a required output
  (the input's `info()`, the full image, the preview or their `info()`); a 9422 from the preview's RGBA output alone
  keeps the upload, answered 200 with a null blurhash. A custom emoji charges two, and a rebuilt row what its writer was
  charged (two for an emoji's, three for any other), to the instance budget only. Card images (A11) draw on their own
  monthly counter (`IMAGES_CARD_MONTHLY_TRANSFORMS`, default 0), one transformation charged right before each Images
  output, two an image (its WebP and its RGBA, which Images may bill as one transformation, so the count is a ceiling),
  never on the uploads' budget, so cards cannot refuse an upload; the two ceilings' sum is what the account's Images
  allowance must cover (docs/setup.md), and the stored images cost R2 storage and operations apart from it, at most 512
  KiB each. Unattached uploads are deleted after a day by a sweep of at most 100 per run. `reserveMedia` in
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
  _Enforced (main)_ for remote accounts' collection syncs (`src/federation/collections.ts`,
  `src/domain/remote-collections.ts`): each round runs one sync within a budget of its own, at most
  `COLLECTION_SYNCS_PER_ROUND` (2) rounds a call. Each part of a read fits one budget with a redirect on each of its
  documents (featured 2 documents, network 3: the following, followers and outbox collections, featuredTags 4), and
  the network part's documents are read with at most one redirect and 512 KiB each (`NETWORK_CAPS`): 6 fetches and
  1.5 MiB, so its outbox never starves behind the other two. A generation starts with every stored actor document (an
  `Update`, a key miss or rotation, an authenticated resolve, any other fetch of the actor), and pending work coalesces
  per actor (one `collection_syncs` row, `requestCollectionSync`); no admission policy limits how often an actor's
  document is stored. One generation makes at most 552 requests: 9 read claims (3 parts × `MAX_SYNC_ATTEMPTS`) and 60
  pin claims (`MAX_REMOTE_PINS` × `MAX_SYNC_ATTEMPTS`), each of 8 fetches; the network part takes at most 6 a round and
  54 a generation, and 3 documents when nothing fails (`test/remote-collections.test.ts` ("bounds them before and after
  the network part reads the outbox", "the network part within one round")).
  A `Follow` reads at most 33 unsettled answers of its pair, of them at most 65 delivery rows, including exposed rows,
  and 33 unexpanded chunks, so it admits at most 32, 64 and 32, and cancels at most those (NET-2); over any bound it
  answers 503 and writes nothing (`followAnswersOf` in `src/domain/deliveries.ts`). A `Follow` within the bounds
  clears its pair's given-up answers at once with the rest; a history already over the bound (an imported or upgraded
  store) clears as its answers deliver and as the sweep deletes their given-up rows (RES-4), and a server whose own
  retries of the `Follow` run out before then needs its user to follow again (`test/follow-answers.test.ts` ("bounds and
  refusals")). A Move moves 100 followers per batch and carries at most 100 blocks and mutes; a deleted actor's purge
  writes at most 500 rows per batch in all, every write counted (SQLite's `total_changes()`): deletions, counter
  recounts (`followers_count`, `following_count`, `statuses_count`, status counters) and the Undo intent of a withdrawn
  boost with its target chunks. The account is
  unavailable from the first batch's transaction on (VIS-1), so the order of the steps shows nothing of it, and no
  boost of its statuses is accepted and no status of it fetched while it lasts. Its follows, notifications, mentions
  and other relationships go first; then local boosts of its statuses, each withdrawn once: the Undo intent is recorded, then its targets
  (the boost's receipts among them) are staged over as many batches as they need (below), the receipts kept until all
  are written (`beginRetraction` and `stageRetraction` in `src/domain/deliveries.ts`); the delivery rounds
  expand them 100 at a time; then the purge deletes the receipts a batch at a time before the boost and its
  booster's recount; then its statuses, each
  deleted only after its children (edits, media, mentions, tags, favourites, bookmarks, notifications, receipts,
  boosts, reply links), so no delete cascades. A proven `Delete` of a remote original records, in its first
  transaction and apart from the batch's budget, at most `MAX_FORWARD_OWNERS` forward intents of at most
  `FORWARD_BODY_MAX` bytes of body each and the job's `bound` naming them, and runs no batch when it recorded one. The
  transaction then writes at most 684 rows: 400 of the receive's sweep (`SWEEP_BATCH` of each of four sources) before
  any handler, and the handler's 284 (the retraction, the deleted object and the job; the streaming capture's 258; the
  hide's 3; the quote's retirement, 3; the 16 intents and the bound), which a witness holding them all at once writes
  exactly; the intents' envelopes and the bound are at most 1,050,686 bytes (not every column of the transaction:
  `test/forward-delete.test.ts` ("records MAX_FORWARD_OWNERS intents within the derived bytes and rows")). The
  constants bound the owners and the body bytes, not the fan-out, which is each booster's followers and its boost's
  receivers, staged within `PURGE_BATCH` as a boost's `Undo` is. The job's `bound` is read within 512
  bytes and used only as a list of at most 16 distinct canonical signed 64-bit integer ids as TEXT (a restored store's
  keys may be zero or negative); any other (an imported one) is logged and forwards nothing, and the boosts are
  withdrawn as without forwards. The intents it names stay staging for good, never given up or released: its ids are
  untrusted and may name another account's activity (`test/forward-delete.test.ts` ("stages nothing
  from an imported bound")).
  A notification's pushes go before it, read from a window of the
  status's first notifications (one notification can hold all `MAX_PUSH_BACKLOG`, 1,000, of them). A remote status's
  own removal (`deleteStatusBatch`, its author's `Delete`) holds the same bound: the `Delete`'s request hides it, and
  each batch takes its hashtags off the tag index only as far as it has room; meanwhile home's followed-hashtag
  candidates probe each row's status for its visibility, so the hidden status is no candidate (VIS-1, the cursor rule
  of [visibility.md](visibility.md)). Neither job recounts an original whose removal has begun (`removalBegunSql`), so
  the recounts read none of its boosts and favourites while its boosts go one by one (each recount would read them
  all). A job round that stages target chunks of an intent recorded earlier rings the delivery doorbell (`delivers`)
  as a new intent does (`test/remote-delete-cleanup.test.ts`). A local status's `DELETE` writes at most 472 rows
  (`REQUEST_ROWS`: the streaming capture, `DELETE_SUPERSEDES` earlier activities superseded with the end of the staging
  of each one still staging, which only an import holds (`outbound_activities_staging_ended`), the intent, the hide, its
  card, trend row, review, pin and poll, its own quote, `MAX_STATUS_TAGS` hashtags, `MAX_STATUS_MEDIA` media, two counts
  and the job), and stores a `Delete` envelope within its derived JSON-escaped byte bound; its job's batches
  (`deleteStatusBatch`) take the rest within `PURGE_BATCH`: leftover hashtags and
  pins, its hashtags with its author's featured hashtags counted again, the earlier activities left to supersede, the
  `Delete`'s staging, its local boosts, the media its answer did not show (with the job's `bound`), then the children
  and the status (`test/local-delete.test.ts`, every input at its bound at once). The staging's bounds below apply
  to that `Delete` too, and the recount of a featured hashtag and of a local booster's `statuses_count` read their
  account's statuses, as posting does. A favourite's tracked
  `Like` ids go before it, read from a window of the account's or the status's first favourites, at most
  `MAX_TRACKED_LIKES` each, a bound a trigger holds for imported rows too;
  `test/inbox-reactions.test.ts` ("RES-6: tracked Like ids in bounded deletions"). The child tables of a status and of
  a purged account are each one list in
  `src/domain/inbox.ts` (`STATUS_CHILDREN`, `PURGED_ACCOUNT_CHILDREN`; each foreign key naming the account has its own
  check; its `remote_field_links` row, one at most, goes in a batch's budget, the foreign key's cascade a backstop);
  the references no foreign key holds (`PURGED_ACCOUNT_REFERENCES`: other accounts' moves to it) are cleared
  with its relationships, each row by its key through a partial index, and the completion check keeps the account row
  while any remains (`test/inbox.test.ts` ("clears the references to a purged account")); and the account's reports (of
  it and by it) and its other notifications go child-first: each from a window of
  their first rows, the pushes of a notification before it and a report's notifications before the report, so no delete
  cascades and the whole batch, the job's completion included, stays within `PURGE_BATCH` (`test/report-notifications.test.ts`
  ("a remote reporter's purge")). `test/cascade-guard.test.ts` checks the lists
  against the schema's cascading foreign keys; the same test requires every trigger that writes to be named with
  where a batch that fires it counts its writes. Blocks and mutes of the account go last, once nothing they filter is
  left (`test/inbox-regressions.test.ts` ("keeps filtering a post that mentions the actor")). A user's own unboost
  (unreblog, or the `DELETE` of a boost; `removeReblog` in `src/domain/statuses.ts`) writes at most 1,361 rows: the
  streaming capture, 32 earlier activities about the boost superseded (each with the end of its staging, as above), its
  `Undo` as an intent alone (no target is read or written and no receipt deleted), the boost's hide and its trigger's
  row, one off its booster's `statuses_count` and its original's `reblogs_count`, its reblog notification by its natural
  key with that notification's pushes, and the job; every read is a key seek but the streaming capture's, with its own
  caps. Its
  job is a local status's (`deleteStatusBatch`): it stages the `Undo`'s targets, then deletes the receipts a batch at
  a time, then the boost (`test/unboost.test.ts`). An unboost of an original whose removal runs is refused (ID-7).
  Local media is detached
  for the media sweep (MEDIA-1), never deleted from R2 here. Both are durable jobs in the Store (`inbound_jobs`), continued by the Queue and by cron, so neither a lost
  Queue message nor maintenance stops them, and waiting out maintenance spends no retry. A round runs at most 4 batches
  in all, failed and stalled ones included, each within `PURGE_BATCH` rows and its attempt's row; which job it takes,
  and how a failed or stalled one backs off and parks without holding back the others, is RES-5. A deletion's batch
  first hides its remote status if it is not hidden (an older build's or an import's job left it shown), and clears its
  content again after an `Update` that arrived once the retraction expired rewrote it (`withdrawn` stays 1): at most 3
  rows each time, written before the batch's savepoint so a failed batch cannot undo it, and charged to that batch's
  `PURGE_BATCH` (`test/inbound-job-isolation.test.ts` ("charges the hide of a shown status to its batch")). A request's
  first batch, and one a delivery of the same activity runs again, runs only while its job is due. A boost of a boost
  cannot be removed by these batches (the boost's removal waits for its own boosts, which wait for theirs): restore
  refuses a dump holding one ([dump-format.md](dump-format.md), "Bounded work"), no writer starts one, and a Store that
  already holds one (restored before that check) parks the deletion or purge that meets it, as a stall, instead of
  holding back the jobs behind it. A remote boost's `Delete` or `Undo` removes it at once only while no status boosts it
  and it has no delete job; otherwise it is hidden, its job written once, and the job's batches remove it, so the
  request never cascades into a chain (`test/inbound-job-isolation.test.ts` ("a boost of a boost", "a remote boost that
  a status boosts")). `test/inbox.test.ts`,
  `test/inbox-regressions.test.ts`, `test/inbox-verify4.test.ts` ("writes the targets of a withdrawal that needs more
  than a batch of rows, every batch within the budget", "reaches every target when purge batches and delivery claims
  interleave", "when the purge completes before any expansion"). _Enforced (main)_ for the staging of a retraction (a
  boost's `Undo`, a local status's `Delete`, a forward: `stageRetraction` in `src/domain/deliveries.ts`, migration
  `0085_retraction_staging`). A retraction still staging is found through `outbound_activities_staging`, a partial index
  of those alone, and is never deleted while it stages, though every row it has written is settled: its one delete
  (`dropSettledActivity`, the inventory `test-node/staged-intents.test.ts`) requires `staged IS NULL`. Each call
  admits every read before it runs, under one rule: a seek, a statement's first row (or its finding none) and each
  further row a page yields count one each, and none runs once `STAGING_READ`
  (500) have, so a read that consuming a row makes is counted before the next row is pulled. It returns at most
  `STAGING_BYTES` (1 MiB) of projected UTF-8 text, or one uri past the bound read to be compared with a name of the
  activity (within its body), and the row that crosses it, three values of `TARGET_CHUNK_BYTES` at most; a value past
  `TARGET_CHUNK_BYTES` is read as NULL, counted and logged, a target `chunked()` would refuse is passed before it is
  stored, and a personal copy refused for its inbox is kept as refused, so the lowest account id behind its addressee
  still decides it. A call consumes its first candidate whatever its size, so one that does not finish always consumes
  a candidate or saves a moved cursor, and no input repeats a call without progress. SQLite parses the JSON: the
  envelope's lists, through `json_each` over the stored body as `forwardFallback` reads them (an element reaches the
  Worker only as an id's canonical form, 18 ASCII digits by its bytes, else as none), and the chunks of
  earlier intents, at most `STAGING_BYTES` of them a call beyond the first; since SQLite reaches a position in an
  array by stepping over the elements before it, a call steps over at most the elements of those chunks and of the two
  lists, two stored bytes an element at least, counted apart from the table rows it reads. The sources are read from
  cursors kept on the staging's row, each in its own index order: the audience's accounts, the status's mentions, its
  parent's author, boosters and quoters, the poll's voters (its current generation compared in SQL), the followers up
  to the highest follow id when the staging began, then the earlier activities' targets not yet expanded, their
  delivery rows and the receipts, in that order, since evidence only moves from a target to a row to a receipt; whether
  an earlier activity retracts is read by its key before its rows or targets are, and a retraction's are not read. A
  forward's shares are resolved as the staging reaches each, one element of one page a call and its boost's seek, the
  boost's uri kept in SQL. An account is reached at its shared inbox, whatever its uri, for an activity that addresses
  no one. What they reach is merged into the staged set (`retraction_reach`), one row per target with the accounts
  behind it (staged retractions carry account provenance only: the send-time check exempts a retraction), and written
  out once every source is read, a chunk per row in key order, a page of at most `EMIT_BYTES` (512 KiB) of its keys'
  and inboxes' JSON and the row that crosses it (a row whose JSON is past `TARGET_CHUNK_BYTES` stays in SQL), each
  staged row deleted as it is written, every call within the `maxRows` it is given. A call's own heap, derived from
  these bounds and the columns' maxima, is within a quarter of the Store isolate's 128 MB. A call saves its cursor
  only when it changed; it runs in its job batch's savepoint, so one that fails is rolled back whole. A staging whose
  retraction is superseded is marked ended (`outbound_activities_staging_ended`) and swept with the delivery sweep,
  `SWEEP_BATCH` rows a round (`test/retraction-staging.test.ts` ("writes audienceTargets’ targets at the start, each
  once, within each call’s maxRows", "reads, returns and writes within their derived bounds in each call", "reaches a
  row that completes during the rows’ walk", "rolls a failing call back whole in its job batch", "is bounded by the
  per-column maxima its reads and budgets admit", "counts a nested seek before the next row", "steps over at most the
  allowance of chunks past its first", "keeps its intent while every chunk it has written is delivered"),
  `test/admin-suspension.test.ts` ("sends the restoration to a non-follower even when the profile is edited before it
  is staged"), `test/forward-delete.test.ts` ("advances a forward whose every share resolves")). _Gap (accepted):_
  a source row removed before its cursor reads it is missed unless other evidence names its inbox; a follow made after
  the staging began is not reached; a delivery row moved in place to a personal inbox
  (`moveToPersonal`) after the rows' walk passed it is missed when its receipt sorts behind the receipts' cursor, or
  when it stays pending or gives up without a receipt; writing out starts only once every source is read, so a large
  audience takes about two batches per `STAGING_READ` of its targets; and each call parses the activity whole in the
  Worker, which an imported activity near the row limit makes a large heap (the claim does not parse it, and the POST
  parses only a mutable personal copy's: `bodyFor`).
  _Gap (accepted), imported Stores only:_ an intent whose `staged` an import replaced while its own staging was live
  leaves that staging unended and unswept; a staged row whose key is malformed UTF-8 is not merged with the target its
  key decodes to, which may then be written twice; a personal copy whose inbox is past `TARGET_CHUNK_BYTES` is refused
  even when that inbox is no URL (`audienceTargets` records the copy as unreachable then); and the envelope's audience,
  read in SQL, departs from the Worker's parse of it: an integer literal that fits 64 bits is compared exactly (a JSON
  real keeps floating-point semantics), a list that is an object is read by its values, a member a JSON object holds
  twice is read at its first (`JSON.parse` keeps the last), and a list that is a string is one element (the Worker's
  spread made it its characters, which reach no account).
  _Enforced (main)_ for received quotes: a quote's verification goes in stages of one
  document each (the quoted status, its author when Kopje lacks it or its stored document is a day old, the status
  again, the stamp), each through loaders
  of its own, so no stage reads another's fetch; between stages only the author's address is kept, never a fetched
  document, so the status is stored only from a fresh fetch. Each stage's outcome applies only to the generation of
  the work it read (a number drawn anew whenever the quote's target, stamp, stage or outcome changes), so a late or
  concurrent outcome is discarded. Only job rounds verify quotes: an inbox request that makes work due only asks the
  Queue for a round, and a round leases what it claims, so nothing else touches the work meanwhile; a relayed `Delete`
  without the author's proof renews only idle work, leaves work that is due or backing off as it is, and only marks a
  leased one to be checked once more, so replays never keep a genuine 404 from applying. A job round (Queue or cron)
  verifies at most 10 quotes, each stage with a whole budget of its own (8 fetches, redirect hops and contexts included), so a heavy or
  failing quote starves no other, and charges every failure of a stage, a budget or deadline that ran out included, as
  it does a stage the Store cannot apply, except the refresh of a stored author, whose failure other than 404/410
  falls back to the stored account uncharged: a stage that never fits a budget is given up after the last attempt, and a
  round that only failed asks for no other (the backoff says when the work is due). A status stored for a
  verification gets one hop less of work, so one traversal stops two levels below the status that arrived, however
  long a chain of quotes; a failed verification is retried five times (1, 5, 30, 120 and 720 minutes later), then given
  up until its status arrives
  again. A stamp's `Delete` writes one `quote_revocations` row and changes the quotes naming it in batches of at most
  500 rows counted with `total_changes()` (a row and its count trigger), the first in the request and the rest in the
  inbound job rounds, each of which runs at most 100 revocation batches (`REVOCATION_BATCHES`) within one 500-row
  allowance, every batch's rows counted against it (a failed one's rolled-back writes included) and its retry state's
  row reserved before the batch is given the rest, however many revocations are pending
  (`test/quotes.test.ts` ("ends 3,000 completable revocations", "stops a run of revocations that each fail before any
  write", "keeps a due retry that runs through within the allowance", "keeps a batch that fails after its writes within
  the allowance")). A newly stored status links at most 100 unresolved quotes naming it. `src/domain/quotes.ts`,
  `src/federation/quotes.ts`; `test/quotes.test.ts` ("verifies a chain two levels below the status that arrived",
  "processes … quotes naming the stamp in bounded batches"), `test/cascade-guard.test.ts` (a purged status's accepted
  quote within the exact budget), `test/policy-bounds.test.ts` ("received quotes cost their work a bounded read").
  QuoteRequests: one fetch (the instrument, between Store rounds, which write nothing) and one answer per request id,
  kept 30 days in `quote_requests` and at most 100 live per actor (503 past the cap, nothing evicted); the sweep removes
  at most 100 expired rows a call. A revoke records one signed `Delete` and at most 100 `Reject`s (the quoting author's
  answered requests). A Delete of a quoting status retires its one authorization before its batches (three rows); a
  purge's batch deletes a quote holding one within a third of the rows left. `test/quote-requests.test.ts`,
  `test/cascade-guard.test.ts`. Streaming (VIS-26): _Enforced (main):_ at most 16 sockets per account (429) and 256 per
  instance (503); 16 subscriptions per socket, 16 stream keys per account and a socket's attachment at most 12 KiB (`Too
  many subscriptions`, 429); incoming messages text only (1003), at most 4 KiB and 120 a minute (1008). The fan-out runs
  in turns, one at a time, each an incoming request to the Store's own stub, which restores the CPU allowance: a turn
  spends at most 512 checks, 64 presentations, 4 MiB of presented payload and 4,096 sends, runs a unit only while what
  is left covers a unit's worst case (35 checks: 16 tokens, home, the mention, one for each of 16 keys (lists and feeds)
  and the feeds' mention filter; one presentation, 256 sends) and leaves the rest to the next turn; a payload over 512
  KiB is skipped and logged. The journal records nothing once it spans 4,096 ids, and is pruned behind the position, at
  most 500 rows a call: the finished journal rows first, so the span shrinks at once, then a delete's capture rows, in
  further turns until none is left. A turn that read anything moves the position, also past what it read with nothing to
  send, before it stops for its budget. a delete's capture is one journal row and at most one row per account in the
  registry (256), each at most 16 KiB (40 boosts); a row over it drops boosts, then list ids, and is logged, and the
  delete goes on. A unit is one subject (the status, or one captured boost) for one viewer, so a delete with 40 boosts
  is 41 units for each viewer, each within a unit's worst case; the position names the viewer and the subject within the
  event. The status and edit triggers write one journal row per status write, under the same span, and no batched delete
  or purge fires them. a delete's capture also holds each viewer's lists (at most 16 for the status and each boost,
  within the same 16 KiB); a list's check is one narrowed read. A conversation's change moves its owner's mark,
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
  in one transaction (its hashtag, status and link parts together: a failure in the link part leaves every trend table
  as it was), and its reads are metered against `TREND_ROW_CAPS.round` (33,855,900 bytes of row heap, which the widest
  rows fill exactly: 1,600 hashtag groups of 1,024-byte names, 400 link candidates of 2,048-byte URLs with their
  reviews, 250 stored links with 253-byte domains, and the 8 copies of each of those 650 links read to choose the copy
  it shows among them); a status's batched delete reserves its trend row and review and its card row (7 + after) and an
  account's final delete its review (3);
  `test/trends-bounds.test.ts` ("meters the round’s rows"), `test/trend-links-round.test.ts` ("the round in one
  transaction"), `test/cascade-guard.test.ts` ("trend and card rows within a batch").
  _Enforced (main)_ for the instance activity's writes: a local status or boost adds one upsert of its day's counter
  to the transaction that creates it, the setup one more and a login row, and an activity stamp (`noteActivity`) at
  most one key insert per account and UTC day (`test/instance-activity.test.ts`).
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
  checks bounds, continuation and non-disclosure. A status page's replies read their window from the partial index
  `statuses_public_replies` (migration `0082_public_replies`), so a status's private, direct, limited and withdrawn
  replies are never read and never a cursor, and a page reads the same rows however many there are
  (`test/web-thread.test.ts` ("seeks the public replies’ index from the cursor both ways, with stale statistics", "names
  no withdrawn reply, past more of them than a window")). Its Boosts, Favourites and Quotes tabs read the API's windows
  for those lists (`interactorsWithin`, `statusQuotesWithin`), with the same bounds; the boosts' window reads
  `statuses_reblogged_by` (migration `0083_kept_boosts`), so a withdrawn boost is never read and never a cursor of the
  page or of `reblogged_by` (`test/web-interaction-tabs.test.ts` ("seek each tab’s index from the cursor both ways, with
  stale statistics", "name no withdrawn boost as a cursor where it would end a full window")). _Gap:_ the number of
  streams is the viewer's follows (their own choice); rows hidden by visibility are walked past, not windowed (account
  statuses read by a non-follower of an account that posts mostly to followers: a remote account's private statuses are
  stored only while a local account follows it, so no outside party can grow it at will; accepted).
  _Enforced (main)_ for search: statuses pass `listableSql` before `LIMIT`, each library source reads at most 2,500 rows through an index ordered by the status id it returns (cursors applied
  inside it), hashtags come from at most 500 entries per library source plus the newest 2,000 public statuses, and an
  account search matches the exact address (always), at most 1,000 username-prefix candidates, the 5,000 newest
  accounts and the local ones, or with `following` the exact address and up to 5,000 accepted follows through a
  partial index (pending follows are never read)
  (`src/domain/search.ts`, `searchAccountIds` in `src/domain/accounts.ts`); `test/search.test.ts` ("filters before
  LIMIT"), `test/search-edge.test.ts` (rows read stay flat as favourites, bookmarks, accounts and tagged statuses grow
  fourfold, pending follows included; `max_id` reaches past each window; an exact address outside every window is
  found). _Enforced (main):_ the peers list seeks each next domain on the (domain,
  username) index, so it reads rows by domain returned, not by account known; the public block list reads the suspend
  blocks in chunks of 500 from the partial index `instance_domain_blocks_public` (migration `0049_instance_bounds`),
  so its rows read are the admitted blocks and at most one chunk more, whatever the noop blocks
  (`test/instance-reads.test.ts` ("reads the same rows whatever the noop blocks")); a tag's history reads its public
  statuses received in the last seven days only, a range of the (name, status_id) index of public hashtags cut by status
  id, so the work follows the instance's own receive volume (ids carry publication time, or receipt time where a cutover
  kept them); a list's history reads at most 20 entries of that range per hashtag (200 for the trends lists), each
  status sought by id, so a page's history is flat in a hashtag's volume: about 21 rows per entry in the dearest world
  (suspend blocks, available authors on eight-label domains), and a whole authenticated page at most 90,000 rows for 200
  `followed_tags` (imported follows; the follow cap bounds only the follow), 115,000 for 40 v2 search hashtags with
  every window full and no two sharing a candidate (4,000), 9,000 for 10 suggestions (`test/tag-history-bounds.test.ts`)
  and 70,000 for 20 trending hashtags (`test/trends-maxima.test.ts`); the rules
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
  notification jobs up to 2,000 more, failed batches included (RES-5); every read of an account's notifications starts
  above its clear, and every read of one group above its dismissal (`keptFloorSql` in `src/domain/audience.ts`), so
  neither the request, a round nor such a read grows with what is hidden (`test/policy-bounds.test.ts` ("touch a bounded
  batch"); `test/notification-clears.test.ts`). _Gap:_ until the rounds have deleted a dismissed group larger than the
  request deletes, a walk of all the account's notifications (the lists, the grouped walk, the unread counts) that
  reaches what is left of it passes over each with a key lookup, as it passes over notifications R15 hides for other
  reasons (a muted sender's); a clear has no such gap. Context traversal and edit history: _Enforced (main):_ a context
  reads at most 8,192 replies of the tree (240 for an anonymous viewer), breadth first, before the list rule and the
  order apply (`CONTEXT_LIMITS` in `src/domain/statuses.ts`), and a status keeps at most `MAX_STATUS_EDITS` (100)
  versions, each within the status text's bound (RES-1); `test/context-work.test.ts` ("a tree several times wider costs
  about the same", "a chain twice as deep costs about the same"), `test/statuses.test.ts` ("bounds the edit history at
  write time"), `test/inbox-statuses-edge.test.ts` ("versions of history: the 101st replaces the newest").
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
  cursor through the partial index `quotes_accepted` (migration `0036_quotes_list`), at most `limit` + 1: the first
  `limit` are the window, and the one past them only tells a public page's pager that a candidate lies there (never
  shown, never a cursor). It applies the rule to the window alone, whatever the count of quotes in any state; when the
  rule hides the window, the page is empty and its next link moves on by the window, so hidden quotes cost a request one
  window (`test/policy-bounds.test.ts` ("the quotes list reads a window")). A client that stops at an empty page sees
  fewer quotes than exist, as on Mastodon (accepted). The stamp endpoint is one read by its id's unique index; a
  request's cap reads at most 100 rows of its actor; a revoke's `Reject`s read at most 100 rows of the quoting author by
  one seek of `quote_requests_instrument`, whatever other actors' requests name the same instrument; quoters' reach
  reads the accepted quotes of the status through `quotes_accepted`, as its boosts are read.
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
  and its link part at saturation (below) it reads 1,199,008 rows with distinct authors and 563,348 with repeated ones
  (its writes' reads included), the same with 10,000 or 1,000,000 older statuses and 0 or 100,000 hidden ones in the
  window (`test/trends-cost.test.ts`, ceiling 1,250,000). The link part reads the window's public copies and at most
  4,000 public boosts of them since yesterday 00:00 UTC, 100 of each original, cut raw before any rule (ids and URLs
  materialized only), groups them by an indexed representative copy, returns at most 1,600 groups (each takes 5 of the
  8,000 contributions) and keeps the first 400 with a qualifying copy, each chosen among the link's 8 newest public
  copies; at saturation every window status is a copy, 1,600 groups reach 5 accounts, each link's copies make the
  check read up to 8 copies (the window's, which fail at the image, then older originals' whose authors' domain was
  suspended after their cards were recorded, on nine-label domains, each failing at the end of its availability walk,
  then the qualifying one), the copies of each candidate and stored link then read again to choose the one it shows (the
  first whose texts present as decoded; a link with none is excluded before the pools), all 250 trend rows are stored
  and listed, every host has 127 labels (126 suffixes walked per review lookup) and the link and publisher review tables
  hold 10,000 each. Inside SQLite the candidate statement materializes at most
  4,000 window ids (`w`), 4,000 copies of an id and their representative id (`o`, counted with a 2,048-byte URL each),
  4,000 rows of three ids (`ob`) and 1,600 groups of a URL, two counts and an id (`q`); its GROUP BY sorter holds at
  most 8,000 rows of two ids and a 24-byte time, its two count(DISTINCT) B-trees 8,000 ids each, and its final ORDER BY
  1,600 URLs with two counts. Counted as ephemeral records (a 9-byte header field per value and 64 bytes a record)
  doubled for page slack, all live at once, that is 39,406,256 bytes, and a link's history statement 1,203,600, each
  within a budget of 64 MiB, half of a Durable Object's memory (`test/trend-links-round.test.ts` ("SQLite’s working
  memory")); no raw time is materialized (`test/trend-links-round.test.ts` ("imported timestamps")). workerd's
  SQLite reports no memory high-water, so these bounds are derived, not measured. The Store isolate's peak while the
  link part runs is derived by phase against half of its 128 MB, the memory model's figure: while the candidates are
  read, 59,812,006 bytes (the hashtag and status parts' rows and the candidates with 25% headroom, the statement's
  SQLite peak and 8 MB for other live Store work); while the shown copies are chosen, the links scored and written,
  57,942,827 bytes (every row the round may read, its RowMeter cap, with 25% headroom, the candidates' and shown
  languages' maps, the scored rows, one link's copies being judged, the writes' JSON and the same 8 MB);
  `test/trend-links-round.test.ts` ("the Store’s memory while the round scores links"). The round keeps only each
  shown copy's language, the copies' rows dropped once the choice is made.
  `GET /api/v1/trends/tags` reads 68,062 rows for 20 hashtags with 201 or 10,000 public statuses each, half of
  them by unavailable authors, on the same kind of accounts and full review tables (`test/trends-maxima.test.ts`).
  `GET /api/v1/trends/links` reads 772,980 rows for a page of 20 links at their history caps (200 public copies of
  the 7 days each, 20 public boosts of each copy), and the same past them, over a full trend table (250 listed links,
  each allowance walking 126 suffixes) with every author and booster available, on its own eight-label domain under
  100 active suspend blocks that cover none, so every availability walks both keys to the end (643,540 with half of
  them deleted; `test/trends-maxima.test.ts`, ceiling 800,000). `GET /api/v1/timelines/link` reads 3,256 rows before
  presentation (the token, the trends setting, the gate, the window and the rule over it) for a page of 40 from a
  window of 120 public copies, the same with 10,000 older public copies and 10,000 newer unlisted ones, and 3,136 for
  a window the rule rejects whole, for a viewer with blocks, mutes and domain blocks, a link whose allowance walks 126
  suffixes among 10,000 publisher reviews, and authors on eight-label domains under 100 active suspend blocks
  (`test/link-timeline.test.ts`, ceiling 3,500). The figure excludes presentation, which is bounded as for the other
  timelines. Each plan is of the production statement as it runs, with statistics taken before the data grew. Review
  lookups are key
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
  `test/moderation-plans.test.ts`, `test/domain-job.test.ts`), each purge batch within `PURGE_BATCH` (RES-6).
  The instance activity reads each of its 12 windows by key: the two sums by `activity_counts`' key, at most 6 rows
  each, and at most `ACTIVITY_LOGIN_ROWS` (600) raw login rows by `activity_logins`' key before counting distinct
  accounts, so a window reads at most 614 rows and the request that makes the day's answer 7,368, whatever the accounts
  or the days stored. That request comes once a UTC day, and again after the setting or the publication state changes;
  during a dump's freeze, when the answer cannot be kept, every request that finds none kept makes it. The others read
  the one kept row (`test/instance-activity.test.ts` ("reads each window by key within 614 rows at the worst case, with
  stale statistics")).
  A forward's reads are pinned (`test/forward-delete.test.ts` ("plans no scan of a large table")): the kept
  local boosts of the original by `statuses_account_reblogs_kept` from each local account, the job's intents by key
  from its `bound`, a share's boost by key, and the oldest retraction still staging of a pair by
  `outbound_activities_object`.

#### Maxima of presented units (RES-3)

The maxima are per column: each column a shape reads at the largest value its stored bound (RES-2: the stored-bound
triggers and the schema's CHECKs) allows, and each column that no CHECK bounds at the largest its writers produce
(writers' invariants: `polls.tallies` holds one integer count per choice, which the poll writers in
`src/domain/polls.ts` keep; no CHECK bounds its elements' type or size), or at the largest its read projection shows (an
account's three counts at 2^53−1, `presentedCountSql`, every account of the fills, nested ones included).
`test/status-bounds.test.ts` ("the table of maxima") builds every part at its bound and measures what one read takes out
of SQLite and what it presents, four ways: the escaped-text fill, using characters JSON escapes to six bytes; the same
with mentioned accounts that have no stored url, so their url is derived; filled with what reads the most bytes for each
bound (ASCII where the bound is in bytes, four-byte characters where it is in characters: a 10,000 character description
reads 40,000 bytes); and the escaped fill with each poll's choices referencing the status's emoji in the fewest
characters (37), so each poll shows all of them. Emoji arrays are at their presented bounds (12,288 and 6,144 JSON
bytes) in the escaped and derived fills, and their stored values padded to the same bounds in the raw fill; the boost's
own row holds one too, which is not read. The parts include the source text of each status row, the boost's own row (all
but its content, which the CHECK keeps empty, with its own attachments, mentions, hashtags and poll, which are not
read), the viewer's profile, her votes in every choice of both polls shown and every flag of hers included, each remote
profile's fields at the largest list a read takes (32 KiB of JSON), with accounts on 2,000-character domains (the
longest an actor id of 2,048 holds), hashtag names of four-byte characters, and the viewer's filters at theirs: 50
filters in every context, each with a 256-character title and 20 keywords of 512 characters, the first held by the
status, and naming the statuses read, so every status carries 50 filter results (about 0.24 MB each set) and every read
takes the 1,000 keywords. SQLite bytes are the UTF-8 bytes of every value read (8 per number); nodes are the objects,
arrays and strings presented. Measured shapes are read through the Store operation. No one fill holds a status's emoji
arrays and its polls' at their bounds at once (the references a poll's choices need displace escaped characters), so the
conservative JSON of a shape is the escaped fill's plus 12,286 bytes for each poll it shows, at least every fill's
(`test/status-bounds.test.ts` ("keeps the conservative JSON of every shape within 85%, above every fill")); shares are
of it. Each remote account of the fills carries its actor id (`uri`) at its bound, 2,048 bytes as JSON, the most it
presents. A local account also shows `noindex` and `roles`, at most the Owner's badge: the account occurrence's
conservative JSON adds those keys (63 bytes) to the remote one measured, and what a local account's four fields at
their derived most (37,677 bytes: names of six-byte escapes, each value at 7,822 and verified) present past the remote
one's fields. Every presented account but the viewer's moved to an account of its own at the nested caps (a display
name referencing emojis that fill 2,048 bytes, URLs at 512 bytes, a 253-byte domain), and each nested account counts at
its derived 11,021 bytes in the conservative JSON (14 in the conversation, 10 in the group). The fills' statuses are
remote, which show no `application`; each status a shape shows counts one at its derived 2,399 bytes (a name of 60 code
points escaped to six bytes each and a website of 2,000 bytes, which JSON writes unescaped, with the key), witnessed by
a local original and a local quote whose apps are at those bounds, escaped, raw and as malformed imported bytes
(`test/status-bounds.test.ts` ("status applications")). Each status and boosted original of the fills holds a card at
its stored bounds (texts escaped, or ASCII in the raw fill; the boost's own row one too, which is not read), and each
status a shape shows that may show one (not a boost, and not a quoted status, which shows none) counts it at its
derived 9,899 bytes (`CARD_JSON_MAX`, `test/link-cards.test.ts`; its image URL at 342 bytes, its blurhash at 54 and its
alt text at 256 JSON bytes included). Through the real Store RPC, a public timeline page, a context and a search answer
of statuses of about 0.98 MB each, each cut at the budget, return 7.82 MB of JSON each
(`test/answer-budgets.test.ts` ("the Store RPC returns a maximal answer")), and the boost of a quote above, alone or as
the one status a lookup of it, the quote and the quoted status admits, returns 5.77 MB (escaped fill) and 4.66 MB (raw
fill, the largest SQLite read) (`test/status-bounds.test.ts`), well under the 32 MiB RPC limit.

| Shape                                                            | Most SQLite bytes | Most JSON bytes | Conservative JSON | Rows read | Nodes | Share of 8 MiB |
| ---------------------------------------------------------------- | ----------------- | --------------- | ----------------- | --------- | ----- | -------------- |
| Account occurrence, with the account it moved to                 | 123,265           | 140,480         | 147,990           | 1         | 92    | 1.8%           |
| Moved-to account (nested), derived from its caps                 | 11,118            | 8,331           | 11,021            | 1         |       | 0.1%           |
| Status                                                           | 4,452,233         | 2,697,144       | 2,703,319         | 1,486     | 2,449 | 32.2%          |
| Quote (the status and its quoted status)                         | 6,826,260         | 5,385,072       | 5,397,422         | 1,919     | 4,882 | 64.3%          |
| Boost of a quote                                                 | 7,120,881         | 5,794,056       | 5,812,060         | 1,976     | 5,841 | 69.3%          |
| Conversation: 12 participants presented, its last status a quote | 8,504,016         | 7,070,801       | 7,122,211         | 1,945     | 5,977 | 84.9%          |
| Notification group: 8 sample accounts, its status a quote        | 7,888,214         | 6,509,336       | 6,547,726         | 1,954     | 5,630 | 78.1%          |
| Report: its first status a quote past the 2 MiB allowance        | 7,206,258         | 5,981,605       | 6,000,465         | 1,934     | 5,197 | 71.5%          |
| An admin.report notification of that report                      | 2,360,617         | 403,364         | 409,874           | 1,061     | 294   | 4.9%           |
| A moderation_warning notification, its local account at bounds   | 133,543           | 290,370         | 332,194           | 9         | 223   | 4.0%           |
| Its notification group                                           | 133,543           | 290,559         | 332,383           | 9         | 230   | 4.0%           |
| A filtered favourite of the quote, as include_filtered lists it  | 6,960,290         | 5,525,678       | 5,541,283         | 1,942     | 4,978 | 66.1%          |
| ActivityPub Note: a local status at its bounds, 1,000 addressed  | 3,697,531         | 4,243,523       |                   | 1,337     | 3,169 | 50.6%          |
| Its Create (the Note and its addressing again)                   |                   | 6,299,611       |                   |           |       | 75.1%          |
| Announcement: each part derived from its caps                    |                   | 121,774         | 248,997           |           |       | 3.0%           |
| Trending hashtag (Tag with history), derived from its caps       |                   | 4,508           | 4,572             |           |       | 0.1%           |
| Listed hashtag (search, followed, suggested), from its caps      |                   | 4,543           | 5,070             |           |       | 0.1%           |
| Access admin's trending hashtag, derived from its caps           |                   | 4,551           | 4,625             |           |       | 0.1%           |
| Access admin's trending status, derived from its caps            |                   | 27,748          | 29,060            |           |       | 0.3%           |
| Trending link (TrendsLink), derived from its caps                |                   | 4,783           | 10,268            |           |       | 0.1%           |
| Access admin's trending link, derived from its caps              |                   | 4,166           | 4,217             |           |       | 0.1%           |
| Instance activity (12 weeks), derived from its caps              |                   | 1,189           | 1,189             | 7,368     |       | 0.0%           |

A moderation_warning shows its account twice (the sender and the warning's `target_account`, the same local account with
four local fields at their limits, each value a verified 255-character link whose `&`s the link markup escapes twice,
2,594 JSON bytes, and its `verified_links` padded to its 4,096-byte bound) beside a text at its 10,000-byte bound
(U+0001, or malformed bytes read back as U+FFFD) and 100 status ids. Its conservative JSON counts each of the eight
fields shown at the most a value presents, 7,822 bytes derived from the value bound (every character twice as a
six-byte escape, and one link's markup per 9 characters). As a stream payload, encoded again as a string, it is at most
331,384 bytes measured and 415,032 conservative (the encoding at most doubles a byte), under the hub's 512 KiB. The most JSON is the emoji-poll fill's, the most SQLite bytes the raw fill's; the escaped fill presents the
conversation in 7,046,599 bytes, and its conservative JSON is 8,105 bytes within 85% of 8 MiB (7,130,316), above
the 4,096 bytes a change may not cross without a review (#1142).
Every remote account shown but the account occurrence counts its fields at 33,485 JSON bytes, derived from the
constants (32 KiB of names and values as presented, 16 fields' keys, 4 verification times of 31 bytes and 12 nulls:
565 bytes past the fill's 8 fields); the account occurrence keeps the larger of the local and remote fields' maxima.
Each account row reads its remote verification times (`remote_verified`) at most 129 bytes, counted at its 290-byte
heap whatever the fills hold (`test/status-bounds.test.ts`, "remote field verification (RES-3)").
The Note's local emoji snapshot is at its 12,288-byte bound with as many entries as fit
(61, every url at its shortest), resolved to 14,850 bytes of `Emoji` tags (at most 64 × 44 bytes past the
snapshot); an actor's at 6,144 bytes resolves to 30 tags of 7,404 bytes (`test/local-emoji-api.test.ts`).

The trends shapes are derived the same way (`test/trends-maxima.test.ts`): a hashtag of a 1,024-byte name with its
URL percent-encoded (three bytes a byte) and seven history days at 200 uses; an admin status of a 4,096-byte URL, a
username and a domain cut on bytes at 255 and 253 (SQLite's character cuts pass malformed bytes whole), each byte
escaped to six bytes (a malformed one decodes to a three-byte U+FFFD), a 200-unit excerpt escaped the same, a
supported language and a 24-byte time. Pages: 20 hashtags (91,461 bytes at most; 90,178 filled through the Store
RPC), 20 admin hashtags, 40 admin statuses (1,162,440 at most; 1,093,041 filled through the Store RPC by imported
rows whose parents pass every bound, half of them with malformed bytes in the username, domain and content). A
trending link is its card at `CARD_JSON_MAX` (9,899 bytes) with its history (seven days at 400 uses: 358 bytes) and
the key (11), 10,268 bytes, so a page of 20 is at most 205,381 bytes; 20 links of 2,048-byte URLs with texts of
control characters at their bounds fill 95,681 through the Store RPC. An admin link takes a 2,048-byte URL, the
title and provider name at their JSON bounds, a 253-byte domain, its publisher's review and the history. A listed
hashtag (v2 search, `followed_tags`, `featured_tags/suggestions`) takes the lists' name bound instead: 256 code points
each escaped to six bytes, the URL of a 1,024-byte name, and seven days at 20 uses; 200 of them (the most
`followed_tags` pages) are within the budget, and a page of 200 imported follows, 196 of them maximal names and 4 past
the bounds (left out), fills 715,687 bytes through the API (`test/tag-history-bounds.test.ts`). Follows and features
past the name bound are refused, and lists leave out stored names past it or not well-formed UTF-8 (`tag-bounds.ts`;
`test/tag-names.test.ts`); v2 search shows a malformed name decoded, identified by its stored bytes, at most 12,750
bytes (a 1,024-byte key of U+FFFD, nine bytes each in the url).

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
  admitted answer's 25.2 MB, the first rejected item's three times its JSON. Every string field counts on its own,
  even one that repeats another's string (an attachment's `remote_url` is its `url`), and rows and presented objects
  often share the same string instances, which the model does not credit either.
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
statuses while their R sums to at most its target, at most 80 and at least one: 416 KiB of heap for pages, contexts,
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
`presentStatusesWithin`, mean of two sets of 20 runs at a load average of 6 (measured at a 768 KiB target; the
ordinary page plans the same one chunk at 416 KiB, and the realistic page was not timed again);
`test/status-rows.test.ts`
("read an ordinary page of 40 statuses in one chunk of at most 14 queries", "a context of 200 statuses reads its
statuses in planned chunks", "a page of 80 groups reads its statuses in planned chunks") holds the planned queries to
their ceilings:

| Page                                                                    | Chunks of 2          | Planned             | One chunk          |
| ----------------------------------------------------------------------- | -------------------- | ------------------- | ------------------ |
| Ordinary: short posts with a hashtag and a mention, every other a quote | 220 queries, 9.1 ms  | 12 queries, 6.8 ms  | 11 queries, 5.6 ms |
| Realistic: 5,000 Japanese characters, a poll of 4, 4 described media    | 200 queries, 11.3 ms | 41 queries, 10.1 ms | 10 queries, 8.6 ms |

The ordinary page's R is 430,160 bytes (368,840 without emoji) as stated, 418,160 as planned (the planner counts a
filter row for each of the viewer's filters that names statuses, none here, where the stated R counts one a status), one
chunk within the 425,984-byte target. With every status and author at the stored emoji caps it is 2,581,160 (at most
85,972 a status, far below the target), planned in 7 chunks (six of 387,174 bytes and one of 258,116), as few as the
target allows, with the backstop never fired ("read a saturated page of 40 statuses in planned chunks"); the packing
bound allows 7. A context of 200 short replies plans 5 chunks in its 3 windows of R, 57 statements ("a context of 200
statuses reads its statuses in planned chunks"). Each chunk also reads its accounts' cached profile images in one more
statement outside the row heap (MEDIA-7, `cachedImagesSql` in `src/domain/remote-media.ts`), which the ceilings count:
13 + 1 for the ordinary page, 65 plus one a chunk for the context.

How many chunks the 416 KiB target adds depends on the workload: statuses that each take a little more than half the
target pair no two of them. 80 statuses of R 229,372 bytes each (a 37,548-character post with 200 mentions) plan 80
chunks of one and 881 statements at 416 KiB, where a 480 KiB target plans 40 pairs and 441 statements; every chunk's
statements run in the same Store operation, so no Store RPC is added, and R is still one query a window. Presented
unobserved, alternating the two targets, the mean of 10 runs each took 97.6 ms at 416 KiB and 97.4 ms at 480 KiB at
load averages of 14 to 18: the rows (the same at both targets) dominate, and a chunk of one is read without a meter
(`test/status-rows.test.ts`, "hydrates 80 statuses just past half of the page target one at a time, and in pairs
64 KiB above it").

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
| Boost of a quote (the largest timeline item)   | 19.33 MB                | 17.44 MB              |
| Group: its status (a quote), 8 sample accounts | 21.36 MB                | 19.65 MB              |
| Report: its status and 4 accounts              | 19.55 MB                | 18.00 MB              |

Groups and reports also keep the presentation's state: the compiled filters (50 filters of 20 keywords, about
0.5 MB) and the filter results cached by status (at most 50 results of about 1.2 KB each, 60 KB a status) for the
statuses and quoted statuses a page presents: 160 for a page of groups (80 groups, each with its status and a quoted
one; a re-admission pass presents its own groups' statuses again, matched once, and holds nothing else of an earlier
pass, and the passes are at most four), 200 for a page of reports (its at most 100 statuses and their quoted ones):
10.1 and 12.5 MB.

| Answer (Store isolate)                      | Normal   | Backstop fired, the dropped chunk still live | A single item |
| ------------------------------------------- | -------- | -------------------------------------------- | ------------- |
| Timelines (largest item a boost of a quote) | 61.95 MB | 63.99 MB (63,989,675 bytes)                  | 61.95 MB      |
| Groups                                      | 76.29 MB | 79.11 MB                                     | 76.29 MB      |
| Reports                                     | 75.24 MB | 78.05 MB                                     | 75.24 MB      |

A chunk of several takes at most its target of heap: 416 KiB (0.43 MB) for timelines, 1 MiB (1.05 MB) for groups and
reports. Normal: the rows are the larger of 1.25 × the target and the item's rows, plus the admitted answer, the
rejected item and, for groups and reports, their state. With the backstop fired, 1.25 × (the target + 1.20 MB) of
dropped rows more. The 416 KiB timeline cap, the largest multiple of 8 KiB that does, keeps the fallback below half
the isolate's memory even while the dropped chunk remains live, with 10,326 bytes to spare (at least 4,096 kept, as
above; the conversation's JSON keeps 7,459 under its ceiling): each remote account row's and moved-to account's cached
profile images (two rows at their caps, MEDIA-7), each status, account and moved-to account row's cached emoji (its
first 16 entries, read with the row: `emojiCacheSql`; the emoji-cache fill caches every entry of snapshots at their most
entries, and a moved-to account counts its at their cap), each account row's remote verification times at their 290-byte
heap, each status row's card at its stored bounds, its embed's src and dimensions and its stored image's token, size,
blurhash and alt text included (a quoted status's is not read), each account row's static images count at their stored
bound (1,056 bytes of heap each, whatever the fills hold), each status row's app name and website at their raw bounds
(4,544 bytes of heap), each attachment row's blurhash at 140 bytes, whether it is remote at 32 and its cached file and
icon (two slots at the packed cap, read with the row: `mediaCacheSql`; the raw fill caches both of every remote
attachment), each presented attachment's four URLs at 4,098 JSON bytes and its blurhash at 56, each moved-to account's
row at its 25,536-byte heap cap and its JSON at 11,021 bytes, and its emojis' presentation holds one entry past those it
admits at a time (18,060 bytes at three times its literals, decoded strings and the larger of its entity and an href
normalization makes before rejecting it:
`referencedEmojis` in `src/domain/custom-emojis.ts`), counted once per answer. Every row term carries 25% headroom; the
peak test rejects growth past that boundary. The backstop-fired figures bound the fallback whenever the dropped rows are
collected. A boost that showed a quote, attachments, mentions, hashtags or a poll of its own (a legacy row may hold
them) would make a timeline's largest item pass half at a chunk of one; it shows none.

| Phase                                             | Store isolate | Worker isolate |
| ------------------------------------------------- | ------------- | -------------- |
| RPC copy (serialized; deserialized in the Worker) | 8.4 MB        | 25.2 MB        |
| The Worker's JSON string and the body             |               | 25.2 MB        |
| Peak, normal                                      | 61.90 MB      | 50 MB          |
| Peak, the backstop fired                          | 63.99 MB      | 50 MB          |

The Store's peak is the timelines' (the answer table above, normal and with the backstop fired and the dropped chunk
still live), while an item is admitted; the RPC copy comes after it. The Worker's JSON string is counted at two bytes
a character (16.8 MB) and the body at its UTF-8 bytes. Timelines stay within half of the Store isolate's 128 MB, and
the Worker within half of its own. One isolate holding both sides at once, the Store's objects alive while the
Worker's are built, would reach about 107 MB; it stays within half (the timelines' peaks above) when the Store drops
its objects once they are serialized. Groups and reports pass half of the Store isolate (RES-3, the Gap note on their
heap).

### Data and keys (DATA)

- **DATA-1: private keys stay wrapped outside cryptographic use.** Actor and instance keys are stored wrapped with
  `USER_KEK` in the legacy format. They are unwrapped per call in the Worker, only to sign and for the health key check,
  are never cached, and never appear in responses or logs. The Store hands them over wrapped only, `inboxGate` and a
  `receiveActivity` need included (their fetch preparation), and the Worker unwraps such a key on the request's first
  fetch, or never. _Enforced (main):_ `src/security/key-wrap.ts`,
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
  they name R2 objects to delete, which a restored Store must not act on. So are card images (`card_images`): they
  have no original to restore from, so a restored Store shows its cards without images (`status_cards` keeps the
  links, which name no row) and fetches an image again for a new record (`test/card-image-dump.test.ts` ("are left out
  with their tombstones, the links kept, and the cards shown without them")). So is the remote media cache
  (`remote_media`, `remote_media_objects`, `remote_media_usage`; MEDIA-7): a restored or imported Store starts it
  empty, presents the remote URLs, fills it again from the backfill, and its orphan sweep deletes the files under
  `remote/` it does not know (`test-node/schema-coverage.test.ts`).
  The instance activity's tables are dumped and restored as stored, held to the CHECKs of `0072_activity_tracking`,
  and a restore counts nothing (`test/instance-activity.test.ts` ("round-trip as stored…")); its kept answer is not
  dumped.
  Each import call's work is bounded by what it
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
  `src/platform/error-message.ts`, used by `app.onError` (`src/app/app.ts`), the admin API's error handler, the queue
  and spool handlers, the snapshot saver and the Store kernel and admin; `test/log-redaction.test.ts`;
  `test-node/log-events.test.ts` (a syntactic check of every log call's shape and fields). Access failures log only
  jose's error code, and the CLI never prints secrets (`test/cli.test.ts`). A forward that is not recorded logs
  `kopje.inbox.forward_skipped` with its reason and size, and one past its owners' cap `kopje.inbox.forward_capped`
  with the cap, and a job bound that is no list of forwards `kopje.inbox.forward_bound_invalid` with its size (the
  intents it names are left staging, as RES-6 says), never
  the body or an identity. A job's failed or stalled batch logs `kopje.jobs.item.failed` and its parking
  `kopje.jobs.item.parked` with the family, the outcome, the count and the error's class only, never the job's key (an
  actor's URI, a status id, an activity id, a stamp, an account or a group key) or the error's message, and an unlock
  acceptance's failed authorization logs `kopje.jobs.step.failed` with its family and the error's class only
  (`test/inbound-job-isolation.test.ts` ("parks a permanently failing first job"), `test/family-job-isolation.test.ts`
  ("parks a permanently failing first item"), `test/unlock-accepts.test.ts` ("passes over its request")). Platform
  telemetry, which Kopje does not write, is not covered by the rule above and is not assumed to be free of secrets. The
  shipped `observability` block keeps Kopje's events for 7 days, readable by every member and API token
  with Workers Observability access on the account. It turns the platform's invocation logs off: they record request
  headers verbatim except a few the platform masks (`Authorization` is masked), so a streaming subprotocol token
  (VIS-26) would be stored, as would request paths such as `/media/<token>/<file>`. It leaves traces off: spans would
  record SQL text, R2 keys, push endpoints and outbound URLs. On an instance using the shipped block, either exists
  only if it opts in, under the conditions of the Accepted risks below (docs/observability.md); an instance whose config
  predates the block stores invocation logs until it applies the block (CHANGELOG.md, Instance changes). It sets
  `redact_query_string`, which removes incoming request query strings from stored invocation logs (observed on a
  deployment; for traces it is not verified, docs/observability.md). Kopje's own events are kept to the rule above by
  the tests it cites, on the paths they cover, not by construction. _Enforced (main):_ `wrangler.jsonc`,
  `/deploy/wrangler.jsonc`; `test-node/wrangler-configs.test.ts` ("pins the observability block", "leaves
  observability out of the maintenance worker config").
- **DATA-6: ids stay strings end to end.** Ids never pass through JS numbers. INTEGER edge and notification ids are read
  with `CAST(id AS TEXT)` and compared with `CAST(? AS INTEGER)`. 18-digit TEXT status ids compare as TEXT; a shorter
  client cursor is zero-padded first. _Enforced (main)_ for edges: `listFollows` in `src/domain/accounts.ts`;
  `test/accounts.test.ts` ("edge ids beyond 2^53", "keeps 18-digit ids exact"). _Enforced (main)_
  for status cursors: `statusCursor` in `src/domain/windows.ts` (_Gap: untested_). _Enforced (main)_ for
  forwards: their intent ids are TEXT in the job's `bound` (`{"forwards": [...]}`) and sought with
  `CAST(? AS INTEGER)`, beside an intent with the largest id there is (`recordForwards` in `src/domain/inbox.ts`;
  `test/forward-delete.test.ts` ("plans no scan of a large table")).
- **DATA-7: the instance key signs only recipient-neutral fetches and the instance actor's own activities.** Fetches
  without a specific recipient are signed by the instance actor; fetches for a personal inbox by the recipient's key;
  fetches on a remote account's behalf (a sync of its featured, featuredTags, following, followers and outbox
  collections in the background job rounds, and the pinned status an `Add` names) by the key of a local account that
  follows it, else by the instance actor, never by a personal inbox's recipient: Mastodon's `local_follower` for the
  featured and pin fetches (the following, followers and outbox fetches differ:
  [mastodon-deviations.md](mastodon-deviations.md), Accounts). The follower is named by its account id and the remote
  account's, and its key is chosen only while it is available and still follows the remote account, which is checked
  again then; otherwise the instance actor signs (`localFollower` in `src/domain/follower-signer.ts`,
  `fetchSignerOf` in `src/domain/actors.ts`, the one home of this rule, read by `fetchSigner` and by the fetch
  preparation of `inboxGate` and of a `receiveActivity` need; `src/federation/collections.ts`, `receiveInbound` in
  `src/federation/inbound.ts`; `test/remote-collections.test.ts`, `test/signed-fetch.test.ts` "the signer of a fetch").
  A signer is judged when it is chosen: a suspension or unfollow committed after the Store answer that chose it costs
  at most that request's fetches, and the next Store round refuses what they bring (`test/quote-requests.test.ts`);
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
  let read it (its `isVisible`), from the object's own `to`/`cc` and
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
  ActivityStreams (415) and a personal inbox of no local account (404) are refused before anything is spooled. A
  request the Store cannot judge (its one read before verification fails as maintenance or transiently) is spooled,
  to be judged on replay.
  _Enforced (main):_
  `src/app/app.ts`, `src/app/gate.ts`, `src/federation/spool.ts`, `processInbox` in `src/federation/inbox.ts`;
  `test/gate.test.ts` ("maintenance gate", "inbox gate"). A PITR
  restore requires env `MAINTENANCE=full`: _Enforced (main)_ (`test/admin.test.ts` ("restores
  only under MAINTENANCE=full")). Replay that verifies the signature against the spool time:
  _Enforced (main):_ `src/jobs/queue.ts`, `src/federation/inbound.ts`; `test/inbox.test.ts`
  ("OPS-1"), `test/gate.test.ts` ("refuses a personal inbox of nobody"). A replay reads the actor's revision when it
  is replayed (ID-1): an `Update(Person)` whose document another store superseded answers 503, having written nothing,
  and the replay takes the Queue's ordinary retry, within its retry budget (`test/inbox-actor-revision.test.ts`).
- **OPS-2: no upgrade runs under a dump freeze or an import.** Migrations wait while either exists. The freeze also
  stops session writes and alarm work. _Enforced (main):_ `src/platform/store-kernel.ts`,
  `src/platform/store-flags.ts`; `test/dump-import.test.ts`, `test/ops-authority.test.ts` ("upgrades during an import").
- **OPS-3: an unknown outcome is reconciled, not assumed.** A migration failure re-reads durable bookkeeping. Other
  operations that a client may retry after a lost response carry a stable idempotency key. _Enforced (main)_ for
  migrations: `test/migrations.test.ts` ("re-reads bookkeeping"). _Enforced (main)_ for posts, a repeat within the
  hour (`Idempotency-Key`, `test/statuses.test.ts`, `test/scheduled-statuses.test.ts`) and for import chunks
  (`test/dump-import.test.ts`). An `Update(Person)` answered 503 because its document was superseded (ID-1) rolled
  back everything; a retry is a new attempt, judged afresh, which may be superseded again.
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
  held as in maintenance (spooled, or requeued without counting a retry); the gate hands over no signing key while
  writes are refused (`Store.inboxGate`); the write's own transaction checks again. The
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
  `src/platform/store-admin.ts` (`publish`, `importBegin`, `cutoverReset`), `inboxGate` (`processInbox` in
  `src/federation/inbox.ts`, `executeProbing` in `src/platform/store-kernel.ts`), `backupClaim` in `src/store.ts`, `src/app/admin.ts`; `test/cutover-rollback.test.ts` ("the
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
  only, as Queues reports it). Residuals: the legacy consumer's side of the drain (that it accepts the drained
  requests) has no test here; delivery is at least once (a crash between the send and its record repeats one request);
  a send given up at its timeout may still reach the legacy Queue after the lease expired, and so after a later drain's
  send, and the legacy consumer does not deduplicate (fixing that needs a change to the legacy runtime, which this
  cutover does not make); while the legacy routes come back, requests spooled just before and the legacy instance's first direct requests can interleave, as deliveries from different servers can
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

## Negative cases by area

The negative cases each area requires, in tests named with the invariant IDs; a row notes the cases still planned.

| Area                    | Required negative cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inbound                 | Wrong signer or actor; foreign activity id; same-origin different actor; unauthorized Undo, Accept, Update, Delete; duplicate and reordered Delete and Create; non-AS media type; private and unlisted object fetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Delivery                | Redirect of a private activity; recipient outside the audience; duplicate inbox; expired lease; stale completion; commit followed by response loss (`test/deliveries.test.ts`, `test/delivery-post.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Statuses, media, search | Edit, source or history of another's status; history seen by a recipient added later; private boost in `reblogged_by`; hidden parent in reply fields; DM moving `last_status_at`; unbounded edits or reply tree; boost or quote of an invisible status; foreign attachment; unsafe R2 key; retained EXIF; failed transform; active media type; private status in search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UI and setup            | Missing, `null` and foreign Origin; framing headers; unsafe return path; session fixation and reuse after logout (`test/web-session.test.ts`, `test/web-images.test.ts`, `test/web-pages.test.ts`); reused setup token, concurrent bootstrap, missing, `null` and foreign Origin on `/setup` (`test/setup.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Backup and restore      | Plaintext dump, media or manifest egress; interrupted upload; missing component; unselected manifest; restored obsolete credentials (`test/backup.test.ts` covers egress, interrupted uploads and changed components; selection and credential invalidation are DATA-8, planned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Cutover                 | Wrong target resources, domain or keys; writes to the source; an alternate Pages route still writable; unreconciled Queue or DLQ; changed content with unchanged length. Conversion (`test-node/cutover-*.test.ts`, `test/cutover-import.test.ts`): the audience never widens (a DM made public by bridge defaults; an author rewritten by 0021; an href-only address; a followers value spelled differently from its address; a followers-only mention that outlives an unfollow; a recipient added to a private boost; a tag or cc outside `to` made a recipient; a non-follower recipient of a followers-only status; conflicting or missing addressing); missing, emptied or same-length rewritten content; a removed or added recipient; a widened visibility; a dropped reply link, alias, follow, boost, notification or list member; a changed source, raw, edit, attachment, profile, key, setting, preference, policy, scope or counter; an extra row; an image moved to another owner or status; a lost or taken legacy id; a lost notification high-water mark; mixed KEKs; unaccepted deletions or truncation; `INSERT ... SELECT`, functions in `VALUES`, `CREATE TABLE ... AS SELECT`, non-canonical default or check expressions, bookkeeping DDL, nested or oversized `replace` expansion and stray statements; content in failure reports; an existing output file or link; an oversized export, total or dump; alias requests for hidden statuses and their images; cutover operations (`test/maintenance-worker.test.ts`, `test/cutover-token.test.ts`, `test-node/cutover-fingerprint.test.ts`, `test-node/cutover-maintenance.test.ts`): a write through the maintenance worker (any method, API, outbox, actor path), a personal inbox of nobody or under another case, a non-AS body, an oversized or undeflatable body, a missing or failing spool Queue, a legacy binding touched, a spooled request altered before replay, a replay a day after the signature, a snapshot key, key id, owner or actor that is not the legacy one, a local actor left out, mixed KEKs, another domain, a second import or a configuration change with `IMPORT_TOKEN` after the first import or once Access is set, a fingerprint after an insert, a delete, a same-length update of a short value, values swapped between rows, an edit inside a long value, emptied content or a moved notification counter, an export without the counter, an incomplete manifest, an export whose counts differ from the fingerprinted database, a secret or instance data in a report; an unsigned or oddly signed spool request, the rate limit, a full backlog; a stale snapshot; a cutover reset after publication, without MAINTENANCE=full, by the import token, during an import or with a non-empty journal; a drain past a request that may verify later, a forged request drained, a drain without the legacy binding, journaling after publication (`test/cutover-rollback.test.ts`); an isolate that first saw an empty Store, a delayed request overtaken by a newer one, a legacy retry overtaken, a dead-lettered legacy message, unreadable backlogs in the drain and in admission, a concurrent drain, a crash while sending, a late redelivery, a missing recipient, a flood against the journal quotas, Rollback A from bootstrap, an emptied notifications table without its counter, a manifest with a missing or extra zero-count table; a failing mark RPC, an import completing while the Worker served, publication with a journal, a drain after publication, re-import after Rollback A, redelivery after a reset and after the mode is removed, a suspended send past its lease, dead-lettering between readings, activities without context or id, valid requests over the quota, bookkeeping keys in a manifest; queue replay and deliveries of an unpublished import with MAINTENANCE=off, a restore published without Access, a mark answered after the lease ran out, a handed-off copy in Kopje's DLQ at close, bookkeeping keys with matching counts, a journal-full stop through a transient key failure and the CLI deadline, the unordered escape; a Queue reading that outlasts the round, a report that outlasts the lease, a live or replayed request while unpublished (no fetch, no retry), a scheduled backup before publication, a publication without an import, an import into a published Store, both publication marks at once, an unordered drain without a reported stop |

## IDs to check by change type

- **Mastodon API endpoint:** AUTH-1, AUTH-2, AUTH-6, VIS-1, VIS-5, VIS-12, RES-1, RES-3, RES-7, DATA-6. Test a wrong
  scope, a revoked token, another account's resource, and a status the viewer may not see.
- **Inbound activity handler:** ID-1, ID-3, ID-6, ID-7, ID-8, VIS-2, HTML-1, RES-1, RES-2, RES-6, OPS-1; the inbox
  precheck and the spool also OPS-6 (the cutover's maintenance worker shares them).
- **Outbound activity or delivery:** VIS-3, VIS-30, NET-2, NET-3, DATA-1, DATA-7, RES-5, RES-6.
- **Forwarded activity:** ID-1, ID-7, VIS-3, VIS-28, NET-2, RES-6, RES-7, DATA-5, DATA-6.
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
OWASP, html5sec and sanitize-html vectors in `test/fixtures/` (`test/html.test.ts`); Mastodon's `StatusPolicy`,
`StatusFilter` and inbound activity specs, cited in test names.

## Accepted risks

| Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why accepted                                                                                                                                                                                                                                                                                                                                                                                                                                             | Revisit when                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A claim of a status's card whose author is suspended and restored within one round attaches the card it fetched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Nothing suspended is presented, and the request had been made; a suspension that is not lifted drops the record (VIS-32)                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                        |
| Whoever controls a page on a host chooses, for 24 hours, the oEmbed endpoint the cards of every link on that host are fetched from (Mastodon caches it the same way)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The endpoint still passes every NET-3 hop rule and the domain policy, and changes only a card's texts and its video's iframe src (HTML-3)                                                                                                                                                                                                                                                                                                                | an operator asks to turn oEmbed off                                                                                      |
| A client that plays a card's video loads the third-party page its iframe src names (Mastodon's web client does so only after a click)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The src is an http(s) URL within its bounds in Kopje's fixed, sandboxed template, never remote markup (HTML-3); `embed_url` is never shown                                                                                                                                                                                                                                                                                                               | —                                                                                                                        |
| A public or unlisted status's first link is requested by the instance, which tells the linked site that it holds the status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A reader of the status would follow the same link; private, direct and limited statuses are never fetched (VIS-32)                                                                                                                                                                                                                                                                                                                                       | an operator asks to turn link cards off                                                                                  |
| An announcement whose rendering passes 64 KiB after it was written (a mentioned account's URL grew) is shown with no link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The text is still shown in full, escaped; a write past the budget is refused (MD-4)                                                                                                                                                                                                                                                                                                                                                                      | announcements need richer rendering                                                                                      |
| An announcement's mentions follow the accounts as they are when read, as Mastodon's do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Mastodon resolves them live too; unavailable accounts are never linked (R1)                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                        |
| Which new emoji a reaction may name is decided by workerd's ICU (`\p{RGI_Emoji}`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Names already stored are unaffected; every name of Mastodon's emoji map passes                                                                                                                                                                                                                                                                                                                                                                           | the runtime's ICU lags Mastodon's map                                                                                    |
| Trends count only the newest 4,000 public originals of the last two days, so past that the oldest are not counted, which lowers `expected` and raises scores (MD-5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The window keeps the round's cost flat; the constants shrink with no schema change                                                                                                                                                                                                                                                                                                                                                                       | an instance receives more than 4,000 public posts in two days                                                            |
| On a one-person or small instance, `GET /api/v1/instance/activity` tells anyone in which 6-day windows of the last 12 weeks its accounts were active and when the instance was set up; it answers by default, also on an instance upgraded to it                                                                                                                                                                                                                                                                                                                                                                                                                                          | Mastodon answers the same by default (`activity_api_enabled`); `usage.users.active_month` already tells the month; the answer is kept for its UTC day, so repeated reads cannot time a day's first login or post, except that a change of the setting or of the publication state makes it again, and during a dump's freeze every request that finds none kept makes it; `kopje-admin instance activity_api_enabled=false` turns it off (docs/setup.md) | an operator asks for it off by default, or Mastodon changes its default                                                  |
| Spam can fill the 50-row review pool and hide newer candidates from review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | It cannot push out allowed trends (separate pools)                                                                                                                                                                                                                                                                                                                                                                                                       | the review pool stays full of spam                                                                                       |
| A listed hashtag's `history` counts at most its newest public entries of the 7 days, before the rule: 20 in v2 search, `followed_tags` and `featured_tags/suggestions`, 200 in the trends lists (MD-5); newer boosts and unavailable authors' posts can make it undercount                                                                                                                                                                                                                                                                                                                                                                                                                | It bounds the lists' reads (RES-7); `GET /api/v1/tags/:id` keeps the full history                                                                                                                                                                                                                                                                                                                                                                        | a client needs the full counts in a list                                                                                 |
| A trending link's `history` counts at most its newest 200 public copies of the 7 days and 200 of their public boosts (20 of each), before the rule (MD-5); a link is identified by its card's final URL, and a card fetched before 0071, or one whose final URL the stored rule refuses, never trends                                                                                                                                                                                                                                                                                                                                                                                     | It bounds the round's and the list's reads (RES-7), and an identity that cannot be stored fails closed                                                                                                                                                                                                                                                                                                                                                   | a client needs the full counts, or an instance relies on older cards trending                                            |
| A link whose cards' texts were imported malformed (they pass the stored bounds and decode past the presented ones) can take one of the 400 candidate places, cut before presentation is judged, and is then not shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Only an imported dump holds such text (every writer stores well-formed text, RES-2); the round's candidate read stays one bounded statement (RES-7)                                                                                                                                                                                                                                                                                                      | an import with malformed card texts is seen to starve link trends                                                        |
| An announcement taken down by its end time sends no `announcement.delete`, and a scheduled one is published up to 5 minutes late                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Mastodon's scheduler does the same (MD-4); REST is authoritative                                                                                                                                                                                                                                                                                                                                                                                         | clients rely on the event                                                                                                |
| Duplicate keys in a JSON OAuth body are not rejected; the last one wins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | RFC 6749 defines form bodies only, and Doorkeeper behaves the same                                                                                                                                                                                                                                                                                                                                                                                       | a client depends on JSON bodies                                                                                          |
| Fedify 2.4.2 signs draft-cavage `(request-target)` without the query string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Mastodon accepts it; reported upstream                                                                                                                                                                                                                                                                                                                                                                                                                   | a peer rejects signed GETs to URLs with a query                                                                          |
| Backups, dumps and cutover exports made before a KEK rewrap hold the local keys under the previous KEK (unprotected when it was empty), so R5 with one of them and that KEK can unwrap the keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The rewrap cannot change copies outside the Store; the rotation procedure tells the operator to delete them or accept this (DATA-14); health warns on an empty KEK                                                                                                                                                                                                                                                                                       | a key leak, or backups are re-encrypted per key                                                                          |
| Signed-fetch cache entries may outlive a remote block or key change by up to 5 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Measured CPU savings on personal inboxes                                                                                                                                                                                                                                                                                                                                                                                                                 | blocks must apply at once                                                                                                |
| OAuth client secrets are stored in plaintext, so R5 can act as any registered app (no user scopes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Matches Mastodon; app tokens carry no user authority                                                                                                                                                                                                                                                                                                                                                                                                     | app tokens gain user-level powers                                                                                        |
| Aggregate counters (`reblogs_count`, `favourites_count`, `replies_count`) include interactions the viewer cannot see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Mastodon parity; clients rely on the counts                                                                                                                                                                                                                                                                                                                                                                                                              | counters must hide private interactions                                                                                  |
| An inbound `Flag` differs from Mastodon's: one whose id is not on its actor's server is ignored (Mastodon files it without a uri); a redelivery files nothing (one report per Flag id and account, where Mastodon files one per delivery); a status's own mention admits it, where Mastodon's mention term is any mention of the domain (`report_service.rb:89`); only originals are attached; at most 101 objects are read                                                                                                                                                                                                                                                               | Each keeps a report tied to one signed activity of its server, and the uncorrelated term would attach any status once one mentions the domain                                                                                                                                                                                                                                                                                                            | Mastodon changes its `Flag` handling                                                                                     |
| One remote actor may have at most 100 unresolved reports, not one server: a server with several actors that send Flags has 100 for each                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Mastodon and Misskey send Flags from one instance or system actor; a server-wide quota would need its own counter                                                                                                                                                                                                                                                                                                                                        | a server is seen spreading reports over actors                                                                           |
| The follower probe (two windows of 1,000 rows) can leave out a private status of an account with more followers when the reporter's server has more stored accounts and neither window holds a follower there                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | It bounds the work of a Flag (RES-7); the report is still filed with its other statuses                                                                                                                                                                                                                                                                                                                                                                  | such reports are seen missing statuses                                                                                   |
| The admin is shown a report's statuses only while its reporter may still see them, and a remote report's `status_ids` keep the ids admitted when it was filed; a remote report's comment (which may hold a NUL, Mastodon's PostgreSQL stores none) is kept until its reporter's or its target's purge                                                                                                                                                                                                                                                                                                                                                                                     | The rule the report was made under (R37); the comment is plain text the admin alone reads                                                                                                                                                                                                                                                                                                                                                                | Mastodon changes what it shows                                                                                           |
| `GET /api/v1/instance/peers` lists the domain of every known remote account, including one known only from a direct or limited status, a follow or a search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Mastodon parity (`Instance.searchable`); the instance's `domain_count` already counts the same set                                                                                                                                                                                                                                                                                                                                                       | peers must hide how a domain became known                                                                                |
| `GET /api/v1/accounts/familiar_followers` does not show a match past the viewer's first 10,000 accepted follows (in account id order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The window is above Mastodon's default follow limit (7,500); a complete intersection would need maintained overlap data                                                                                                                                                                                                                                                                                                                                  | a viewer follows more than 10,000 accounts                                                                               |
| `GET /api/v1/lists/:id/accounts?limit=0`, which Mastodon answers with every member, answers the newest 1,000 by account id, and at most 8 MiB of accounts, linking `next` to the rest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | One answer presents whole accounts (remote bios included), and 1,000 and 8 MiB keep it well within the isolate's 128 MB; the answer stays bounded (RES-3)                                                                                                                                                                                                                                                                                                | a list holds more than 1,000 members and a client relies on limit=0                                                      |
| Non-public media is readable by anyone holding its unguessable URL; cached copies outlive deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Clients and peers fetch media without credentials; URLs appear only under VIS-1                                                                                                                                                                                                                                                                                                                                                                          | authenticated media fetch becomes interoperable                                                                          |
| A write of a failed upload that lands after the sweep stays a day; one landing after its tombstone stays for good                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | An HTTP Worker has no fixed wall-time limit; deleting unrecorded objects would destroy media after a restore                                                                                                                                                                                                                                                                                                                                             | R2 offers conditional writes bound to a Store record                                                                     |
| R2 originals keep the uploaded bytes, EXIF and location included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Never served (MEDIA-2); backups restore from them; they are A8                                                                                                                                                                                                                                                                                                                                                                                           | backups can be rebuilt from re-encoded files                                                                             |
| Remote servers' copies of statuses from before the cutover lose their images once the legacy images are deleted from Cloudflare Images                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Kopje sends no `Update` for old statuses, which Mastodon would mark as edited; the runbook keeps the images for 30 days first                                                                                                                                                                                                                                                                                                                            | send `Update` for the old statuses                                                                                       |
| Service tokens are recognized by Access's claim shape (no email, empty `sub`, `common_name`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The admin application's policy decides which identities reach it                                                                                                                                                                                                                                                                                                                                                                                         | the admin application admits mTLS or Access changes the claims                                                           |
| A delivery whose completion was lost is POSTed again after its lease (at-least-once); a Mastodon server that processes the repeated `Follow` after the `Undo` sent behind it follows again (each body it receives is its own job), while Kopje has ended the follow                                                                                                                                                                                                                                                                                                                                                                                                                       | Receivers deduplicate by activity id; exactly-once needs the receiver's cooperation, and Mastodon repeats a delivery whose answer it lost the same way                                                                                                                                                                                                                                                                                                   | a receiver is seen to apply a repeat                                                                                     |
| Misskey with several silent recipients of one status on one server: only the first copy Misskey processes sets the note's audience, so the other silent recipients there cannot see it. Supported: one silent recipient per Misskey server                                                                                                                                                                                                                                                                                                                                                                                                                                                | Misskey keeps the first `Create` of a note; a combined copy would name the recipients to each other, and recipient-specific object ids would split the status                                                                                                                                                                                                                                                                                            | Misskey honours a later copy, or a peer needs it                                                                         |
| A retraction staged over several batches (a job's Undo of a local boost, a local status's `Delete`, a forward) misses a follow made after its staging began, and a delivery row moved in place to a personal inbox after the rows' walk passed it whose receipt sorts behind the receipts' cursor or that gets none                                                                                                                                                                                                                                                                                                                                                                       | Each source is read once from its own cursor (RES-6); following later changes of every source would read them again at each call                                                                                                                                                                                                                                                                                                                         | such follows or moves are seen to lose a retraction                                                                      |
| A boost again after an unboost may reach a server before the earlier boost's `Undo`, whose targets its job writes later: a Mastodon receiver then ignores the new `Announce` (it holds the earlier boost) and removes the earlier boost on the `Undo`, so the new boost is lost there                                                                                                                                                                                                                                                                                                                                                                                                     | Mastodon's own `RemovalWorker` and `DistributionWorker` race the same way; the unreblog asks for the job's round at once, which narrows the window                                                                                                                                                                                                                                                                                                       | a receiver is seen to lose boosts this way in practice                                                                   |
| An untyped `Undo` whose object is a pair-shaped id (`/follows/<a>/<b>`) that matches nothing is not recorded as retracted, so a `Block` with that id arriving after it applies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Such an id names every generation of a Misskey follow and must not be recorded; Misskey's Block ids are `/blocks/<id>`, so only an unusual server that gives a Block a pair-shaped id and reorders its delivery is affected                                                                                                                                                                                                                              | a server is seen to send pair-shaped Block ids                                                                           |
| A lease taken just before maintenance and not completed counts one attempt when it expires                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Bounded by one attempt per lease; maintenance itself claims nothing (RES-5)                                                                                                                                                                                                                                                                                                                                                                              | maintenance windows become frequent                                                                                      |
| With Workers invocation logs turned on by the instance (off as shipped, docs/observability.md): entries record request headers verbatim except a few the platform masks (`Authorization` is masked), so a streaming client's subprotocol access token (VIS-26), and request URL paths, `/media/<token>/<file>` capability paths included, readable for 7 days by every member and API token with Workers Observability access on the account, a wider audience than VIS-1's; a copy taken during retention outlives it                                                                                                                                                                    | Taken only by an operator who opts in, when every such principal (human members and API tokens with a Workers Observability or broader permission) is trusted with users' access tokens and media capabilities and the operator accepts that copies outlive retention; account membership or holding the Worker's secrets is not enough (DATA-5)                                                                                                         | Cloudflare offers header and path redaction in Workers Logs                                                              |
| With Workers traces turned on by the instance (off as shipped, docs/observability.md): spans record the text of every SQL statement (the admin SQL route's queries verbatim), R2 keys (media capability tokens, uploads never shared included), Web Push endpoint URLs (capability URLs, RFC 8030 section 8) and outbound URLs, readable for 7 days by every member and API token with Workers Observability access on the account, and a copy taken during retention outlives it                                                                                                                                                                                                         | Taken only by an operator who opts in, when every such principal (human members and API tokens with a Workers Observability or broader permission) is trusted with all of that data and the operator accepts that copies outlive retention; account membership or holding the Worker's secrets is not enough (DATA-5)                                                                                                                                    | Cloudflare offers span attribute redaction                                                                               |
| Fedify's own fetch-failure logs include response headers; they are silent only because logtape is unconfigured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Kopje configures no logtape sink (DATA-5); a sink without redaction must not be added                                                                                                                                                                                                                                                                                                                                                                    | Kopje configures logtape                                                                                                 |
| Remote HTML is sanitized by sanitize-html, whose htmlparser2 is a tokenizer rather than an HTML5 tree builder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | It emits only allowlisted tags with quoted, escaped attributes and escapes all other text; the parse5-checked vector suites pass                                                                                                                                                                                                                                                                                                                         | a vector fails, or a maintained tree-based sanitizer fits the budget                                                     |
| Backup media copies are never pruned, so an original deleted from R2 stays in the bucket (and copies from abandoned or stale attempts stay too); served `files/` variants are not backed up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Copies are reused across backups and the kept indexes refer to them; originals are the source of the variants (the media rebuild, MEDIA-2)                                                                                                                                                                                                                                                                                                               | a restore tool re-encodes variants, or backups track deletions                                                           |
| The backup's S3 credentials can delete backups under `backups/` (not `media/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Retention needs delete; versioning or object lock on the bucket is the documented protection                                                                                                                                                                                                                                                                                                                                                             | the job can work with put-only credentials                                                                               |
| Activities signed by someone other than their actor (forwarded, with LD signatures) are refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ID-1. Replies that reach Kopje only by forwarding (to a collection the author cannot deliver to) and deliveries through relays are missed                                                                                                                                                                                                                                                                                                                | relays or forwarded replies must be supported                                                                            |
| The app registration limit is approximate: the Rate Limiting binding counts per Cloudflare location and is eventually consistent, and many addresses together can fill the 500 never-authorized slots, evicting never-authorized apps older than an hour or refusing registration for an hour at most                                                                                                                                                                                                                                                                                                                                                                                     | The Store's bound holds exactly whatever the limiter lets through, and every refusal is visible (429); Workers offers no exact global limiter without a paid product                                                                                                                                                                                                                                                                                     | registrations are seen to be refused or evicted in practice                                                              |
| An app token (`client_credentials`) of an app no user has authorized may stop working under registration pressure: the app is evicted with its tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Anyone can get an app token without a user; letting app tokens protect an app would let them fill the budget for good. Clients re-register, as after Mastodon's vacuum                                                                                                                                                                                                                                                                                   | logged-out clients are seen to lose their app tokens                                                                     |
| Two first sign-ins of one browser that overlap (the second starts before the first's session cookie arrives) leave two sessions; signing out ends only the one in the cookie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Both belong to the same person in the same browser, the other token is in no cookie or response any more, and it expires with its 7-day lifetime; binding them would need a server-side browser identity before sign-in                                                                                                                                                                                                                                  | a session token is seen to leak this way                                                                                 |
| A web session lasts its 7 days even if the person's Access session ends or the Access policy changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Access checks the person at sign-in only, by design; suspension, sign-out and "sign out other sessions" end sessions at once                                                                                                                                                                                                                                                                                                                             | sessions must follow Access policy changes                                                                               |
| Notifications written before a block, a mute or a domain block are hidden while it lasts, not deleted as Mastodon deletes them, so they show again after it ends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The one notification rule hides them at read time (VIS-13 to VIS-15); deleting them would be unbounded work in the request                                                                                                                                                                                                                                                                                                                               | a user expects them gone after an unblock                                                                                |
| A local block of a remote actor at its retraction cap does not record the ended Follow as retracted, so after an unblock a redelivery of that Follow is accepted as a new one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The block must apply whatever the blocked actor did to its own cap; while the block lasts its Follows are refused (VIS-13)                                                                                                                                                                                                                                                                                                                               | redelivered Follows are seen after unblocks                                                                              |
| Deliveries queued before a block or a domain block (retries of them included) are still sent as queued, to the blocked account's inboxes too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Mastodon does not rewrite deliveries already queued either; a re-check at claim cannot tell, for a shared inbox or a follower target, which recipients it serves (VIS-13, VIS-15)                                                                                                                                                                                                                                                                        | deliveries keep their recipients                                                                                         |
| A follow answer (`Accept`, `Reject`) whose delivery was confirmed before the follower's new `Follow` committed is still POSTed, once per lane of the pair; a server matching answers by account pair may apply it to the new request, so the sides can disagree (NET-2). Misskey 2026.10.0 retries an `Accept` that finds no follow request, so an old `Accept` can meet a later request: a locked account's pending renewal may be authorized there while Kopje still waits for the owner. A `Reject` of a `Follow` refused because the target blocks the follower cancels nothing                                                                                                       | A server's application of a POSTed answer cannot be observed: servers queue, process concurrently and retry, and the POST deadline bounds Kopje's attempt, not the server's processing. Once superseded, an answer gets no further attempt and no failure backoff; `kopje.delivery.stale_follow_answer` with `sent_in_flight` is local evidence of a possible overlap, not an observed disagreement. Recovery: the follower follows again                | a server offers answer correlation, or such a disagreement is seen                                                       |
| A block followed at once by an unblock races a new remote `Follow`: when the `Follow` reaches Kopje after the unblock but before the follower's server processed the `Block`, Kopje accepts it and sends `Block`, its `Undo` and the `Accept` in lane order; a Mastodon server drops the pending request on the `Block` (`block.rb`), so the `Accept` finds nothing and Kopje keeps a follower whose server does not follow (VIS-13)                                                                                                                                                                                                                                                      | Mastodon as the sender behaves the same: `BlockService` and `UnblockService` enqueue independent deliveries. Cancelling on unblock a `Block` no claim ever leased, with its `Undo`, as `cancelFollowAnswers` does for answers, would narrow the window, while a `Block` already sent keeps the race. Recovery: the follower follows again                                                                                                                | such a disagreement is seen in practice                                                                                  |
| A remote `Follow` that reaches Kopje after a newer `Follow` of the same follower (its server's deliveries are independent jobs) is taken as the next generation, so the older one's `Undo` then ends the follow at Kopje while the follower's server holds the newer one (ID-7)                                                                                                                                                                                                                                                                                                                                                                                                           | Kopje cannot tell the generations' order from their ids; a Mastodon receiver takes the older `Follow` the same way (`follow.rb`'s update of an existing request or follow). Recovery: the follower follows again                                                                                                                                                                                                                                         | a server orders its `Follow`s (a sequence or a timestamp)                                                                |
| A remote status's `Update` that reaches Kopje before its `Create`, more than 24 hours after the status's publication (its server's deliveries are independent jobs, retried for about three days), is dropped as an `Update` of an old unknown object, so the `Create` that follows stores the earlier version until the next edit (ID-7)                                                                                                                                                                                                                                                                                                                                                 | A Mastodon receiver does the same (`update.rb`'s `object_too_old?`, one day); taking such an `Update` would store late edits of statuses that concern nobody here. Recovery: the author edits again                                                                                                                                                                                                                                                      | such a disagreement is seen in practice                                                                                  |
| A remote account that blocks a local one and follows it (the local owner authorized the request the `Block` kept, VIS-13) drops the follow on its server when Mastodon refollows (`RefollowWorker` unfollows locally, with no `Undo`) and its `FollowService` refuses the new `Follow` because it blocks the local account, so Kopje keeps a follower whose server no longer follows                                                                                                                                                                                                                                                                                                      | A Mastodon receiver keeps the follow the same way, since nothing is sent; Kopje cannot learn of a follow its follower dropped silently. Recovery: the local owner removes the follower, or the remote account unblocks and follows again                                                                                                                                                                                                                 | the follower's server sends an `Undo` for a refollow it refuses                                                          |
| A Mastodon server processes each body it receives as its own job and matches a typed `Undo` of a `Follow` or a `Block` by the account pair, not by the id it names (`undo.rb`): an earlier `Undo` processed after the newer `Follow` or `Block` ends that one there, and a newer `Undo` processed before its `Follow` or `Block`, while the earlier one stood, ends the earlier one and is not kept to stop the newer, which then applies there. The sides then disagree on that one follow or block of the local account (VIS-13)                                                                                                                                                        | Kopje sends the lane in order and cannot order the receiver's jobs; a Mastodon sender races the same way, its deliveries being independent jobs. Recovery: the local account follows or blocks again, or undoes it again                                                                                                                                                                                                                                 | Mastodon matches the `Undo` by the id it names                                                                           |
| Clients, and browsers viewing a public page or the embed, load from the hosts that name them, which see the viewer's address (a page sends them no referrer): a custom emoji image not yet cached, that the cache refuses (by type, size, host or a policy), or past a snapshot's first 16 entries (edit history included); a remote attachment's file or icon not yet cached, that the cache refuses (Ogg, HEIF, QuickTime, a size past its cap, a host or a policy), that arrived before the retention or was stored longer, and every attachment of the edit history; posters; avatars and headers not yet cached or that the cache refuses; a page's video and audio only once played | The remote URL is the fallback Mastodon's media proxy replaces; the cache takes attachments within `MEDIA_CACHE_RETENTION_DAYS` (NET-3, MEDIA-7); the Store's memory bound (RES-3) holds the emoji cache read with each row to 16 entries; the URLs are http(s) and bounded (HTML-3, RES-2); a page's players ask for nothing before play (`preload="none"`, no autoplay, WEB-2)                                                                         | more cached emoji entries fit the memory bound, the edit history shows cached files, or a remote URL must never be shown |
| An emoji snapshot goes stale until its object is delivered again: an emoji the author's server changes or removes keeps its old URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Each object keeps what it tagged; a global (shortcode, domain) registry, as Mastodon keeps, is not stored                                                                                                                                                                                                                                                                                                                                                | emoji are kept in a registry                                                                                             |
| An uncached emoji's `static_url` is the same as `url`, and so is a cached one's when no still could be remuxed within 256 KiB, so such an animated emoji stays animated where a client asked for still images                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Mastodon serves a still image it generates; stills are remuxed, never decoded (MEDIA-6)                                                                                                                                                                                                                                                                                                                                                                  | clients need stills of every emoji                                                                                       |
| Rows stored before migration `0053_custom_emoji_snapshots`, and converted ones, show no emoji: an account until its next refresh, a status until its next Update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Backfilling from the stored documents would put the upgrade's time budget at risk                                                                                                                                                                                                                                                                                                                                                                        | a backfill fits the upgrade budget                                                                                       |
| A disabled local emoji keeps showing in the posts and profiles that used it, and in their Notes and actors; Mastodon hides it (`EntityCache#emoji`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A snapshot shows what was posted; the image is never deleted (MEDIA-5)                                                                                                                                                                                                                                                                                                                                                                                   | disabling must withdraw an emoji                                                                                         |
| Replacing an emoji changes the image peers show on earlier posts (they key emoji by shortcode); a delayed Create of an old post, or a peer's first fetch of one, switches that shortcode back to the old image until a newer object arrives. Edits carry the current image; poll-count Updates change nothing                                                                                                                                                                                                                                                                                                                                                                             | Nothing is re-delivered on disable, enable or replace, as Mastodon                                                                                                                                                                                                                                                                                                                                                                                       | peers key emoji by id or url                                                                                             |
| Local emoji too have `static_url` equal to `url`, and a status's snapshot shows `visible_in_picker: true` for an unlisted local emoji                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Kopje makes no still rendition; the snapshot keeps two elements                                                                                                                                                                                                                                                                                                                                                                                          | clients need still images                                                                                                |
| Disabled emoji versions' files, backup copies and rebuild transformations are kept and paid indefinitely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Emoji are never deleted (owner decision); the cost is documented in backup.md                                                                                                                                                                                                                                                                                                                                                                            | the cost matters                                                                                                         |
| An imported emoji whose existing `full` is 256 KiB or more, or whose actual edges pass 1,024 while its recorded ones do not, is served until `kopje-admin media-rebuild` reports it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The Store never sees file bytes; a restore always runs the rebuild                                                                                                                                                                                                                                                                                                                                                                                       | imports come from untrusted dumps                                                                                        |
| A remote account's `avatar_static` and `header_static` equal `avatar` and `header` until its image is cached, and after when no still could be remuxed within the still cap; so do a local one's for images uploaded before still renditions were made, so such an animated image stays animated where a client asked for a still one                                                                                                                                                                                                                                                                                                                                                     | Stills are remuxed, never decoded (MEDIA-6), and a rebuild never changes an account                                                                                                                                                                                                                                                                                                                                                                      | clients need stills of every image                                                                                       |
| A cached file is served with a one-year immutable `Cache-Control`, so a client or a cache may keep it after the cache deleted it (a new URL, a suspension, a purge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Its capability URL is never shown again once its slot changes (MEDIA-7)                                                                                                                                                                                                                                                                                                                                                                                  | deleted profile images must be withdrawn from clients                                                                    |
| After a PITR restore, a cached URL the restored Store shows may answer 404 until validation reaches it (at most 100 a round)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Validation resets a missing file to be fetched again; the presenter cannot check R2                                                                                                                                                                                                                                                                                                                                                                      | restores happen while users browse                                                                                       |
| After an unlock, a request from an unavailable requester, or from one the account blocks or whose domain it blocks, stays pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepting it would make a follower R1 or R21 refuses; the account can still reject it                                                                                                                                                                                                                                                                                                                                                                    | Mastodon's handling of such requests is matched                                                                          |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a Codex or human review checks the IDs listed for the change type above, plus
  anything this model is missing. The other lenses (correctness, design, tests) use their own criteria.
- **Tests** name the invariant in the test name or a comment where practical (for example `// VIS-4`), so `grep -rn
  'VIS-4' packages/kopje/test` shows its coverage.
- This document covers security only. It is not a correctness or design checklist.
