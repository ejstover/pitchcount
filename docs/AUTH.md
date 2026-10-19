# Google login and account administration

Pitchwork uses Supabase Auth and Postgres on the free tier, with the existing GitHub Pages frontend. The admin creates every account. Approved coaches can manage and record practices for their assigned teams. There are no Pitchwork passwords, automatic public signup, or approval emails.

Google is the initial provider. App-level Face ID/passkeys and Facebook are deferred. [Supabase passkeys](https://supabase.com/docs/guides/auth/passkeys) are currently experimental. Users may still use any authentication methods Google offers for their Google account.

## Configure the backend before deploying the frontend

1. Create a Supabase project. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started). Run `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, then `supabase db push` from this repository. This installs both numbered migrations, including RLS, account provisioning, and team/practice synchronization.
2. In **Authentication → Hooks**, enable the **Before User Created** hook, choosing the Postgres function `public.before_user_created`. This is essential: the hook only permits the exact UUID preallocated by an admin, and rejects direct signup even if someone knows an approved email. Local CLI configuration enables the same hook in `supabase/config.toml`.
3. Disable the Email authentication provider and anonymous sign-ins. Leave Google enabled. Keep manual identity linking disabled. Passwords and email-based signup must remain disabled. Do not disable all new-user creation globally: the admin API must be able to provision users.
4. Create a Web OAuth client in Google Cloud and configure its consent screen. Set the authorized JavaScript origin to `https://count.twelvefs.com`. Add the Supabase callback URL shown in its Google provider settings as an authorized redirect URI (normally `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`). Put the Google client ID and secret into Supabase's Google provider settings, never frontend files. Google apps in testing may require adding users to the consent screen's test-user list before sign-in works.
5. In Supabase's Auth URL configuration, set Site URL to `https://count.twelvefs.com` and allow redirect `https://count.twelvefs.com/`. For development, also allow `http://localhost:5173/` and `http://127.0.0.1:5173/`. The app uses PKCE and returns to the root URL so GitHub Pages does not need dynamic routes.
6. Set backend function secrets. `ALLOWED_ORIGINS` is a comma-separated list, initially `https://count.twelvefs.com`. Add local development URLs only when needed. Set `REQUEST_RATE_SALT` to a newly generated random secret. Supply secrets using the Supabase dashboard or `supabase secrets set --env-file` pointing to an ignored local file. The function uses Supabase's built-in `SUPABASE_SERVICE_ROLE_KEY`; never copy it into a `VITE_` variable.
7. Deploy the account endpoint: `supabase functions deploy accounts`. Its gateway JWT check is intentionally disabled in config because the request-account form is public. All other actions explicitly validate the bearer token with `auth.getUser()` and then check the current database role, active flag, Google identity, and matching verified email.

## Create the first admin

For an entirely local Supabase stack, Docker must be running. Set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in an ignored root `.env` file before `supabase start`; the CLI reads the env-backed Google provider in `supabase/config.toml`. Add `http://127.0.0.1:54321/auth/v1/callback` to that Google OAuth client's allowed redirect URIs, use the CLI's local project URL and publishable key for Vite, and run `supabase db reset` to install migrations locally. Set local `ALLOWED_ORIGINS` and `REQUEST_RATE_SALT` in an ignored function secrets file and pass it to `supabase functions serve accounts --env-file PATH`. Use that local stack's service role credentials for the bootstrap command below. For a local frontend against a hosted Supabase project, configure Google in the hosted dashboard instead; Docker and these CLI provider secrets are unnecessary.

In a private terminal, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your environment, then run:

```sh
node scripts/bootstrap-admin.mjs your-google-email@example.com "Your name"
```

The script allocates the admin UUID and creates a confirmed, password-free Auth user. Google links its verified identity to this precreated email on first sign-in. The command is safe to repeat for that same admin; a unique constraint prevents a second admin. Remove the service key from the terminal environment afterward. Do not grant bootstrap RPC execution to `anon` or `authenticated`.

Sign in as admin, create teams, and open Settings → Accounts & access. Users can submit **Request an account** with their name, Google email, and requested team. The request creates no Auth user. Review the request, select teams, and choose **Create account**. You can also create accounts without a request and edit assigned teams or active status later. New accounts default to coach. You cannot remove or suspend the last active assigned coach of a team; assign another coach first.

No approval email is sent in this version. Tell users to retry Google sign-in after their account is created. Team invitations grant team membership only after the invitee has an approved account and signs in using the matching verified email.

## Configure and deploy the frontend

Copy `.env.example` to `.env.local` and set the project URL and publishable key. These are public configuration. For GitHub Pages, set repository Actions variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then deploy only after backend setup and admin bootstrap succeed.

```sh
npm install
npm test
npm run build
```

Missing configuration displays a setup error and never unlocks the app. Do not use `.env.example` placeholders in production. Never use `service_role` or `sb_secret_` keys in frontend configuration.

## Offline access and recovery

Initial login and initial team download require internet. Afterward, the app can reopen with the last approved identity and locally downloaded team data, even after its online token expires. Cached identity must match the locally stored authentication session. Each account has a separate IndexedDB database, and OAuth/session data is managed by Supabase.

Account access is checked on startup, focus, visibility, reconnect, and every 30 seconds while visible. Offline changes to account or team access take effect when detected online. Backend RLS checks current active status and team membership on every request, independent of an older JWT. A suspended account cannot sync. Blocked pending practices remain isolated for recovery and cannot be uploaded through a different account.

Pause or end a live practice and sync pending changes before signing out. The sign-out guard refuses to discard pending practice uploads. Settings provides recovery export for blocked operations. Explicit sign-out clears downloaded records for that account and removes the local session. Switching Google accounts never opens another account's cache.

Free-tier quotas, project pausing, Google consent-screen restrictions, and service outages can affect online availability. Local recording remains available after setup, but external backups are still useful. No paid plan is enabled by the code.

## Verification and troubleshooting

- `npm test` includes PGlite tests against the actual account/team migrations. Browser network fixtures in `tests/auth_mock.py` exercise the real frontend without a test-login backdoor; they do not prove Google OAuth configuration.
- Build browser tests using URL `https://pitchwork-test.supabase.co` and key `sb_publishable_browser_test`, then run the acceptance scripts against that server. Never use fixture settings for production.
- If signup says admin creation is required, confirm the matching Google email was provisioned and that the before-user-created hook is enabled. Requests alone are not accounts.
- If Google reports a redirect mismatch, compare its redirect URI with Supabase's provider callback. Frontend redirect URLs belong in Supabase's URL allowlist.
- If account requests fail, check Edge Function deployment, allowed origins, and `REQUEST_RATE_SALT`. Invalid fields return errors; duplicate, approved, and rate-limited requests all return the same generic success response. Request limits allow five submissions per hashed client IP per hour.
- If sync pauses after expiry, use **Reconnect with Google**. Saved practices stay on the device. Never clear site storage to fix a sync error before exporting unsynced work.
- Before rollout, verify actual Google sign-in, sign-out, home-screen PWA reopening, offline recording, and reconnect on a physical iPhone in Safari. Automated Chromium tests cannot verify Face ID, Safari, or Google production credentials.
