# Pitchwork

A mobile-first baseball and softball practice pitch tracker. Pitchwork runs entirely in your browser, with React, TypeScript, Vite, Tailwind CSS, and Dexie/IndexedDB. No account or backend is required. After one successful online setup, it can reopen and record practices offline.

Production address: **https://count.twelvefs.com** (requires the GitHub Pages and DNS setup below).

## Use it on an iPhone

1. Open **https://count.twelvefs.com** in Safari while online.
2. Use **Share → Add to Home Screen**. Choose **Open as Web App** if Safari offers that option.
3. Launch Pitchwork from its home-screen icon while still online. Wait for **Ready offline** in the connection strip.
4. Add your roster and start practice. Your PC does not need to be running.
5. In Settings, periodically **Download backup** and save the JSON file in Files or another location you can recover.

The ordinary browser and installed web app may have separate storage. Install first, then create your roster inside the installed app. If you already have records in the browser or on your PC, use backup/restore to move them into the installed app.

### Verify on a physical iPhone

After installing, create a test pitcher and record a pitch. Close the app, enable airplane mode, reopen from the home screen, record another pitch, and close/reopen again. Confirm both pitches remain. Restore connectivity and verify backup download and file selection in Settings. Automated acceptance checks use Chromium; this device/Safari check must be completed on your phone.

## Run locally

Use Node.js 22.12+ or Node.js 24 LTS and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://localhost:5173). To try the layout on a phone connected to the same network, use the network URL Vite prints and allow the development server through your firewall if needed.

```sh
npm test             # Counting rules and persistent-storage tests
npm run typecheck    # TypeScript checks
npm run build        # Type checks and production build into dist/
npm run preview      # Serve the production build locally
```

Optional browser acceptance checks use Python Playwright and its Chromium browser (not application dependencies). With the development server running, run `python tests/browser_smoke.py`. Set `PITCHWORK_BASE_URL` to test another server, such as the production preview. The script checks scoring, storage recovery, keyboard controls, and layouts at 320, 390, 768, and 1440 pixels. Screenshots go into the ignored `.test-artifacts/` directory.

For actual service-worker and backup acceptance tests, build the app, start `npm run preview -- --port 4174`, and run `python tests/pwa_backup.py`. This checks offline close/reopen, file transfer between browser profiles, and a real waiting service-worker update. It temporarily edits only the ignored `dist/sw.js` build artifact and restores it afterward. The ordinary Vite development server deliberately does not register a service worker.

App icons can be regenerated from the existing mark with `python scripts/generate_icons.py` (requires Pillow; it is not needed to build or run the app).

## Practice workflow

1. Add a pitcher, with an optional jersey number and team. Type an existing team name or create one while editing a pitcher.
2. Start a named or unnamed practice. Only one active or paused practice is allowed at a time.
3. Tap **BALL**, **STRIKE**, **FOUL**, or **IN PLAY**. Strike records a called strike; use **Record swinging strike** for a swinging strike.
4. Walks, strikeouts, and balls in play automatically start the next batter. **Next batter** manually ends the current batter. **Reset count** retains the pitches and starts a new batter marked as a manual reset.
5. Changing pitchers manually ends the current batter and starts a fresh 0–0 count, including when returning to an earlier pitcher.
6. Undo reverses the latest recorded pitch in the entire session, selecting its pitcher. Automatic completions are reversed. Later manual boundaries are preserved. The undone event remains in the audit history.
7. Pause/resume as needed. End the session to move it into history. Notes can also be saved on historical sessions. Unsaved note drafts remain available when switching tabs within the app; save them before closing it.

Pitchers can be archived and reactivated without losing their history. Change the selected pitcher or end the ongoing session before archiving that pitcher. There are no application-imposed limits on pitchers, teams, or sessions; available browser storage is the practical limit.

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
- `src/storage.ts`: versioned tables for teams, pitchers, sessions, appearances, and source events. UUIDs, UTC timestamps, and session sequence numbers support future migrations and synchronization.
- `src/App.tsx`: coaching screens and an ordered command queue. Actions become “saved” after the IndexedDB transaction commits. Failed actions stop the queue; Retry preserves their order. Discard unsaved actions cancels only uncommitted queued work.
- Appearance rows are materialized from source events within the same transaction. Statistics are derived, not stored as authoritative totals.

Data belongs to this browser profile and origin (protocol, hostname, and port). Use the final custom domain consistently. Clearing browser/site data removes both records and offline caches. Settings can request persistent storage where supported, but browser protection does not replace an external backup. The source repository and hosted app are public; individual practice records are never uploaded by the app.

The connection strip reports network status and offline readiness independently of **Saved on device**. An available update waits for your explicit action. Pause or end practice, save all notes, let pending saves finish, and close forms or restore previews before choosing **Update app**. App updates preserve the IndexedDB database.

## Backup, transfer, and recovery

In Settings, choose **Download backup**. The version 1 JSON format includes `format`, `version`, `exportedAt`, `teams`, `pitchers`, `sessions`, and `events`. Materialized plate appearances are rebuilt from source events rather than trusted from a file.

To move from localhost to the published address, or from PC to phone:

1. Export a backup from the browser that contains your records.
2. Transfer the JSON file to the destination device using your preferred file-transfer method.
3. Open the destination app and choose Settings → **Restore from a JSON backup**.
4. Review the pitcher/session/pitch totals. Export the destination's current records first if you want to keep them.
5. Confirm **I understand this replaces this device’s records**, then choose **Replace & restore**.

Restore validates the complete file before writing and replaces all records in one transaction. Failure leaves existing records intact. It preserves active/paused sessions, archived pitchers, notes, and undo history. Restore does not merge records or synchronize devices. To recover a previous state, restore the backup saved before replacement.

## GitHub Pages deployment

Repository: **https://github.com/ejstover/pitchcount**. The blog repository remains independent.

- Create the repository as **public**, with `main` as its default branch, and push this application's source.
- In repository Settings → Pages, set the source to **GitHub Actions**.
- Set the custom domain to **count.twelvefs.com before adding its DNS record**.
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

Permanent deletion, cloud sync, and authentication are outside Phase 1.
