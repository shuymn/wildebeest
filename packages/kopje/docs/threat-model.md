# Kopje threat model

What Kopje protects, from whom, and the security invariants the code must keep, by ID (for example `ID-1`). It covers
security only; correctness, compatibility and design are reviewed against their own criteria.

**Keep it current.** A PR that adds an entry point, asset, trust boundary or accepted risk, or changes an invariant's
status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired with the reason.

## Status of an invariant

Paths are relative to `packages/kopje`. **Enforced (main):** the cited source and test exist on `main`. **Implemented on
branch `kopje/<name>`:** on a branch not yet in a PR (`kopje/inbound-statuses` is B1b-2). **Planned (stage):** not
implemented; required before the stage ships.

A **Gap** note names a part that no test pins yet; that part does not count as enforced. Stages: B1b inbound activities,
B2 delivery, B4 statuses, media and search, B5 web UI and `/setup`, B6b backups and restore, B8 cutover tools. "Push"
and "polls" are the stages that add Web Push and polls.

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

| Entry point                                                    | Reached by | Authenticated by                                         | Status and code                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /inbox`, `/ap/users/:username/inbox`, `/actor/inbox`     | R1, R2     | HTTP signature, also on replay from the spool            | main: `src/federation/inbound.ts`                                                                                                                                                                                                     |
| Actor, `/actor`, WebFinger, NodeInfo, followers and following  | R1, R2     | none (public)                                            | main: `src/federation/*`                                                                                                                                                                                                              |
| `/ap/o/:uuid`, status documents and the outbox                 | R1, R2     | none (VIS-4)                                             | main: `src/federation/federation.ts`                                                                                                                                                                                                  |
| Outbound document fetches                                      | R1 answers | final URL and parsed id (ID-2)                           | main: `src/federation/loader.ts`                                                                                                                                                                                                      |
| Deliveries, remote media fetches, Web Push POSTs               | R1 answers | sink policy (NET-3)                                      | main (deliveries, Web Push: `src/jobs/push.ts`); Planned (B4)                                                                                                                                                                         |
| Mastodon API `/api/*`                                          | R2–R4, R7  | bearer token and route access                            | main: `src/mastodon/*`, `src/domain/auth.ts`                                                                                                                                                                                          |
| `/oauth/authorize`                                             | R2, R6, R7 | Access JWT, Origin, consent                              | main: `src/app/authorize.tsx`                                                                                                                                                                                                         |
| `/oauth/token`, `/oauth/revoke`                                | R2, R3     | client credentials                                       | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                         |
| `/oauth/userinfo`                                              | R2, R3     | bearer token with `profile`                              | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                         |
| `/.well-known/oauth-authorization-server`                      | R2         | none (public)                                            | main: `src/mastodon/oauth.ts`                                                                                                                                                                                                         |
| `/admin/*` and the `kopje-admin` CLI                           | R2, R6     | admin Access JWT, service token, `IMPORT_TOKEN`, session | main: `src/app/admin.ts`                                                                                                                                                                                                              |
| `/setup` and its Cloudflare API calls                          | R2, R7     | `SETUP_TOKEN`, then the admin's web session (SETUP-2)    | `kopje/setup`: `src/app/setup.tsx`                                                                                                                                                                                                    |
| Web UI (profiles, permalinks, settings)                        | R2, R4, R7 | session (AUTH-8), Origin and form token (WEB-4)          | branch `kopje/web-ui`: `src/app/web.tsx`, `src/web/*`                                                                                                                                                                                 |
| Media upload and serving, Images transformation                | R2–R4      | bearer token; capability URL for reads                   | main: `src/mastodon/media.ts`                                                                                                                                                                                                         |
| Web Push registration                                          | R3         | bearer token with `push`                                 | main: `src/mastodon/push.ts`, `src/domain/push.ts`                                                                                                                                                                                    |
| Queue consumer, alarms, cron                                   | internal   | —                                                        | main: `src/jobs/queue.ts`, `src/platform/store-kernel.ts`                                                                                                                                                                             |
| Delivery doorbell and cron (`src/jobs/deliver.ts`)             | internal   | —                                                        | main: `src/jobs/deliver.ts`                                                                                                                                                                                                           |
| Dump import, backup restore, cutover tools                     | R5, R8     | admin authority, then digest chain and manifest          | main (import, convert, verify-conversion: DATA-11 to DATA-15); `kopje/scheduled-backup` (`backup-verify`); `kopje/cutover-ops` (`cutover-preflight`, `maintenance-worker`, `fingerprint`, `cutover`: OPS-4, OPS-7 to OPS-10, DATA-16) |
| Cutover maintenance worker (the legacy Pages routes, step 3)   | R1, R2     | none; inbox requests as above, on replay (OPS-1)         | `kopje/cutover-ops`: `src/maintenance.ts` (OPS-6, OPS-7)                                                                                                                                                                              |
| Backup bucket (S3-compatible, outside Cloudflare) and its cron | R5, R8     | SigV4 credentials scoped to the prefix (DATA-9)          | `kopje/scheduled-backup`: `src/jobs/backup.ts`                                                                                                                                                                                        |

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
  ("stored keys, rotation and ownership").
- **ID-2: a fetched document is trusted only for its own origin.** The identity of a fetched object is its parsed `id`
  after JSON-LD processing, and it must have the origin of the final response URL. The loader's literal `id` check is a
  pre-filter. Cross-origin redirects are refused. _Enforced (main):_ `src/federation/loader.ts`;
  `test/remote-identity.test.ts`, `test/loader.test.ts`.
- **ID-3: remote input never changes local actors or local objects.** No inbound activity updates, deletes, moves or
  attributes anything to a local account or local status. _Enforced (main)_ for actors and relationships: `upsertRemoteActor` and
  `localAccount` in `src/domain/inbox.ts`; `test/inbox.test.ts` ("a local actor URI is never written", "an actor updates
  only itself"). _Implemented on branch `kopje/inbound-statuses`_ for statuses, favourites and boosts: a remote object
  must have its actor's origin and name no other author, and only its stored author updates or deletes it, so a local
  status is never created, updated or deleted from outside (`storeRemoteStatus` and `updateRemoteStatus` in
  `src/domain/remote-statuses.ts`, `deleteObject` in `src/domain/inbox.ts`); `test/inbox-statuses.test.ts` ("nobody
  remote updates a local one (ID-3)", "nothing of anyone else’s (ID-6, ID-3)").
- **ID-4: `Move` requires the alias.** A `Move` is honoured only if the freshly fetched target lists the source in
  `alsoKnownAs`. _Enforced (main):_ `prepare` in `src/federation/inbound.ts`, `move` in
  `src/domain/inbox.ts`; `test/inbox.test.ts` ("ignores a Move whose target does not list the actor").
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
  table"). _Implemented on branch `kopje/inbound-statuses`_ for Create, Update and Delete of statuses, Like and
  Announce (the rows of the same table): `Create` needs the actor's origin and no other `attributedTo`; `Update` and
  `Delete` the stored status's author (a refused `Delete` records no retraction); `Like` a local status the actor may
  see (VIS-1, which Mastodon does not check); `Announce` an original that is public, unlisted or the actor's own
  (VIS-6); `Undo` of a `Like` or `Announce` the actor's own; `test/inbox-statuses.test.ts` ("ID-6: another actor of
  the same origin cannot update a status", "deletes the author’s status with its children, and nothing of anyone
  else’s (ID-6, ID-3)", "ID-6, ID-7: keeps an Undo that arrived before its Like", "ID-6, VIS-6: a boost of a private,
  direct or unfetchable object stores nothing").
- **ID-7: replay changes nothing twice.** A repeated activity creates no second relationship, counter change,
  notification, push or outbound intent (natural keys). A valid `Delete` or `Undo` that arrives before its target is
  recorded for 30 days and prevents the target from appearing later. Input that fails ID-1 or ID-6 reserves no key and
  records no retraction. _Enforced (main):_ natural keys and `retract` and `isRetracted` in
  `src/domain/inbox.ts`. A Follow has generations: a superseded, undone, refused or blocked Follow id is recorded as retracted, so
  no late Undo, Accept, Reject or replay reaches a newer generation, and no Accept or Reject is recorded twice; an
  answer's id derives from the Follow it answers. A Move is a job keyed by its id that never moves a follow made after
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
  _Implemented on branch `kopje/inbound-statuses`_ for statuses, favourites and boosts: a status, favourite or boost
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
  `Delete` of an unknown object at the cap is not recorded and answers 202. An `Undo` of a `Like` records both its
  own reference and the id the matched favourite was stored under, or neither. A local boost of a status that is
  deleted while its author is purged is withdrawn once: the boost row's own marker (`statuses.withdrawn`) records
  that its Undo was recorded, whichever job did it, and lives until the boost is deleted, however soon the intent
  itself goes once its deliveries settle; both jobs wait for the intent's staging before they delete the boost.
  `test/inbox-statuses.test.ts` ("ID-7: duplicate and reordered Create and Delete", "ignores an Update that is not
  newer"), `test/inbox-statuses-edge.test.ts` ("ID-7: the Update watermark", "leaves nothing for every order of
  Create, Update and Delete", "ID-7: retractions at the per-actor cap", "retracts both ids", "withdraws a local boost
  once", "ID-7: a retryable refusal commits nothing", "ID-6, ID-7: a deleted status is not created again by anyone",
  "after its deliveries are done").
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
  `direct` and `limited` by the mentioned (silent included) only. Every read path uses the same SQL rule, from the one policy module (`docs/visibility.md`; `test/policy.test.ts` keeps the rule out of other modules). A remote account is unavailable from the first transaction of its purge (`accounts.deleted_at`), so nothing of it is shown while the purge's batches remove its relationships and statuses (`test/inbox-regressions.test.ts`, "shows nothing of the actor from the Delete on"). _Enforced (main):_ `src/domain/audience.ts` (`visibleSql`, `canView`); `test/audience.test.ts`,
  `test/visibility.test.ts` (single status, context, history, source, `favourited_by`, timelines, account statuses,
  notifications, bookmarks, favourites). _Enforced (main)_ for search: `src/domain/search.ts`;
  `test/search.test.ts` ("never returns a status the viewer may not see", "drops a boosted status that became
  inaccessible", hashtags only where a status with them is visible), `test/search-edge.test.ts` (hashtag candidates
  pass the rule before ranking and truncation, so hidden statuses neither hide nor crowd out a visible tag, hidden
  mentions included). Hashtag search is recent autocomplete over the viewer's own library windows and the newest
  public statuses, not a catalogue: a tag outside the windows is not found. _Gap:_ a status the viewer saved that later
  became hidden still takes a slot of the viewer's own window, which reveals that something changed, not what. Media
  URLs appear only in statuses that pass the rule (see the capability URL accepted risk). The object endpoint serves only what VIS-4 allows (enforced on main). The web UI's public pages apply the rule with no viewer: _Implemented on branch `kopje/web-ui`:_ `src/domain/web-pages.ts`; `test/web-pages.test.ts`.
- **VIS-2: limited stays limited.** A direct status with silent recipients (Misskey `specified`) is `limited`: shown
  only to its addressed recipients, presented as `private` by the API, never widened by an edit. _Enforced (main):_ `interpretAddressing` in `src/domain/audience.ts`; `test/audience.test.ts` ("reads Misskey
  specified"). _Implemented on branch `kopje/inbound-statuses`_ for inbound statuses: addressing goes through
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
  each local profile whose images the conversion changed (OPS-8). _Implemented on branch `kopje/web-ui`:_
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
  endpoint's Note. A profile page lists only the account's public and unlisted originals. _Implemented on branch `kopje/web-ui`:_
  `statusPage` and `profilePage` in `src/domain/web-pages.ts`; `test/web-pages.test.ts` ("answers the same 404 for
  private, direct, limited, boosts, remote, another author and nothing", "hides the statuses of a suspended account").
- **VIS-5: lists also apply the viewer's filters**, Mastodon's `StatusFilter`. Feeds, context, notifications, bookmarks,
  favourites, `favourited_by` and `reblogged_by` drop authors the viewer blocks, mutes or domain-blocks. A single status
  by id is not filtered. A mute counts only until it expires (VIS-14), and home also drops a status or boosted
  original that mentions an account the viewer blocks or mutes (`FeedManager#filter_from_home`; VIS-13, VIS-14). _Enforced (main):_ `filteredForSql`, `listableSql` and `homeFilterSql` in
  `src/domain/audience.ts`; `test/audience.test.ts`, `test/visibility.test.ts` ("blocked and muted accounts stay out of
  lists"). _Implemented on branch `kopje/inbound-statuses`:_ a domain block matches an account by its stored domain
  and by the host of its actor id, the account's side normalized (lowercase, no port, no trailing dot) and compared with the block's stored, normalized domain through its index (`inDomainSql`, `domainBlocksSql`), everywhere a domain block applies (lists, notifications,
  relationships, inbound Follows and Moves, account search and search resolution), so an account confirmed under
  another WebFinger domain cannot escape a block of the server it lives on; `test/inbox-canonical-address.test.ts`
  ("applies a block of the actor’s host on every path", "never lets a third-party alias replace a confirmed domain or
  evade a block on it"). Account search finds an account that is available and not on a domain the viewer blocks
  (`findableBySql`). Search resolution answers an account only when account search would find it, and a status by the
  rule of a single status (VIS-1, `canView`, as Mastodon's `ResolveURLService` authorizes `show?`) unless the viewer
  blocks its author's domain. _Implemented on branch `kopje/account-lists`:_ `findAccounts` in
  `src/domain/accounts.ts`, `resolveSearch` in `src/domain/remote-statuses.ts`; `test/inbox-statuses.test.ts`
  ("answers a status by the single-status rule"), `test/policy-endpoints.test.ts`.
- **VIS-6: a wrapper reveals nothing its target hides.** A boost is visible only if its original is; boosting is limited
  to `public` and `unlisted` statuses and one's own `private` ones (`StatusPolicy#reblog?`). _Enforced (main):_ `viewableSql`; `test/visibility.test.ts` ("a boost of an original the viewer may not see is hidden
  with it"), `test/statuses.test.ts` ("refuses to boost direct and others’ private statuses"). Quotes and other embedded
  objects check their target the same way: _Planned (B4)._ _Implemented on branch `kopje/inbound-statuses`_ for
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
  would not show the same viewer: _Implemented on branch `kopje/startup-reads`:_ `familiarFollowers` in
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
  only and answer a page with 403. Kopje does not learn a remote account's setting, so a remote account's lists are
  never hidden. _Implemented on branch `kopje/account-lists`:_ `followListsShownSql` and `followListedSql` in
  `src/domain/audience.ts`, `listFollows` and `familiarFollowers` in `src/domain/accounts.ts`, `getCollection` in
  `src/domain/actors.ts`; `test/accounts.test.ts` ("follower lists for the viewer (R13)"), `test/account-reads.test.ts`
  ("shows no followers of an account that hides its network"), `test/federation.test.ts` ("shows only the size of the
  collections of an actor that hides its network"), `test/policy-oracle.test.ts`, `test/policy-endpoints.test.ts`.
- **VIS-9: only the followed side accepts.** A pending follow of a local account becomes `accepted` only by that
  account's own authorize call; a pending remote follow only by an `Accept` that passes ID-6. _Enforced (main):_ `answerFollowRequest` in `src/domain/accounts.ts` (`POST
/api/v1/follow_requests/:id/authorize` and `/reject`, the viewer from the credential; a remote requester gets the
  Accept or Reject at its shared inbox, or its personal inbox without one), and the inbound `Accept`, matched first by the `follows.uri` of our Follow;
  `test/inbox.test.ts` ("Accept: only the target of our Follow accepts it"), `test/inbox-regressions.test.ts` ("with
  outbound delivery").
- **VIS-10: a notification is emitted once.** It is written only if the recipient is local and may see the status, and
  only when new under its natural key; a repeat inserts nothing (`update` replaces the previous one). Its push is sent
  only for a newly inserted row. _Enforced (main):_ `notify` in `src/domain/notifications.ts`;
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
  `src/domain/statuses.ts`, `ACCOUNT_COLUMNS` in `src/domain/accounts.ts`; `test/statuses.test.ts` ("review
  regressions"). A tag's `history` (`GET /api/v1/tags/:id`) counts only public originals (as Mastodon's
  `Trends::Tags`) of accounts that are not suspended, the same for every viewer, so it counts no status the caller may
  not see: _Implemented on branch `kopje/startup-reads`:_ `getTag` in `src/domain/tags.ts`; `test/tags.test.ts`
  ("shows a tag with seven days of history", "leaves out the statuses of a suspended account", "keeps the public
  history whatever hidden statuses the window holds", "counts public statuses only"). The rule is applied in the query
  with no row limit, so hidden statuses cannot change the public counts.
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
  _Implemented on branch `kopje/blocks-mutes`:_ `block` and `unblock` in `src/domain/blocks.ts`, the inbound `block`
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
  an active one (`move` in `src/domain/inbox.ts`; `test/inbox.test.ts`, "carries an active mute over an expired one").
  _Implemented on branch `kopje/blocks-mutes`:_ `activeMuteSql`, `filteredForSql`, `homeFilterSql` and `shownSql` in
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
  slash) and this instance's own domain is refused. _Implemented on branch `kopje/blocks-mutes`:_ `blockDomain` and
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
  Mastodon's `FeedInsertWorker#notify?` lets `:skip_home` through. _Implemented on branch `kopje/lists`:_
  `src/domain/lists.ts`, `listTimeline` and `EXCLUSIVE_MEMBERS` in `src/domain/timelines.ts`, migration
  `0007_list_members` (trigger `list_members_follow_ended`), `moveBatch` in `src/domain/inbox.ts`; `test/lists.test.ts`,
  `test/inbox.test.ts` ("list members and inbound activities"), `test/migrations.test.ts`,
  `test/policy-endpoints.test.ts`, `test/policy-bounds.test.ts`, `test/policy-writes.test.ts`.

### Authorization (AUTH)

- **VIS-17: a filter changes only what its owner is shown.** Filters (`CustomFilter`) belong to a local account;
  another account's filter, keyword or filter status is not found, read or written. They apply after the read rule
  (VIS-1, VIS-5), in the presenter, for their owner only: a `hide` filter removes a status or its notification from
  the owner's response in the contexts it names, `warn` and `blur` only report the match in `filtered`, and nothing a
  filter reports names a status other than the one it is on or its original. A filter status is accepted only for a
  status the owner may view and is listed by id only. Matching is bounded (RES-1, RES-7): at most 50 filters per
  account, 20 keywords of 512 characters per filter and 200 statuses per filter, a status's text matched on its first
  10,000 code units and a request's statuses on 400,000 together (500 each at least), by `indexOf` over literal
  keywords, never a regular expression built from them. _Implemented on branch `kopje/filters`:_
  `src/domain/filters.ts`, `src/domain/status-presenter.ts`, migration `0011_filters`; `test/filters.test.ts` (API,
  ownership, contexts, matching, the worst case at the caps), `test/policy-filters.test.ts` (generated worlds),
  `test/policy-bounds.test.ts` (rows read up to the caps).
- **AUTH-1: authorization happens inside the operation.** Token validity, expiry, revocation, scope and account
  suspension are checked in the same Store transaction as the operation they authorize. _Enforced (main):_
  `userReadOperation` and `userWriteOperation` in `src/domain/auth.ts`; `test/store-auth.test.ts`, `test/oauth.test.ts`
  ("refuses a token that survived the suspension").
- **AUTH-2: every API route declares its access.** Each Mastodon API route is `public`, `token` (any valid token, app
  tokens included) or a required user scope, or any one of several (`GET /api/v1/accounts/verify_credentials`:
  `profile` or `read:accounts`); one helper decides scope coverage (parents cover children, `follow` expands to its
  split scopes, nothing else is implied: `read` does not cover `profile`, which covers nothing else). _Enforced (main):_ `src/mastodon/routes.ts`, `src/security/scopes.ts`;
  `test/scopes.test.ts`, `test/vectors.test.ts` ("Mastodon's scope hierarchy"), `test/oauth.test.ts` ("scopes on
  routes"). Main adds `optional` scopes (no token reads as anonymous; a token sent must be valid). _Implemented on
  branch `kopje/startup-reads`:_ an `optional` route may declare no scope (`GET /api/v1/tags/:id`: any valid token,
  app tokens read as anonymous), and a `token` route may still require a user (`GET /api/v1/announcements`: any user
  token, whatever its scopes; app tokens 422); `test/tags.test.ts`, `test/placeholders.test.ts`.
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
  ("constantTimeEqual").
- **AUTH-6: a user acts only on what that user may touch.** User operations take the acting account from the validated
  viewer, never from the body or path, and check ownership or VIS-1 access to every referenced resource in the same
  transaction. Admin, setup and federation operations use their own named rules (AUTH-5, SETUP-2, ID-6). _Enforced
  (main)_ for accounts and OAuth: `src/domain/accounts.ts`, `src/domain/oauth.ts`; `test/oauth.test.ts` ("does not
  revoke a token of another client"). _Enforced (main)_ for statuses and notifications:
  `test/statuses.test.ts` ("cannot edit someone else's status", "gives the source for editing to the author only"),
  `test/notifications.test.ts` ("only the viewer’s own notifications").
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
  own tokens (AUTH-6). _Implemented on branch `kopje/web-ui`:_ `src/domain/web-session.ts`, `src/web/session.ts`,
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
  decision posted from another origin", "refuses an account suspended between the consent page and approval"). Missing
  and `null` Origin: _Implemented on branch `kopje/web-ui`:_ `test/oauth.test.ts` ("refuses a decision posted from another origin, a null
  origin or none").
- **WEB-2: Kopje's HTML pages cannot be framed, scripted or cached.** Consent and code pages send a CSP with `script-src
'none'` and `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control:
no-store`, and render every value escaped. _Enforced (main):_ `src/app/authorize.tsx`, `src/web/consent.tsx`;
  `test/oauth.test.ts` ("logs in through Access and calls the API with the token"). _Gap: only `script-src`,
  `X-Frame-Options` and escaping are asserted._ Web UI pages: _Implemented on branch `kopje/web-ui`:_ a CSP of `default-src 'none'` with only
  `style-src 'self'` (the stylesheet is a static asset), `img-src 'self' https:`, `form-action 'self'`, `base-uri 'none'`
  and `frame-ancestors 'none'` (no script source at all), `X-Frame-Options: DENY`; pages of a signed-in user and the
  sign-in flow send `Cache-Control: no-store` and `Referrer-Policy: same-origin`; public pages may be kept 60 s and vary
  with `Accept`. `src/app/web.tsx`; `test/web-pages.test.ts` ("sends a CSP without script, denies framing"),
  `test/web-session.test.ts` ("is never cached, framed or opened to other origins"). `/setup`: _Implemented on branch
  `kopje/setup`:_ the same CSP, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` and `Cache-Control: no-store`
  on every page. Not `no-referrer`: under it browsers post a same-origin form with `Origin: null`, which WEB-1's
  Origin check refuses; `same-origin` still sends no referrer to other origins; `src/app/setup.tsx`; `test/setup.test.ts` ("WEB-2, WEB-3, WEB-5: is never cached, framed, scripted
  or opened to other origins").
- **WEB-3: CORS is open only where no ambient credential exists.** Wildcard CORS without credentials applies to
  `/api/*`, `/oauth/token`, `/oauth/revoke`, `/oauth/userinfo` (bearer tokens) and
  `/.well-known/oauth-authorization-server` (public) only. `/oauth/authorize`, `/admin/*`, `/setup` and the
  web UI send no CORS headers. _Enforced (main):_ `src/app/app.ts`; `test/oauth.test.ts` ("opens the API and token
  endpoints to browser clients, errors included"). Admin, setup and UI routes: _Planned (B5); `/admin/*` on main sends no CORS headers._
  UI routes: _Implemented on branch `kopje/web-ui`:_ no CORS headers even for a request with a foreign `Origin`; `test/web-pages.test.ts`,
  `test/web-session.test.ts`. `/setup`: _Implemented on branch `kopje/setup`:_ no CORS headers, preflight included;
  `test/setup.test.ts`.
- **WEB-4: the web UI applies WEB-1 to every state change.** Each form that changes state checks `Origin` and its
  session; a return or redirect target is a validated local path. _Implemented on branch `kopje/web-ui`:_ every POST (profile, avatar, header,
  revoking an app, signing out other sessions, sign-out) first requires `Origin` equal to the instance origin (missing,
  `null` and foreign answer 403 before the body is read), then the session and an anti-forgery token derived from it
  (SHA-256 of the session token under its own context, compared in constant time). The only redirect targets are fixed
  local paths and the sign-in's return path, which must start with exactly one `/`, contain no backslash, whitespace,
  control character, `.` or `..` segment, or percent-encoded slash, backslash, dot, control or `%`, and resolve to the
  instance origin as a path of the same form (so normalization cannot turn it into `//host`); anything else becomes
  `/settings`. A legacy permalink moves to the author's stored username, not the request's text. `src/web/session.ts`,
  `src/app/web.tsx`; `test/web-session.test.ts` ("refuses a missing, null or foreign Origin on every form", "refuses a
  missing or wrong anti-forgery token on every form", "accepts only local paths (WEB-4: unsafe return path)", "returns after sign-in only to a
  validated local path", "ignores a tampered return path in the login cookie"), `test/web-images.test.ts` ("refuses a
  foreign, null or missing Origin and a wrong token before any transformation"). `/setup`: _Implemented on branch
  `kopje/setup`:_ every POST, sign-in with `SETUP_TOKEN` included, first requires `Origin` equal to the instance origin;
  every other POST then requires the session that authorizes it (the setup session, or after bootstrap the admin's web
  session) and an anti-forgery token derived from it under a context of its own (`kopje-setup-csrf`). The only
  redirect target is `/setup`. `test/setup.test.ts` ("WEB-1, WEB-4: refuse a missing, null or foreign Origin on every
  form", "WEB-4: refuse a missing or wrong anti-forgery token on every form", "WEB-1: refuses a sign-in posted from
  another origin, a null origin or none").
- **WEB-5: responses declare their type.** API and federation responses carry their exact JSON media type and
  `X-Content-Type-Options: nosniff`. _Implemented on branch `kopje/inbound-statuses`:_ one middleware sets `nosniff`
  on every response (API, federation, inbox, media, errors and maintenance answers), and API and federation bodies
  are written by Hono's `c.json` and Fedify with their JSON types; `src/app/app.ts`; `test/inbox-statuses.test.ts`
  ("WEB-5: responses declare their type").
  Web UI pages: _Implemented on branch `kopje/web-ui`:_ `text/html; charset=UTF-8` and `nosniff` on every page and error page; static assets
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
  _Implemented on branch `kopje/setup`:_ the Worker compares the token with `constantTimeEqual` (AUTH-5; it must be at
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
  the next checkpoint when the admin's session expires during the run", "refuses a team that is not the selected
  account’s organization, before any write", "refuses a reusable policy attached to other applications"). `src/domain/setup.ts`, `src/app/setup.tsx`; `test/setup.test.ts` ("a reused setup token opens nothing", "a
  setup session opened before bootstrap cannot change the domain, the admin or Access", "shows the status to the
  admin, runs the checks, and reconciles Access with a new token", "refuses a signed-in user who is not the admin",
  "AUTH-5: refuses when SETUP_TOKEN is unset or shorter than 32 characters").
- **SETUP-3: bootstrap happens once.** The domain and the first admin are written in one Store transaction that fails if
  either exists, so concurrent requests cannot create two. _Implemented on branch `kopje/setup`:_ `bootstrapInstance`
  writes the domain, the Access configuration, `admin_email` and the admin's local account together, refuses once any
  configuration row or local account exists, while a reconciliation runs or is unresolved (a failure, or a lease that
  ran out without an outcome), or when the session's Access outcome is not the latest completed revision; it ends
  every setup session. `src/domain/setup.ts`;
  `test/setup.test.ts` ("SETUP-3: concurrent bootstraps create one admin", "SETUP-3: refuses when a domain or an
  account exists already", "SETUP-3: writes the domain, the Access configuration and the admin together", "SETUP-3: a
  failure at the last insert rolls the whole bootstrap back"), `test/setup-access.test.ts` ("only the latest completed
  run bootstraps", "bootstrap waits while a run is in progress", "a failure after external write n of 4 leaves the
  state unresolved").
- **SETUP-4: the Cloudflare API token is transient.** It is used only within the request that received it and is never
  stored, logged or returned. _Implemented on branch `kopje/setup`:_ it is read from the form of one POST, sent only to
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
  "refuses to send once the lease budget has run out").
- **NET-3: every outbound sink has its own policy.** Any URL derived from remote or user input is fetched only through a
  sink client that applies NET-1's host rules (https, public address, re-checked hops, a hop limit) plus its own budget:
  documents as NET-1; remote media a size cap, a time limit and a type allowlist; Web Push and deliveries no redirects.
  Credentials and signatures never follow a redirect to another origin. Fedify's sending and queueing are not used.
  _Enforced (main)_ for documents and the Fedify rule: `test/fedify-usage.test.ts` ("never sends or queues through
  Fedify"). Deliveries: _Enforced (main):_ `assertPublicShape` and the DNS check before every
  POST, no redirects, 30 s (`postActivity` in `src/federation/delivery.ts`); `test/delivery-post.test.ts` ("NET-3:
  refuses inboxes that fail the public-host rules"). Web Push: _Enforced (main):_ the same sink before every POST
  (`sendPush` in `src/jobs/push.ts`), and the rules that need no lookup at registration (`publicShapeRefusal` in
  `src/platform/http-url.ts`, shared with `assertPublicShape`); `test/push.test.ts` ("NET-3: refuses endpoints that are
  not public https URLs"), `test/push-send.test.ts` ("PUSH-2: the endpoint is an outbound sink at every send", "never
  follows a redirect, and retries instead"). Media: _Planned (B4)._
- **NET-4: signed fetches stay with their signer.** A document fetched with a signature is cached under a key that
  includes the signing key id and is never served to another key or to the unsigned path. _Enforced (main):_
  `signedLoader` in `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("caches signed documents per signing
  key"). Expiry within 5 minutes and a sweep of expired rows: _Planned (B1b); the TTL is Fedify's `kvCache` default and
  no test pins it._ _Implemented on branch `kopje/inbound-statuses`_ for the fetches of inbound processing and search:
  the original of a boost (and its author) is fetched as the request's other fetches are, with the personal inbox
  owner's key or the instance actor's, never from the signed-document cache; search with `resolve=true` fetches as
  the instance actor only, for a request whose token is valid and has the scope (401 or 403 otherwise, before
  anything is fetched), with WebFinger unsigned. An account's canonical address is decided as Mastodon 4.7.3's
  `ActivityPub::ProcessAccountService#check_webfinger!` and `ResolveAccountService` decide it: the actor's own host
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
  actor keeps its host until it is resolved again. `test/inbox-canonical-address.test.ts`. `createRemoteLoaders` in
  `src/federation/federation.ts`, `src/federation/resolve.ts`; `test/inbox-statuses.test.ts` ("signed by the instance
  actor (NET-4)", "resolves a status URL as the instance actor", "answers 401 without a token and fetches nothing"),
  `test/inbox-statuses-edge.test.ts` ("NET-4: search resolution fetches nothing without a valid token", "the
  canonical WebFinger domain").
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
  `test/html.test.ts`. _Implemented on branch `kopje/inbound-statuses`_ for status content (sanitized once by the
  Worker before it is stored, the converted text of an Article or Page included) and profile field values (read from
  the stored actor document and sanitized when presented, at most 16 fields): the same `sanitizeRemoteHtml`;
  `test/inbox-statuses.test.ts` ("sanitizes content by allowlist with http(s) links only", "shows PropertyValue fields
  with sanitized values").
  The web UI sanitizes again at the sink: bios, status content and field values reach a page only as the sanitizer's
  output (`SafeHtml` in `src/web/safe-html.ts`), whatever the Store holds. _Implemented on branch `kopje/web-ui`:_ `test/web-pages.test.ts`
  ("sanitizes stored HTML at the sink and drops non-http links").
- **HTML-2: local text becomes HTML only by escaping and linking.** Status text and bios are escaped, then absolute
  http(s) URLs, known mentions and hashtags are linked. Display names stay plain strings. _Enforced (main)_ for bios:
  `src/domain/plain-text.ts`; `test/accounts.test.ts` ("stores plain-text profile fields safely"). _Enforced (main)_ for status text: `src/domain/status-text.ts`; `test/status-text.test.ts`.
  Local profile fields are stored as plain text and presented escaped with http(s) URLs linked (`renderFieldValue`),
  in the API and as the actor's `PropertyValue` attachments: _Implemented on branch `kopje/web-ui`:_ `test/web-session.test.ts` ("saves the
  profile", "publishes fields as PropertyValue attachments of the actor").
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
  `test/html.test.ts`. _Implemented on branch `kopje/inbound-statuses`_ for field links and remote statuses at ingest
  (the status url and attachment and preview URLs, which are dropped unless http(s)); `src/federation/remote-status.ts`;
  `test/inbox-statuses.test.ts` ("keeps only http(s) media (HTML-1, HTML-3)", "http(s) links only").
  Web UI pages emit only local paths and http(s) URLs (avatars, headers, media, field and app links, the parent of a
  reply); field links carry `rel="me"`: _Implemented on branch `kopje/web-ui`:_ `src/web/pages.tsx`; `test/web-pages.test.ts`.

### Media (MEDIA)

- **MEDIA-1: only the owner uses an attachment.** Only the uploader may update, delete or attach an attachment, and only
  while it is unattached or attached to the status being edited. _Enforced (main)_ for attaching:
  `attachableMedia` in `src/domain/statuses.ts`; `test/statuses.test.ts` ("attaches own unattached media").
  _Enforced (main)_ for reading, updating and deleting: `src/domain/media.ts` (an upload is
  read or updated only by its owner while unattached; it is deleted only through its owner's status with
  `delete_media`, or by the sweep after its grace period, and a doomed or still-processing upload cannot be attached);
  `test/media.test.ts` ("shows and updates own unattached media only").
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
  restore outside its database (`kopje/pitr-restored/<store id>` in R2, never served) before scheduling it, and the
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
- **MEDIA-3: served images are re-encoded.** An image is served only as Images output with location metadata removed; if
  transformation fails, the upload is refused and original bytes are never served. _Enforced (main):_ outputs are PNG or WebP only, for which Images discards all metadata (the binding has no
  metadata option, and JPEG output would keep the EXIF copyright tag); `processImage` in `src/platform/images.ts` then
  checks every output with `retainedMetadata` (`src/platform/image-bytes.ts`), which refuses any EXIF, XMP, IPTC,
  comment, text chunk or unknown JPEG application segment and keeps only colour profiles, and refuses the upload
  otherwise; `test/image-bytes.test.ts` ("refuses every EXIF block", "refuses XMP, IPTC, comments"),
  `test/media.test.ts` ("re-encodes an image without its location", "refuses a failed transformation", "refuses an
  output that keeps ..."). Tests use Miniflare's local Images binding (sharp); the production binding's output is
  verified on the verification instance (B9). The media rebuild, which makes the served files of restored or moved
  media from their originals, goes through the same `processImage` and writes nothing for an original that fails, and
  never serves an original instead; it refuses an original whose served type differs from the row's (its URLs name that
  type). `test/media-rebuild.test.ts` ("makes both files ... and corrects meta", "reports a missing original and a type
  mismatch").
- **MEDIA-4: media cannot run as instance content.** Uploads are accepted by detected type from an allowlist and served
  with their stored type and `nosniff`; HTML, SVG and other active types are never served from the instance origin.
  _Enforced (main):_ `sniffImageType` (JPEG, PNG, GIF, WebP, AVIF by signature, and Images
  must read the same type); `SERVED_TYPES` and `src/web/media.ts` (JPEG, PNG and WebP only, `nosniff`, `sandbox` CSP);
  video and audio are refused; `test/media.test.ts` ("refuses active and unsupported types by their bytes", "never
  serves a stored object of another type").

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
  counts once. _Planned (polls)._

### Resources (RES)

- **RES-1: input is bounded before it is parsed.** API parameter bodies and inbox bodies stop at 1 MiB, by
  `Content-Length` or while streaming. Each text field has a raw cap before parsing or counting (status text: 10,000
  code units). Media uploads have their own limit. _Enforced (main)_ for bodies: `src/platform/body.ts`,
  `src/mastodon/params.ts`; `test/gate.test.ts` ("refuses an inbox body over 1 MiB", "stops reading a streamed inbox
  body"). _Gap: no API body test._ _Enforced (main)_ for status text: `test/status-text.test.ts`
  ("raw input bound"). _Enforced (main)_ for search terms (500 characters) and media (16 MB
  and 16,777,216 pixels, read with the body bound before parsing): `src/mastodon/search.ts`, `src/mastodon/media.ts`;
  `test/search.test.ts` ("bounds the query"), `test/media.test.ts` ("refuses a file over 16 MB"). _Enforced (main)_ for remote profiles: bios are cut at 50,000 code units before sanitizing and
  display names at 2,048 (`src/security/html.ts`, `src/federation/remote-actor.ts`). Other query strings: _Gap._
- **RES-2: parsing work is bounded.** Every regex, parser and normalization over input at the RES-1 cap has an
  adversarial fixture with a time bound. _Enforced (main)_ for status text:
  `test/statuses.test.ts` ("handles the worst case at the bound within a generous time"). _Enforced (main)_ for the image metadata walk: `test/image-bytes.test.ts` ("walks a worst-case file at the upload
  bound"). Remote HTML: _Enforced (main):_ `test/html.test.ts` ("at the raw cap
  within a generous time"). _Implemented on branch `kopje/inbound-statuses`_ for JSON-LD processing and inbound JSON:
  every inbound activity and every fetched document must stay within 10,000 values and 32 levels of nesting before
  anything reads it or hands it to JSON-LD (`withinJsonBounds` in `src/platform/json-bounds.ts`, applied by
  `parseActivity` and by the loaders of `createRemoteLoaders`); JSON-LD contexts too, before they are cached and again
  on every cache hit (an entry may predate the check; `boundedContexts` in `src/federation/federation.ts`); and one
  request fetches at most 8 documents (the fetch budget), so one activity's JSON-LD work is at most 8 bounded
  documents and their bounded contexts; the Store asks the Worker for documents at most 3 times per activity;
  statuses are read as compacted JSON, without JSON-LD, as Mastodon reads them; `test/inbox-statuses.test.ts`
  ("refuses an activity or a fetched document past the JSON bounds before reading it", "caps the attachments, tags
  and content one status stores"), `test/inbox-statuses-edge.test.ts` ("RES-2: JSON-LD contexts past the JSON
  bounds", "the Store asks for documents at most three times").
- **RES-3: lists are bounded.** Pageable lists return at most 80 items; relationships read at most 100 ids; any other
  collection names its count and byte bound. _Enforced (main):_ `src/mastodon/pagination.ts`, `MAX_RELATIONSHIP_IDS` in
  `src/domain/accounts.ts`. _Gap: neither cap is tested._ _Enforced (main)_ for search: at
  most 40 results per type (80 for the account search), and offsets past 10,000 answer an empty page;
  `test/search.test.ts` ("bounds the query, the limit and the offset"). _Implemented on branch `kopje/blocks-mutes`:_
  the domain block list (`GET /api/v1/domain_blocks`) returns at most 200 domains, as Mastodon's does
  (`src/mastodon/blocks.ts`). _Implemented on branch `kopje/startup-reads`:_ `GET /api/v1/instance/peers` lists at most
  10,000 domains (`MAX_PEERS` in `src/domain/instance.ts`); `familiar_followers` reads at most 20 ids and shows at
  most 80 accounts for each (`src/domain/accounts.ts`); `test/instance-reads.test.ts` ("bounds the peers"),
  `test/account-reads.test.ts` ("bounds the ids and the accounts shown").
- **RES-4: stored derived data is bounded.** Snapshots, the KV cache, the spool and deliveries each have a size cap, a
  count cap or an expiry with a sweeper. _Implemented on branch `kopje/inbound-statuses`_ for remote statuses: one
  status stores at most 4 attachments (Mastodon's limit) with 10,000 code units of description each, 100 hashtags
  of at most 256 code units, 200 `status_mentions` rows (local accounts first; 100 `Mention` tags and 1,000 `to` and
  `cc` entries are read; a redelivery to a personal inbox keeps the bound, its owner taking a remote recipient's
  place, and so does an edit of a public or unlisted status that newly mentions and addresses a local account), 10,000 code units of content warning, and content cut at 50,000 code units before sanitizing; its history
  at most 100 versions (the newest edit replaces the last); an arriving parent links at most 100 replies that came
  before it; a boost at most 200 recipients; profiles show at most 16 fields. A deleted status is removed by a job
  (`inbound_jobs` kind `delete`) in batches of at most 500 rows, measured with `total_changes()`; the first batch hides
  it (its mentions, then its content and audience) within that budget. `src/domain/remote-statuses.ts`;
  `test/inbox-statuses.test.ts` ("caps the attachments, tags and content one status stores", "deletes a status with
  many children in bounded batches"), `test/inbox-statuses-edge.test.ts` ("RES-4: bounds at their limits", "writes at
  most PURGE*BATCH rows per batch, hiding included"). \_Enforced (main)* for snapshots: `test/snapshot.test.ts` ("snapshot caps"). KV
  sweep and spool: _Planned (B1b)._ Deliveries: _Enforced (main):_ delivered rows are deleted
  at once and given-up rows after 30 days by the 5-minute cron (`sweepDeliveries`); receipts belong to their status
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
- **RES-5: retries are bounded, but maintenance is not a failure.** Waiting out maintenance consumes no processing
  retry; real processing errors count against `max_retries`. _Enforced (main):_ `src/jobs/queue.ts`; `test/gate.test.ts`
  ("spool consumer"). Deliveries give up after 15 attempts (`min(30s·2^n, 12h)`, n the attempts so far) or at once on a
  permanent answer (Mastodon's rule: 4xx except 401, 408 and 429, and 501), and are listed and retried through
  `/admin/deliveries` and `kopje-admin deliveries`; in maintenance nothing is claimed, so no attempt is counted. An
  activity a later one about the same object follows (an `Undo`, `Delete` or `Update`) is superseded and never sent
  again: naming it answers 409 `superseded`, and `--all` skips it, choosing eligible rows before its batch limit and
  continuing from the cursor it returns (`test/delivery-regressions.test.ts`, "refuses to retry a Like that its Undo
  has superseded"; `test/delivery-verify.test.ts`, "operator retries", "the `all` cursor").
  _Enforced (main):_ `src/domain/deliveries.ts`, `src/jobs/deliver.ts`;
  `test/deliveries.test.ts` ("retries after min(30 s·2^n, 12 h)"), `test/delivery-post.test.ts` ("RES-5: claims
  nothing and counts no attempt in maintenance"), `test/cli.test.ts`. Spool messages that fail terminally are kept and
  inspectable before acknowledgement: _Planned (B1b)._ Web Push: _Enforced (main):_ the deliveries' schedule and limit,
  a push older than 48 hours is dropped, a 4xx other than 408 and 429 (or an endpoint the sink refuses outright)
  deletes the subscription and its pending pushes, as Mastodon 4.5 does, and nothing is claimed in maintenance or
  without a `VAPID_JWK`; at most 1,000 pushes wait (`MAX_PUSH_BACKLOG`): a notification gets only the room left,
  counted in its transaction, however many subscriptions want it (RES-4). `src/domain/push.ts`, `src/jobs/push.ts`,
  `queuePushes` in `src/domain/notifications.ts`; `test/push-send.test.ts` ("retries a failure with the deliveries’
  backoff and gives up after their limit", "deletes the subscription and its pending pushes when the push service
  answers", "keeps the subscription and retries when the push service answers", "sends pushes from the delivery
  doorbell, and not without a VAPID_JWK or in maintenance", "RES-4: a notification fanned out to several
  subscriptions fills the backlog only up to its cap", "records no push beyond the backlog cap").
- **RES-6: one request cannot trigger unbounded work.** An inbound activity has fixed limits on dereferences,
  recipients, collection expansion and notifications. Delivery backlog and concurrency are bounded. Anonymous app
  registration, inbox spooling and media transformations have rate or storage budgets with a visible refusal. _Planned
  (B1b)._ Domain blocks: _Implemented on branch `kopje/blocks-mutes`:_ a domain block's cleanup scans at most 500 follows
  per batch and does at most 4 batches a round, its first batch in the request, so blocking a domain stays bounded
  however many follows the user has, and always succeeds (VIS-15, `test/blocks.test.ts`). App registration: _Implemented on branch `kopje/web-ui`:_ `POST /api/v1/apps` is limited to 5 per minute per client IP by the Workers
  Rate Limiting binding before its body is read (429), and the Store keeps at most 500 never-authorized apps (no token or
  code of a user); when full it first removes unused apps (no token of any kind) older than a day, then the oldest
  never-authorized apps older than an hour (app tokens and all), and otherwise refuses with 429. Only a user's token or
  code protects an app: anyone can get an app token without a user, so app tokens cannot hold a slot for good. The cron removes unused apps after a day,
  as Mastodon's `ApplicationsVacuum` does, and expired codes and web sessions, 500 of each per run. `registerApp` and
  `sweepOAuth` in `src/domain/oauth.ts`, `src/mastodon/oauth.ts`; `test/apps-budget.test.ts`. Avatar and header
  uploads from the web UI go through the media budgets below.
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
  refusal. A key an actor lists by reference is taken from the verification that just resolved it, not fetched again. A Move moves 100
  followers per batch and carries at most 100 blocks and mutes; a deleted actor's purge writes at most 500 rows per batch in all, every
  write counted (SQLite's `total_changes()`): deletions, counter recounts (`followers_count`, `following_count`,
  `statuses_count`, status counters) and the Undo intent of a withdrawn boost with its target chunks. The account is
  unavailable from the first batch's transaction on (VIS-1), so the order of the steps shows nothing of it, and no
  boost of its statuses is accepted and no status of it fetched while it lasts. Its follows, notifications, mentions
  and other relationships go first; then local boosts of its statuses, each withdrawn once: the Undo intent is recorded, then its targets
  (the boost's receipts among them) are staged a chunk per row over as many batches as they need, the receipts kept
  until all are written (`beginRetraction` and `stageRetraction` in `src/domain/deliveries.ts`); B2's delivery rounds
  expand them 100 at a time; then the purge deletes the receipts a batch at a time before the boost and its
  booster's recount; then its statuses, each
  deleted only after its children (edits, media, mentions, tags, favourites, bookmarks, notifications, receipts,
  boosts, reply links), so no delete cascades. Blocks and mutes of the account go last, once nothing they filter is
  left (`test/inbox-regressions.test.ts`, "keeps filtering a post that mentions the actor"). A user's own unboost keeps B2's path unchanged. Local media is detached
  for B4b's media sweep, never deleted from R2 here. Both are durable jobs in the Store (`inbound_jobs`), continued by the Queue and by cron, so neither a lost
  Queue message nor maintenance stops them, and waiting out maintenance spends no retry. `test/inbox.test.ts`,
  `test/inbox-regressions.test.ts`, `test/inbox-verify4.test.ts` ("writes the targets of a withdrawal that needs more
  than a batch of rows, every batch within the budget", "reaches every target when purge batches and delivery claims
  interleave", "when the purge completes before any expansion"). _Gap:_ the batch budget bounds the rows a withdrawal
  writes, not the work it does: each staging call reads every receipt of the boost and every follower of its booster
  and sorts all the targets left, so a boost's withdrawal (by a purge, or by a remote author's `Delete` of the boosted
  status) costs work proportional to its audience in every batch until it is staged. Receipt enumeration has this in
  common with follower enumeration.
- **RES-7: query work is bounded, not only the rows returned.** Feeds apply visibility and filters in the query before
  `LIMIT`. Context traversal visits a bounded number of statuses before sorting. A status keeps a bounded number and
  size of edits. _Enforced (main)_ for filtering before `LIMIT`: `src/domain/timelines.ts` (_Gap:
  untested_); the tag feed's candidates are the hashtags of public statuses (`status_tags.public`, through a partial
  index), so it never reads the tag's unlisted, private, direct or limited statuses, and it reads each requested tag
  (at most five) in id order from the cursor until it has a page, so a page reads the same rows however long the tag's
  history (`test/policy-bounds.test.ts`, `test/tag-timeline.test.ts`). Home and a list's timeline read a window of
  each followed account's (or active member's) public, unlisted and private statuses with every filter inside it, from
  the cursor through `statuses_feed`, so a page reads about a page per author however long each author's history and
  never reads a followed account's direct or limited statuses to others; home adds the viewer's own statuses (a page)
  and the direct and limited statuses that mention the viewer, from the cursor in the viewer's mentions
  (`test/policy-bounds.test.ts`, the second case); an account whose every status the rule hides (unavailable, blocking
  the viewer, or blocked, muted or domain-blocked by them) has no window. The public feed, account statuses,
  notifications, favourites and bookmarks start at the cursor in their index, so a page from the middle of a long
  history reads what the newest does (`test/policy-bounds.test.ts`, "however long the world's history"). Home's
  mentions stream reads a window per followed account of the viewer's mentions in that account's direct and limited
  statuses, through the partial index `status_mentions_requires_mention` (migration
  `0008_status_mentions_requires_mention`), so mentions by accounts the viewer does not follow are never read. Account
  statuses decide once whether the viewer may see the account at all (it is available, neither blocks the other), and
  read nothing when not (`test/policy-bounds.test.ts`, "never sees"). _Gap:_ what a follow's options (boosts,
  languages, replies) and the home filter leave out is still read on the way, and account statuses read past the
  statuses of an account the viewer may see that they may not (a non-follower opening the profile of an account that
  posts mostly to followers), up to that account's stored history: a remote account's private statuses are stored only
  while a local account follows it, so no outside party can grow it at will (accepted).
  _Enforced (main)_ for search: statuses pass `listableSql` before `LIMIT`, each library source reads at most 2,500 rows through an index ordered by the status id it returns (cursors applied
  inside it), hashtags come from at most 500 entries per library source plus the newest 2,000 public statuses, and an
  account search matches the exact address (always), at most 1,000 username-prefix candidates, the 5,000 newest
  accounts and the local ones, or with `following` the exact address and up to 5,000 accepted follows through a
  partial index (pending follows are never read)
  (`src/domain/search.ts`, `findAccounts` in `src/domain/accounts.ts`); `test/search.test.ts` ("filters before
  LIMIT"), `test/search-edge.test.ts` (rows read stay flat as favourites, bookmarks, accounts and tagged statuses grow
  fourfold, pending follows included; `max_id` reaches past each window; an exact address outside every window is
  found). _Implemented on branch `kopje/startup-reads`:_ the peers list seeks each next domain on the (domain,
  username) index, so it reads rows by domain returned, not by account known; a tag's history reads its public statuses
  received in the last seven days only, a range of the (name, status_id) index of public hashtags cut by status id, so
  the work follows the instance's own receive volume (ids carry publication time, or receipt time where a cutover kept them); the rules
  read only their setting; familiar followers reads at most 10,000 of the viewer's accepted follows (above
  Mastodon's default follow limit of 7,500) and checks each against the account through the pair index; `test/instance-reads.test.ts`, `test/tags.test.ts`,
  `test/account-reads.test.ts` (rows read stay flat as accounts per domain, accounts known, statuses outside the
  window, and the account's other followers grow). Context traversal and edit history:
  _Planned (B4a fixes)._

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
  everything. _Implemented on branch `kopje/scheduled-backup`:_ `src/jobs/backup.ts`, `src/platform/backup-crypto.ts`;
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
  saver and the Store kernel; `test/log-redaction.test.ts`. Access failures log only jose's error code (main), and the
  CLI never prints secrets (main, `test/cli.test.ts`). Later stages: _Planned (all stages)._
- **DATA-6: ids stay strings end to end.** Ids never pass through JS numbers. INTEGER edge and notification ids are read
  with `CAST(id AS TEXT)` and compared with `CAST(? AS INTEGER)`. 18-digit TEXT status ids compare as TEXT; a shorter
  client cursor is zero-padded first. _Enforced (main)_ for edges: `listFollows` in `src/domain/accounts.ts`;
  `test/accounts.test.ts` ("edge ids beyond 2^53", "keeps 18-digit ids exact"). _Enforced (main)_
  for status cursors: `statusCursor` in `src/domain/statuses.ts` (_Gap: untested_).
- **DATA-7: the instance key signs only recipient-neutral fetches.** Fetches without a specific recipient are signed by
  the instance actor; fetches for a personal inbox by the recipient's key; activities by their author's key. The
  instance key never signs an activity attributed to a user. _Enforced (main)_ for fetches:
  `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("signed fetches"). Activities: _Enforced (main):_ a delivery is signed with the key of its lane's account, unwrapped once per round
  (`src/jobs/deliver.ts`); `test/delivery-post.test.ts` ("signs the activity with its author key").
- **DATA-9: backup credentials stay out of the Store, logs and reports, and are scoped.** The S3 key is a Worker
  secret, read apart from the main config so a bad backup setting stops only the backup. Config issues name the
  variable, never its value. Failures are recorded and logged as fixed reason codes (`s3-<op>-<status|timeout>`,
  Store refusal codes), never an error message, a response body, a URL or a signature. The Store keeps only keys,
  upload ids, fingerprints, sizes and digests. The documented policy grants put under the prefix, delete and abort only
  under `backups/` (never `media/`), and prefix-conditioned listing; multipart listing, which cannot be
  prefix-conditioned, is optional (`docs/backup.md`). _Implemented on branch `kopje/scheduled-backup`:_
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
  media coverage with exit code 3. The import re-checks the dump's own trailer. _Implemented on branch `kopje/scheduled-backup`:_ `src/jobs/backup.ts`,
  `src/platform/backup-state.ts`, `verifyBackup` in `cli/lib/commands.js`; `test/backup.test.ts` ("verifies the whole
  restore set after retention removed the backup that copied an original", "reports incomplete media coverage",
  "verifies the index alone before any media is downloaded", "rejects index entries that name anything but
  originals/<id>", "a restarted dump replaces the membership", "round-trips"). Gap: comparing `manifestSha256` is a manual step of the restore runbook (DATA-8).
- **DATA-8: a restore has selected authority.** Restore uses a manifest the operator selected by digest, checks schema
  version, domain and every referenced component before use, and before leaving maintenance invalidates OAuth grants
  restored from the checkpoint and reconciles suspension and admin state. _Planned (B6b)._
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
  file or symbolic link is followed or reused. _Implemented on branch `kopje/cutover-convert`:_
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
  sides share is pinned by a hand-written expectation. _Implemented on branch `kopje/cutover-convert`:_
  `test-node/cutover-convert.test.ts` ("the check fails on damage", one tampered dump per kind),
  `test-node/cutover-safety.test.ts` ("HTML is never cut silently"), `test/cutover-import.test.ts` (the check passes
  on the Store's own dump after a real import).
- **DATA-13: conversion reports carry aggregates only, on failure too.** What the commands print and the manifest holds
  are counts, fixed codes and messages, SHA-256 digests and table checksums; never rows, keys, emails, URIs, the domain
  (only its digest) or KEK values, which the CLI also redacts. An untrusted name (a table, an object type) appears only
  as a digest prefix, and a parser or database error only as its class. _Implemented on branch
  `kopje/cutover-convert`:_ `test-node/cutover-safety.test.ts` ("failure reports carry codes, counts and digests only",
  through the real CLI), `test-node/cutover-convert.test.ts` ("runs from the real CLI under Node").
- **DATA-16: cutover fingerprints and preflight reports are aggregate or configuration only.** A fingerprint holds,
  per table of an export, the row count and a SHA-256 over its rows' hashes, plus the notification counter;
  `fingerprint compare` prints table names, counts and the changed tables. `cutover-preflight` prints binding names,
  resource identifiers, variable names and types and the writers it sees, never a secret value (the API does not return
  them, and a value in the file is not read) and no instance data but the public `DOMAIN`. `maintenance-worker` reports
  counts, KEK candidate names and digests. _Implemented on branch `kopje/cutover-ops`:_ `cli/lib/cutover/fingerprint.js`,
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
  URIs and image ids, and the per-row sweep never deletes the files of another row showing the same image. _Implemented on branch `kopje/images-export`:_
  `cli/lib/cutover/images-export.js`, `cli/lib/main.js`; `test-node/cutover-images.test.ts` ("uses the Images API with
  the token when given an account id", "runs from the CLI with the token from the environment only, and never prints
  it", "marks a 404, a wrong type, an oversized file and too many pixels missing"), `test/cutover-images-lifecycle.test.ts`.
- **DATA-14: legacy keys are carried over as bytes, under one KEK.** Wrapped private keys, salts and public keys move
  unchanged (DATA-1; no re-wrapping, the owner's decision). The converter stops unless one KEK candidate (empty,
  `userKEK`, `USER_KEY`) unwraps every local key and verifies against its public key, reports which candidate by name,
  and flags an empty KEK. _Implemented on branch `kopje/cutover-convert`:_ `cli/lib/cutover/kek.js`;
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
  `MAINTENANCE=readonly`). _Implemented on branch `kopje/kek-rewrap`:_ `src/app/key-rewrap.ts`, `src/domain/actors.ts`
  (`listRewrapKeys`, `rewrapLocalKey`), `cli/lib/main.js`; `test/key-rewrap.test.ts`. _Not covered:_ backups, dumps and
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
  moves to a public original, an image shows with a servable status. _Implemented on branch `kopje/cutover-convert`:_
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
  restore requires env `MAINTENANCE=full`: _Enforced (main)_ (`test/admin.test.ts`, "restores
  only under MAINTENANCE=full"). Replay that verifies the signature against the spool time:
  _Enforced (main):_ `src/jobs/queue.ts`, `src/federation/inbound.ts`; `test/inbox.test.ts`
  ("OPS-1"), `test/gate.test.ts` ("refuses a personal inbox of nobody").
- **OPS-2: no upgrade runs under a dump freeze or an import.** Migrations wait while either exists. The freeze also
  stops session writes and alarm work. _Enforced (main):_ `src/platform/store-kernel.ts`,
  `src/platform/store-flags.ts`; `test/dump-import.test.ts`, `test/ops-authority.test.ts` ("upgrades during an import").
- **OPS-3: an unknown outcome is reconciled, not assumed.** A migration failure re-reads durable bookkeeping. Other
  operations that a client may retry after a lost response carry a stable idempotency key. _Enforced (main)_ for
  migrations: `test/migrations.test.ts` ("re-reads bookkeeping"). _Enforced (main)_
  (`Idempotency-Key`, `test/statuses.test.ts`) and for import chunks (`test/dump-import.test.ts`).
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

    _Implemented on branch `kopje/scheduled-backup`:_ `src/jobs/backup.ts`, `src/platform/backup-state.ts`,
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
  Store, PITR and backups. _Implemented on branch `kopje/cutover-ops`:_ `cli/lib/cutover/fingerprint.js`,
  `cli/lib/cutover/preflight.js`, `docs/cutover-runbook.md`; `test-node/cutover-fingerprint.test.ts` (an insert, a
  delete, a short value changed at the same length, values swapped between rows, two characters swapped inside a long
  value, emptied content and a moved notification counter all FAIL; a missing counter, an incomplete manifest and
  other counts are refused; an export with the notifications table but no sqlite_sequence is refused even when the
  table is empty; a manifest with a missing or an extra table key fails). Gap: closing writers outside the Pages project and reconciling the legacy DLQ are go/no-go
  checks the operator makes; the tools cannot see them.
- **OPS-6: the maintenance worker accepts no write but the spool.** The cutover's Pages `_worker.js` answers actor and
  WebFinger GETs from its snapshot and spools every inbox POST (shared and personal) to Kopje's Queue through Kopje's
  own code (`federation/inbox-request.ts`, `federation/spool.ts`): the same refusals before spooling (413, 415, 404 for
  a personal inbox of no local account by its exact username), the same message format and size limit, 202 only after
  the Queue accepted the message, 503 when it cannot spool. Every other request, any method, is 503 with
  `Retry-After`. It reads no legacy binding and imports no runtime module, so it runs on the legacy project's
  compatibility settings. The spooled request keeps its URL, headers and body as received and the time it arrived, so
  Kopje's replay verifies the signature against that time (OPS-1). _Implemented on branch `kopje/cutover-ops`:_
  `src/maintenance.ts`, `scripts/build-maintenance.mjs`; `test/maintenance-worker.test.ts` ("refuses every other
  write with 503 and touches no legacy binding", "refuses before spooling what Kopje refuses", "answers 503 rather than
  202 when it cannot spool", "spools a signed Follow ... and Kopje replays it" with the replaying clock a day later,
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
  actor (its key does not exist before the import; `/actor` is 503). _Implemented on branch `kopje/cutover-ops`:_
  `src/maintenance-render.ts`, `cli/lib/cutover/maintenance.js`; `test/maintenance-worker.test.ts` ("serves byte for
  byte what the Store serves after the import, keys included"), `test-node/cutover-maintenance.test.ts` ("refuses a
  snapshot with another public key / key id / owner / actor", "leaves a local actor out", mixed KEKs, another domain,
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
  _Implemented on branch `kopje/cutover-ops`:_ `src/platform/store-flags.ts` (`admitFlags`),
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
  dead-letter queue empty. _Implemented on branch `kopje/cutover-ops`:_
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
  the template's configuration; the runbook inspects, reconciles and redrives it. _Implemented on branch
  `kopje/cutover-ops`:_ `wrangler.jsonc`, `deploy/wrangler.jsonc`, `scripts/check-kopje-package.mjs`.

## Negative cases by stage

Each stage ships tests for these cases, named with the invariant IDs.

| Stage                      | Required negative cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1b inbound                | Wrong signer or actor; foreign activity id; same-origin different actor; unauthorized Undo, Accept, Update, Delete; duplicate and reordered Delete and Create; non-AS media type; private and unlisted object fetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B2 delivery                | Redirect of a private activity; recipient outside the audience; duplicate inbox; expired lease; stale completion; commit followed by response loss (`test/deliveries.test.ts`, `test/delivery-post.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B4 statuses, media, search | Edit, source or history of another's status; history seen by a recipient added later; private boost in `reblogged_by`; hidden parent in reply fields; DM moving `last_status_at`; unbounded edits or reply tree; boost or quote of an invisible status; foreign attachment; unsafe R2 key; retained EXIF; failed transform; active media type; private status in search                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B5 UI and setup            | Missing, `null` and foreign Origin; framing headers; unsafe return path; session fixation and reuse after logout (`test/web-session.test.ts`, `test/web-images.test.ts`, `test/web-pages.test.ts`); reused setup token, concurrent bootstrap, missing, `null` and foreign Origin on `/setup` (`test/setup.test.ts`, B5b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B6b backup and restore     | Plaintext dump, media or manifest egress; interrupted upload; missing component; unselected manifest; restored obsolete credentials (`kopje/scheduled-backup` covers egress, interrupted uploads and changed components in `test/backup.test.ts`; selection and credential invalidation are DATA-8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B8 cutover                 | Wrong target resources, domain or keys; writes to the source; an alternate Pages route still writable; unreconciled Queue or DLQ; changed content with unchanged length. B8a conversion (`test-node/cutover-*.test.ts`, `test/cutover-import.test.ts`): the audience never widens (a DM made public by bridge defaults; an author rewritten by 0021; an href-only address; a followers value spelled differently from its address; a followers-only mention that outlives an unfollow; a recipient added to a private boost; a tag or cc outside `to` made a recipient; a non-follower recipient of a followers-only status; conflicting or missing addressing); missing, emptied or same-length rewritten content; a removed or added recipient; a widened visibility; a dropped reply link, alias, follow, boost, notification or list member; a changed source, raw, edit, attachment, profile, key, setting, preference, policy, scope or counter; an extra row; an image moved to another owner or status; a lost or taken legacy id; a lost notification high-water mark; mixed KEKs; unaccepted deletions or truncation; `INSERT ... SELECT`, functions in `VALUES`, `CREATE TABLE ... AS SELECT`, non-canonical default or check expressions, bookkeeping DDL, nested or oversized `replace` expansion and stray statements; content in failure reports; an existing output file or link; an oversized export, total or dump; alias requests for hidden statuses and their images; B8b operations (`test/maintenance-worker.test.ts`, `test/cutover-token.test.ts`, `test-node/cutover-fingerprint.test.ts`, `test-node/cutover-maintenance.test.ts`): a write through the maintenance worker (any method, API, outbox, actor path), a personal inbox of nobody or under another case, a non-AS body, an oversized or undeflatable body, a missing or failing spool Queue, a legacy binding touched, a spooled request altered before replay, a replay a day after the signature, a snapshot key, key id, owner or actor that is not the legacy one, a local actor left out, mixed KEKs, another domain, a second import or a configuration change with `IMPORT_TOKEN` after the first import or once Access is set, a fingerprint after an insert, a delete, a same-length update of a short value, values swapped between rows, an edit inside a long value, emptied content or a moved notification counter, an export without the counter, an incomplete manifest, an export whose counts differ from the fingerprinted database, a secret or instance data in a report; an unsigned or oddly signed spool request, the rate limit, a full backlog; a stale snapshot; a cutover reset after publication, without MAINTENANCE=full, by the import token, during an import or with a non-empty journal; a drain past a request that may verify later, a forged request drained, a drain without the legacy binding, journaling after publication (`test/cutover-rollback.test.ts`); round 3: an isolate that first saw an empty Store, a delayed request overtaken by a newer one, a legacy retry overtaken, a dead-lettered legacy message, unreadable backlogs in the drain and in admission, a concurrent drain, a crash while sending, a late redelivery, a missing recipient, a flood against the journal quotas, Rollback A from bootstrap, an emptied notifications table without its counter, a manifest with a missing or extra zero-count table; round 4: a failing mark RPC, an import completing while the Worker served, publication with a journal, a drain after publication, re-import after Rollback A, redelivery after a reset and after the mode is removed, a suspended send past its lease, dead-lettering between readings, activities without context or id, valid requests over the quota, bookkeeping keys in a manifest; round 5: queue replay and deliveries of an unpublished import with MAINTENANCE=off, a restore published without Access, a mark answered after the lease ran out, a handed-off copy in Kopje's DLQ at close, bookkeeping keys with matching counts, a journal-full stop through a transient key failure and the CLI deadline, the unordered escape; round 6: a Queue reading that outlasts the round, a report that outlasts the lease, a live or replayed request while unpublished (no fetch, no retry), a scheduled backup before publication, a publication without an import, an import into a published Store, both publication marks at once, an unordered drain without a reported stop |

## IDs to check by change type

- **Mastodon API endpoint:** AUTH-1, AUTH-2, AUTH-6, VIS-1, VIS-5, VIS-12, RES-1, RES-3, RES-7, DATA-6. Test a wrong
  scope, a revoked token, another account's resource, and a status the viewer may not see.
- **Inbound activity handler:** ID-1, ID-3, ID-6, ID-7, ID-8, VIS-2, HTML-1, RES-1, RES-2, RES-6, OPS-1; the inbox
  precheck and the spool also OPS-6 (the cutover's maintenance worker shares them).
- **Outbound activity or delivery:** VIS-3, NET-2, NET-3, DATA-1, DATA-7, RES-5, RES-6.
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

| Risk                                                                                                                                                                                                                                                                                                  | Why accepted                                                                                                                                                                                                                                                      | Revisit when                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Duplicate keys in a JSON OAuth body are not rejected; the last one wins                                                                                                                                                                                                                               | RFC 6749 defines form bodies only, and Doorkeeper behaves the same                                                                                                                                                                                                | a client depends on JSON bodies                                      |
| Fedify 2.4.2 signs draft-cavage `(request-target)` without the query string                                                                                                                                                                                                                           | Mastodon accepts it; reported upstream                                                                                                                                                                                                                            | a peer rejects signed GETs to URLs with a query                      |
| Backups, dumps and cutover exports made before a KEK rewrap hold the local keys under the previous KEK (unprotected when it was empty), so R5 with one of them and that KEK can unwrap the keys                                                                                                       | The rewrap cannot change copies outside the Store; the rotation procedure tells the operator to delete them or accept this (DATA-14); health warns on an empty KEK                                                                                                | a key leak, or backups are re-encrypted per key                      |
| Signed-fetch cache entries may outlive a remote block or key change by up to 5 minutes                                                                                                                                                                                                                | Measured CPU savings on personal inboxes                                                                                                                                                                                                                          | blocks must apply at once                                            |
| OAuth client secrets are stored in plaintext, so R5 can act as any registered app (no user scopes)                                                                                                                                                                                                    | Matches Mastodon; app tokens carry no user authority                                                                                                                                                                                                              | app tokens gain user-level powers                                    |
| Aggregate counters (`reblogs_count`, `favourites_count`, `replies_count`) include interactions the viewer cannot see                                                                                                                                                                                  | Mastodon parity; clients rely on the counts                                                                                                                                                                                                                       | counters must hide private interactions                              |
| `GET /api/v1/instance/peers` lists the domain of every known remote account, including one known only from a direct or limited status, a follow or a search                                                                                                                                           | Mastodon parity (`Instance.searchable`); the instance's `domain_count` already counts the same set                                                                                                                                                                | peers must hide how a domain became known                            |
| `GET /api/v1/accounts/familiar_followers` does not show a match past the viewer's first 10,000 accepted follows (in account id order)                                                                                                                                                                 | The window is above Mastodon's default follow limit (7,500); a complete intersection would need maintained overlap data                                                                                                                                           | a viewer follows more than 10,000 accounts                           |
| `GET /api/v1/lists/:id/accounts?limit=0`, which Mastodon answers with every member, answers the newest 1,000 by account id                                                                                                                                                                            | One answer presents whole accounts (remote bios included), and 1,000 keeps it well within the isolate's 128 MB; the answer stays bounded (RES-3)                                                                                                                  | a list holds more than 1,000 members and a client relies on limit=0  |
| Non-public media is readable by anyone holding its unguessable URL; cached copies outlive deletion                                                                                                                                                                                                    | Clients and peers fetch media without credentials; URLs appear only under VIS-1                                                                                                                                                                                   | authenticated media fetch becomes interoperable                      |
| A write of a failed upload that lands after the sweep stays a day; one landing after its tombstone stays for good                                                                                                                                                                                     | An HTTP Worker has no fixed wall-time limit; deleting unrecorded objects would destroy media after a restore                                                                                                                                                      | R2 offers conditional writes bound to a Store record                 |
| R2 originals keep the uploaded bytes, EXIF and location included                                                                                                                                                                                                                                      | Never served (MEDIA-2); backups restore from them; they are A8                                                                                                                                                                                                    | backups can be rebuilt from re-encoded files                         |
| Remote servers' copies of statuses from before the cutover lose their images once the legacy images are deleted from Cloudflare Images                                                                                                                                                                | Kopje sends no `Update` for old statuses, which Mastodon would mark as edited; the runbook keeps the images for 30 days first                                                                                                                                     | send `Update` for the old statuses                                   |
| Service tokens are recognized by Access's claim shape (no email, empty `sub`, `common_name`)                                                                                                                                                                                                          | The admin application's policy decides which identities reach it                                                                                                                                                                                                  | the admin application admits mTLS or Access changes the claims       |
| A delivery whose completion was lost is POSTed again after its lease (at-least-once)                                                                                                                                                                                                                  | Receivers deduplicate by activity id; exactly-once needs the receiver's cooperation                                                                                                                                                                               | a receiver is seen to apply a repeat                                 |
| Misskey with several silent recipients of one status on one server: only the first copy Misskey processes sets the note's audience, so the other silent recipients there cannot see it. Supported: one silent recipient per Misskey server                                                            | Misskey keeps the first `Create` of a note; a combined copy would name the recipients to each other, and recipient-specific object ids would split the status                                                                                                     | Misskey honours a later copy, or a peer needs it                     |
| A purge's Undo of a local boost staged over several batches misses a follower whose inbox changes, between two batches, to a key the staging has already passed                                                                                                                                       | Staging spans batches only when a batch's remaining rows can't hold the targets, and the boosted status was deleted by its author, whose `Delete` already makes other servers drop boosts of it; tracking every staged target durably would cost a row per target | staging is seen to span many batches in practice                     |
| An untyped `Undo` whose object is a pair-shaped id (`/follows/<a>/<b>`) that matches nothing is not recorded as retracted, so a `Block` with that id arriving after it applies                                                                                                                        | Such an id names every generation of a Misskey follow and must not be recorded; Misskey's Block ids are `/blocks/<id>`, so only an unusual server that gives a Block a pair-shaped id and reorders its delivery is affected                                       | a server is seen to send pair-shaped Block ids                       |
| A lease taken just before maintenance and not completed counts one attempt when it expires                                                                                                                                                                                                            | Bounded by one attempt per lease; maintenance itself claims nothing (RES-5)                                                                                                                                                                                       | maintenance windows become frequent                                  |
| Fedify's own fetch-failure logs include response headers; they are silent only because logtape is unconfigured                                                                                                                                                                                        | Kopje configures no logtape sink (DATA-5); a sink without redaction must not be added                                                                                                                                                                             | Kopje configures logtape                                             |
| Remote HTML is sanitized by sanitize-html, whose htmlparser2 is a tokenizer rather than an HTML5 tree builder                                                                                                                                                                                         | It emits only allowlisted tags with quoted, escaped attributes and escapes all other text; the parse5-checked vector suites pass                                                                                                                                  | a vector fails, or a maintained tree-based sanitizer fits the budget |
| Backup media copies are never pruned, so an original deleted from R2 stays in the bucket (and copies from abandoned or stale attempts stay too); served `files/` variants are not backed up                                                                                                           | Copies are reused across backups and the kept indexes refer to them; originals are the source of the variants (B8 restore tools)                                                                                                                                  | a restore tool re-encodes variants, or backups track deletions       |
| The backup's S3 credentials can delete backups under `backups/` (not `media/`)                                                                                                                                                                                                                        | Retention needs delete; versioning or object lock on the bucket is the documented protection                                                                                                                                                                      | the job can work with put-only credentials                           |
| Activities signed by someone other than their actor (forwarded, with LD signatures) are refused                                                                                                                                                                                                       | ID-1. Replies that reach Kopje only by forwarding (to a collection the author cannot deliver to) and deliveries through relays are missed                                                                                                                         | relays or forwarded replies must be supported                        |
| The app registration limit is approximate: the Rate Limiting binding counts per Cloudflare location and is eventually consistent, and many addresses together can fill the 500 never-authorized slots, evicting never-authorized apps older than an hour or refusing registration for an hour at most | The Store's bound holds exactly whatever the limiter lets through, and every refusal is visible (429); Workers offers no exact global limiter without a paid product                                                                                              | registrations are seen to be refused or evicted in practice          |
| An app token (`client_credentials`) of an app no user has authorized may stop working under registration pressure: the app is evicted with its tokens                                                                                                                                                 | Anyone can get an app token without a user; letting app tokens protect an app would let them fill the budget for good. Clients re-register, as after Mastodon's vacuum                                                                                            | logged-out clients are seen to lose their app tokens                 |
| Two first sign-ins of one browser that overlap (the second starts before the first's session cookie arrives) leave two sessions; signing out ends only the one in the cookie                                                                                                                          | Both belong to the same person in the same browser, the other token is in no cookie or response any more, and it expires with its 7-day lifetime; binding them would need a server-side browser identity before sign-in                                           | a session token is seen to leak this way                             |
| A web session lasts its 7 days even if the person's Access session ends or the Access policy changes                                                                                                                                                                                                  | Access verifies the person at sign-in only (design); suspension, sign-out and "sign out other sessions" end sessions at once                                                                                                                                      | sessions must follow Access policy changes                           |
| Notifications written before a block, a mute or a domain block are hidden while it lasts, not deleted as Mastodon deletes them, so they show again after it ends                                                                                                                                      | The one notification rule hides them at read time (VIS-13 to VIS-15); deleting them would be unbounded work in the request                                                                                                                                        | a user expects them gone after an unblock                            |
| A local block of a remote actor at its retraction cap does not record the ended Follow as retracted, so after an unblock a redelivery of that Follow is accepted as a new one                                                                                                                         | The block must apply whatever the blocked actor did to its own cap; while the block lasts its Follows are refused (VIS-13)                                                                                                                                        | redelivered Follows are seen after unblocks                          |
| Deliveries queued before a block or a domain block (retries of them included) are still sent as queued, to the blocked account's inboxes too                                                                                                                                                          | Mastodon does not rewrite deliveries already queued either; a re-check at claim cannot tell, for a shared inbox or a follower target, which recipients it serves (VIS-13, VIS-15)                                                                                 | deliveries keep their recipients                                     |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a Codex or human review checks the IDs listed for the change type above, plus
  anything this model is missing. The other lenses (correctness, design, tests) use their own criteria.
- **Tests** name the invariant in the test name or a comment where practical (for example `// VIS-4`), so `grep -rn
'VIS-4' packages/kopje/test` shows its coverage.
- This document covers security only. It is not a correctness or design checklist.
