# Pitchwork

A mobile-first baseball and softball practice pitch tracker. Pitchwork uses React, TypeScript, Vite, Tailwind CSS, Dexie/IndexedDB, and Supabase. Admin-approved coaches sign in with email and password, manage their assigned teams, and share team practice history. After signing in and downloading the roster online, coaches can reopen and record practices offline; saved pitches sync when connectivity returns.

Production address: **https://count.twelvefs.com** (requires the GitHub Pages and DNS setup below).

## Use it on an iPhone

1. Configure Supabase and email/password login using [the account setup guide](docs/AUTH.md), then open **https://count.twelvefs.com** in Safari while online.
2. Use **Share → Add to Home Screen**. Choose **Open as Web App** if Safari offers that option.
3. Launch Pitchwork from its home-screen icon while still online. Open the save and sync status beside the page title and check for **Ready offline**.
4. Sign in with your approved account, create or join a team, assign pitchers, and start practice. Your PC does not need to be running.
5. In Settings, periodically **Download backup** and save the JSON file in Files or another location you can recover.

The ordinary browser and installed web app may have separate storage. Install first, then create your roster inside the installed app. Sign in with the same approved account to download shared records. Unsynced practices remain on their original recording device; reconnect that device to upload them.

### Verify on a physical iPhone

After installing, create a test pitcher and record a pitch. Close the app, enable airplane mode, reopen from the home screen, record another pitch, and close/reopen again. Confirm both pitches remain. Restore connectivity and verify backup download and file selection in Settings. Automated acceptance checks use Chromium; this device/Safari check must be completed on your phone.

## Run locally

Use Node.js 22.12+ or Node.js 24 LTS and npm.

```sh
npm install
# Copy .env.example to .env.local and set the public Supabase URL/key.
npm run dev
```

Open the local URL printed by Vite (normally http://localhost:5173). To try the layout on a phone connected to the same network, use the network URL Vite prints and allow the development server through your firewall if needed.

```sh
npm test             # Counting rules and persistent-storage tests
npm run typecheck    # TypeScript checks
npm run build        # Type checks and production build into dist/
npm run preview      # Serve the production build locally
```

Browser acceptance checks use Python Playwright and its Chromium browser (not application dependencies). Start Vite with the test-only public settings documented in `tests/auth_mock.py`, then run `python tests/browser_smoke.py`, `python tests/teams_browser.py`, `python tests/sync_feedback.py`, and `python tests/auth_ui.py`. Backend requests are intercepted in the browser; these fixtures do not bypass production authentication. `npm test` also runs the real SQL migrations and access rules in PGlite PostgreSQL. Set `PITCHWORK_BASE_URL` to test another server, such as the production preview. The scripts check scoring, storage recovery, keyboard controls, sync feedback, and layouts at 320, 390, 768, and 1440 pixels. Screenshots go into the ignored `.test-artifacts/` directory.

For actual service-worker and backup acceptance tests, build with the same test-only settings and run `python tests/pwa_backup.py` against a production preview on port 4174. To isolate test artifacts, pass `--outDir .test-artifacts/pwa-preview` to both Vite build and preview, and set `PITCHWORK_WORKER` to `.test-artifacts/pwa-preview/sw.js`. This checks offline close/reopen, file transfer between browser profiles, and a real waiting service-worker update. It temporarily edits only that ignored worker artifact and restores it afterward. The ordinary Vite development server deliberately does not register a service worker.

App icons can be regenerated from the existing mark with `python scripts/generate_icons.py` (requires Pillow; it is not needed to build or run the app).

## Practice workflow

1. In Roster → Teams, create teams and assign pitchers and coaches. A pitcher or coach can belong to multiple teams. Add pitchers with an optional jersey number and any number of team selections.
2. Start a named or unnamed practice and choose its team, or Independent for a private practice. Its team stays fixed. Each recording device has one active or paused practice; other coaches’ practices are read-only and do not block yours.
3. Each **BALL**, **STRIKE**, **FOUL**, and **IN PLAY** tile has four quadrants and a center circle. Tap a region to record both the outcome and pitch location in one action: upper left, upper right, lower left, lower right, or middle, from the **pitcher's view looking toward home plate**. Strike records a called strike; **Record swinging strike** records a swinging strike without a location. Locations appear in Recent pitches and session history; older pitches show “Not recorded.” Historical “in” locations remain on the left and “out” locations on the right, matching the original recording controls. Saved location keys are unchanged.
4. Walks, strikeouts, and balls in play automatically start the next batter. **Next batter** manually ends the current batter. **Reset count** retains the pitches and starts a new batter marked as a manual reset.
5. Changing pitchers manually ends the current batter and starts a fresh 0–0 count, including when returning to an earlier pitcher.
6. Undo reverses the latest recorded pitch in the entire session, selecting its pitcher. Automatic completions are reversed. Later manual boundaries are preserved. The undone event remains in the audit history.
7. Pause/resume as needed. End the session to move it into history. Notes can also be saved on historical sessions. Unsaved note drafts remain available when switching tabs within the app; save them before closing it.

Remove a pitcher from one team through its roster; their other memberships and historical practice references remain. Use **Remove** on a player, team, coach account, or practice to choose history-preserving removal or permanent deletion. Players can be archived after active roster assignments are removed; teams and ended practices can also be archived and reactivated. Archived records remain in history and statistics. End related ongoing practices before archiving players or teams. Only admins may suspend or delete coach accounts; suspension prevents sign-in while preserving history. Delete related practices individually before permanently deleting a player, team, or coach. Permanent deletion requires typing the displayed name or email and cannot be undone. Assigned coaches can delete ended practices within their teams. Shared players require ownership, admin access, or management access to every assigned team for global removal; otherwise remove the team assignment. Active teams must retain an active coach. Save notes and sync changes before removal. There are no application-imposed limits on pitchers, teams, or sessions; available browser storage is the practical limit.

## Statistics

- **Pitch count:** every recorded, non-undone pitch, including every two-strike foul.
- **Batter count:** four balls produce a walk; three strikes produce a strikeout. Fouls advance strikes only below two strikes. In play ends the batter. Foul bunts are not supported in Phase 1.
- **Positive strike outcomes:** called strikes, swinging strikes, all fouls, and balls in play.
- **Strike percentage:** positive strike outcomes / total pitches × 100.
- **First-pitch strike percentage:** batters whose first pitch was a positive strike outcome / batters with at least one pitch × 100.
- **Batters faced:** plate appearances with at least one non-undone pitch, including manually ended appearances.
- **Walk percentage:** walks / batters faced × 100.
- **Pitches per batter:** total pitches / batters faced.
- Empty denominators display “—”. Manually ending, switching, resetting, or ending a practice never creates a walk or strikeout.

### Goals and player accounts

Statistics supports ongoing targets for all ten summary measures. Select a team to set staff targets, or a pitcher to view individual targets. Use **Set goal / Edit goals** beside a measure; smaller text shows each target and the current result’s difference. Date, source, and roster filters change the comparison, not the saved target. Percentage differences are percentage points. Missing data cannot meet a goal; Combined retains its coverage and estimate notices. Balls and positive-strike counts are unavailable for Games and for Combined when game totals contribute.

Assigned coaches (or the admin) edit team standards and team-specific coach targets for individual pitchers. Linked players edit their own personal targets, shared across teams and data sources. Team rate standards apply to pitchers as well as the staff; team count targets measure staff totals. A personal target that is less demanding than any active team standard or coach target displays a warning but can still be saved. Opposing count directions are labeled as different target directions.

In **Settings → Accounts & access**, the admin can create a **Player** account and choose its existing pitcher. Each account links to one pitcher, and each pitcher can have one player account. Team access follows that pitcher’s active memberships; links never confer coaching permissions. Players open on their own Statistics and can view teammates’ statistics and goals. Roster management, imports, restore, and coach targets remain restricted to coaches. Player practice recording is limited to their own independent practices.

Goal editing requires connectivity. Downloaded targets and comparisons remain readable offline. Concurrent changes produce **Refresh goal** instead of overwriting someone else’s edit. Archiving preserves targets; removing a roster membership ends its team access and warnings. Permanent team/pitcher deletion removes dependent targets. Backups export version 5, include goals, and still accept versions 1–4. Restored copies never restore account links; restored personal goals need a linked player before editing.

Deploy `202610210004_goals_players.sql` and `202610210005_player_practices.sql`, then the updated accounts function, before publishing the frontend:

```sh
npx supabase db push --dry-run
npx supabase db push
npx supabase functions deploy accounts --use-api
npm test
npm run build
```

`python tests/goals_browser.py` uses the mocked Supabase Vite environment from `tests/auth_mock.py`. It checks inline editing, warnings, conflicts, offline controls, teammate visibility, account linking, and 320/390/768/1440-pixel layouts. SQL authorization tests run through `npm test`.

### Pitch locations and date ranges

Statistics defaults to **All time + All pitches**, combining all history available to the signed-in coach, including archived practices and pitchers. The five-region heat map shows counts and percentages from the pitcher's view. Choose **Balls**, **Strikes** (called and swinging), **Fouls**, or **In play** to examine one outcome without changing the summary statistics. Each pitcher in session review also has an independent map for their complete session.

Percentages use only pitches with a recorded location for the selected outcome. “Locations recorded for X of Y pitches” shows coverage, including older or swinging-strike records without a location. Undone pitches are excluded. Every view uses the same 0–100% color scale and identifies the most frequent region, including ties. Ball locations show where pitches ended up; measuring misses from a target would also require recording the intended target. No exact coordinates or batter handedness are inferred.

The Statistics date filter applies to summary metrics, the map, and the session list, intersecting with pitcher, team, and session-scope selections. **This week** begins Sunday and ends today; **Last week** is the previous Sunday–Saturday; **Last two weeks** includes today and the preceding 13 days; **Last month** is the previous complete calendar month. **Custom range** requires both inclusive dates and an explicit **Apply**; invalid or unapplied edits retain the previously applied range. The displayed dates use the viewer's local calendar and each practice's start date, including all of that practice's pitches even if recording crosses midnight. Filters remain selected during navigation and reset to their defaults on a fresh app load. Session-review maps always show the complete selected session.

Run `python tests/statistics_browser.py` against the mocked Supabase Vite environment described in `tests/auth_mock.py` for heat-map/date acceptance checks. Run `tests/pitch_locations.py` with `PITCHWORK_AUTH_FIXTURE=1` for recording-target and backup-location regression checks. Both cover layouts at 320, 390, 768, and 1440 pixels, with screenshots in `.test-artifacts/`.

## GameChanger season summaries

Open account settings using your coach profile button (or Settings), expand **GameChanger imports**, and choose a CSV. Export standard stats from GC with all intended games included, then choose the destination team, confirm the season name and coverage dates, and match each participating pitcher. Name and jersey suggestions require confirmation; confirmed matches are remembered. You can create a pitcher or skip a row explicitly. Review totals and warnings before importing. Import controls and saved-summary management live in account settings.

Each team/season has one current summary. An unchanged export is detected even when renamed or reordered. **Replace summary** replaces the entire summary, including removal of omitted players; decreased totals are allowed for GC scoring corrections. Coverage labels are supplied by the coach because the CSV does not identify its games or date range. Imports require an online approved coach assigned to the team (or an admin). Saved summaries can be read offline and removed in Settings.

Statistics defaults to **All teams**, **All pitchers**, **All time**, and **Combined**. Its shared controls are ordered Team, Pitcher, Date range, Source; the same selections apply to Combined, Practice, and Games. Choosing a team narrows the pitcher list to its current roster and historical practice/import references, including archived pitchers. An incompatible pitcher selection resets to All pitchers. Source and team changes never change the date filter.

There is no season selector in Statistics. All imported summaries fully covered by the selected dates contribute automatically. Summaries with overlapping coverage for the same team and selected pitcher population are excluded, with a notice directing coaches to correct coverage or remove duplicates in account settings. Non-conflicting games and practice results remain available. A partial date range excludes GC rather than prorating its totals; **Show all time** explicitly clears that date restriction. Without eligible game data, Combined still shows practice results. Combined counts use selected pitcher rows; GC's reported team Totals remain in **Data coverage & calculation notes**. Game-only metrics and raw values are under **Game details**. Games pitched are never summed into unique team games.

Combined strike and first-pitch strike rates are **estimates**, weighted by GC pitches and batters faced respectively. Missing rates display as unavailable. Practice/game scoring definitions can differ. Innings, ERA, WHIP, and other game-only values stay in the GC detail view. Summaries create no synthetic pitches, appearances, or locations; heat maps and pitch-outcome breakdowns continue to use practice events. Season totals cannot reconstruct individual games, partial-period trends, or daily workload.

JSON backups now use version 5 and include goals, summaries, and remembered mappings. Versions 1–4 still restore. Production restore creates new copies with remapped team/player references and preserves existing records. Remove related summaries before permanently deleting a referenced team or pitcher; archiving retains them.

Deploy the backend **before** publishing the new frontend:

```sh
npx supabase db push --dry-run
npx supabase db push
npm test
npm run build
```

The incremental `202610210002_gamechanger.sql` migration adds permission-checked, atomic imports with revision conflict detection and operation receipts. `202610210003_gamechanger_workspace.sql` ensures roster and summary reads remain consistent during concurrent imports. The frontend stays local until committed/published through the usual deployment workflow. Unit and PostgreSQL coverage runs through `npm test`. Browser acceptance is `python tests/gamechanger_browser.py` using the test-only Vite settings documented above (set `PITCHWORK_BASE_URL` to the server URL).

Run `python tests/statistics_filters_browser.py` in the same test environment to verify defaults, dependent pitcher choices, automatic summary selection, overlap handling, account import placement, and responsive filter layouts. The filter simplification requires no database migration.

## Storage and architecture

- `src/domain.ts`: pure event replay and metrics, independent of React and IndexedDB.
- `src/storage.ts`: account-scoped IndexedDB tables, team memberships, source events, and a durable upload queue. Each scoring transaction commits its practice and upload together. Pending snapshots coalesce; in-flight operations keep stable IDs and server revisions for safe retry.
- `src/cloud.ts` and `supabase/migrations/`: authenticated team management, row-level access rules, and atomic practice uploads. Practice history is scoped to its recorded team, not the pitcher’s current roster.
- `src/AuthGate.tsx`: Email/password authentication, admin approval, account isolation, and offline reopening. See [account/backend setup](docs/AUTH.md).
- `src/App.tsx`: coaching screens and an ordered command queue. Actions become “saved” after the IndexedDB transaction commits. Failed actions stop the queue; Retry preserves their order. Discard unsaved actions cancels only uncommitted queued work.
- Appearance rows are materialized from source events within the same transaction. Statistics are derived, not stored as authoritative totals.

Locally saved data belongs to this browser profile and origin (protocol, hostname, and port). Synced team data is available to its assigned coaches; independent practices stay private to their recorder. Use the final custom domain consistently. Clearing browser/site data removes both records and offline caches. Settings can request persistent storage where supported, but browser protection does not replace an external backup. The source repository and hosted frontend are public; practice records are stored in the private Supabase database and protected by current account status and team membership. Browser bundles contain only public connection settings.

The single save and sync indicator beside the page title reports **All changes synced**, pending uploads, offline status, unsaved notes, or errors. Expand it to see local saves, team sync, connection, and offline readiness separately, or choose **Refresh & sync** to retry. Both automatic and manual sync show **Syncing…**, disable repeated taps while running, and display the result below the button. After 15 seconds, a slow sync shows **Taking longer than expected…**. Errors appear in a red notice and inside the sync details; saved device data remains separate from team sync. Legacy event-ordering uploads are sorted and retried once only after the server explicitly rejects them with **Recorded events cannot change**; uncertain uploads retain their original payload for safe retry. A rejected upload is preserved for recovery; Settings can export unsynced work before clearing blocked uploads. An available update waits for your explicit action. Pause or end practice, save all notes, let pending saves finish, and close forms or restore previews before choosing **Update app**. App updates preserve the IndexedDB database.

## Backup, transfer, and recovery

In Settings, choose **Download backup**. Version 4 includes teams, pitchers, team–pitcher memberships, practice team/recorder attribution, notes, locations, original source events including undo history, and GameChanger summaries and player mappings. Account credentials, invitations, and coach access grants are excluded. Versions 1–3 are normalized when read.

Import requires an online approved coach account. Choose **Restore from a JSON backup**, review the preview, confirm that separate copies will be imported, and choose **Import backup copies**. The server creates fresh IDs and new teams assigned only to the importing coach. Existing shared records stay intact, and imported practices are read-only history. Source appearances are rebuilt rather than trusted from the file. Imports are atomic and use a stable request ID for safe retry.

Use ordinary synchronization to continue a practice on its original recording device. A backup import does not transfer recording ownership. For uploads rejected after membership changes or a revision conflict, choose **Export unsynced work** before removing recovered blocked uploads. If an account is suspended, the locked sign-in screen still offers export of its isolated pending work.

## GitHub Pages deployment

Repository: **https://github.com/ejstover/pitchcount**. The blog repository remains independent.

- Create the repository as **public**, with `main` as its default branch, and push this application's source.
- In repository Settings → Pages, set the source to **GitHub Actions**.
- Set the custom domain to **count.twelvefs.com before adding its DNS record**.
- Configure Supabase, the Email provider, the account creation hook, and the initial admin first using [docs/AUTH.md](docs/AUTH.md). Set repository Actions variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; never put an administrative key into a frontend variable.
- The deployment workflow checks tests, TypeScript, and the production build before publishing successful `main` builds. Pull requests run checks without deploying.
- Vite, the manifest, and the service worker use `/` as their base because the app lives at the root of the dedicated subdomain. Do not use the temporary `/pitchcount/` project URL as an installation or data-storage address.

At the existing DNS provider, add only this record:

| Type | Name | Target |
|---|---|---|
| CNAME | `count` | `ejstover.github.io` |

Do not include the repository name in the DNS target. If the provider asks for a full hostname, use `count.twelvefs.com`. No blog, apex-domain, or nameserver changes are required.

After DNS resolves, wait for GitHub's certificate to become available and enable **Enforce HTTPS** in Pages settings. Verify the custom address, app assets, `/manifest.webmanifest`, `/sw.js`, and offline readiness. GitHub documents the process at https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site.

Useful checks from an authenticated GitHub CLI:

```sh
gh run list --repo ejstover/pitchcount
gh api repos/ejstover/pitchcount/pages
```

On Windows, check DNS with `Resolve-DnsName count.twelvefs.com -Type CNAME`. Certificate issuance and DNS propagation may require additional time after the record is added.

## Later phases

- **Phase 2:** trends, comparisons, editable global/per-pitcher coaching goals, and CSV exports. Initial coaching targets: 65% overall strikes, 60% first-pitch strikes, and walks below 10%.
- Installation, offline reopening, and JSON backup/restore have been brought forward from Phase 3. Further mobile polish remains iterative.

Simultaneous recording into the same practice and additional sign-in providers are outside this version.


## Deploying removal support

Deploy backend changes before publishing the new frontend:

```sh
npx supabase db push
npx supabase functions deploy accounts --use-api
npm test
npm run build
```

The incremental `202610210001_removal.sql` migration adds archive metadata, permission-checked removal, and private deletion markers. Existing upload/restore receipts are reduced to hashes so permanent deletion does not leave historical content in receipts. Deleted IDs cannot be recreated by stale save requests or uploads. Rejected offline work stays available through recovery export. Account deletion removes application access before deleting the authentication user; if authentication cleanup fails, use **Finish account deletion** in account administration to retry.

Backups export version 4 with team/practice archive state and GameChanger summaries; versions 1 and 2 still import with those records active, and version 3 preserves archive state. Import creates fresh IDs in the shared workspace. Previously exported backup files remain independent copies.
