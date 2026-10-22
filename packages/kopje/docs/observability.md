# Kopje's logs and traces

A Kopje instance keeps its logs in Cloudflare Workers Logs, on the instance's own Cloudflare account. This page says
what is turned on, where to read it, what it costs and what it records. Traces are off unless you turn them on
([Traces](#traces-off-unless-you-opt-in)).

## What is on

The template's `wrangler.jsonc` (the same as the package's own) sets:

```jsonc
"observability": {
	"enabled": true,
	"redact_query_string": true,
	"logs": { "enabled": true, "invocation_logs": true, "head_sampling_rate": 1 },
	"traces": { "enabled": false, "head_sampling_rate": 1 },
}
```

- **Kopje's events.** Every `console` entry the Worker and the Store write is kept: one structured object per event,
  named in its `event` field (`kopje.<area>.<what>`). What an event may contain is threat-model rule DATA-5
  ([threat-model.md](threat-model.md)).
- **Invocation logs.** One entry per invocation, written by the platform: for an HTTP request its method, URL, status
  and duration, and one for each Store (Durable Object) invocation, cron tick and Queue batch with its outcome.
- **`redact_query_string`** asks the platform to remove the query string from request URLs in logs and traces, so
  that search terms, the sign-in callback's `code` and `state`, and a streaming `access_token` sent in the URL (VIS-26)
  are not kept. It is configured; that the stored invocation logs no longer hold incoming query strings has not yet
  been checked on a deployment.
- **Head sampling at 1**: every invocation is kept.

Edit the block in your instance's `wrangler.jsonc` and deploy to change it; the next deploy applies the file's block,
so a change made only in the dashboard does not last.

## Where to look

- **Dashboard:** Workers & Pages, your Worker, Observability. Events lists entries; the Query Builder filters and counts
  them. Filter on the `event` field (for example `event = kopje.store.upgrade.failed`) rather than on the level: some
  failure events are written at the info level today.
- **Live:** `npx wrangler tail` in your instance's repository streams the Worker's entries as they happen. Wrangler's
  OAuth login (`npx wrangler login`) is enough.
- **Telemetry API:** querying Workers Logs from a script needs an API token with the Workers Observability read
  permission. Wrangler's OAuth login does not grant it.
- **Retention:** 7 days. Nothing older can be read.

## Events to act on

| Event                          | Meaning                                                                                   | More                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `kopje.error`                  | An unexpected exception answered 500 (logged by class, method, route and status)          | —                                                  |
| `kopje.config.invalid`         | The Worker's variables or secrets do not parse; requests answer 503 until fixed           | —                                                  |
| `kopje.store.upgrade.failed`   | A Store upgrade phase failed; the Store holds readonly                                    | [upgrade.md](upgrade.md), "What happens on deploy" |
| `kopje.jobs.failed`            | A jobs Queue message or a cron jobs round failed; the message is retried                  | —                                                  |
| `kopje.spool.backlog-full`     | The inbox spool is full: inbox requests that would be spooled answer 503, and peers retry | —                                                  |
| `kopje.spool.replay.failed`    | A spooled inbox request failed to replay; the Queue retries it                            | [cutover-runbook.md](cutover-runbook.md)           |
| `kopje.queue.unknown`          | The Queue holds a message this version does not know; it is retried                       | [cutover-runbook.md](cutover-runbook.md)           |
| `kopje.delivery.gave_up`       | Deliveries to remote inboxes were given up after their retries (a count)                  | `kopje-admin deliveries`                           |
| `kopje.backup.failed`          | A backup run failed                                                                       | [backup.md](backup.md)                             |
| `kopje.media.images_quota`     | The month's Images transformations are used up; uploads are refused                       | [setup.md](setup.md), "Before you start"           |
| `kopje.media.transform_failed` | An uploaded image could not be transformed; the upload answers 500                        | [setup.md](setup.md)                               |

## Cost

Workers Logs is billed to the account, not to one Worker: every Worker and Pages project in the account shares the
allowance, and other observability data the account keeps counts too. Read the account's usage in the dashboard's
billing pages rather than estimating.

From 2026-12-01, Cloudflare's pricing gives Workers Paid 50 GB of ingestion and 10 GB-month of storage per billing
cycle, then charges for both. Before that date, logs are counted in events (20 million a month included). Check
Cloudflare's current pricing before relying on these figures.

**Storage runs out first.** With 7-day retention, the amount kept at any time is about 7 days of ingestion, so
GB-month ≈ 0.23 × GB ingested a month, and 10 GB-month corresponds to about 43 GB ingested, before the 50 GB ingestion
allowance. Act when the account's projected ingestion passes **40 GB a month**.

An estimate, before there is usage to read:

```text
GB a month ≈ 30 × (log bytes a day + span bytes a day) / 10⁹

log bytes a day  ≈ (Worker invocations + Store invocations) × ~1.2 KB + Kopje events × ~0.4 KB
span bytes a day ≈ spans × ~0.8 KB   (0 while traces are off)
spans            ≈ Worker invocations + Store calls × (3 + SQL statements per call) + outbound fetches, R2 and
                   Queue operations
```

Worker invocations are HTTP requests plus cron ticks (one every 5 minutes) plus Queue batches. Every term is uncertain
by about a factor of two; after a week, read the real figure in the dashboard.

## Sampling and turning things off

In this order, each in your instance's `wrangler.jsonc`, then deploy:

1. If traces are on, lower `traces.head_sampling_rate` (for example 0.25, then 0.1), or set `traces.enabled` to
   `false`. Sampled traces still show representative timings.
2. Set `logs.invocation_logs` to `false`. This removes most log bytes and keeps every Kopje event.
3. Lower `logs.head_sampling_rate` below 1 only as a last resort: head sampling drops whole invocations, Kopje's error
   events included.

## Privacy: what the platform records

Kopje's own events follow DATA-5. The platform's invocation logs are not written by Kopje, and record:

- each request's URL path, including `/media/<token>/<file>` paths, which are the capability that opens non-public
  media (threat-model.md, "Accepted risks");
- the query string too, unless `redact_query_string` removes it (configured, not yet verified; see above);
- the method, status and duration, and request properties Cloudflare attaches (such as the data center and country).

Anyone who can read the account's Workers Observability data (members with that access, and API tokens with Workers
Observability read or broader) can read these for 7 days, and can keep a copy that outlives the retention. Do not
assume that telemetry holds no secret because Kopje's own events hold none.

## Traces: off unless you opt in

Traces record each invocation as spans: Store RPC sessions and methods with their durations, every SQL statement,
R2 operations, outbound requests and the Queue and cron handlers. They show where a slow request spent its time.

**To opt in**, set `"traces": { "enabled": true, "head_sampling_rate": 1 }` in your instance's `wrangler.jsonc` and
deploy. Traces count toward the same allowance as logs; lower the rate if the cost section says so.

**What spans disclose**, beyond the invocation logs:

- **SQL statement text** of every Store statement. Kopje's own statements pass request values as parameters, so those
  values are not in the text; but `kopje-admin sql` (`POST /admin/sql`) runs the SQL you type verbatim, so whatever
  you put in such a query is recorded.
- **R2 object keys.** A media file's key carries its capability token, so a span gives what the `/media/<token>/<file>`
  URL gives: read access to the file. That includes uploads that were never attached to a status or shared, since an
  upload is written to R2 before anyone reads it.
- **Web Push endpoint URLs.** An endpoint is a capability URL (RFC 8030, section 8): Kopje's own events never log it
  (DATA-5). Sending to it still needs the instance's VAPID key, and a readable message the subscription's own keys.
- **Outbound URLs:** remote inboxes and actors, the pages that link cards and profile-link checks fetch, and the backup
  storage's object paths.
- **Copies outlive retention.** Spans are kept 7 days, but a capability (a media key, a push endpoint) copied from them
  during that time stays valid after they are gone.

**Opt in only if** every principal that can read the account's telemetry is trusted with all of that data: every
human member of the account, and every API token with Workers Observability read or broader. Being a member of the
account, or holding the Worker's secrets, is not by itself enough; a member with observability access may have no
access to the secrets or to the Store's data. You must also accept that copies taken during retention outlive it.

**After opting in, check** on your instance, with harmless marker values, what the spans hold:

- a marker in an incoming request's query string (for example a search), and a marker sent as a WebSocket subprotocol
  credential to `/api/v1/streaming`: neither appears in any log or span;
- the setup wizard's outbound requests to the Cloudflare API carry your API token as a bearer header (SETUP-4): give
  `/setup` a token (for example to update the Access applications) and confirm it appears in no span attribute;
- the attributes of SQL, R2, outbound fetch and Web Push spans: list their keys and confirm they hold no header value.

If a check fails, set `traces.enabled` back to `false` and deploy.

## The maintenance worker

During a cutover, the legacy Pages project runs Kopje's maintenance worker as its `_worker.js` (see
[cutover-runbook.md](cutover-runbook.md)). It is not a Worker of its own, and this block does not apply to it. Read its
events (`kopje.maintenance.backlog-full`, `kopje.maintenance.rate-limited`) live with
`npx wrangler pages deployment tail --project-name <project>`.
