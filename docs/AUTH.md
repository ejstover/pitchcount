# Email/password login and approved accounts

Pitchwork uses Supabase's free tier for authentication, accounts, and shared team records. Each user's email is their username. Only the admin creates accounts; approved coaches manage and record practices for assigned teams. Google, Facebook, and passkeys are not required.

Supabase stores salted bcrypt hashes, never plaintext passwords. Pitchwork sends passwords directly to Supabase over HTTPS and never stores them in its database tables, browser storage, backups, or logs. The setup form requires at least 15 characters and at most 72 UTF-8 bytes to avoid bcrypt truncation. Set the project's server-side minimum length to 15 too. Do not enable paid password-security add-ons unless desired.

## Hosted project setup

1. Create a Free project at https://supabase.com/dashboard. Copy the project URL and publishable key from **Connect** or **Settings → API Keys**. Keep the database password and administrative keys private.
2. From the repository, run `npx supabase login`, `npx supabase link --project-ref YOUR_PROJECT_REF`, and `npx supabase db push` to install the account/team tables, access policies, and admin-only provisioning functions.
3. In **Authentication → Hooks**, enable **Before User Created** using `public.before_user_created`. The hook permits only the exact UUID allocated by the server's account-creation API, preventing unauthorized signup, including a race using an approved email. Requests alone do not create users.
4. Enable the Email provider. Disable Google and anonymous sign-ins. Keep manual identity linking disabled. Leave email confirmation enabled. Admin-created accounts are confirmed by the privileged API; the admin must deliver each setup link privately to the corresponding email owner. The before-user-created hook, not an open signup form, controls account creation.
5. Set **Authentication → URL Configuration → Site URL** to `https://count.twelvefs.com`; allow `https://count.twelvefs.com/`, `http://localhost:5173/`, and `http://127.0.0.1:5173/` as redirect URLs. Verify the production site's HTTPS certificate before using password login. Never bypass a certificate warning.
6. Under **Edge Functions → Secrets**, set `ALLOWED_ORIGINS` to `https://count.twelvefs.com,http://localhost:5173,http://127.0.0.1:5173`, `APP_URL` to `https://count.twelvefs.com/`, and `REQUEST_RATE_SALT` to a long random secret. The accounts function reads the injected `SUPABASE_SECRET_KEYS` default key, falling back to the legacy service-role environment variable for older projects. These keys never enter the frontend.
7. Deploy with `npx supabase functions deploy accounts --use-api`. Its gateway JWT check is disabled because account requests are public; every other action verifies the token with `auth.getUser()` and checks the current active account, confirmed email, and database privileges. Private account responses have `Cache-Control: no-store`.

## Create the admin

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a private terminal environment. Despite its compatibility name, the latter may contain a current `sb_secret_` key. Then run:

```sh
node scripts/bootstrap-admin.mjs your-email@example.com "Your name"
```

The script creates the one approved admin and prints a private, expiring, single-use password setup link. Open it using the correct HTTPS site and choose your password. Repeat the command to create a fresh admin reset link if needed; it will not create a second admin. Remove the administrative key from the terminal environment afterward. Never commit the printed link or secret key. No paid SMTP service or Google Cloud project is needed.

For local testing, set `PITCHWORK_APP_URL=http://localhost:5173/` before generating a link. An entirely local Supabase stack also requires Docker and `supabase start`/`supabase db reset`. `supabase/config.toml` enables Email and disables Google for that stack. Set local function secrets through an ignored file passed to `supabase functions serve accounts --env-file PATH`.

## Requests, setup, and password resets

- A user submits their name, email, and requested team through **Request an account**. Passwords are not collected with requests. Duplicate, already-approved, and rate-limited requests return the same generic confirmation. The public endpoint accepts at most five requests per hashed client IP per hour.
- The admin opens **Settings → Accounts & access**, reviews the request, selects teams, and creates the coach account. The response displays a private setup link. Copy it and share it only with that email's owner through a trusted channel. Approval emails are not sent automatically.
- Setup links place their credential in the URL fragment, which browsers do not send in HTTP requests. The page removes the fragment from browser history; the token is redeemed only when the user submits matching, valid passwords. Opening the page alone does not consume it. Supabase handles one-time use and expiration (set the Email OTP expiry to 3600 seconds for one-hour links). Creating a new recovery link invalidates the previous recovery token.
- **Forgot your password?** tells users to contact the admin. In the account list, **Create password link** generates another setup/reset link. Suspended users cannot receive an admin-generated link until reactivated. Admin can generate a reset link for their own account too, or use the bootstrap command if locked out. No passwords are shown to or selected by the admin.
- Suspension and team changes are enforced by database policies on each data request. You cannot suspend or remove the last active assigned coach of a team until another coach is assigned.

If automated password-reset emails are desired later, configure custom SMTP in Supabase and add an email-reset request flow. The default Supabase mail sender is limited to organization-team addresses; this release uses manually shared setup links and does not require it.

## Frontend and GitHub Pages

Create `.env.local` in the project folder:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

This local file is ignored by Git. For the published build, add the same two public values under the repository's **Settings → Secrets and variables → Actions → Variables**. Administrative keys and setup links must never be put in `VITE_` variables. Build and publish only after backend deployment, admin setup, and HTTPS are ready. Missing configuration shows an error instead of unlocking the app.

## Offline use and verification

First sign-in and first team download require internet. Afterward, the last approved identity can reopen downloaded records offline, including after its online token expires. The cached approval must match the stored session's user ID. Account/team access is rechecked on startup, reconnect, focus, and every 30 seconds while visible. Explicit sign-out clears the account cache and is blocked until pending practices are synced or recovered. Suspended users' pending work remains available only through the locked screen's recovery export.

`npm test` checks the real database migrations and authorization rules in PGlite. Browser fixtures in `tests/auth_mock.py` exercise password login, private setup, expired/reused links, admin creation, account isolation, and offline reopening. They do not create a production authentication bypass. Run `tests/auth_ui.py` against a Vite server using the fixture settings documented in that helper; production PWA checks also set `PITCHWORK_PWA=1`.

Before broad use, verify the real setup link/password flow and installed PWA on a physical iPhone. Free-tier limits or project pausing may affect online access; external backups remain useful. No paid plan is enabled by this code.
