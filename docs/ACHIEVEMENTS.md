# Player achievements

The executable catalog in `src/achievements/catalog.ts` defines 400 awards in 80
families. IDs 001–400 and family/tier artwork keys are stable. Definitions include
scope, evidence source, threshold, category and rule version. SVG artwork is
generated from the matching manifest in `src/achievements/art.ts`.

Browse [all 400 definitions](ACHIEVEMENT-CATALOG.md) and the
[artwork preview](achievement-awards-preview.svg). Regenerate both with
`node --experimental-strip-types scripts/generate_achievement_catalog.mjs`.

## Player experience

Awards opens the player clubhouse: Profile, My award goals, Activity log, Seasons,
and Collection. Three confirmed designs can be pinned. Filters expose all 400
designs without requiring the player to complete the collection. The player
defaults to their own Statistics; teammate statistics and ongoing coaching goals
remain shared within active teams, as separately requested. Achievement activity,
journals and awards remain private to the linked player.

Ongoing Statistics goals remain independent from dated achievement challenges.
Achievement targets are versioned for weekly, monthly or seasonal windows. Edits
start next window, pauses apply immediately, and resumed goals create a new
version. Walk-rate challenges use naturally completed batters; their denominator
differs from the existing all-batters Statistics walk rate. Pitch goals do not
create additional volume trophies above the capped calendar awards.

Players can record only their own independent practices. Start a target drill
before its pitches, select an intended region, then tap an actual outcome/location.
Target metadata becomes immutable with its source event. Completing or ending the
drill allows evaluation once practice ends. Other focus drills and personal
actions are self-reported, with one credit per type/local day. Rest must have been
planned before its date; creation timestamps captured offline are self-reported
device timestamps, not a medical or independently verified claim.

Weeks start Sunday in the saved player timezone; practices belong to their start
date. The first player setup saves the device timezone, which stays fixed to
preserve dated editions. Goal windows retain that timezone and rule version. A single primary season
can cover a date. Archived records continue to count. Restored copies use original
practice provenance to prevent duplicate credit; legacy recovered records without
provenance do not count. No GameChanger summary is expanded into practice events.

## Server confirmation and recovery

The same pure evaluator runs in the browser and Supabase Edge Function. Local
progress is provisional. Only server-confirmed awards can be exported, and sharing
waits for pending activity and source revisions to sync. Evaluator errors do not
block login or access to saved statistics.

Source mutations atomically advance a durable job revision. The worker reads the
source, calculates awards, and commits only if that revision still matches. It
preserves the first award timestamp and quietly withdraws unsupported awards after
corrections/deletion. Reinstatement preserves identity and is not celebrated again.
The client batches simultaneous unlocks; initial historical backfill is a single
collection load rather than hundreds of popups.

Activity operations have stable IDs, ordered revisions and operation receipts.
Conflicts retain pending work for Settings → Export unsynced work. The player
profile offers Use server version after export. Backup version 5 adds an optional
achievementRecords list while retaining existing goal-backup compatibility and
read support for versions 1–4. Credentials and account links are never restored;
award grants are recalculated from source evidence.

## Accounts and sharing

An approved coach who owns the pitcher, or the admin, can create a player username
from Awards. Admin account creation also supports usernames. A private, one-use
setup link lets the child choose a password; recovery uses the existing private
password-link flow. Synthetic internal authentication email addresses are never
used as social identities. The accounts function rate-limits public username
sign-in with salted IP/username buckets and uniform credential errors.

PNG generation accepts an AchievementDefinition only, never a player or award
instance. It draws the generic title, tier, requirement and brand into a fresh
canvas. Square cards are 1080×1080; story cards are 1080×1920. No personal names,
photos, notes, dates, account IDs, QR codes or public trophy links are included.
Device file sharing falls back to download. Nothing automatically posts to a
social account. Native social-app controls remain outside Pitchwork.

## Backend deployment

Deploy the backend before shipping the frontend. The required migration chain is
the existing coaching-goals/player-practice migrations followed by the three 20261022000x files.
`scripts/deploy_achievements.ps1` performs this deployment, creates the worker's
dedicated secret, installs its Vault-backed schedule, and removes temporary secret
files. Its `-DryRun` option checks pending migrations without deploying.

```powershell
npx supabase db push --dry-run
npx supabase db push
npx supabase functions deploy accounts --use-api
npx supabase functions deploy achievements --use-api
```

Both functions authenticate requests explicitly; their config sets verify_jwt=false.
Keep the existing ALLOWED_ORIGINS and REQUEST_RATE_SALT secrets. Generate a random
ACHIEVEMENT_WORKER_SECRET and set it as an Edge Function secret. In Supabase Vault,
store that same value as achievement_worker_secret and the full function endpoint
as achievement_worker_url. Run `supabase/achievement-scheduler.sql` once to install
the 15-minute cron job. That SQL never prints secret values. Re-running it replaces
the named schedule without duplicating jobs.

The scheduler evaluates at most 100 players per invocation, oldest due first.
Opening a player workspace also requests that player's evaluation. Existing
pitchers are queued by the migration, with no inferred goals or habits. Monitor
achievement_jobs.last_error, requested_at, evaluated_at, revision and
processed_revision for failed/stale work. These diagnostics contain identifiers,
not journal text or passwords.
`scripts/verify_achievements.sql` reports counts and access checks without player
content. `scripts/drain_achievements.sql` idempotently retries dirty jobs if a
source revision changed during backfill.

## Verification

`npm test` includes all SQL migrations in PGlite, all 400 positive catalog paths,
empty-evidence rejection, source/correction rules, and offline ordered outbox tests.
`npm run build` checks TypeScript and builds the PWA. Browser acceptance:

```powershell
$env:VITE_SUPABASE_URL='https://pitchwork-test.supabase.co'
$env:VITE_SUPABASE_PUBLISHABLE_KEY='sb_publishable_browser_test'
npm run build -- --outDir .test-artifacts/achievement-preview
$env:PITCHWORK_PWA='1'
$env:PITCHWORK_BASE_URL='http://127.0.0.1:5315'
# Start preview on 5315, then:
python tests/achievements_browser.py
```

The browser fixture mocks service calls, while SQL permission tests run real
PostgreSQL rules. Acceptance covers 320/390/768/1440 widths, all 400 designs, both
PNG sizes, real service-worker offline reopening, goal entry and target recording.
Physical iPhone sharing and Safari installation still require a device check.
