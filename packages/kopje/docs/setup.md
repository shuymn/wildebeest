# Setting up a Kopje instance

A fresh Kopje Worker serves nothing under its domain until it is set up: federation paths and sign-in answer 503. The
`/setup` wizard sets it up from the browser. The config file (`wrangler.jsonc`) is the same for every install; the
values that belong to this instance (its domain, the Access applications and the admin) are kept in the Store.
`src/app/setup.tsx` implements the wizard.

## Before you start

Some things cannot be done from the wizard. Do these in the Cloudflare dashboard first. The wizard lists them too, at
`/setup/checklist`.

1. **Add the zone.** The instance domain must be on a zone of this account. Give the Worker a custom domain or a route
   on it. A `workers.dev` address cannot be used: Access cannot protect paths there, and the domain can never change.
2. **Create the Zero Trust organization.** Choose a team name and a plan. The Free plan is enough, but it asks for
   payment details. Add a login method; a one-time PIN is enough.
3. **Set the secrets** of the Worker:
    - `SETUP_TOKEN`: at least 32 random characters, for example `openssl rand -base64 33`. Only the wizard reads it.
    - `USER_KEK`: wraps the private keys of local accounts. Set it before the admin is created.
4. **Create an API token** for the Access step, with a short expiry (a day is plenty). The permissions it needs:

    | Permission                                                           | Why                                                      |
    | -------------------------------------------------------------------- | -------------------------------------------------------- |
    | Account, Access: Apps and Policies, Edit                             | Required: creates or updates the applications and policy |
    | Account, Access: Organizations, Identity Providers, and Groups, Read | Required: checks that the team is this account's         |
    | Account, Access: Service Tokens, Read                                | Only with a service token client ID                      |
    | Account, Account Settings, Read                                      | Only when you leave the account ID empty                 |
    | Zone, Zone, Read and Zone, Bot Management, Read                      | Only to let the Bot Fight Mode check read the setting    |

5. **Optional: a service token for the admin CLI** (`kopje-admin`). Create it under Access, Service credentials, and
   keep its client ID for the Access step and its secret for the CLI.
6. **Optional: Images Paid.** Without it the account includes 5,000 Images transformations a month; an upload uses
   two. If you buy more, raise `IMAGES_MONTHLY_TRANSFORMS`.
7. **Turn off Bot Fight Mode** for the zone (Security, Bots). It challenges other servers, which breaks federation,
   and it cannot be skipped for some paths.

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

    Only one run of this step happens at a time. A run that fails, or is interrupted, leaves the step "did not finish",
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

- Set up the daily backup: see [backup.md](backup.md).

## Things to check on a real account

The wizard was tested against a fake of the Cloudflare API. These points are confirmed on the verification instance:

- `GET /accounts` lists the account for a token with only account-scoped permissions (Account Settings, Read).
- `GET /accounts/{id}/access/organizations` returns `auth_domain` as `<team>.cloudflareaccess.com`.
- Reusable policies report `app_count`, and applications list their policies with ids.
- The application listing filters by `name` with `exact=true`, and listings accept `per_page=50`.
- An Access application for `<domain>/admin` covers every path under `/admin/`.
- The Images binding transforms on an account without Images Paid.
