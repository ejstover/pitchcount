# Pitchwork option 3 — design QA

final result: passed

## Target and evidence

Selected target: the user's reattached option 3, matching `exec-4eae6812-ad04-47fa-aff7-e1d1badaba40.png` in this chat's generated images. This is the light horizontal-navigation Practice start screen. Implementation: the existing production app components, rendered through the isolated `.test-artifacts/design-preview/index.html` entry point with sample records. No production data or authentication was changed for verification.

The source image is 1487 × 1058 pixels. The desktop browser CSS viewport was 1488 × 1056 at devicePixelRatio 1; its screenshot output was 1473 × 1045. The source was normalized to the screenshot dimensions for a joint comparison. Both artifacts show Practice before starting, with Riverhawks/Avery selected, five recent practices, and healthy sync status.

- Full comparison: [.test-artifacts/design-qa/comparison-final.png](.test-artifacts/design-qa/comparison-final.png), source left / implementation right.
- Readable focused comparison: [.test-artifacts/design-qa/comparison-detail-final.png](.test-artifacts/design-qa/comparison-detail-final.png), source above / implementation below.
- Rendered desktop: [.test-artifacts/design-qa/desktop-final.jpg](.test-artifacts/design-qa/desktop-final.jpg).
- Phone start screen: [.test-artifacts/design-qa/phone-start.jpg](.test-artifacts/design-qa/phone-start.jpg).
- Phone roster: [.test-artifacts/design-qa/roster-phone-final.jpg](.test-artifacts/design-qa/roster-phone-final.jpg).
- Scoring at additional widths: `active-320-final.jpg`, `active-768.jpg`, `active-1440.jpg` in the same evidence folder. The final 320px capture confirms the single-column pitch log and two-column compact metrics after repair. These captures exercise functionality; their data/state differ from the static start-screen reference.

## Iteration findings and resolution

1. P2, desktop layout: the first capture's maximum width pulled content farther inward than the reference. Increased the desktop content maximum and aligned the header/page gutters. The final joint comparison confirms the common left edge and full-width form/table composition.
2. P2, typography: the initial session names and supporting text were undersized against the target. Increased table/name text, navigation, supporting copy, and status text; the focused final comparison confirms readable hierarchy and balanced form sizing.
3. P2, phone supporting content: an inherited two-column pitch-log rule cramped location text at 320px. Restored a single-column log and two-column compact metrics below the scoring controls.
4. P2, accessibility: the nested status span left the native status disclosure without a dependable accessible name in the browser accessibility tree. Added a name containing the current status and “Save and sync details.” Verified the named expanded/collapsed control and separately labeled device/sync/network/offline rows.

No actionable P0/P1/P2 visual issues remain in the final compared start screen or inspected responsive states.

## Required fidelity surfaces

- **Fonts/typography:** self-hosted DM Sans for UI, Georgia for page titles; restrained green text, readable 14–20px working text, clear serif title. Font-family values verified in-browser. All four font weights are local and included in the service-worker cache.
- **Spacing/layout:** horizontal desktop header, large page title, three aligned setup controls, flat session table, subtle dividing rules, no marketing hero or permanent instructional cards. Optional practice naming adds a small disclosure/vertical gap to retain existing functionality. Mobile uses stacked setup controls and the existing bottom-navigation model. No horizontal overflow at 320, 390, 768, or 1440px in the checked states.
- **Colors/tokens:** warm off-white `#faf9f6`, evergreen text/actions, muted green-gray rules, limited lime on the account initials. Status color conveys pending/error alongside explicit text. Kept the real app's scoring colors for fast outcome recognition.
- **Images/assets:** the reference has no photography or decorative raster assets. Reused the product's existing wordmark, initials, and vector icon system. No generated screenshot was used as a functioning UI background. No additional raster-asset generation was needed.
- **Copy/content:** removed repeated device-storage reassurance and decorative slogans from the app shell. One status summary exposes separate local/save/network/readiness details. Preserved unsaved-note warnings, save failures, sync errors, offline status, update notices, archive/removal controls, backups, and private Independent practice defaults. Preview records are fictional samples; production uses repository data.

## Interaction and responsive checks

Verified in the in-app browser: team and pitcher selection; optional practice naming; inline Start practice; pitch/location recording and updated batter count; Undo; Pause/Resume and disabled scoring while paused; unsaved-note status; saving notes and reload persistence; save/sync disclosure; Roster search; Pitchers/Teams navigation; Statistics and Settings navigation; recent/session-history entry controls. Only isolated sample records were modified.

At 320/390/768/1440px, checked rendered document width against viewport and visible button/input/select/summary heights. No checked control was below 48 CSS px, and all 20 pitch targets met 48px in both dimensions. At 390 × 844 the Undo action was above the fixed navigation. Full-page mobile captures include the fixed navigation at its viewport position; content remains scrollable with bottom clearance.

## Accepted differences and limits

- P3: original app icons and brand mark differ slightly from the generated image; retained them for product consistency. Native select chevrons remain platform-specific.
- Optional practice naming is retained behind a disclosure. Jersey numbers remain in pitcher selections. Independent/private remains the initial team choice; the comparison explicitly selected Riverhawks to match the reference.
- This is a responsive web application. It retains phone bottom navigation and the complete scoring experience rather than shrinking the desktop mockup.
- The Python browser regression scripts were updated for inline setup, named navigation, and the separate local-save state; syntax was checked. Verification here used the in-app browser, not those standalone Playwright runners.
- Physical Safari/iPhone, installed-PWA offline reopening, authentication, and live server sync were not re-tested in this visual pass. The isolated preview uses a sample gateway and does not establish those integration claims.

## Validation

- Latest full Vitest run: 138 tests passed, 8 files passed.
- TypeScript and production build passed; final build verification recorded in the task tool results.
- Review checklist: selected visual matched; desktop and phone inspected; core actions exercised; reference/implementation compared together; required fidelity surfaces checked; only accepted P3 differences remain.
