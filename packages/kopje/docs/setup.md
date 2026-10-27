# Setting up a Kopje instance

A fresh Kopje Worker serves nothing under its domain until it is set up: federation paths and sign-in answer 503. The
`/setup` wizard sets it up from the browser. The config file (`wrangler.jsonc`) is the same for every install; the
values that belong to this instance (its domain, the Access applications and the admin) are kept in the Store.
`src/app/setup.tsx` implements the wizard.

## Before you start

The account needs the Workers Paid plan. The Free plan allows 10 ms of CPU time and 50 subrequests per request, which
signature checks on federated requests, the daily backup and media processing exceed.

Some things cannot be done from the wizard. Do these in the Cloudflare dashboard first. The wizard lists them too, at
`/setup/checklist`.

1. **Add the zone.** The instance domain must be on a zone of this account. Give the Worker a custom domain or a route
   on it. A `workers.dev` address cannot be used: Access cannot protect paths there, and the domain can never change.
2. **Create the Zero Trust organization.** Choose a team name and a plan. The Free plan is enough, but it asks for
   payment details. Add a login method; a one-time PIN is enough.
3. **Set the secrets** of the Worker:
    - `SETUP_TOKEN`: at least 32 random characters, for example `openssl rand -base64 33`. Only the wizard reads it.
    - `USER_KEK`: wraps the private keys of local accounts. Set it before the admin is created. To change it later,
      see [Rotating the KEK](#rotating-the-kek).
    - `VAPID_JWK`, optional: turns on Web Push. An EC P-256 private key as a JWK; the instance template's README shows
      how to make one. Kopje never makes or replaces it: without it, push notifications are unavailable, and replacing
      it once clients have subscribed breaks their subscriptions.
4. **Create an API token** for the Access step, with a short expiry (a day is plenty). The permissions it needs:

    | Permission                                                           | Why                                                      |
    | -------------------------------------------------------------------- | -------------------------------------------------------- |
    | Account, Access: Apps and Policies, Edit                             | Required: creates or updates the applications and policy |
    | Account, Access: Organizations, Identity Providers, and Groups, Read | Required: checks that the team is this account's         |
    | Account, Access: Service Tokens, Read                                | Only with a service token client ID                      |
    | Account, Account Settings, Read                                      | Only when you leave the account ID empty                 |
    | Zone, Zone, Read and Zone, Bot Management, Read                      | Only to let the Bot Fight Mode check read the setting    |

5. **Optional: a service token for the admin CLI** (`kopje-admin`, see [Running the admin CLI](#running-the-admin-cli)).
   Create it under Access, Service credentials, and keep its client ID for the Access step and its secret for the CLI.
6. **Images.** The account needs an Images plan. An account still on the legacy Image Resizing billing (from before
   Images and Image Resizing were merged in November 2023) has no Images binding, and the wizard's Images step fails
   with error 9432: move the account to an Images plan under Images in the dashboard. Images already stored in
   Cloudflare Images are billed under that plan, so check its pricing first. Images Paid is optional: without it the
   account includes 5,000 transformations a month, and an upload, avatar or header uses up to three (the full image,
   the preview and the preview's pixels its blurhash is computed from, which Images may bill as one with the preview);
   a custom emoji uses two. If you buy more, raise `IMAGES_MONTHLY_TRANSFORMS`.

   Link card images are off by default. To store them, set `IMAGES_CARD_MONTHLY_TRANSFORMS` (a plain-text variable)
   to the transformations they may start each UTC month: up to two each (one before the stored WebP, one before the
   pixels its blurhash is computed from; Images may bill the two as one transformation), counted when each starts, so a
   start whose output is refused still counts, and the month's stored images are at most that many. Cards never use
   `IMAGES_MONTHLY_TRANSFORMS`, so they cannot refuse an upload. Keep the sum of the two ceilings within what the
   account's Images allowance covers (4,000 + 1,000 = 5,000 on the free allowance), counting anything else in the
   account that transforms images. The images are stored in the media bucket (R2), whose storage and operations are
   billed apart from Images: at most 512 KiB an image, one write each, and one read per view.

   Remote accounts' avatars and headers, remote custom emoji, and remote posts' attachments are cached in the media
   bucket under `remote/` and served from the instance, so clients do not load them from other servers. Nothing needs
   setting: `REMOTE_MEDIA_CACHE_BYTES` (a plain-text variable, default 4294967296, 4 GiB) caps the bytes the cache
   keeps, files awaiting deletion included, and the oldest files are deleted to stay below it. 0 turns caching off:
   nothing new is cached, and what is cached stays. A positive value below 268435456 (256 MiB) is refused as a
   configuration error, as any invalid variable is: requests answer 503 and the cron's rounds do not run until it is
   fixed. A profile image is kept while its account shows it, and an emoji while a post or profile stored within 90 days
   names it. `MEDIA_CACHE_RETENTION_DAYS` (default 14) is how long a remote post's attachments are cached: those that
   arrived longer ago are not fetched, and a cached copy is deleted once stored longer; 0 keeps every one. It is also
   how far back the backfill takes remote posts' attachments and emoji. The cache uses no Images transformation: at most
   two R2 writes a file, one read per view, and the cron's own deletes, lists and heads.
7. **Turn off Bot Fight Mode** for the zone (Security, Bots). It challenges other servers, which breaks federation,
   and it cannot be skipped for some paths.

## Running the admin CLI

`kopje-admin` comes in the `kopje` package. Run the copy of the version your instance runs, in one of two ways:

- **In your instance's repository**, after `npm ci` (or `npm install`), through the template's `admin` script:

    ```sh
    npm run admin -- health
    ```

    The script runs `node node_modules/kopje/cli/kopje-admin.js`, the copy installed for the instance, by its path:
    without the install it fails, and it never runs another `kopje-admin` from your `PATH` or npm's cache.

- **Anywhere else** (for example in the empty directory of a restore), name the package and its version, the `kopje`
  version in your instance's `package.json`:

    ```sh
    npm exec --yes --package=kopje@<version> -- kopje-admin health
    ```

Do not run `npx kopje-admin` without the install: npm would look for a package named `kopje-admin`, which is not Kopje.
The CLI needs Node.js 22 or later and these variables: `KOPJE_ADMIN_URL` (the instance's https origin), and
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (the service token of step 5). `kopje-admin --help` lists the
commands. These docs write `kopje-admin <command>` for either form: in the instance's repository, read it as
`npm run admin -- <command>`.

### The Mastodon admin API's admin

Moderation clients (such as Fedilab) use the Mastodon admin API with a token of the admin: the one local account whose
email equals `admin_email`, compared trimmed and lowercased. `kopje-admin health` shows it as `oauthAdmin`. When its
`status` is `none` or `ambiguous`, give the right account that email (any other account with it, after trimming and
lowercasing, is refused):

```sh
kopje-admin account set-email <username> <email>
```

When its `status` is `suspended`, unsuspend it (its old tokens stay refused, so it signs in again):

```sh
kopje-admin account unsuspend <username>
```

`kopje-admin moderation-log` lists what the admin did through the API, and these repairs, newest first
(`--before <id>` continues the list).

## Running the wizard

Open `https://<your domain>/setup` and enter the setup token. The browser gets a setup session for an hour; the token
itself is not kept. Then go through the steps:

- **Step 1, domain.** Confirm the domain the page is on. It cannot be changed later, because actor ids are made from
  it.
- **Steps 2 and 3, Zero Trust and Access.** Enter the team name (the `team` of `team.cloudflareaccess.com`), the
  admin's email as Access will assert it, optionally the account ID and the service token's client ID, and the API
  token. Kopje checks that the team's key set answers and that the team is the account's Zero Trust organization,
  reads and checks everything it will change, and only then creates or updates:
    - a reusable policy `Kopje <domain> admin`, which allows the admin's email;
    - a reusable policy `Kopje <domain> admin CLI`, which admits the service token (only when its client ID is given);
    - an application `Kopje <domain> sign-in` for `<domain>/oauth/authorize`, with the admin policy;
    - an application `Kopje <domain> admin` for `<domain>/admin`, with both policies.

    Kopje remembers the ids of what it made, and a run again updates those objects, whatever they are called now. Without
    ids (the first run, or after a restore), it takes over an object of the expected name only if there is exactly one,
    an application protects the expected path, and a policy is not attached to other applications. Otherwise the step
    stops before changing anything and says why. Two recovery choices are on the form: take over the objects with
    Kopje's names whatever they are, or create new objects (delete the old ones in the dashboard afterwards).

    Only one run of this step happens at a time; a run that stops answering holds the step for two and a half minutes. A run that fails, or is interrupted, leaves the step "did not finish",
    and setup cannot finish until a run completes. If two people run it, only the latest completed run counts, and step
    7 must be done from that browser. The API token is used only for that request and is not stored, logged or shown.
    Delete it once the step has passed.

- **Step 4, Images.** Transforms a 1x1 image through the Images binding. Images bills the same transformation once a
  month, so Kopje charges it to the month's budget once, however often you check.
- **Step 5, Queue and cron.** Sends a probe message through the Queue and shows when the consumer received it. Reload
  the page after a few seconds. The cron's last run is shown too; it runs every 5 minutes.
- **Step 6, Bot Fight Mode.** A warning, and the setting itself if you give a token that can read it. Kopje reports
  "off" only when the answer shows it: Bot Fight Mode, Super Bot Fight Mode and a configuration left over from a plan
  change are all read.
- **Step 7, the admin.** A username and the email Access admits. This writes the domain, the Access configuration and
  the admin account in one step, and ends every setup session.

Checks show pass, warning or fail, with a hint on what to fix. Each can be run again. Steps 4 to 6 do not block step 7.

## After setup

- Remove the `SETUP_TOKEN` secret. It no longer opens anything: once the domain and the admin exist, the wizard refuses
  the token.
- `/setup` then shows a status page to the admin only. Sign in to the web UI as the admin and open `/setup` to run
  the checks again, or to update the Access applications with a new API token (for example after adding the CLI's
  service token). The domain and the admin cannot be changed there.
- If the sign-in application is gone, the admin cannot sign in to do that. Recreate it in the dashboard and set its AUD
  tag with `kopje-admin config access_aud=<tag>`, which goes through the `/admin` application.

- Optionally, turn on Early Hints for the zone (Speed, Settings, Content Optimization). The pages name their
  stylesheet in a `Link: rel=preload` header. Cloudflare sends Early Hints from hints it has cached from earlier
  answers of the same page, so a browser may fetch the stylesheet while a later request for that page is made.
- Set up the daily backup: see [backup.md](backup.md).
- Kopje's log events are kept in Workers Logs for 7 days; invocation logs and traces are off. Where to read them, the
  events to act on, what they cost and what they record: [observability.md](observability.md).
- Before the first update, read [upgrade.md](upgrade.md): how updates arrive, what the Store does on a new version,
  and how to roll back.

## Adding accounts

Setup makes one account, the admin's. Anyone else gets an account by invitation, and only by it: Kopje has no
sign-up form, and `POST /api/v1/accounts` stays closed. Two things let a person in, and both are needed:

1. **An invitation**, the email Access will assert for them and the username their account takes (1 to 30 letters,
   digits or underscores):

    ```sh
    kopje-admin invitation add <email> <username>
    ```

    An email or a username that a local account or another invitation already has is refused, compared ignoring ASCII
    case only, as sign-in compares emails; at most 10 invitations are pending. `kopje-admin invitation` lists them, and
    `kopje-admin invitation remove <email>` withdraws one. Each is logged in the moderation log.

2. **Access to the sign-in application.** Setup gives `Kopje <domain> sign-in` only the admin policy. In the Zero
   Trust dashboard, add a policy of your own to that application that allows the person's email. Do not add them to
   `Kopje <domain> admin`: that policy also opens `/admin`. Running the Access step of `/setup` again sets the
   application's policies back to the admin policy alone, so add yours again after it.

The person then signs in from any app or the web UI. Their first sign-in makes the account and ends the invitation;
later sign-ins use the account. Removing an invitation, or the Access policy, never deletes an account that exists:
suspend it through the Mastodon admin API instead. Invitations are data, so a backup carries them and a restore
brings them back.

## Instance details

The instance's public settings are data, not configuration: a dump carries them, an import brings them in, and a
reset (`import-reset`, `cutover reset`) removes them. A Store that holds any is not empty, so an import into it is
refused: after a cutover, set them once the import is published. Only the Access admin sets them, through `/admin`:

```sh
kopje-admin instance                                   # show them, with the documents' stamps
kopje-admin instance title='Our herd' description='A small server' contact_email=admin@example.com
kopje-admin instance contact_username=alice            # or bob@example.com: an account Kopje knows
kopje-admin instance privacy_policy --file privacy.html
kopje-admin instance terms_of_service --file terms.html terms_of_service_effective_date=2026-11-01
kopje-admin instance show_domain_blocks=users show_domain_blocks_rationale=disabled
kopje-admin instance description=                      # an empty value removes it
```

Trends are worked out every 5 minutes from stored posts (docs/mastodon-deviations.md MD-5). Nothing trends until the
Access admin approves it, unless `trendable_by_default=true` (which links never take):

```sh
kopje-admin trends                                     # what trends now, approved or not, with each one's review
kopje-admin trends approve-tag cats                    # or reject-tag
kopje-admin trends approve <post id> --author          # or reject; --author decides for the author's posts
kopje-admin trends approve-link https://news.example/a --publisher  # or reject-link; --publisher decides for its site
kopje-admin trends approve-publisher news.example      # or reject-publisher: the domain and its subdomains
kopje-admin instance trends=false                      # turn trends off (the lists answer [])
kopje-admin instance activity_api_enabled=false        # turn the weekly activity off (it answers 404)
```

| Name                                                 | Bound                                 | Shown by                                                 |
| ---------------------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `title`                                              | 1,024 code points                     | `/api/v1/instance`, `/api/v2/instance`, `/about`         |
| `description`                                        | 200 code points (Mastodon's limit)    | the same                                                 |
| `contact_email`                                      | an email address, 254 UTF-8 bytes     | the same                                                 |
| `contact_username`                                   | an account's address, 509 UTF-8 bytes | `contact_account` (v1), `contact.account` (v2)           |
| `extended_description`                               | HTML, 50,000 UTF-8 bytes              | `/api/v1/instance/extended_description`, `/about`        |
| `privacy_policy`                                     | HTML, 50,000 UTF-8 bytes              | `/api/v1/instance/privacy_policy`, `/privacy-policy`     |
| `terms_of_service`                                   | HTML, 50,000 UTF-8 bytes              | `/api/v1/instance/terms_of_service`, `/terms-of-service` |
| `terms_of_service_effective_date`                    | a date, `YYYY-MM-DD`                  | the same                                                 |
| `show_domain_blocks`, `show_domain_blocks_rationale` | `disabled`, `users` or `all`          | `/api/v1/instance/domain_blocks`                         |
| `trends`                                             | `true` (default) or `false`           | `/api/v1/trends/tags` and `/statuses` (off: `[]`)        |
| `trendable_by_default`                               | `true` or `false` (default)           | the same: unreviewed hashtags and posts trend when true  |
| `activity_api_enabled`                               | `true` (default) or `false`           | `/api/v1/instance/activity` (off: 404)                   |

- Values are trimmed of spaces, tabs, line feeds, vertical tabs, form feeds and carriage returns; a blank value is
  refused (send an empty value to remove one). The whole request is refused if any value is.
- `contact_username` takes `user` or `user@domain`, with an optional leading `@`; the instance's own domain names a
  local account. The account must exist: Kopje stores its address as the account holds it (`Alice` for `alice`), and
  shows the account presented as `GET /api/v1/accounts/:id` shows it (redacted while unavailable, none once deleted).
- Documents are HTML, sanitized when served: convert Markdown to HTML first. Headings are kept (as h2 to h4, under the
  page's own title). Links must be absolute `https://` (or `http://`) URLs: a relative one (`/about`,
  `privacy.html`) is dropped and its text stays plain (threat model HTML-3). A document that sanitizes to no text is
  refused. `--file` sends the file's text and the other values in one request.
- The terms of service and their effective date are set together: a first `terms_of_service` needs
  `terms_of_service_effective_date` in the same request; later either may change alone; the date cannot be removed
  while the text stays; removing `terms_of_service` removes its date. They are served as soon as they are set, a
  future date included (as Mastodon serves an upcoming version); `effective` becomes true on the day after the
  effective date (UTC). `/terms-of-service/<date>` answers only that date.
- A changed `extended_description` or `privacy_policy` is stamped with the time of the change (`updated_at`); the same
  value sent again changes nothing. Each change is logged in the moderation log (`update_setting`, `remove_setting`)
  without its value.
- `show_domain_blocks` lists the instance's suspend blocks at `/api/v1/instance/domain_blocks`: to anyone at `all`,
  to signed-in users at `users`, to no one at `disabled` (the default). `show_domain_blocks_rationale` shows their
  public comments by the same rule. A block with `obfuscate` set is listed with part of its domain replaced by `*`.

## Rotating the KEK

`USER_KEK` wraps the private key of every local account and of the instance actor. `kopje-admin keys rewrap` moves
them to a new KEK: each key is unwrapped with the previous KEK and wrapped again with the new one. The keys themselves
do not change, so other servers see nothing and signatures made before still verify. Rotate when the KEK is empty (an
instance whose keys came over from Wildebeest under the empty KEK, where `kopje-admin health` warns `USER_KEK is empty`),
or when the KEK may have leaked.

Signing uses `USER_KEK` only. From the moment it changes until the rewrap has run, keys still under the previous KEK
cannot sign: deliveries fail and wait for their next attempt (each failed attempt counts toward the 15 a delivery has),
inbox requests that need a signed fetch to check their signature answer 503 for the sender to retry, and searches that
resolve remote accounts fail. Actor documents keep serving, from the stored public keys, and Web Push does not use the
KEK. The steps below hold outgoing work with the `MAINTENANCE` variable for those minutes.

1. **Make a new KEK** and keep a copy somewhere safe:

    ```sh
    openssl rand -base64 32
    ```

2. **Set the variables** on the Worker (dashboard: Settings, Variables and Secrets), together in one deployment:
    - `MAINTENANCE=readonly`, as a plain-text variable: deliveries and the cron pause and the inbox spools, so no
      attempt is spent while keys cannot sign. Reads and sign-ins still work; writes answer 503. Use the variable, not
      `kopje-admin maintenance on`: the Store's own maintenance refuses the rewrap's writes.
    - `USER_KEK_PREVIOUS`, a secret: the current KEK. Leave it unset when the current KEK is empty (`USER_KEK` unset or
      empty): unset reads as the empty KEK.
    - `USER_KEK`: the new KEK.

3. **Wait for the new version.** A deployment reaches the Worker first and the Store a little later, up to about a
   minute. A rewrap run before both run it meets the previous version:
    - a previous Worker still reads the previous variables. It answers `kek-empty` when the previous KEK was empty. When
      it was not, it counts every key as already under `USER_KEK` and moves none, so the rewrap looks done when it is
      not.
    - a new Worker in front of a previous Store gets `version-mismatch`.

    `kopje-admin health` shows when the new version is everywhere: the `store` check's `build` equals the report's
    `build`, and the `keys` check fails with `unwrap-failed`, because the keys are still under the previous KEK, rather
    than passing or warning `USER_KEK is empty`.

4. **Rewrap the keys:**

    ```sh
    kopje-admin keys rewrap
    ```

    It works through the keys a page at a time and prints how many were rewrapped, how many were already under
    `USER_KEK`, and the keys it could not move, by owner, with a reason: `changed` (the key changed while it ran; run
    the command again), `unwrap-failed` (neither KEK unwraps it: check `USER_KEK_PREVIOUS`), `pubkey-mismatch` (it
    unwraps, but does not match its account's public key) or `recheck-failed` (the rewrapped key did not pass its check
    and was not written). It exits 3 when any key failed. A key it could not move is left as it was. Running it again
    is safe: keys already under `USER_KEK` are skipped. It refuses to run while `USER_KEK` is empty or equals
    `USER_KEK_PREVIOUS`.

5. **Check** with `kopje-admin health`: the `keys` check passes with no failures and no `USER_KEK is empty` warning.
6. **Remove `MAINTENANCE`** (or set it to `off`) and **remove `USER_KEK_PREVIOUS`**. Deliveries resume and spooled
   inbox activities are replayed.
7. **Deal with what was saved before.** Backups, `kopje-admin dump` files and cutover exports made before the rotation
   hold the keys under the previous KEK, and the rotation cannot change them. Delete them, or accept that they protect
   the keys only as well as the previous KEK did (not at all, when it was empty). Backups taken afterwards hold the keys
   under the new KEK.

## Things to check on a real account

The wizard was tested against a fake of the Cloudflare API. Confirmed on a verification instance:

- `GET /accounts/{id}/access/organizations` returns `auth_domain` as `<team>.cloudflareaccess.com`.
- Reusable policies report `app_count`, and applications list their policies with ids.
- The application listing filters by `name` with `exact=true`, and listings accept `per_page=50`.
- An Access application for `<domain>/admin` covers every path under `/admin/`, and the sign-in application covers
  `/oauth/authorize`: without a session both redirect to the Access login.
- The Images binding transforms on an account with the free Images plan (without Images Paid). An account on the legacy
  Image Resizing billing gets error 9432 instead (step 6 of [Before you start](#before-you-start)).
- A browser posts the wizard's and the web UI's forms with their `Origin`. The pages send `Referrer-Policy:
same-origin`, because under `no-referrer` browsers send `Origin: null` on these same-origin posts.

Still to confirm:

- `GET /accounts` lists the account for a token with only account-scoped permissions (Account Settings, Read), when the
  account ID is left empty. On the verification instance the lookup did not find exactly one account, and the account
  ID was entered instead. The wizard now says whether the token reached no account or several.
- Still images of animated uploads (a release gate: the local Images binding decodes one frame only and ignores
  `anim`, so tests stand in for the real output). On the verification instance, upload as the avatar, then as the
  header, a 2-frame GIF, a 2-frame animated WebP, a 2-frame APNG and a still PNG (8 uploads, 24 transformations). For
  each, fetch `avatar` and `avatar_static` (`header` and `header_static`) and count the frames of the served bytes
  (WebP: the `ANMF` chunks, or 1 without the `VP8X` animation flag; PNG: `acTL`'s frame count, or 1 without it):
  - GIF and animated WebP: `avatar` has at least 2 frames, `avatar_static` exactly 1, and the URLs differ (`/full.` and
    `/small.`).
  - Still PNG and APNG: the upload answers 200, `avatar` has exactly 1 frame, and `avatar_static` equals `avatar`.
  - A GIF attached to a status: its `preview_url` has exactly 1 frame.

  An upload that answers 500 with `kopje.media.transform_failed` in the log blocks the release: the detail `output is
  animated` for an animated upload, or `images 9401` for a PNG.
