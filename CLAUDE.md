# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Wildebeest is an ActivityPub and Mastodon-compatible Fediverse server that runs on Cloudflare's infrastructure (Workers, Pages, D1, Durable Objects, Queues). This is a fork of cloudflare/wildebeest.

## Commands

```bash
# Install dependencies
pnpm install

# Run backend unit tests (Vitest with miniflare)
pnpm test

# Run a single test file
pnpm vitest run backend/src/path/to/file.test.ts

# Run UI E2E tests (Playwright)
pnpm run database:create-mock  # initialize local test database first
pnpm run test:ui

# Lint all code
pnpm run lint

# Check formatting
pnpm run pretty

# Local development
pnpm run database:create-mock  # initialize local test database
pnpm run dev

# Watch frontend changes (run in separate terminal)
pnpm --prefix frontend run watch

# Deploy to Cloudflare Pages
pnpm run deploy
```

## Architecture

### Monorepo Structure

- **`/backend`** - Hono-based REST API and ActivityPub server (Cloudflare Workers)
- **`/frontend`** - Qwik SSR web interface (Cloudflare Pages)
- **`/consumer`** - Queue consumer for async ActivityPub delivery
- **`/do`** - Durable Objects for stateful operations

### Backend (`/backend/src`)

- **`/routes`** - File-based HTTP routing (auto-mounted by Hono)
  - `/api/v1/*`, `/api/v2/*` - Mastodon REST API compatibility
  - `/ap/*` - ActivityPub protocol endpoints
  - `/.well-known/*` - WebFinger, NodeInfo
  - `/oauth/*` - Authentication
- **`/activitypub`** - ActivityPub protocol implementation
- **`/mastodon`** - Mastodon API compatibility layer
- **`/accounts`** - User account management
- **`/database`** - D1 database abstraction with sqlc-generated queries
- **`/middleware`** - Request processing (CORS, auth, errors)

### Frontend (`/frontend/src`)

- **`/routes`** - Qwik page routes
- **`/components`** - Reusable UI components
- Built with Vite and styled with Tailwind CSS

### Database

- SQLite via Cloudflare D1
- Schema: `/schema.sql`
- Migrations: `/migrations/*.sql`
- Query generation: sqlc with ts-d1 plugin (`/backend/src/database/sql/`)

## Code Style

- TypeScript strict mode enabled
- Tabs for indentation, 120 char line width
- Single quotes, no semicolons, trailing commas
- Alphabetical import ordering (ESLint enforced)
- Use environment variables from bindings, never hardcode values

## Testing

- Backend: Vitest with miniflare environment simulating Cloudflare Workers
- Frontend E2E: Playwright (Chromium, Firefox, WebKit)
- Test helpers: `/backend/test/utils.ts`
