# Kopje

A Mastodon-compatible ActivityPub server for one person or a small group (up to about ten local accounts), running as
one Cloudflare Worker and one SQLite-backed Durable Object on your own Cloudflare account. It is a spiritual successor
of cloudflare/wildebeest and is not affiliated with or endorsed by Cloudflare, Inc.

## Running an instance

Do not install this package by hand: start from the instance template, which has the Deploy to Cloudflare button, the
`wrangler.jsonc` every instance uses, and the update setup. See
[deploy/README.md](https://github.com/shuymn/wildebeest/tree/main/deploy).

- [docs/setup.md](docs/setup.md): the `/setup` wizard
- [docs/upgrade.md](docs/upgrade.md): updates and rollback
- [docs/backup.md](docs/backup.md): the daily encrypted backup
- [docs/observability.md](docs/observability.md): logs and traces, what they cost and what they record
- [docs/cutover-runbook.md](docs/cutover-runbook.md): moving a legacy Wildebeest instance to Kopje
  ([docs/cutover.md](docs/cutover.md): the conversion)
- [CHANGELOG.md](CHANGELOG.md): release notes

## What the package contains

| Path or export                | What                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kopje` (`dist/worker.js`)    | The Worker, bundled and minified: the default export has `fetch`, `queue` and `scheduled`, and `Store` is the Durable Object class. It has no runtime dependencies |
| `dist/*.sql`                  | The Store's schema migrations, imported by the bundle as text modules (the `**/*.sql` Text rule in `wrangler.jsonc`)                                               |
| `kopje/public/*`              | The static assets the Worker serves through the `ASSETS` binding                                                                                                   |
| `kopje/migrations/*`          | The same migrations as SQL files, for reference                                                                                                                    |
| `kopje-admin`                 | The operations CLI (Node.js 22 or later). See [docs/setup.md](docs/setup.md#running-the-admin-cli)                                                                 |
| `dist/maintenance-*.js`       | The cutover's maintenance worker and the code `kopje-admin` renders its snapshot and converts with ([docs/cutover-runbook.md](docs/cutover-runbook.md))            |
| `dist/THIRD_PARTY_NOTICES.md` | The licenses of the packages bundled into `dist/worker.js` (the maintenance bundles hold a subset of them)                                                         |

The bundle is built with wrangler from the source in the
[repository](https://github.com/shuymn/wildebeest/tree/main/packages/kopje); an instance's `wrangler deploy` bundles it
once more with its own entry module.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
