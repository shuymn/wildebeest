# Repository Guidelines

Kopje is a Mastodon-compatible ActivityPub server for one person or a small group. It runs as one Cloudflare Worker and
one SQLite-backed Durable Object on the operator's own Cloudflare account. It is a spiritual successor of
cloudflare/wildebeest and is not affiliated with Cloudflare; the product is named Kopje, and the repository keeps the
wildebeest name.

The code is in `packages/kopje`, and `deploy/` is the instance template operators deploy. The legacy Wildebeest packages
(`packages/backend`, `packages/frontend`, `packages/consumer`, `packages/do`) and the root `migrations/`, `schema.sql`
and `wrangler.toml` are kept for the move from legacy Wildebeest and will be removed. Do not build new work on them.

## Layout of `packages/kopje`

- `src/worker.ts` is the Worker entry (`fetch`, `queue`, `scheduled`), and `src/store.ts` is the Store Durable Object.
- `src/mastodon/` serves the Mastodon API, `src/federation/` ActivityPub, `src/web/` the public pages, and `src/app/`
  the admin, setup and OAuth pages. `src/domain/` holds the domain logic and its SQL, `src/jobs/` the queue and cron
  work, and `src/platform/` and `src/security/` the shared infrastructure.
- `migrations/` holds the Store's migrations, registered in `src/db/migrations.ts`. A released migration is never
  changed; add a new one. A migration never recreates a parent table, because that cascades deletes into its child
  tables.
- `cli/` is the `kopje-admin` operations CLI.
- `test/` runs in workerd (`vitest.config.ts`, plus `vitest.streaming.config.ts` for `test/streaming/`), and `test-node/`
  runs in Node (`vitest.node.config.ts`), including the checks that read the source tree and the docs.
- `docs/` is the design and operator documentation.

## Commands

- `mise install` installs the pinned tools the hooks use, and `pnpm install` installs the workspace.
- `pnpm --filter kopje test` runs all three suites. For one file, run
  `pnpm --filter kopje exec vitest run test/<name>.test.ts`, adding `-c vitest.node.config.ts` for a file in
  `test-node/` or `-c vitest.streaming.config.ts` for a file in `test/streaming/`.
- `pnpm --filter kopje typecheck` and `pnpm --filter kopje lint` check types and ESLint, and `pnpm run pretty` checks
  formatting.
- `pnpm --filter kopje build` builds the assets and the package.
- `pnpm --filter kopje bench:migration` measures migration cost locally (see `packages/kopje/RELEASING.md`).

lefthook runs lint, formatting and a secret scan on commit, and the affected test suites on push
(`scripts/test-affected.sh`; a change that is all Markdown runs only the suites that read it). Running
`bash scripts/test-affected.sh` on a clean tree records the pass, and the push then skips that tree; its whole output
is in `test-affected.log` in the Git directory.

## Rules

Paths in this section are under `packages/kopje/`.

- **Mastodon compatibility.** Kopje follows the Mastodon API as the release named in `docs/mastodon-deviations.md`
  serves it, and that page lists every accepted departure.
- **Visibility.** Who may see what, and who is addressed, is decided in `src/domain/audience.ts`
  (`docs/visibility.md`).
- **Security.** Changes keep the invariants in `docs/threat-model.md`.
- **Engineering.** Code and tests follow `docs/engineering.md`: fences, rounds, bounds, stored values, queries and
  concurrency tests.
- **Public pages.** `docs/web-pages.md`.
- **Changelog and releases.** `RELEASING.md`.
- **Style.** Prettier (tabs, 120 columns, single quotes, no semicolons) and ESLint, including alphabetical import
  order.

## Commits and pull requests

- Commit subjects use Conventional Commits with a scope, for example `feat(kopje): ...` or `fix(kopje): ...`.
- A pull request explains what changed, why, and how it was verified, and names what was not run. It lists the
  `packages/kopje/docs/threat-model.md` invariant IDs it touches. UI-visible changes include screenshots.
