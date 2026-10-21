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

Browser acceptance checks use Python Playwright and its Chromium browser (not application dependencies). Start Vite with the test-only public settings documented in `tests/auth_mock.py`, then run `python tests/browser_smoke.py`, `python tests/teams_browser.py`, and `python tests/auth_ui.py`. Backend requests are intercepted in the browser; these fixtures do not bypass production authentication. `npm test` also runs the real SQL migrations and access rules in PGlite PostgreSQL. Set `PITCHWORK_BASE_URL` to test another server, such as the production preview. The script checks scoring, storage recovery, keyboard controls, and layouts at 320, 390, 768, and 1440 pixels. Screenshots go into the ignored `.test-artifacts/` directory.

For actual service-worker and backup acceptance tests, build with the same test-only settings and run `python tests/pwa_backup.py` against a production preview on port 4174. To isolate test artifacts, pass `--outDir .test-artifacts/pwa-preview` to both Vite build and preview, and set `PITCHWORK_WORKER` to `.test-artifacts/pwa-preview/sw.js`. This checks offline close/reopen, file transfer between browser profiles, and a real waiting service-worker update. It temporarily edits only that ignored worker artifact and restores it afterward. The ordinary Vite development server deliberately does not register a service worker.

App icons can be regenerated from the existing mark with `python scripts/generate_icons.py` (requires Pillow; it is not needed to build or run the app).

## Practice workflow

1. In Roster → Teams, create teams and assign pitchers and coaches. A pitcher or coach can belong to multiple teams. Add pitchers with an optional jersey number and any number of team selections.
2. Start a named or unnamed practice and choose its team, or Independent for a private practice. Its team stays fixed. Each recording device has one active or paused practice; other coaches’ practices are read-only and do not block yours.
3. Each **BALL**, **STRIKE**, **FOUL**, and **IN PLAY** tile has four quadrants and a center circle. Tap a region to record both the outcome and pitch location in one action: top left is up/in, top right is up/out, bottom left is down/in, bottom right is down/out, and the circle is down the middle. Strike records a called strike; **Record swinging strike** records a swinging strike without a location. Locations appear in Recent pitches and session history; older pitches show “Not recorded.”
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

## Storage and architecture

- `src/domain.ts`: pure event replay and metrics, independent of React and IndexedDB.
- `src/storage.ts`: account-scoped IndexedDB tables, team memberships, source events, and a durable upload queue. Each scoring transaction commits its practice and upload together. Pending snapshots coalesce; in-flight operations keep stable IDs and server revisions for safe retry.
- `src/cloud.ts` and `supabase/migrations/`: authenticated team management, row-level access rules, and atomic practice uploads. Practice history is scoped to its recorded team, not the pitcher’s current roster.
- `src/AuthGate.tsx`: Email/password authentication, admin approval, account isolation, and offline reopening. See [account/backend setup](docs/AUTH.md).
- `src/App.tsx`: coaching screens and an ordered command queue. Actions become “saved” after the IndexedDB transaction commits. Failed actions stop the queue; Retry preserves their order. Discard unsaved actions cancels only uncommitted queued work.
- Appearance rows are materialized from source events within the same transaction. Statistics are derived, not stored as authoritative totals.

Locally saved data belongs to this browser profile and origin (protocol, hostname, and port). Synced team data is available to its assigned coaches; independent practices stay private to their recorder. Use the final custom domain consistently. Clearing browser/site data removes both records and offline caches. Settings can request persistent storage where supported, but browser protection does not replace an external backup. The source repository and hosted frontend are public; practice records are stored in the private Supabase database and protected by current account status and team membership. Browser bundles contain only public connection settings.

The single save and sync indicator beside the page title reports **All changes synced**, pending uploads, offline status, unsaved notes, or errors. Expand it to see local saves, team sync, connection, and offline readiness separately, or choose **Refresh & sync** to retry. A rejected upload is preserved for recovery; Settings can export unsynced work before clearing blocked uploads. An available update waits for your explicit action. Pause or end practice, save all notes, let pending saves finish, and close forms or restore previews before choosing **Update app**. App updates preserve the IndexedDB database.

## Backup, transfer, and recovery

In Settings, choose **Download backup**. Version 2 includes teams, pitchers, team–pitcher memberships, practice team/recorder attribution, notes, locations, and original source events including undo history. Account credentials, invitations, and coach access grants are excluded. Version 1 files are normalized when read.

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

- **Phase 2:** trends, date filters, comparisons, editable global/per-pitcher coaching goals, and CSV exports. Initial coaching targets: 65% overall strikes, 60% first-pitch strikes, and walks below 10%.
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

Backups export version 3 with team/practice archive state; versions 1 and 2 still import with those records active. Import creates fresh IDs in the shared workspace. Previously exported backup files remain independent copies.
