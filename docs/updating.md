[Index](../README.md) ┊ [Back](supported-clients.md) ┊ [Other Cloudflare services](other-services.md)

## Updating Wildebeest

The deployment workflow runs automatically every time the main branch changes, so updating the Wildebeest is as easy as synchronizing the upstream official repository with the fork. You don't even need to use git commands for that; GitHub provides a convenient **_Sync fork_** button in the UI that you can simply click.

![configuration screen](https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/92ddc9f2-789b-454d-f6ca-2e9011613900/w=500)

Once your fork is synchronized with the official repo, the GitHub Actions workflow is triggered and a new build will be deployed.

### How updates are applied

On every sync, the deploy runs database migrations first (`wrangler d1 migrations apply`), then deploys the new code. D1 tracks which migrations a database has already applied, so a sync only runs the **pending** ones, **in order** — your data is preserved across schema changes; the database is never destroyed and recreated.

Most changes are additive (new column / new table) and are completely transparent. **Some releases also include cleanup steps that drop an old column or table** once its data has been migrated into the new shape. These are not silent data loss: each destructive step is preceded, in the same ordered run, by the backfill that moves the data, and is gated by a guard that **aborts the deploy** if that backfill is incomplete (a failed deploy you can retry, never a corrupted database).

### Updating after falling behind ("version jumps")

You can safely sync even if you are many releases behind — D1 applies **all** pending migrations in order in one pass, so every intermediate step still runs. Because migrations apply *before* the new code finishes deploying, a large jump may show **a few minutes of errors** while the deploy completes; this clears on its own and **does not lose data**. No manual migration steps are required of you.

> Maintainers of a fork: **never squash or delete old migration files.** The complete, append-only history in `migrations/` is what lets any instance — however far behind — replay every step. Add new migrations; never rewrite old ones.

![first login](https://imagedelivery.net/NkfPDviynOyTAOI79ar_GQ/51a4767c-5d3d-4075-d17d-b8112432ca00/w=850)

[Index](../README.md) ┊ [Back](supported-clients.md) ┊ [Other Cloudflare services](other-services.md)
