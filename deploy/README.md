# Kopje instance

A [Kopje](https://github.com/shuymn/wildebeest/tree/main/packages/kopje) instance: a Mastodon-compatible ActivityPub
server for one person or a small group, running as one Cloudflare Worker with one Durable Object on your own Cloudflare
account.

This repository holds only the instance's configuration. The server is the [`kopje`](https://www.npmjs.com/package/kopje)
npm package, pinned in `package.json`; `src/index.ts` re-exports it. `wrangler.jsonc` is the same for every install:
your domain, your Access applications and your admin account are kept in the instance's Store and set in the browser,
through the `/setup` wizard.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuymn/wildebeest/tree/main/deploy)

## Before you deploy

Read [setup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/setup.md), "Before you start". You
need the Workers Paid plan, a zone on the account for the instance's domain, and a Zero Trust organization. Kopje
cannot run on a `workers.dev` address.

## Deploy with the button

The button copies this directory into a new repository on your GitHub or GitLab account, connects it to Workers
Builds, and deploys it. On its form:

- **Resources.** It creates the Worker, the Store's Durable Object namespace, the Queue (`my-kopje-queue`) and the R2
  bucket (`my-kopje-media`). Change their names if your account already uses them. The Queue's dead-letter queue keeps
  the messages that exhaust their retries. The form does not rename it: it is created as `my-kopje-queue-dlq` whatever
  you call the Queue. For a second Kopje in the same account, give it its own: in the new repository's
  `wrangler.jsonc`, change `dead_letter_queue` to a new name, create that queue with
  `npx wrangler queues create <name>`, and change the two rate-limit `namespace_id`s too. The rate limits, Images and
  the static assets need no resource of their own.
- **Secrets.** It asks for the two secrets in `.dev.vars.example`:
    - `SETUP_TOKEN`: at least 32 random characters, for example from `openssl rand -base64 33`. It opens the `/setup`
      wizard. Remove it once setup is finished.
    - `USER_KEK`: a long random value, for example from `openssl rand -base64 33`. It wraps the private keys of local
      accounts. Keep a copy somewhere safe: keys wrapped with it cannot be read with any other value.
- **Build and deploy commands.** Leave the build command empty and the deploy command `npm run deploy`
  (`wrangler deploy`). `wrangler deploy` copies the static assets from the installed package first (`scripts/assets.mjs`).

Then attach your domain to the Worker (Settings, Domains & Routes, as a custom domain or a route on your zone), open
`https://example.com/setup` (your domain), and follow [setup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/setup.md).

## Settings after setup

Set these on the Worker in the dashboard (Settings, Variables and Secrets) or with `npx wrangler secret put <NAME>`.
`wrangler.jsonc` keeps variables set in the dashboard across deploys (`keep_vars`).

| Name                                                             | Kind     | What for                                                                                                                                                                        |
| ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                                                    | secret   | Remove it after setup                                                                                                                                                           |
| `USER_KEK`                                                       | secret   | Set before the admin is created; change it only as [setup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/setup.md), "Rotating the KEK", says            |
| `VAPID_JWK`                                                      | secret   | Optional, turns on Web Push: an EC P-256 private key as a JWK (below). Never replace it once clients have subscribed                                                            |
| `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET` | variable | The daily encrypted backup. See [backup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/backup.md) for these and the optional `BACKUP_*` settings        |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`         | secret   | The backup storage's credentials                                                                                                                                                |
| `IMAGES_MONTHLY_TRANSFORMS`                                      | variable | Optional: raise it if you buy more Images transformations ([setup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/setup.md), "Before you start", step 6) |
| `MAINTENANCE`                                                    | variable | `off` (the default), `readonly` or `full`. Used for a rollback ([upgrade.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/upgrade.md))                    |

A key for `VAPID_JWK` can be made with Node.js:

```sh
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))"
```

## The admin CLI

After `npm ci`, `npm run admin -- <command>` runs the `kopje-admin` CLI of the installed `kopje` version, for example
`npm run admin -- health`. See
[setup.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/setup.md#running-the-admin-cli) for the
service token and the variables it needs.

## Updates

The `kopje` version in `package.json` is the instance's version. To keep it updated, install the
[Renovate](https://github.com/apps/renovate) app on this repository: `renovate.json` makes it open a pull request for each
new Kopje version, never merged automatically. Merging the pull request deploys the new version, and the Store upgrades its
schema by itself. Read [upgrade.md](https://github.com/shuymn/wildebeest/blob/main/packages/kopje/docs/upgrade.md)
before your first update: it explains what happens and how to roll back.

To use Dependabot instead, add `.github/dependabot.yml`:

```yaml
version: 2
updates:
    - package-ecosystem: npm
      directory: /
      schedule:
          interval: weekly
      allow:
          - dependency-name: kopje
          - dependency-name: wrangler
```

Use only one of the two.

## Without the button

Make a repository from this directory yourself (copy it, or download it from the `deploy/` directory of
[shuymn/wildebeest](https://github.com/shuymn/wildebeest)), then create the resources the button would create:

```sh
npm install
npx wrangler login
npx wrangler queues create my-kopje-queue
npx wrangler queues create my-kopje-queue-dlq
npx wrangler r2 bucket create my-kopje-media
npx wrangler deploy
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put USER_KEK
```

`wrangler deploy` creates the Worker and the Store's Durable Object namespace. Commit the `package-lock.json` that
`npm install` wrote. Then deploy every change in one of two ways:

- **Workers Builds.** In the dashboard, open the Worker, then Settings, Build, and connect the repository. Keep the
  root directory `/` (or the directory you copied this template to), the build command empty and the deploy command
  `npx wrangler deploy`. Every push to the production branch deploys.
- **GitHub Actions.** Copy `ci/github-actions-deploy.yml` to `.github/workflows/deploy.yml`, and add two repository
  secrets: `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`, an API token made from the "Edit Cloudflare Workers"
  template with the permission Account, Queues, Edit added. Every push to `main` deploys.

Use one of the two, not both.

## License

Apache-2.0, as Kopje. See [LICENSE](https://github.com/shuymn/wildebeest/blob/main/LICENSE).
