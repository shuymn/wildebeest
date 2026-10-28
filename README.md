# Kopje

![A klipspringer on a granite kopje at sunset](.github/assets/kopje-hero.jpg)

Kopje is a Mastodon-compatible [ActivityPub](https://www.w3.org/TR/activitypub/) server for one person or a small group
(up to about ten local accounts). It runs as one Cloudflare Worker and one SQLite-backed Durable Object on your own
Cloudflare account, works with Mastodon clients, and keeps a daily encrypted backup.

Kopje is a spiritual successor of [cloudflare/wildebeest](https://github.com/cloudflare/wildebeest). It is not
affiliated with or endorsed by Cloudflare, Inc.; Cloudflare and Cloudflare Workers are trademarks of Cloudflare, Inc.

## Status

Kopje is pre-1.0: a minor version may break. See the [CHANGELOG](packages/kopje/CHANGELOG.md).

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuymn/kopje/tree/main/deploy)

Read [Before you deploy](deploy/README.md#before-you-deploy) in the instance template first.

## Docs

- [Setup](packages/kopje/docs/setup.md): the `/setup` wizard
- [Upgrade](packages/kopje/docs/upgrade.md): updates and rollback
- [Backup](packages/kopje/docs/backup.md): the daily encrypted backup
- [Observability](packages/kopje/docs/observability.md): logs and traces
- [Mastodon deviations](packages/kopje/docs/mastodon-deviations.md): where Kopje departs from the Mastodon API
- [Cutover runbook](packages/kopje/docs/cutover-runbook.md): coming from a Wildebeest instance

## Development

The layout, commands and rules are in [AGENTS.md](AGENTS.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
