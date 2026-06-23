# Repository Guidelines

## Project Compatibility

- This project is a Mastodon-compatible ActivityPub implementation. Avoid changes that break interoperability with Mastodon.

## Project Structure & Module Organization

- `packages/backend/` hosts the ActivityPub/Mastodon API and Workers code (TypeScript).
- `packages/frontend/` contains the Qwik UI, assets, and build adapters.
- `packages/consumer/` and `packages/do/` include queue/Durable Object handlers.
- `migrations/` and `schema.sql` define D1 schema evolution.
- `packages/frontend/e2e/` holds Playwright end-to-end specs.
- `docs/` contains deployment and operational guides.

## Build, Test, and Development Commands

- `pnpm install` installs root dependencies.
- `pnpm run build` installs frontend deps via pnpm and builds the UI bundles.
- `pnpm run dev` builds, applies local D1 migrations, and starts Pages dev server.
- `pnpm run database:create-mock` initializes a local D1 database with mock data.
- `pnpm run test` runs backend unit tests with Vitest.
- `npx playwright test` runs UI end-to-end tests in `packages/frontend/e2e/`.
- `pnpm run lint` and `pnpm run pretty` run ESLint and Prettier checks.

## Coding Style & Naming Conventions

- TypeScript is standard across `packages/backend/`, `packages/consumer/`, `packages/do/`, and `packages/frontend/`.
- Indentation follows tabs in existing source files; keep style consistent.
- Test files use `*.test.ts`; Playwright specs use `*.spec.ts`.
- Linting: ESLint (root and `packages/frontend/`), formatting: Prettier (`pnpm run pretty`).

## Testing Guidelines

- Unit tests live alongside backend routes and utilities (`packages/backend/**.test.ts`).
- UI E2E tests live in `packages/frontend/e2e/` and use Playwright.
- For UI tests, run `pnpm run database:create-mock` before starting the dev server.

## Commit & Pull Request Guidelines

- Commit subjects are short and imperative; follow patterns like "Update dependency <name>".
- PRs should explain the change, link relevant issues, and note testing performed.
- Include screenshots or short clips for UI-visible changes.

## Configuration & Security Notes

- Cloudflare bindings live in `wrangler.toml` (keep D1 binding name `DATABASE`).
- Required env vars: `USER_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`.
- See `docs/` for deployment, access policy, and troubleshooting details.
