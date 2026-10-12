# Kopje threat model

What Kopje protects, from whom, and the security invariants the code must keep, by ID (for example `ID-1`). It covers
security only; correctness, compatibility and design are reviewed against their own criteria.

**Keep it current.** A PR that adds an entry point, asset, trust boundary or accepted risk, or changes an invariant's
status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired with the reason.

## Status of an invariant

Paths are relative to `packages/kopje`. **Enforced (main):** the cited source and test exist on `main`. **Implemented on
branch `kopje/<name>`:** on a branch not yet in a PR (`kopje/ops-tools` is B6a, `kopje/statuses` is B4a). **Planned
(stage):** not implemented; required before the stage ships.

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

| Entry point                                                   | Reached by | Authenticated by                                         | Status and code                                           |
| ------------------------------------------------------------- | ---------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `POST /inbox`, `/ap/users/:username/inbox`, `/actor/inbox`    | R1, R2     | HTTP signature, also on replay from the spool            | main: bounded read, spool, stub; B1b: verification        |
| Actor, `/actor`, WebFinger, NodeInfo, followers and following | R1, R2     | none (public)                                            | main: `src/federation/*`                                  |
| `/ap/o/:uuid` and status documents                            | R1, R2     | none (VIS-4)                                             | Planned (B1b)                                             |
| Outbound document fetches                                     | R1 answers | final URL and parsed id (ID-2)                           | main: `src/federation/loader.ts`                          |
| Deliveries, remote media fetches, Web Push POSTs              | R1 answers | sink policy (NET-3)                                      | Planned (B2, B4, push)                                    |
| Mastodon API `/api/*`                                         | R2–R4, R7  | bearer token and route access                            | main: `src/mastodon/*`, `src/domain/auth.ts`              |
| `/oauth/authorize`                                            | R2, R6, R7 | Access JWT, Origin, consent                              | main: `src/app/authorize.tsx`                             |
| `/oauth/token`, `/oauth/revoke`                               | R2, R3     | client credentials                                       | main: `src/mastodon/oauth.ts`                             |
| `/admin/*` and the `kopje-admin` CLI                          | R2, R6     | admin Access JWT, service token, `IMPORT_TOKEN`, session | `kopje/ops-tools`: `src/app/admin.ts`                     |
| `/setup` and its Cloudflare API calls                         | R2, R7     | `SETUP_TOKEN`                                            | Planned (B5)                                              |
| Web UI (profiles, permalinks, settings)                       | R2, R4, R7 | session                                                  | Planned (B5)                                              |
| Media upload and serving, Images transformation               | R2–R4      | bearer token; capability URL for reads                   | Planned (B4)                                              |
| Web Push registration                                         | R3         | bearer token with `push`                                 | Planned (push)                                            |
| Queue consumer, alarms, cron                                  | internal   | —                                                        | main: `src/jobs/queue.ts`, `src/platform/store-kernel.ts` |
| Dump import, backup restore, cutover tools                    | R5, R8     | admin authority, then digest chain and manifest          | `kopje/ops-tools` (import); Planned (B6b, B8)             |

## Invariants

### Identity and inbound activities (ID)

- **ID-1: an inbound activity acts only for its signer.** It is processed only if its HTTP signature verifies, the key's
  owner equals `activity.actor`, and that actor is not local. An unsigned or unverifiable request changes nothing and
  answers 401. _Planned (B1b)._
- **ID-2: a fetched document is trusted only for its own origin.** The identity of a fetched object is its parsed `id`
  after JSON-LD processing, and it must have the origin of the final response URL. The loader's literal `id` check is a
  pre-filter. Cross-origin redirects are refused. _Enforced (main):_ `src/federation/loader.ts`;
  `test/remote-identity.test.ts`, `test/loader.test.ts`.
- **ID-3: remote input never changes local actors or local objects.** No inbound activity updates, deletes, moves or
  attributes anything to a local account or local status. _Planned (B1b)._
- **ID-4: `Move` requires the alias.** A `Move` is honoured only if the freshly fetched target lists the source in
  `alsoKnownAs`. _Planned (B1b)._
- **ID-5: local documents come from stored data only.** Actor ids derive from the domain fixed at setup and the stored
  username's exact spelling; public keys come from `local_accounts.pubkey`. Another spelling or host answers 404 and has
  no key pair. _Enforced (main):_ `src/federation/federation.ts`; `test/federation.test.ts` ("differently cased path",
  "another host, an unknown user, and the request host"), `test/signed-fetch.test.ts` ("no key pairs for a spelling").
- **ID-6: each activity type has a fixed authorization rule** (Mastodon 4.7.3's table, pinned by one negative test per
  row). The activity `id` has the actor's origin before any idempotency key is reserved. `Undo` requires the actor of
  the undone activity; `Accept` and `Reject` require the target of the matching `Follow`; `Update` and `Delete` require
  the object's current author, and an update never changes the author. A same-origin but different actor is refused like
  a cross-origin one. _Planned (B1b)._
- **ID-7: replay changes nothing twice.** A repeated activity creates no second relationship, counter change,
  notification, push or outbound intent (natural keys). A valid `Delete` or `Undo` that arrives before its target is
  recorded for 30 days and prevents the target from appearing later. Input that fails ID-1 or ID-6 reserves no key and
  records no retraction. _Planned (B1b)._
- **ID-8: only ActivityStreams media types become objects.** A fetched document is used as an actor, key or object only
  if served as `application/activity+json` or `application/ld+json` with the ActivityStreams profile, as Mastodon
  requires. Other JSON (an uploaded file, for example) is refused. _Planned (B1b). Gap — fix in progress on branch
  `kopje/hardening-1`: the loader on main also accepts `application/json`, `application/jrd+json` and
  `application/ld+json` without the profile._

### Visibility (VIS)

Content authorization (may this viewer see this status at all) is separate from filtering (does this viewer want it in a
list). VIS-1 to VIS-4 are authorization; VIS-5 is filtering.

- **VIS-1: one rule decides who may see a status**, Mastodon's `StatusPolicy#show?`: a suspended author's statuses are
  seen by nobody; the author sees all their own; an author who blocks the viewer hides everything from them; `public`
  and `unlisted` are seen by everyone else; `private` by accepted followers and the mentioned (silent included);
  `direct` and `limited` by the mentioned (silent included) only. Every read path uses the same SQL rule. _Implemented
  on branch `kopje/statuses`:_ `src/domain/audience.ts` (`visibleSql`, `canView`); `test/audience.test.ts`,
  `test/visibility.test.ts` (single status, context, history, source, `favourited_by`, timelines, account statuses,
  notifications, bookmarks, favourites). Search, the web UI, media and the object endpoint are _Planned (B4, B5, B1b)._
  _Gap: `reblogged_by` lists private boosts (VIS-12)._
- **VIS-2: limited stays limited.** A direct status with silent recipients (Misskey `specified`) is `limited`: shown
  only to its addressed recipients, presented as `private` by the API, never widened by an edit. _Implemented on branch
  `kopje/statuses`:_ `interpretAddressing` in `src/domain/audience.ts`; `test/audience.test.ts` ("reads Misskey
  specified"). Use on inbound statuses: _Planned (B1b)._
- **VIS-3: changes reach only the original audience.** `Update` and `Delete` are addressed to the audience the status
  already had; `Delete` carries a `Tombstone`, not the content. _Implemented on branch `kopje/statuses`:_
  `src/domain/activities.ts`; `test/statuses.test.ts` ("records Create, Update and Delete for the original audience
  only"). Delivery: _Planned (B2)._
- **VIS-4: the object endpoint serves public and unlisted local statuses only.** `/ap/o/:uuid` and status documents
  answer for local `public` and `unlisted` statuses, as Mastodon does for an unauthenticated fetch. `private`, `direct`,
  `limited`, remote objects and statuses of suspended accounts answer 404, whether or not the request is signed.
  _Planned (B1b)._
- **VIS-5: lists also apply the viewer's filters**, Mastodon's `StatusFilter`. Feeds, context, notifications, bookmarks,
  favourites, `favourited_by` and `reblogged_by` drop authors the viewer blocks, mutes or domain-blocks. A single status
  by id is not filtered. _Implemented on branch `kopje/statuses`:_ `unfilteredSql` and `listableSql` in
  `src/domain/audience.ts`; `test/audience.test.ts`, `test/visibility.test.ts` ("blocked and muted accounts stay out of
  lists").
- **VIS-6: a wrapper reveals nothing its target hides.** A boost is visible only if its original is; boosting is limited
  to `public` and `unlisted` statuses and one's own `private` ones (`StatusPolicy#reblog?`). _Implemented on branch
  `kopje/statuses`:_ `viewableSql`; `test/visibility.test.ts` ("a boost of an original the viewer may not see is hidden
  with it"), `test/statuses.test.ts` ("refuses to boost direct and others’ private statuses"). Quotes and other embedded
  objects check their target the same way: _Planned (B1b, B4)._ _Gap: see VIS-12 for write responses._
- **VIS-7: silent recipients see, but are not mentioned.** A silent mention grants VIS-1 access only. It never appears
  in `mentions` and never produces a mention notification. _Implemented on branch `kopje/statuses`:_
  `src/domain/status-presenter.ts`, `src/domain/notifications.ts`; `test/visibility.test.ts` ("none for a silent
  recipient").
- **VIS-8: a pending follow grants nothing.** A follow of a locked local account or of any remote account starts
  `pending`; only `accepted` follows count, appear in follower lists, or grant `private` access. _Enforced (main):_
  `follow` in `src/domain/accounts.ts`; `test/accounts.test.ts` ("requests a locked or remote account", "lists following
  without pending requests").
- **VIS-9: only the followed side accepts.** A pending follow of a local account becomes `accepted` only by that
  account's own authorize call; a pending remote follow only by an `Accept` that passes ID-6. _Planned (B4, B1b)._
- **VIS-10: a notification is emitted once.** It is written only if the recipient is local and may see the status, and
  only when new under its natural key; a repeat inserts nothing (`update` replaces the previous one). Its push is sent
  only for a newly inserted row. _Implemented on branch `kopje/statuses`:_ `notify` in `src/domain/notifications.ts`.
  _Gap: no replay test._ Push: _Planned (push)._
- **VIS-11: earlier versions keep the original audience.** Edit history and earlier versions are visible only to the
  status's original audience, and an edit of a non-public status never widens that audience (a recipient added by an
  edit does not see earlier versions). This differs from Mastodon on purpose. _Planned (B4a fixes)._
- **VIS-12: metadata reveals no hidden status.** Presenter fields never disclose a status the viewer may not see:
  `last_status_at` ignores `direct` and `limited` statuses; `in_reply_to_id` and `in_reply_to_account_id` follow an
  explicit rule for a parent the viewer may not see; `reblogged_by` lists only `public` and `unlisted` boosts and both
  interactor lists only accounts the viewer may see; a write response (such as deleting a boost) applies VIS-1 to every
  status it embeds, and `source` appears only on the viewer's own status. Aggregate counters are excepted (see accepted
  risks). _Planned (B4a fixes)._

### Authorization (AUTH)

- **AUTH-1: authorization happens inside the operation.** Token validity, expiry, revocation, scope and account
  suspension are checked in the same Store transaction as the operation they authorize. _Enforced (main):_
  `userReadOperation` and `userWriteOperation` in `src/domain/auth.ts`; `test/store-auth.test.ts`, `test/oauth.test.ts`
  ("refuses a token that survived the suspension").
- **AUTH-2: every API route declares its access.** Each Mastodon API route is `public`, `token` (any valid token, app
  tokens included) or a required user scope; one helper decides scope coverage (parents cover children, `follow` expands
  to its split scopes, nothing else is implied). _Enforced (main):_ `src/mastodon/routes.ts`, `src/security/scopes.ts`;
  `test/scopes.test.ts`, `test/vectors.test.ts` ("Mastodon's scope hierarchy"), `test/oauth.test.ts` ("scopes on
  routes"). `kopje/statuses` adds `optional` scopes (no token reads as anonymous; a token sent must be valid).
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
- **AUTH-5: admin authority comes only from the target's own configuration.** _Implemented on branch `kopje/ops-tools`:_
  `src/app/admin.ts`, `src/platform/store-admin.ts`, `src/platform/access-settings.ts`; `test/ops-authority.test.ts`,
  `test/admin.test.ts`, `test/dump-import.test.ts`. - Configuration is every name `/admin/config` accepts: `domain`,
  `access_aud`, `access_team_domain`, `access_admin_aud`, `admin_email`, `access_service_token_client_id`. A verified
  import restores the target's values exactly; an imported value never replaces them and an absent name stays absent. -
  An admin is the configured `admin_email`, or a service token with no email, `sub === ""` and `common_name` equal to
  the configured client id. - `IMPORT_TOKEN` only begins an import into an empty Store without usable admin access, or
  configures the Store while admin access is not usable. The Store checks this, not only the Worker. - A token import
  continues only with the one-time session credential `begin` returned; the Store keeps its SHA-256 only. An unverified
  token import idle for 15 minutes may be reset with `IMPORT_TOKEN`; an Access import never. - Secrets are compared as
  fixed-size SHA-256 digests.
- **AUTH-6: a user acts only on what that user may touch.** User operations take the acting account from the validated
  viewer, never from the body or path, and check ownership or VIS-1 access to every referenced resource in the same
  transaction. Admin, setup and federation operations use their own named rules (AUTH-5, SETUP-2, ID-6). _Enforced
  (main)_ for accounts and OAuth: `src/domain/accounts.ts`, `src/domain/oauth.ts`; `test/oauth.test.ts` ("does not
  revoke a token of another client"). _Implemented on branch `kopje/statuses`_ for statuses and notifications:
  `test/statuses.test.ts` ("cannot edit someone else's status", "gives the source for editing to the author only"),
  `test/notifications.test.ts` ("only the viewer’s own notifications").
- **AUTH-7: opaque credentials are unguessable and stored as digests.** Client ids and secrets, codes and access tokens
  are 32 random bytes. Codes and access tokens are stored and looked up only by their full SHA-256. _Enforced (main):_
  `src/security/tokens.ts`, `src/domain/oauth.ts`; `test/oauth.test.ts` ("stores only digests of tokens and codes").

### Web (WEB)

- **WEB-1: the consent decision cannot be forged cross-site.** `GET /oauth/authorize` issues nothing. The `POST`
  requires a valid Access identity, an `Origin` equal to the instance origin (missing, `null` or foreign answers 403),
  and `decision=approve`; the Store revalidates client, redirect URI, scopes and account when it writes the code.
  _Enforced (main):_ `src/app/authorize.tsx`, `issueCode` in `src/domain/oauth.ts`; `test/oauth.test.ts` ("refuses a
  decision posted from another origin", "refuses an account suspended between the consent page and approval"). _Gap:
  missing and `null` Origin are not tested._
- **WEB-2: Kopje's HTML pages cannot be framed, scripted or cached.** Consent and code pages send a CSP with `script-src
'none'` and `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control:
no-store`, and render every value escaped. _Enforced (main):_ `src/app/authorize.tsx`, `src/web/consent.tsx`;
  `test/oauth.test.ts` ("logs in through Access and calls the API with the token"). _Gap: only `script-src`,
  `X-Frame-Options` and escaping are asserted._ Web UI and `/setup` pages: _Planned (B5)._
- **WEB-3: CORS is open only where no ambient credential exists.** Wildcard CORS without credentials applies to
  `/api/*`, `/oauth/token` and `/oauth/revoke` only (bearer tokens). `/oauth/authorize`, `/admin/*`, `/setup` and the
  web UI send no CORS headers. _Enforced (main):_ `src/app/app.ts`; `test/oauth.test.ts` ("opens the API and token
  endpoints to browser clients, errors included"). Admin, setup and UI routes: _Planned (B5); `kopje/ops-tools` adds
  `/admin/*` without CORS._
- **WEB-4: the web UI applies WEB-1 to every state change.** Each form that changes state checks `Origin` and its
  session; a return or redirect target is a validated local path. _Planned (B5)._
- **WEB-5: responses declare their type.** API and federation responses carry their exact JSON media type and
  `X-Content-Type-Options: nosniff`. _Planned (B1b, B4)._

### Setup (SETUP)

- **SETUP-1: nothing is published before setup.** Federation paths answer 503 until `/setup` has fixed the domain;
  sign-in answers 503 until Access is configured. _Enforced (main):_ `src/federation/setup-gate.ts`,
  `src/app/authorize.tsx`; `test/app.test.ts` ("answers 503 on federation routes until setup has fixed the domain"),
  `test/oauth.test.ts` ("answers 503 until Access is configured").
- **SETUP-2: `SETUP_TOKEN` only bootstraps.** `/setup` changes require `SETUP_TOKEN`, compared as fixed-size digests.
  Once the domain and admin exist, the token cannot change the domain, the admin or the Access configuration. _Planned
  (B5)._
- **SETUP-3: bootstrap happens once.** The domain and the first admin are written in one Store transaction that fails if
  either exists, so concurrent requests cannot create two. _Planned (B5)._
- **SETUP-4: the Cloudflare API token is transient.** It is used only within the request that received it and is never
  stored, logged or returned. _Planned (B5)._

### Network (NET)

- **NET-1: document fetches are bounded and public-only.** The safe loader fetches https only, refuses URLs with
  credentials, literal IPs, `localhost` and single-label hosts, checks that the name resolves to public addresses,
  re-checks every redirect hop (same origin, at most 5), stops at 1 MiB and 5 s for the whole load, and honours abort
  signals. _Enforced (main):_ `src/federation/loader.ts`; `test/loader.test.ts`.
- **NET-2: deliveries reach only the audience's inboxes.** Inboxes come from the stored audience and are deduplicated by
  shared inbox; targets pass NET-3; a non-public activity is never sent to a redirect target. Claims serialize each
  `(actor, inbox)` lane; the POST timeout (30 s) is shorter than the lease (60 s), and completion requires the current
  lease token, so a stale completion cannot settle a later claim. _Planned (B2)._
- **NET-3: every outbound sink has its own policy.** Any URL derived from remote or user input is fetched only through a
  sink client that applies NET-1's host rules (https, public address, re-checked hops, a hop limit) plus its own budget:
  documents as NET-1; remote media a size cap, a time limit and a type allowlist; Web Push and deliveries no redirects.
  Credentials and signatures never follow a redirect to another origin. Fedify's sending and queueing are not used.
  _Enforced (main)_ for documents and the Fedify rule: `test/fedify-usage.test.ts` ("never sends or queues through
  Fedify"). Media, push and deliveries: _Planned (B4, push, B2)._
- **NET-4: signed fetches stay with their signer.** A document fetched with a signature is cached under a key that
  includes the signing key id and is never served to another key or to the unsigned path. _Enforced (main):_
  `signedLoader` in `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("caches signed documents per signing
  key"). Expiry within 5 minutes and a sweep of expired rows: _Planned (B1b); the TTL is Fedify's `kvCache` default and
  no test pins it._
- **NET-5: snapshots come only from authoritative local data.** A rescue snapshot holds only a canonical actor,
  WebFinger or NodeInfo document rendered on the fixed domain from Store columns, and is kept only if its source still
  matches the Store when saved. Request hosts, arbitrary queries and remote documents never create or change one.
  _Enforced (main):_ `src/domain/snapshot.ts`, `src/federation/routes.ts`; `test/snapshot.test.ts`.

### Content (HTML)

- **HTML-1: remote HTML is sanitized by allowlist.** Tags, attributes and URL schemes are allowlisted by a maintained
  sanitizer (or custom code that passes the vector suites below). Sanitized HTML enters only rich-content sinks
  (`content`, `note`, field values) and is not escaped a second time. _Planned (B1b)._
- **HTML-2: local text becomes HTML only by escaping and linking.** Status text and bios are escaped, then absolute
  http(s) URLs, known mentions and hashtags are linked. Display names stay plain strings. _Enforced (main)_ for bios:
  `src/domain/plain-text.ts`; `test/accounts.test.ts` ("stores plain-text profile fields safely"). _Implemented on
  branch `kopje/statuses`_ for status text: `src/domain/status-text.ts`; `test/status-text.test.ts`.
- **HTML-3: navigable URLs are http(s) only.** Before a profile URL, avatar, header, attachment URL, field link or app
  website is emitted, it is parsed and must be http or https; anything else becomes absent or the default. This applies
  to fetched and imported data too. _Enforced (main)_ for app websites at registration: `validWebsite` in
  `src/mastodon/oauth.ts` (_Gap: untested_). Account presenter and actor documents: _Planned (B1b, B4). Gap — fix in
  progress on branch `kopje/hardening-1`: `presentAccount` and `localActorObject` on main emit stored URLs unchecked._

### Media (MEDIA)

- **MEDIA-1: only the owner uses an attachment.** Only the uploader may update, delete or attach an attachment, and only
  while it is unattached or attached to the status being edited. _Implemented on branch `kopje/statuses`_ for attaching:
  `attachableMedia` in `src/domain/statuses.ts`; `test/statuses.test.ts` ("attaches own unattached media"). Upload,
  update and delete: _Planned (B4)._
- **MEDIA-2: R2 keys are server-made.** Keys derive from server-generated ids and stored records; no filename, path
  segment or encoded separator from a request selects or overwrites a key. Originals are not publicly readable. _Planned
  (B4)._
- **MEDIA-3: served images are re-encoded.** An image is served only as Images output with location metadata removed; if
  transformation fails, the upload is refused and original bytes are never served. _Planned (B4)._
- **MEDIA-4: media cannot run as instance content.** Uploads are accepted by detected type from an allowlist and served
  with their stored type and `nosniff`; HTML, SVG and other active types are never served from the instance origin.
  _Planned (B4)._

### Web Push and polls (PUSH, POLL)

- **PUSH-1: a subscription belongs to its token.** Subscription operations require the `push` scope and select the
  subscription by the authenticated token, never by an id from the request. _Planned (push)._
- **PUSH-2: endpoints are outbound sinks.** A push endpoint passes NET-3 at registration and at every send. _Planned
  (push)._
- **PUSH-3: push reveals no more than notifications.** A push is sent only for a VIS-10 notification the recipient may
  still see when sending. Revoking the token or suspending the account deletes its subscriptions. _Planned (push)._
- **POLL-1: votes are the voter's own.** Only the poll's author changes its definition or results. A vote is attributed
  to the verified voter, names a valid option of that poll, respects expiry and single or multiple choice, and a replay
  counts once. _Planned (polls)._

### Resources (RES)

- **RES-1: input is bounded before it is parsed.** API parameter bodies and inbox bodies stop at 1 MiB, by
  `Content-Length` or while streaming. Each text field has a raw cap before parsing or counting (status text: 10,000
  code units). Media uploads have their own limit. _Enforced (main)_ for bodies: `src/platform/body.ts`,
  `src/mastodon/params.ts`; `test/gate.test.ts` ("refuses an inbox body over 1 MiB", "stops reading a streamed inbox
  body"). _Gap: no API body test._ _Implemented on branch `kopje/statuses`_ for status text: `test/status-text.test.ts`
  ("raw input bound"). Query strings, search terms and media: _Planned (B4)._
- **RES-2: parsing work is bounded.** Every regex, parser and normalization over input at the RES-1 cap has an
  adversarial fixture with a time bound. _Implemented on branch `kopje/statuses`_ for status text:
  `test/statuses.test.ts` ("handles the worst case at the bound within a generous time"). JSON-LD processing and remote
  HTML: _Planned (B1b)._
- **RES-3: lists are bounded.** Pageable lists return at most 80 items; relationships read at most 100 ids; any other
  collection names its count and byte bound. _Enforced (main):_ `src/mastodon/pagination.ts`, `MAX_RELATIONSHIP_IDS` in
  `src/domain/accounts.ts`. _Gap: neither cap is tested._
- **RES-4: stored derived data is bounded.** Snapshots, the KV cache, the spool and deliveries each have a size cap, a
  count cap or an expiry with a sweeper. _Enforced (main)_ for snapshots: `test/snapshot.test.ts` ("snapshot caps"). KV
  sweep, spool and deliveries: _Planned (B1b, B2)._
- **RES-5: retries are bounded, but maintenance is not a failure.** Waiting out maintenance consumes no processing
  retry; real processing errors count against `max_retries`. _Enforced (main):_ `src/jobs/queue.ts`; `test/gate.test.ts`
  ("spool consumer"). Deliveries give up after 15 attempts (`min(30s·2^n, 12h)`) and are listed for the operator; spool
  messages that fail terminally are kept and inspectable before acknowledgement: _Planned (B2, B1b)._
- **RES-6: one request cannot trigger unbounded work.** An inbound activity has fixed limits on dereferences,
  recipients, collection expansion and notifications. Delivery backlog and concurrency are bounded. Anonymous app
  registration, inbox spooling and media transformations have rate or storage budgets with a visible refusal. _Planned
  (B1b, B2, B4). Gap: `POST /api/v1/apps` on main has no rate or storage budget yet; planned with B5 (rate limiting)._
- **RES-7: query work is bounded, not only the rows returned.** Feeds apply visibility and filters in the query before
  `LIMIT`. Context traversal visits a bounded number of statuses before sorting. A status keeps a bounded number and
  size of edits. _Implemented on branch `kopje/statuses`_ for filtering before `LIMIT`: `src/domain/timelines.ts` (_Gap:
  untested_). Context traversal and edit history: _Planned (B4a fixes)._

### Data and keys (DATA)

- **DATA-1: private keys stay wrapped outside cryptographic use.** Actor and instance keys are stored wrapped with
  `USER_KEK` in the legacy format. They are unwrapped per call in the Worker, only to sign and for the health key check,
  are never cached, and never appear in responses or logs. _Enforced (main):_ `src/security/key-wrap.ts`,
  `src/security/keyring.ts`; `test/keyring.test.ts`, `test/health-keys.test.ts`.
- **DATA-2: VAPID keys are never regenerated implicitly.** `VAPID_JWK` is a secret that Kopje only reads; an invalid
  value is a misconfiguration. _Enforced (main):_ `src/platform/vapid.ts`, `src/platform/config.ts`;
  `test/instance.test.ts` ("refuses an invalid VAPID_JWK as misconfiguration").
- **DATA-3: dumps are exact and verified.** A dump keeps exact bytes and storage classes. Import accepts only exact
  template statements with bound literals, into an empty Store with the same schema, and verification recomputes the
  digests from the imported rows. _Implemented on branch `kopje/ops-tools`:_ `src/platform/store-dump.ts`,
  `src/platform/store-import.ts`, `docs/dump-format.md`; `test/dump-import.test.ts`, `test/ops-regressions.test.ts`,
  `test/dump-format.test.ts`.
- **DATA-4: backups leave Cloudflare only encrypted.** Dump chunks, R2 originals and manifests are age-encrypted before
  upload. _Planned (B6b)._
- **DATA-5: logs carry no secrets or content.** Log entries are structured events. They never include request bodies,
  post content, tokens, keys, Access assertions or URLs with credentials. Tests inject marker values into errors and
  assert they are absent. _Planned (all stages). Gap — fix in progress on branch `kopje/hardening-1`: `app.onError` and
  the queue handlers on main log arbitrary exception messages. Access failures log only jose's error code (main), and
  the CLI never prints secrets (`kopje/ops-tools`, `test/cli.test.ts`)._
- **DATA-6: ids stay strings end to end.** Ids never pass through JS numbers. INTEGER edge and notification ids are read
  with `CAST(id AS TEXT)` and compared with `CAST(? AS INTEGER)`. 18-digit TEXT status ids compare as TEXT; a shorter
  client cursor is zero-padded first. _Enforced (main)_ for edges: `listFollows` in `src/domain/accounts.ts`;
  `test/accounts.test.ts` ("edge ids beyond 2^53", "keeps 18-digit ids exact"). _Implemented on branch `kopje/statuses`_
  for status cursors: `statusCursor` in `src/domain/statuses.ts` (_Gap: untested_).
- **DATA-7: the instance key signs only recipient-neutral fetches.** Fetches without a specific recipient are signed by
  the instance actor; fetches for a personal inbox by the recipient's key; activities by their author's key. The
  instance key never signs an activity attributed to a user. _Enforced (main)_ for fetches:
  `src/federation/federation.ts`; `test/signed-fetch.test.ts` ("signed fetches"). Activities: _Planned (B2)._
- **DATA-8: a restore has selected authority.** Restore uses a manifest the operator selected by digest, checks schema
  version, domain and every referenced component before use, and before leaving maintenance invalidates OAuth grants
  restored from the checkpoint and reconciles suspension and admin state. _Planned (B6b)._

### Operations (OPS)

- **OPS-1: an accepted inbox request is never lost.** An inbox answers 202 only after the Store commits or the Queue
  accepts the spooled request; otherwise it answers an explicit failure (413 over the cap, 503 when it cannot spool).
  Maintenance is the maximum of the env flag and the Store flag: `readonly` admits reads and sessions and refuses other
  writes with 503; `full` also refuses reads and sessions, except always-served routes. _Enforced (main):_
  `src/app/app.ts`, `src/app/gate.ts`, `src/federation/spool.ts`; `test/gate.test.ts` ("maintenance gate"). A PITR
  restore requires env `MAINTENANCE=full`: _Implemented on branch `kopje/ops-tools`_ (`test/admin.test.ts`, "restores
  only under MAINTENANCE=full"). Replay that verifies the signature against the spool time: _Planned (B1b)._
- **OPS-2: no upgrade runs under a dump freeze or an import.** Migrations wait while either exists. The freeze also
  stops session writes and alarm work. _Implemented on branch `kopje/ops-tools`:_ `src/platform/store-kernel.ts`,
  `src/platform/store-flags.ts`; `test/dump-import.test.ts`, `test/ops-authority.test.ts` ("upgrades during an import").
- **OPS-3: an unknown outcome is reconciled, not assumed.** A migration failure re-reads durable bookkeeping. Other
  operations that a client may retry after a lost response carry a stable idempotency key. _Enforced (main)_ for
  migrations: `test/migrations.test.ts` ("re-reads bookkeeping"). _Implemented on branch `kopje/statuses`_
  (`Idempotency-Key`, `test/statuses.test.ts`) and `kopje/ops-tools` (import chunks, `test/dump-import.test.ts`).
  Deliveries and push: _Planned (B2, push)._
- **OPS-4: cutover never writes the source and never goes back.** The legacy source stays read-only; every ingress route
  (custom domain, `pages.dev`, previews) is replaced before the final export; publication requires independent per-row
  verification that fails when content changes at the same length, and Queue and DLQ reconciliation. After publication,
  recovery uses the Store, PITR and backups. _Planned (B8)._

## Negative cases by stage

Each stage ships tests for these cases, named with the invariant IDs.

| Stage                      | Required negative cases                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1b inbound                | Wrong signer or actor; foreign activity id; same-origin different actor; unauthorized Undo, Accept, Update, Delete; duplicate and reordered Delete and Create; non-AS media type; private and unlisted object fetches                                                                                                                                                   |
| B2 delivery                | Redirect of a private activity; recipient outside the audience; duplicate inbox; expired lease; stale completion; commit followed by response loss                                                                                                                                                                                                                      |
| B4 statuses, media, search | Edit, source or history of another's status; history seen by a recipient added later; private boost in `reblogged_by`; hidden parent in reply fields; DM moving `last_status_at`; unbounded edits or reply tree; boost or quote of an invisible status; foreign attachment; unsafe R2 key; retained EXIF; failed transform; active media type; private status in search |
| B5 UI and setup            | Missing, `null` and foreign Origin; framing headers; unsafe return path; reused setup token; concurrent bootstrap                                                                                                                                                                                                                                                       |
| B6b backup and restore     | Plaintext dump, media or manifest egress; interrupted upload; missing component; unselected manifest; restored obsolete credentials                                                                                                                                                                                                                                     |
| B8 cutover                 | Wrong target resources, domain or keys; writes to the source; an alternate Pages route still writable; unreconciled Queue or DLQ; changed content with unchanged length                                                                                                                                                                                                 |

## IDs to check by change type

- **Mastodon API endpoint:** AUTH-1, AUTH-2, AUTH-6, VIS-1, VIS-5, VIS-12, RES-1, RES-3, RES-7, DATA-6. Test a wrong
  scope, a revoked token, another account's resource, and a status the viewer may not see.
- **Inbound activity handler:** ID-1, ID-3, ID-6, ID-7, ID-8, VIS-2, HTML-1, RES-1, RES-2, RES-6, OPS-1.
- **Outbound activity or delivery:** VIS-3, NET-2, NET-3, DATA-1, DATA-7, RES-5, RES-6.
- **Fetch of a remote URL:** NET-1, NET-3, NET-4, ID-2, ID-8. Use a sink client, never `fetch` directly.
- **Rendered field or HTML page:** HTML-1, HTML-2, HTML-3, WEB-2, WEB-5. Run the vector suites.
- **Web UI, consent or setup:** WEB-1 to WEB-4, SETUP-1 to SETUP-4.
- **Media:** MEDIA-1 to MEDIA-4, NET-3, VIS-1, RES-1, RES-6.
- **Web Push:** PUSH-1 to PUSH-3, AUTH-7, DATA-2, NET-3, VIS-10.
- **Store operation or migration:** AUTH-1, OPS-2, OPS-3, DATA-6. Migrations are append-only after the first release and
  never recreate a parent table (that cascades deletes into child tables).
- **Admin, dump, import, backup or CLI:** AUTH-4, AUTH-5, DATA-3, DATA-4, DATA-5, DATA-8, OPS-2.
- **New dependency:** prefer a maintained, widely used library over custom security code. Record its version, age (at
  least 3 days, per `minimumReleaseAge`), license and bundle size in the PR.

## Verification sources

Custom code is cross-checked against external vectors: RFC 7636 Appendix B and the RFC 6749 and RFC 7009 examples
(`test/vectors.test.ts`); Fedify's draft-cavage vector and a pinned Mastodon-shaped signature
(`test/http-signature.test.ts`); NIST SHA-256 vectors (`kopje/ops-tools`, `test/dump-format.test.ts`); the DOMPurify,
OWASP, html5sec and sanitize-html vectors in `packages/backend`; Mastodon's `StatusPolicy`, `StatusFilter` and inbound
activity specs, cited in test names.

## Accepted risks

| Risk                                                                                                                 | Why accepted                                                                       | Revisit when                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Duplicate keys in a JSON OAuth body are not rejected; the last one wins                                              | RFC 6749 defines form bodies only, and Doorkeeper behaves the same                 | a client depends on JSON bodies                                |
| Fedify 2.4.2 signs draft-cavage `(request-target)` without the query string                                          | Mastodon accepts it; reported upstream                                             | a peer rejects signed GETs to URLs with a query                |
| Legacy keys are not rewrapped; an empty or known `USER_KEK` gives no protection against R5                           | Owner's decision; health warns on an empty KEK (main), the cutover tool warns (B8) | a key leak, or rewrapping becomes cheap                        |
| Signed-fetch cache entries may outlive a remote block or key change by up to 5 minutes                               | Measured CPU savings on personal inboxes                                           | blocks must apply at once                                      |
| OAuth client secrets are stored in plaintext, so R5 can act as any registered app (no user scopes)                   | Matches Mastodon; app tokens carry no user authority                               | app tokens gain user-level powers                              |
| Aggregate counters (`reblogs_count`, `favourites_count`, `replies_count`) include interactions the viewer cannot see | Mastodon parity; clients rely on the counts                                        | counters must hide private interactions                        |
| Non-public media is readable by anyone who holds its unguessable URL                                                 | Clients and remote servers fetch media without credentials                         | authenticated media fetch becomes interoperable                |
| Service tokens are recognized by Access's claim shape (no email, empty `sub`, `common_name`)                         | The admin application's policy decides which identities reach it                   | the admin application admits mTLS or Access changes the claims |
| `constantTimeEqual` on main takes time that depends on the input length                                              | No content leak is known; `kopje/ops-tools` compares fixed-size digests            | `kopje/ops-tools` merges (then remove this row)                |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a Codex or human review checks the IDs listed for the change type above, plus
  anything this model is missing. The other lenses (correctness, design, tests) use their own criteria.
- **Tests** name the invariant in the test name or a comment where practical (for example `// VIS-4`), so `grep -rn
'VIS-4' packages/kopje/test` shows its coverage.
- This document covers security only. It is not a correctness or design checklist.
