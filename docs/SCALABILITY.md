# Scalability audit and launch gates

Audit date: November 12, 2026. Target: thousands of concurrent users and millions
of registered users, with the existing authorization, audit history, conflict
detection, and offline recovery guarantees intact.

**Status: hardening and capacity testing in progress; production capacity is not
certified.** No production migration, function deployment, DNS change, or load
traffic has been performed by this audit. Existing work on self-service onboarding
was present in the checkout and has been preserved.

**Initial launch scope:** adoption is expected to be gradual. The user clarified
that 5,000 simultaneous users is a growth target, not a prerequisite for the first
release. Merge the verified foundations and start with a small observed cohort;
expand as real usage and measurements justify it. This does not relax account
gateway, authorization, data integrity, recovery or hosting-security requirements.
Do not describe the initial release as certified for the later 5,000-user target.

## Changes made

| Risk | Change | Security/integrity boundary |
| --- | --- | --- |
| Every practice upload acquired the same exclusive database lock | Uploads share the structural gate; practice-specific locks and revision receipts still serialize competing writes to one practice | Revocation, removal, and roster changes retain the exclusive structural gate; checks, immutable events, and tombstones remain |
| Independent player activities serialized every user | Per-player activity locks under the shared structural gate | Creates, conflicts, profile uniqueness, drill references, and retries remain serialized for the affected player |
| Concurrent practices could lock achievement jobs in different pitcher orders | Dirty player jobs in sorted, deduplicated order | Atomic source changes still advance job revisions |
| Reads could mix session/event snapshots after allowing concurrent scoring | Legacy workspace functions use a single statement snapshot; new pages include each practice and its events together | A scoped structural epoch rejects downloads that span a relevant roster/access/import change |
| Every sync downloaded all accessible pitch bodies | Keyset practice pages, up to 50 by default/100 maximum, with exact-version cache hints | The server constructs the authorized manifest independently of hints; missing/revoked records are pruned only after a complete download |
| Each pitch resent the whole practice | Send appended events and sparse undo changes against an exact server revision/event count; persist the transport choice before sending | Reconstruct on the server and run the complete original ownership, access, immutable-event, drill and receipt checks; a SHA-256 transport receipt fences changed retries |
| Validation scanned growing identifier arrays for every event | Check uniqueness once and index appearance reservation positions | Forward/self references, duplicate identifiers, malformed events, batter rules and undo history remain rejected; private reference-validator equivalence tests cover mixed and tampered histories |
| Many large practices could produce a huge page | Approximately 1 MiB history-page target, with an atomic practice as the minimum unit | A practice and its authoritative source events are never split inconsistently; one large practice can exceed this target |
| Workspace predicates ran against unrelated tenants' rows | Resolve visible teams, practices, and pitchers as indexed sets | No browser write grants or RLS policies are removed; active identity is checked on every page |
| A page repeatedly rebuilt visibility queries and their plans | One private server-derived context and prepared PL/pgSQL queries | Plans are reused; identity, permissions and data are read afresh under the same stable snapshot |
| Every warm sync still paged all practice headers | SHA-256 check of the complete authorized ID/version set and structural epoch | Missing, extra, changed, archived or newly private records force ordinary pagination; fresh authorization and metadata are still read |
| Unchanged private award evidence was transferred on every sync | Hash the actual authorized award values plus the access epoch and reuse only an exact client cache match | Role changes and direct service repairs invalidate hints; status and authorization remain fresh; partial downloads never commit an award cache |
| Award evaluation rebuilt formatters and recalculated the same practice totals | At most 64 timezone formatters, indexed static definitions, and weakly keyed totals for fresh per-evaluation practice projections | No identities or authorization results are cached; new dates and source corrections remain effective |
| Successful evaluations rewrote identical award rows | Skip an award UPDATE when the complete JSONB value is unchanged | Source revision, owner, lease and job confirmation checks remain; corrections and withdrawals still write |
| Inactive players replayed closed history every day | Leave jobs asleep once all relevant weeks, months and seasons are closed and no goal records remain; keep daily evaluation conservatively for all goals | Only a successful leased, revision-checked evaluation can sleep; source writes wake the job; private bounded rule-refresh batches handle later rule changes |
| A scheduled wave could run several expensive replays before checking its budget | Claim one job at a time and stop claiming after 250 ms of measured synchronous validation/rules work, including failed work | No replay is truncated; completed jobs retain full validation and commit fences; a single oversized replay still needs separate CPU/memory testing |
| Scalar permission helpers repeatedly rebuilt plans | Cached PL/pgSQL plans for the same stable permission expressions | Authorization results and identities are never cached |
| Goal filtering hid indexed predicates behind CASE | Explicit personal/team predicates and a team-goal index | Includes the same team, coach and personal goal scopes |
| Unused raw table reads could evaluate opaque policies for millions of rows | Revoke authenticated table SELECT except indexed self-profile access | Supported clients use independently authorized RPCs; table RLS remains enabled and service privileges remain intact |
| Old clients could request unbounded full snapshots | Scoped indexed legacy reader with explicit 1,000-practice/8 MiB limits; small global admin compatibility also preflighted | Oversized reads fail with an update message; records are never silently truncated or pruned |
| Historical containment and reverse joins lacked supporting indexes | GIN index for practice pitcher IDs and indexes for ownership, memberships, goals, awards, deletion visibility, queue due times, and rate-limit expiry | Indexes accelerate existing access checks |
| Unchanged history was deleted, rewritten, and replayed locally | Compare per-practice data/events and update only changed/removed history; group events once | Reconciliation remains one IndexedDB transaction and preserves uncommitted uploads and blocked-work recovery |
| Sync status notifications reloaded all local history | Separate status/data notifications and share overlapping UI snapshot reads | Data changes invalidate in-flight reuse; repositories never share snapshots; a later status event cannot discard a delayed data refresh |
| History rendered every practice and scanned all appearances for each row | Render 50 practices per page and index appearances by practice once per snapshot | All authorized records remain stored and accessible offline; paging does not discard or truncate history |
| Admin opening the app downloaded every tenant | Admin workspace contains assigned teams plus an explicitly selected team | Server verifies admin access before honoring a selected team; unrelated practice review loads one authorized record |
| Account administration fetched entire tables and could silently stop at API row limits | 50-account/50-request directory pages, server filters, prefix search, bounded related memberships/player links | Directory and team-search functions are service-only and independently recheck the active admin |
| Email verification scanned all requests | Confirm the one verified account | Confirmation still requires the verified Auth identity/email |
| Account bodies were fully allocated before checking a character limit | Enforce a 20,000-byte streaming limit before account work | Oversized/malformed bodies cannot start provisioning or authentication work |
| Public authentication relied too heavily on network buckets | Additional private per-email verification/recovery and per-invitation-token buckets | Changing a supplied network address cannot reset those subject limits; raw email/token values are not stored in buckets |
| Workers could evaluate the same jobs concurrently | Bounded `SKIP LOCKED` claims, expiring leases, revision checks, lease-token fencing, and fenced failure handling | Worker functions are service-only; player requests derive their pitcher from the authenticated link |
| Every pitcher, including unlinked players, was evaluated repeatedly | Queue linked players; remove jobs on unlink; dirty source data becomes immediately eligible | No inferred activity or coaching permissions are created |
| Unchanged lifetime history was replayed every 15 minutes | Date-dependent background evaluation moves to the next local midnight with a stable spread of up to 15 minutes; changes still queue immediately | Source revision mismatch rejects stale commits; active players can request their due evaluation during sync |
| Scheduler could process only 100 jobs every 15 minutes | Every-minute configurable worker fan-out (default 16, range 1–64); each invocation processes at most 100 jobs within its wall/work budgets | Uses the existing dedicated worker secret; leases prevent duplicate processing across invocations |
| A foreground claim could use a generic plan that scanned the global backlog | Separate primary-key foreground and ordered global-worker plans | Both preserve SKIP LOCKED leases and server-only execution |
| Profile/evaluation steps multiplied sequential API round trips | Service-only joined profile context and atomic player job/source preparation | Identity still comes from fresh GoTrue verification; the database checks current active role/linkage, and browser roles cannot invoke these contexts |
| Every rapid pitch triggered a lifetime award replay and several API round trips | Coalesce ordinary practice changes for 15 seconds from the last successful evaluation | Every source revision stays dirty until confirmed; end, undo/removal/archive and explicit activities retain urgent priority; pending awards cannot be shared as confirmed |
| Foreign-key removal checks lacked reverse indexes | Eight complete indexes for team/account/pitcher references | No cascading behavior or access checks change |
| A sign-in/signup could delete an entire expired rate-bucket backlog | Indexed expiry batches of at most 64 rows using SKIP LOCKED | Current attempts still increment atomically, denied attempts still count, and existing retention/window thresholds remain |
| A retiring worker could reject a read-only profile POST | Body-free GET profile with the same identity, approval and suspension checks; POST remains compatible | Responses remain no-store; no authorization cache or automatic mutation retry |
| A single large frontend bundle changed on every release | Separate React, Supabase, and local-storage vendor chunks | Public build settings remain the only frontend connection credentials |
| Static hosting lacked an explicit header policy | Build emits `_headers` with exact configured Supabase connection origins, CSP, no-referrer, nosniff, HSTS, and cache rules | Requires a host that actually honors these headers; GitHub Pages does not apply this file |
| Development serving could expose private test credentials | Deny private artifact/tool directories through the dev server while preserving Vite's built-in environment/key/Git restrictions | Synthetic canaries verify direct, raw-import, filesystem and Windows case-variant paths return 403; no actual credentials are fetched; CI checks the gate |

An exact cache version includes the server revision, archive state, visibility
mode, and player identity. Cached private projections cannot become full practice
records just because a version hint was supplied. Failed/invalidated downloads do
not replace the complete local cache.

## Evidence and limits

Local validation passed **381 tests across 31 test files**, TypeScript checking,
and the production build. The automated suite runs the entire migration chain in PGlite and tests counting,
storage, authorization, removal, conflict/retry behavior, player privacy, paging,
scope epochs, admin directory cursors, account body limits, and worker leases.
`npm test` and `npm run build` must pass before deployment.
`npm run test:dev-security` also verifies that private test artifacts and
environment files cannot be served, that upgraded Vite deny defaults remain
included, and that ordinary source modules still load.
`npm run test:build-secrets` rejects private browser keys/credential-bearing
URLs before emission and checks every emitted file for a synthetic server-key
canary. A runtime configuration error alone cannot undo a leaked build setting.

The [verified account gateway](ACCOUNT-GATEWAY.md) is prepared, with bounded
same-origin public requests and signed network provenance. Direct unsigned public
function calls now fail before counters or Auth. Small real HTTP probes cover
forged forwarding/host/origin headers, dropped credentials and body limits;
the real local API suite passes 13 checks, including signed username login.
Pages Function compilation and public-flow browser checks pass. Hosted address
provenance, provider forwarding, bot protection and capacity remain unverified.
Cloudflare is not signed in here and no hosting deployment has occurred. The
static-only GitHub Pages publication path is gated pending verified ingress.

The user chose to continue local work without paid resources. The proposed
hosted test budget is not approved or pending. No cloud project, upgrade or paid
test is authorized by the retained capacity-plan document. Representative hosted
capacity verification remains incomplete.

Browser instrumentation measured one full history read per successful sync and
zero during a status-only failed sync. Delayed data reads still showed additions
and removals after the final sync-status notification. Overlapping UI reads share
only an in-flight result; completed/failed results are not retained, a data change
starts a new read, and different account repositories never share results. Backup
exports continue to request independent mutable snapshots.

The single-browser history check retained all **1,051 practices and 2,102
events**, rendered at most 50 history rows, opened an older practice, reset archive
filters correctly, and paged offline at mobile/desktop widths without overflow.
This bounds history rendering; downloading/loading an entire account history
still needs the separate lifetime-history limits described below.

### Real PostgreSQL, two million accounts

An isolated localhost-only PostgreSQL 17.11 container supplies a free staging
database. It uses a private random password, SCRAM, data checksums, durable commits,
fsync and full-page WAL writes. No production connection settings are read.
`npm run test:postgres` passed fourteen real multi-connection races: independent and
conflicting writes, revocation ordering in both directions, deletion/retry fences,
independent player activity, disjoint worker leases, reversed participant order,
atomic denied-attempt counting and private worker privileges. The new races also
verify that a source write waiting for idle completion wakes the job after commit,
and that rule-refresh batches retain skipped locked jobs and apply a cutoff only
once. These tests exposed
and fixed a CRLF-sensitive migration replacement that otherwise left the global
player-activity lock exclusive. CI now requires the real PostgreSQL checks too.

The synthetic population contains **2,000,000 accounts and historical practices,
500,000 linked players, 3,000,000 goals, 1,000,000 private player records and
500,000 initially due jobs** (approximately 8.1 GB). Trusted fixture construction
suppresses derived triggers only in its loading transactions; measured requests
use normal triggers, SQL roles, RLS, current authorization and durable commits.
This is an early population model, not a years-of-history or worker-drain test.

`npm run benchmark:idle-queue` separately tested the deployed global candidate
query shape with a temporary queue of 500,000 sleeping jobs and a forced generic
plan. The empty queue lookup took 0.036 ms; selecting one due job among the
sleeping jobs took 0.084 ms. Both used the ordered index without a sequential
scan or sort. Only temporary synthetic rows were created. This checks candidate
selection, not complete worker throughput, backlog drain time or hosted capacity.

The native runner uses distinct actors and 64 pooled connections. Writers save
every 2.5–3.5 seconds and refresh their workspace; other clients poll every
25–35 seconds. Errors, identity/scope assertions, connection queues and generator
event-loop delay are measured. Source/migration fingerprints and container limits
are recorded in the ignored JSON reports. Initial results before metadata enrichment:

| Database resources | Users / recording share | Result |
| --- | --- | --- |
| 4 CPU, 8 GB | 1,000 / 20% | 11,790 requests; zero errors/isolation failures; profile p95 ≤25 ms, workspace/upload p95 ≤50 ms |
| 4 CPU, 8 GB | 3,000 / 20% | Failed latency gate; 97,131 requests, zero errors/isolation failures, p95 in the 2,000 ms bucket; CPU saturated |
| 8 CPU, 8 GB | 3,000 / 20% | 67,498 requests over 121 seconds; zero errors/isolation failures; workspace p95 ≤50 ms and upload p95 ≤100 ms |

The complete metadata population and bounded legacy/raw-table migrations were
then tested at 3,000 users/20% recording: **67,473 requests**, zero errors or
isolation failures, the same ≤50 ms workspace and ≤100 ms upload p95 buckets.
The 3,000-user **100% recording** case **failed** the latency gate on eight cores
(p95 in the 5,000 ms bucket). After acknowledged-upload cache reuse, another run
made 172,278 requests without request/isolation errors, and compared all 3,000
final practices with their complete expected source: **zero integrity failures**.
It still failed latency. CPU reached its eight-core limit; sampled activity showed
CPU work rather than lock waits. Do not describe this case as production-ready.

Percentiles are histogram upper bounds. These are short **database-layer** runs;
hosted Auth, Edge Functions (including award evaluation), HTTPS, CDN and browser
work are excluded. They do not certify production capacity. The larger metadata
all-recording peak, longer holds, cold starts and worker backlog still need
passing representative results. Upload caching saves transfer and retains
server-checked revision/archive/visibility/player version hints; it did not solve
the CPU-bound all-recording case.

### Real local Auth/API acceptance

The official pinned Supabase CLI 3.1.0 now also runs a separate local stack with
Auth, Kong, PostgREST, the actual Supabase database and both Edge Functions. The
CLI overrides Docker bridge defaults, so the Windows launcher enforces localhost
bindings on container creation through a private named pipe; it opens no Docker
TCP listener. It verifies the resulting bindings and stops the test containers
if they are unsafe. Private CLI logs and generated credentials stay ignored.
The existing email-confirmation hook, 15-character password requirement and
provider rate protections are retained. Test mail goes only to local Mailpit.

`npm run test:local-api` passed **13 real acceptance checks**: unsigned public
request rejection, signed gateway dispatch, real signed username login, anonymous
rejection, public Auth hook enforcement, normal sign-in/profile consistency,
acknowledged-upload cache reuse, cross-user/raw-table denial, receipt fencing
after revocation with cache pruning, private award evaluation, exact award-cache
reuse/invalidation after a service repair without a job revision change, sleeping
closed-calendar jobs waking through ordinary activity writes, and suspension with
an existing token. Setup creates only synthetic accounts using the trusted local
service identity; the measured/checking requests use ordinary signed-in clients.

This found an actual Edge worker boot failure: the shared type-import graph had
extensionless module paths that the browser bundler and mocked function tests
accepted but Deno could not resolve. The graph now uses explicit extensions and
has a regression check, including transitive type imports. The real worker then
evaluated and committed awards successfully. These small acceptance checks are
not a full-stack capacity test. The full population has since been transferred
into its real Auth/app schema with all **35 public foreign keys validated** and
normal triggers restored. Trusted fixture construction uses GoTrue-compatible
empty token fields; no signup/login limits or verification hooks were disabled.
The returning-user fixtures have ordinary authenticated claims and real local
Auth sessions; real Auth verifies their signatures and looks up their users.
Interactive sign-in/refresh peak behavior is excluded and must be tested
separately with representative client addresses.

A ten-user HTTP smoke load (all recording) passed 260 requests with zero request
or isolation errors, including 18 real player evaluations. Complete workspace
p95 was in the ≤100 ms bucket, including evaluation/metadata confirmation.
Longer full-stack holds, heavier writers and hosted results remain outstanding. The runner now
checks expected team/pitcher/peer scopes, private record ownership and private
player projections, and measures complete workspace cycles in addition to
individual requests. It rejects administrative or prematurely expiring fixture
tokens before sending traffic.

The first **1,000-user / 20% recording** full-stack run made **28,695 requests**
with zero scope violations and 2,087 player evaluations. Nine requests failed
(0.031%); complete workspace p95 was ≤100 ms. A diagnostic repeat made 28,216
requests with one generic runtime HTTP 500 and no scope violations, with the same
complete-workspace p95. These met the provisional aggregate gates, but the
failures remain visible in the reports rather than being called zero-error runs.
CPU soft-limit worker recycling was logged; its relationship to each transient
response is not yet proven. The handler now separately returns retryable 503s
when Auth/network/database availability fails, instead of misclassifying those
conditions as expired sign-in. Verification still fails closed.

The initial 3,000-user run exposed the development gateway's **512-connection**
default and many closed sockets. The local launcher now sets two gateway workers,
8,192 connections per worker and a 16,384 file limit in the CLI's custom Nginx
template, verifies localhost bindings, and waits for real handlers to reject
anonymous identity before declaring readiness. It preserves Auth, RLS and rate
protections. An API pool of 32 stays below the database's 100-connection ceiling.
These are local rig settings, not a claim about managed service configuration.
The stack and traffic generator share a gaming PC (Intel i5-11600K, 12 logical
processors, 64 GiB RAM). Container CPU/memory limits
are ceilings on shared resources, not dedicated server capacity. High generator
event-loop delay and host contention limit interpretation of failed peak runs;
do not infer a production user ceiling from these results. Final capacity tests
require a separate generator and representative staging hardware.

With service-only joined contexts and the 15-second award coalescing window,
the stricter **3,000 users / 20% recording** run passed: **109,857 requests**,
11 transient failures, zero scope or integrity failures, and exact comparison of
all **600 writers' final practices**. Coach complete-workspace p95 was ≤500 ms,
player p95 ≤750 ms, profile p95 ≤750 ms and upload p95 ≤500 ms. A prior aggregate
gate pass did not suffice: separate player/coach gates and source verification
were added, and failed follow-ups remain recorded.

The next **5,000 users / 20% recording** step failed latency: 143,790 requests,
30 transient failures, zero scope/integrity failures, and all 1,000 final writer
sources verified. Upload/workspace p95 was in the 3,000 ms bucket and player
complete-workspace p95 in the 10,000 ms bucket. Increasing the single API process
from two to four runtime cores did not improve this case. It has been reverted;
current work reduces repeated award-evidence transfer and measures API pool/GC
statistics through an internal-only metrics port. Histories grow between runs,
so these are capacity observations, not controlled percentage speedup claims.

Further 5,000-user runs with award transfer caching and then two API instances
also failed the local gates. Two-instance routing was verified with 500 ordinary
signed-in self-profile reads split exactly 250/250 with correct identity. This
did not establish improved capacity; the optional replica has been stopped.
After evaluator reuse, another 5,000-user run made 86,268 requests with 611
failures, zero scope/integrity failures, and all 1,000 final writer sources
verified. Generator event-loop p99 reached 468 ms. These failures remain recorded,
but the shared-PC rig cannot establish which production resources are required.

The evaluator optimization was separately compared against the prior evaluator
using 240 practices, 12,990 events, 7,802 activity records and ten seasons. All
15,073 awards, 16,610 progress entries and 1,374 goal windows matched exactly in
UTC, New York and Lord Howe timezones. Measured local evaluation time fell from
about 509–584 ms to 268–292 ms after also deduplicating calendar work. This isolated comparison supports the efficiency
change; it does not certify concurrent-user capacity. A database regression also
checks that unchanged award evidence retains its physical tuple while a corrected
or withdrawn award changes it, and that stale source revisions still fail.

The 15-second window is anchored to the last successful evaluation, so continuous
pitching does not postpone eligibility indefinitely. Urgent end, undo/removal,
archive and explicit activity changes retain priority until committed. Actual
confirmation also depends on the next client/worker attempt; pending revisions
are never marked confirmed merely because source saving succeeded.

```powershell
npm run supabase:local:start
# After adding SQL migrations to an existing local stack:
npx --offline --yes supabase@3.1.0 migration up --local --workdir .test-artifacts/full-stack
# Capture status privately; never paste its keys into logs or commit it:
npx --offline --yes supabase@3.1.0 status --workdir .test-artifacts/full-stack --output json > .test-artifacts/full-stack-status.json
npm run test:local-api
npm run supabase:local:stop
```

```powershell
npm run postgres:start
npm run seed:native
npm run seed:native:metadata
npm run test:postgres
$env:PITCHWORK_NATIVE_VUS='3000'
$env:PITCHWORK_NATIVE_SECONDS='1800'
$env:PITCHWORK_NATIVE_RAMP_SECONDS='180'
$env:PITCHWORK_NATIVE_WRITE_FRACTION='0.2'
npm run benchmark:native
npm run postgres:stop # Preserve the synthetic data for subsequent runs.
```

The default new local container has four CPU/eight GB limits; set
`PITCHWORK_NATIVE_CPUS=8` before first creation to reproduce the eight-core limit.
The measured existing container has 1 GB shared buffers; the helper's fresh
default is 512 MB, so record actual settings rather than assuming identical runs.

### Dependency security

Available fixes were applied to the build's URL parser, glob matcher and serializer
chains. `npm run test:security` requires **zero production advisories**. One
unpatched low-severity [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
remains in build dependencies. Both ES and CommonJS consumer paths were reviewed:
each only copies a source-code literal defaults object. No application, request or
build-option input reaches the merge. The gate pins both consumer hashes and exact
versions, rejects severity changes/new advisories and expires this reachability
review on February 11, 2027. This is a documented unreachable build-time path,
not a claim that the full dependency audit is empty.

Browser checks exercised the complete coaching workflow, responsive layouts,
keyboard access, save recovery, iPhone sync progress/error/retry behavior, and
admin team search/directory paging. The production PWA check also passed offline
close/reopen and scoring, JSON backup transfer/restore, and a real waiting
service-worker update that preserved records. Run:

```powershell
python tests/browser_smoke.py
python tests/sync_feedback.py
python tests/scalability_browser.py
```

Use the test-only backend settings described in `tests/auth_mock.py`; these
browser fixtures do not certify live database authorization or capacity. Offline
PWA/backup regression uses `tests/pwa_backup.py` against a production preview.

The isolated query benchmark was run with **100,000 unrelated tenants**, each
with an account, team, membership, pitcher, and roster assignment. The foreground
workspace returned only its one team/pitcher/account (1,160 bytes), with warmed
read p95 approximately **3.2 ms** over 20 measured reads on this machine.
This is a single-connection PGlite measurement with empty practice history. It
does not measure network latency, Auth, concurrent lock behavior, production
hardware, or million-user capacity; do not extrapolate its throughput.

```powershell
$env:PITCHWORK_BENCH_POPULATION='100000'
npm run benchmark:workspace
```

The event microbenchmark compared the private original validator with the new
validator on 100-, 1,000-, and 5,000-event valid streams. At 5,000 events, median
validation time fell from approximately **977 ms to 94 ms** locally. The encoded
one-event update fell from **1,834,624 bytes to 1,140 bytes**. These measurements
include local parameter JSON parsing; they do not measure database WAL/TOAST,
network throughput, or concurrent production capacity.

```powershell
npm run benchmark:events
```

Incremental-upload regression coverage includes a committed request whose
acknowledgement is lost, closing/reopening IndexedDB with a fresh gateway, and
retrying the exact persisted delta without duplicating events. It also covers
revocation/deletion before receipt acknowledgement, stale bases, immutable undo,
cross-player writes, and the original validator's acceptance/rejection behavior
across mixed histories and 168 hostile field/reference mutations.

## Required before calling the app ready for mainstream traffic

1. **A staging project and representative data.** Use a separate Supabase project
   with production-equivalent compute, disk, pool/API limits, Auth/SMTP settings,
   and worker configuration. Seed at least two million background accounts and
   realistic team/practice/activity distributions. Include years of history for
   heavy coaches/players; an empty-directory benchmark is insufficient. Use only
   synthetic or appropriately sanitized data.
2. **Measured peak workloads.** Test 1,000, 3,000, then 5,000 distinct simultaneous
   identities, including 20% and 100% recording workloads, cold sign-ins, returning
   cached clients, team-shared reads, offline reconnect bursts, imports, removals,
   and public onboarding. A thousand recorders uploading every three seconds is
   materially different from a thousand idle signed-in browsers.
3. **Real multi-connection correctness.** Hold an upload transaction open while
   another user uploads to another practice; it must proceed. A conflicting
   upload to the same practice must wait/reject its stale revision. Race upload
   against team/coach revocation, archive, deletion, and restore. PGlite's single
   connection is not proof of these lock interactions.
4. **Hosting cutover.** GitHub Pages documents a soft 100 GB monthly bandwidth
   limit and disallows commercial SaaS hosting. Move the frontend to a suitable
   CDN host. Keep `count.twelvefs.com` so installed apps retain their origin and
   IndexedDB data. Verify `_headers` support (or translate the policy into the
   host's native format), TLS, CSP/Auth, asset caching, and service-worker updates
   on the actual host. The file's presence alone does not enable headers.
5. **Abuse protection at the public boundary.** Verify which client-IP headers
   the deployed gateway overwrites; arbitrary caller-supplied forwarding headers
   are not identity. Add/validate gateway rate limits and CAPTCHA/bot protection
   for public signup, OTP, username login, and recovery. Per-subject limits in
   this patch remain necessary even with gateway protection. Exercise the direct
   Supabase endpoints as well as the frontend/proxy; frontend-only controls can
   be bypassed. Keep provider Auth/SMTP protections enabled while sizing quotas.
   Without the explicit forwarding configuration, server-side username login and
   OTP operations still share the Edge server's egress address at Auth. The
   prepared gateway supplies a verified client
   IP in `Sb-Forwarded-For`, a modern `sb_secret_` key and the provider's explicit
   IP-forwarding setting. Legacy `service_role` keys do not support this header.
   Do not forward an arbitrary caller-supplied address or raise global limits to
   hide this aggregation; prove the gateway's address provenance first.
6. **Worker throughput and observability.** Measure the oldest due job's age,
   queue growth, lease expiry, stale commits, errors, and processing rate. Default
   fan-out is a starting configuration, not a guarantee of throughput. Size for
   timezone-boundary bursts and source updates, with enough headroom to drain a
   backlog after a worker outage.
   `scripts/scale-health.sql` supplies read-only queue, lock, connection, and table
   diagnostics without selecting private record content.
7. **Production operating controls.** Collect request p95/p99, error rates, CPU,
   connection saturation, statement/lock waits, disk/WAL/TOAST growth, autovacuum,
   database/egress cost, failed logins, and restore/backup recovery evidence.
   Configure actionable alerts and an incident/rollback owner before launch.

Candidate performance gates for the staging runs: read/profile p95 <= 1 second,
upload p95 <= 1.5 seconds, unexpected request errors < 0.1%, zero cross-tenant
reads/writes, zero lost/duplicated source events, and a bounded/draining award
queue. Record the actual workload mix, dataset, deployment SHA, hardware,
generator utilization, and whether the run met every gate. Repeat long enough to
observe maintenance: at least a 30-minute peak hold and a longer soak.

## Authenticated load runner

`npm run test:load:sharded` runs the same protected workload in separate Node
processes (four by default, at most 16). It validates the whole fixture set before
partitioning, distributes both users and the exact writer count round-robin, and
writes private per-process fixture files/logs under ignored artifacts. Only the
required IDs, token and scope assertions are copied; passwords and email fields
are not propagated. Credentials stay out of arguments and console output.

The controller merges request histograms before computing percentiles. It never
averages per-process p95 values or sums peaks from different time windows. A
qualified peak is the intersection of every process's ready/active interval;
driver delay uses the worst process. Report identity binds a run, process index,
assigned fixture fingerprint, target origin, source revision and limits. Missing,
duplicate, mismatched or internally inconsistent reports cannot pass. A security
or source-integrity failure stops peer processes through their control channels,
including queued starts. Performance results still require separate backend,
database/population and worker evidence; the controller cannot certify production.

`PITCHWORK_LOAD_PROCESSES` selects the process count. Use no more processes than
the generator's available CPU cores and verify its memory/network headroom too.
`PITCHWORK_LOAD_WRITERS` is an internal exact-count setting for identified
controller cohorts; ordinary standalone runs use the requested fraction. Reports
state the effective writer fraction explicitly. The source fingerprint includes
the measurement helpers, gateway/build configuration and scheduler configuration.

The runner uses actual public-key + user-JWT HTTP requests, not administrative
credentials or mocked access. It mirrors profile polling, workspace pages/cache
hints, realistic event streams, stable operation retries, and independent practice
uploads, using the same incremental transport encoder as the application. It
also optionally asserts that an unrelated coach is hidden by RLS.
It creates real **staging** practices and ends them at completion where possible.

The runner now proves that every virtual user completed startup and that the
whole population shared the requested peak hold. It rejects a pass when driver
event-loop p99 exceeds 50 ms (the configured limit may only be tightened).
Cleanup/integrity-read successes do not dilute workload request errors. Security
or acknowledged-content failures cancel new/in-flight work and queued ramp timers;
cleanup writes are skipped after that stop rather than proceeding under uncertain
scope. The report includes ready/peak user counts, measured full-population hold,
separate workload counts and explicit assessment reasons.

The root linked Supabase project is protected from load traffic. For remote
runs also supply the production API root through `PITCHWORK_LOAD_PROTECTED_URL`
(or the production `VITE_SUPABASE_URL`). Protected host matching covers case,
alternate ports and a trailing DNS dot. Keep staging CLI state in an isolated
work directory; never relink the root project to make the guard pass. Missing
protection for a remote target, private API keys, credential-bearing URLs and
duplicate/malformed fixture identities are rejected before the workload starts.

`npm run test:load-runner` passes six checks using three synthetic identities
and a loopback fake server: startup/hold accounting, early protected-target
rejection, wrong-identity cancellation, two-process aggregation and cross-process
failure cancellation, and redirect rejection. Redirected traffic never leaves
the designated API boundary. It exercises runner mechanics without creating app
accounts, sending email or making production/cloud requests. This is not capacity
evidence. Historical run reports predate these additional qualification gates;
their original latency/error observations remain diagnostic.

Use Node 24+. Store fixtures only in an ignored/private file, for example
`.test-artifacts/load-users.json`:

```json
[
  {
    "coachId": "a real approved staging account UUID",
    "accessToken": "its current access token",
    "pitcherId": "its own accessible independent-practice pitcher UUID",
    "forbiddenCoachId": "an unrelated account UUID for the RLS assertion"
  }
]
```

Provide distinct non-admin identities. Tokens must remain valid for the run;
never commit fixtures, use production records, or replace user tokens with a
service-role key. The runner does not create accounts or bypass verification.

```powershell
$env:PITCHWORK_LOAD_ENVIRONMENT='staging'
$env:PITCHWORK_LOAD_URL='https://STAGING_PROJECT.supabase.co'
$env:PITCHWORK_LOAD_PROTECTED_URL='https://PRODUCTION_PROJECT.supabase.co'
$env:PITCHWORK_LOAD_PUBLIC_KEY='YOUR_STAGING_PUBLIC_KEY'
$env:PITCHWORK_LOAD_USERS='.test-artifacts/load-users.json'
$env:PITCHWORK_LOAD_VUS='3000'
$env:PITCHWORK_LOAD_SECONDS='2100'
$env:PITCHWORK_LOAD_RAMP_SECONDS='180'
$env:PITCHWORK_LOAD_MIN_PEAK_SECONDS='1800'
$env:PITCHWORK_LOAD_PROCESSES='4'
$env:PITCHWORK_LOAD_WRITE_FRACTION='0.2' # Repeat with 1.0 for all-recording load.
npm run test:load:sharded
```

The summary contains counts, aggregate payload bytes, and histogram bounds for
p95/p99, with no tokens or response bodies. Nonzero exit means its API gates
failed. Measure server and generator utilization separately. This runner does
not replace browser/offline testing, onboarding/mail burst tests, the broader
security matrix, or the real PostgreSQL transaction races above.

## Remaining architectural limits to measure

- Structural/admin/restore operations still take the exclusive global structural
  gate. This deliberately protects cross-team removal and access invariants.
  Measure its hold/wait time under onboarding/import bursts before replacing it
  with fully scoped locks. Never remove it just to improve a benchmark.
- Routine uploads now send only appended events/undo changes. The first upload,
  uncertain legacy uploads, and uploads without a matching cached base retain
  the complete-snapshot protocol. PostgreSQL still reconstructs and validates the
  full source stream and stores it as JSONB. Identifier checks no longer rescan
  growing arrays, and metadata-only saves retain the existing event value, but
  appends still amplify WAL/TOAST/vacuum work. Measure realistic/pathological
  session lengths. If storage writes dominate, migrate to normalized append-only
  event rows with equivalent undo validation and operation receipts before
  raising capacity claims.
- The UI still retains each account's accessible history to support offline
  statistics and backups. Paging and changed-history updates reduce transfer and
  rebuild work, but do not cap a very heavy account's total browser memory or
  IndexedDB usage. History retention/on-demand statistics require a separate
  product decision if long-history tests exceed device budgets.
- Roster/goal/import/activity metadata is scoped but not individually paged.
  Very large single organizations or lifetime activity collections need explicit
  bounds or further paging if measured responses exceed the budget.
- The legacy `get_workspace` endpoint remains for small installed-client scopes.
  It now fails explicitly above its row/byte budget and uses indexed tenant
  selection. Retire its browser grant after the upgrade window. Raw table SELECT
  is closed; integrations must use authorized RPCs instead of relation scans.
- Tombstones and hashed operation receipts are durable integrity records, not
  disposable caches. Do not prune them merely to shrink the database. Any future
  retention/partitioning policy needs explicit replay and offline-retry analysis.

## Rollout and rollback

Deploy the complete existing migration chain plus:

- `202611120002_scale_foundations.sql`
- `202611120003_paged_sync.sql`
- `202611120004_admin_directory.sql`
- `202611120005_incremental_uploads.sql`
- `202611120006_indexed_event_validation.sql`
- `202611120007_workspace_query_context.sql`
- `202611120008_cached_workspace_plans.sql`
- `202611120009_indexed_goal_scope.sql`
- `202611120010_bounded_legacy_workspace.sql`
- `202611120011_rpc_read_boundaries.sql`
- `202611120012_cached_permission_plans.sql`
- `202611120013_workspace_manifest_check.sql`
- `202611120014_indexed_foreground_claim.sql`
- `202611120015_coalesce_practice_evaluation.sql`
- `202611120016_service_request_context.sql`
- `202611120017_reference_indexes.sql`
- `202611120018_bounded_rate_cleanup.sql`
- `202611120019_award_cache_validation.sql`
- `202611120020_unchanged_award_writes.sql`
- `202611120021_idle_achievement_jobs.sql`

Then deploy **both** `accounts` and `achievements` functions, reinstall
`supabase/achievement-scheduler.sql`, verify the private scheduler secrets, and
publish the frontend last. New frontend downloads intentionally fail if the new
RPC is absent; they never silently downgrade to the unbounded legacy endpoint.

```powershell
npx supabase db push --dry-run
npx supabase db push
npx supabase functions deploy accounts --use-api
npx supabase functions deploy achievements --use-api
npm test
npm run build
```

The old worker remains revision-safe during deployment; new worker lease APIs
must exist before the new function runs. Deploy the scheduler after the worker.
Old workers continue using their existing finish function during this rollout;
the new finish function independently retains the same commit fences.

For a later **semantic award-rule change**, sleeping jobs need an explicit refresh.
Pause the scheduler, deploy the new worker, and verify that old worker invocations
and their in-flight database requests have drained before selecting a cutoff.
Keep one database-generated cutoff for the entire refresh. Through an authorized
operator connection, obtain it once:

```sql
select clock_timestamp() as rules_refresh_cutoff;
```

Copy that exact value into the placeholder below and repeat the same call until
the JSON result says `remaining: false`. Never replace the fixed value with a new
`now()` on each batch. Each transaction changes at most 1,000 jobs; `updated: 0`
with `remaining: true` means eligible rows are locked and must be retried later.
The function is service-only, advances revisions to fence already-running work,
and does not alter practice source, receipts, or historical award identities.

```sql
select public.achievement_requeue_rules(
  'FIXED_CUTOFF_FROM_ABOVE'::timestamptz, 1000
);
```

Resume the scheduler after the bounded refresh has completed and inspect queue
age, failed leases and commit counts. A fixed cutoff is idempotent. Newly written
source still wakes its own job through the normal triggers during this process.

An application rollback can use the previous frontend; preserve new tables,
indexes, receipts, tombstones, account data, and offline databases. Do not drop
these migrations or clear browser storage as a rollback procedure. Reassess an
old worker's throughput before restoring an older scheduler configuration.

References: [PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html),
[statement snapshots](https://www.postgresql.org/docs/16/xfunc-volatility.html),
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Supabase production checklist](https://supabase.com/docs/guides/deployment/going-into-prod),
[Supabase compute/disk](https://supabase.com/docs/guides/platform/compute-and-disk),
[Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits),
[CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha),
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
