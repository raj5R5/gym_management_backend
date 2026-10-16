# API latency diagnostics

## What inspection established

The previous `pino-http` completion logs already contained `req.method`,
`res.statusCode`, `responseTime` (milliseconds), and `requestId`. They deliberately
omitted URLs, but also omitted route templates, so slow requests could not be
attributed to endpoints. HTTP 200 establishes success, not acceptable latency.

For these application logs, timing starts in the request logger before Helmet,
CORS, rate limiting, JSON parsing, authentication, and route handling. It ends
when the response finishes (or closes/errors). It includes dependency waits,
processing, and writing the response, but excludes Render's pre-Node queueing,
service spin-up, startup initialization, and delivery to the client after Node
finishes writing. Render platform timings and client timings may therefore differ.

MongoDB uses one connection established before the HTTP listener starts, with a
pool capped at 10 connections, 10-second selection/connect timeouts, and Mongoose
command buffering disabled. There is no per-request connection setup or verbose
query logging. Startup creates the existing explicitly selected indexes before
listening; this change does not alter that behavior. No production database,
deployment metrics, region settings, or Cloudinary timings were accessed during
this investigation.

## Plausible bottlenecks, not measured causes

| Path | Code evidence and implication |
| --- | --- |
| Protected requests generally | Authentication reads the session and active account sequentially. Gym authorization then reads the grant and active gym; services recheck access. These checks are security requirements, but database round-trip latency accumulates even for small responses. |
| `GET /api/v1/gyms/:gymId/dashboard` | An admin request without a branch filter performs eight sequential database operations before six parallel aggregations. The aggregations include joins/facets across members, plans, subscriptions, payments, and attendance. Outstanding dues include historical non-cancelled subscriptions. Data size and database load can matter even when a short reporting period is selected. |
| `GET /api/v1/gyms/:gymId/members` | After access checks, the service fetches a sorted/offset page and an exact count in parallel. Search uses unanchored, case-insensitive regexes over member code, names, and phone. Ordinary list indexes do not establish that these searches are efficient; large offsets and counts are additional candidates. |
| Member summary | The route's `authorizeRead` and the service's `get` both resolve member access. Summary aggregations join history; payment aggregation waits for current-subscription resolution. Trainer access adds assignment checks. |
| Authentication | Login performs Argon2id verification (64 MiB, time cost 3), then sequential session/token writes and identity reads. Refresh also has sequential reads and rotation writes. CPU/native-worker contention is plausible under concurrent login or image work; security settings should stay intact. |
| `GET /api/v1/gyms/:gymId/members/:memberId/photo` | Each request checks authentication and gym access, rechecks service access, reads the member, then fetches an authenticated image from Cloudinary with a 30-second timeout. The backend buffers the complete image before sending it. The route sets `Cache-Control: no-store`; repeated image requests repeat this work. A page requesting many photos could create a burst of database and outbound requests, but client behavior has not been inspected. |
| Photo writes/background cleanup | Uploads decode/re-encode with Sharp, call Cloudinary (60-second timeout), and commit database changes in a transaction. Cleanup starts after server startup and runs every minute, sharing database and outbound resources. |
| Infrastructure/dependencies | A 10-connection pool can queue work under concurrent load. MongoDB server load, actual query plans/index presence, network distance to MongoDB/Cloudinary, and Render CPU/memory pressure remain unverified. No particular timeout or code path proves a fixed 5.6–5.7-second delay. |

Render documents idle spin-down after 15 minutes and roughly one minute to spin
back up: [Free web services](https://render.com/docs/free#spinning-down-on-idle).
This is a separate mechanism from repeated slow requests in an active Node
process. An upgrade can remove idle spin-down; it does not establish the cause of
warm-request latency or guarantee faster database/provider calls.

## Logging change

The existing single completion event now includes a server-declared `route`
template. Explicit mount templates preserve gym/member parameters even after
Express unwinds a router during error handling. No URL guessing or replacement
of client values is used. A typical completion entry contains:

```json
{
  "level": 40,
  "req": { "id": "example-request-id", "method": "GET" },
  "requestId": "example-request-id",
  "res": { "statusCode": 200 },
  "responseTime": 5670,
  "route": "/api/v1/gyms/:gymId/members/:memberId/photo",
  "msg": "request completed"
}
```

Requests taking **at least 1,000 ms** log at warning level (`40`). Server failures
retain error level (`50`), including slow failures. Other completions use info
level (`30`). This promotes the existing entry instead of adding a duplicate
warning. Existing sanitized application error events remain separate.

Unknown routes and errors before route selection use `route: "unmatched"`.
This includes JSON/CORS/rate-limit failures and router-wide authentication
failures before a handler is selected. These events cannot safely identify a full
endpoint using `req.route`; the raw requested path is never a fallback.

Request/response logging retains its allowlist. Query values, URL IDs, bodies,
headers, cookies, response payloads, and raw error messages/stacks are excluded.
Existing request IDs and redaction stay in place. No dependencies, configuration,
queries, indexes, payment behavior, or authentication rules changed.

## Deployment and measurement

1. Review the patch, then deploy it through the usual Render workflow when
   authorized. Keep the current instance tier, secrets, configuration, and database
   unchanged for the initial baseline. This investigation does not deploy, commit,
   or push anything.
2. After `API server started`, verify a health completion and a normal authorized
   Dashboard/member request produce the expected templates. With existing info
   logging enabled, both fast and slow completions are available; higher log-level
   filters can hide fast requests and prevent a complete latency distribution.
3. Observe representative warm traffic, preferably over a day including normal
   load. Group completion events by `req.method`, `route`, and `res.statusCode`;
   calculate counts, median, p95, and the fraction with `responseTime >= 1000`.
   Separate startup/reconnect periods using lifecycle logs and timestamps.
4. Compare photo reads, Dashboard, member lists/details, summaries, login, and
   `/health`. Match individual requests to client measurements with the existing
   `X-Request-ID`. Avoid exporting request URLs, credentials, or member data into
   diagnostic notes. Exercise normal reads rather than synthetic payment or
   member mutations in production.
5. Correlate spikes with Render CPU/memory and request volume where available
   ([Render metrics](https://render.com/docs/service-metrics)), MongoDB connection
   events/resource metrics, and deployment/restart timestamps. Verify the service
   and database regions privately without printing connection strings. Do not
   enable raw production query logging.
6. If photos dominate, investigate provider latency and image request concurrency.
   If database-backed routes dominate while health stays fast, investigate
   database/network latency and plans using a separately reviewed, scoped process.
   If health also slows during warm load with resource pressure, an instance
   upgrade becomes a stronger candidate. If only client/platform latency is high
   while application timing stays low, investigate delays outside this timer.

These diagnostics attribute latency to endpoints; they do not split database,
pool wait, CPU, and Cloudinary time within an endpoint. Any deeper instrumentation
should follow the production evidence and remain narrowly scoped.

## Validation

Supertest tests cover successful requests, handled and unexpected errors, unknown
routes, pre-route errors, malformed JSON, the 1,000 ms warning boundary, slow
server errors, actual application mounts, and nested bootstrap branch templates.
They assert sensitive sentinels are absent from all captured logs. Slow timing is
simulated using pino-http's documented start-time symbol without delaying tests
or changing the production threshold. Run `npm test` and `npm run lint`.

Validation completed: all 899 backend tests passed, with no skips or failures;
ESLint and `git diff --check` passed. Tests used isolated local MongoDB processes,
not application environment files or a production database.
