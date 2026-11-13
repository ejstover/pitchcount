# Self-service coach signup and player invitations

Coaches choose **Create a team** on the sign-in screen, enter their name, email,
and team name, then verify an emailed code and choose a password. Verification
activates the coach and creates a new team in one database transaction. No admin
approval is needed for this flow. A team with the same name never grants access
to another coach’s team. Existing accounts and legacy approval requests retain
their current roles, status, and memberships.

The final setup screen offers player invitations and **Go to my dugout** to skip.
An unfinished invitation step resumes after sign-in. Coaches can add invitations
later through **Roster → Teams → select team → Invite your players**.
Refreshing during email verification restores the current tab’s signup details
and resend cooldown. Passwords and verification codes are never stored.

## Player invitations

Create an invitation for a new player or choose an existing roster pitcher to
preserve their history. Pitchwork displays a private link for the coach to copy
or share with that player or their parent/guardian. **No invitation email is
sent.** Each player chooses a username and password; an email address is not
required for these coach-managed player accounts. Coaches can generate a private
password recovery link for their own players through the existing account tools.

Links expire after seven days, can be revoked, and can be used once. Generating a
replacement revokes earlier links for the pitcher. Only a SHA-256 hash is stored
in the database. The bearer credential is in a URL fragment and is removed from
the address bar when opened; the current browser tab retains it temporarily in
session storage so refreshing can resume acceptance. It is removed on success
or cancellation. Invitation previews disclose only the invited player’s name,
team name, and expiration to someone holding the private link.

An existing player account must keep its current pitcher identity: assign that
pitcher to the new team instead of creating another account. Invitations cannot
replace a linked player’s password or merge two roster histories. A signed-in
account is preserved when someone opens a player link; use a separate browser
profile to set up a different person’s account.

The server rechecks coach access, active roster membership, archive state,
expiration, revocation, and account linkage at acceptance. Players gain player
access only, never coaching privileges. Invitation creation uses a stable
request ID and a server HMAC-derived secret so a network retry returns the same
invitation without duplicating a pitcher. The salt must remain private.

## Deployment

Deploy the backend before publishing the new frontend:

```sh
npx supabase db push --dry-run
npx supabase db push
npx supabase functions deploy accounts --use-api
npm test
npm run build
```

The migration is `202611120001_self_service_onboarding.sql`; it depends on all
preceding migrations, including `202610220004_account_requests.sql`. Keep the
**Before User Created** hook enabled. Public direct Auth signup remains blocked;
the accounts function allocates exact identities using the server-only key.
The new RPCs and tables are accessible only to `service_role`.

Set `APP_URL` to the canonical HTTPS app URL, configure its auth redirect allowlist,
and keep `REQUEST_RATE_SALT` as a strong, random server secret (at least 32 random
bytes recommended). This existing secret also derives invitation secrets.
Rotating it does not invalidate links already issued, but may prevent returning
an earlier link for an uncertain creation retry; create a replacement if needed.

Configure production custom SMTP in Supabase before release. Set the **Magic
Link** template to `supabase/templates/verification.html` with `{{ .Token }}`;
the same neutral wording supports self-service signup and legacy requests.
Keep the Email OTP expiry at one hour and the server minimum password length at
15. Test mail delivery to addresses outside the Supabase organization. The
default sender is unsuitable for general public signup.

**Forgot your password?** now sends Supabase’s standard recovery email to the
account email and opens the existing password setup screen. Configure that
template and redirects too. Username-only players continue to use coach-managed
recovery. Recovery and signup responses avoid disclosing whether an email has
an account. Signup/resend, code verification, recovery, invitation preview and
acceptance are rate limited; the underlying Auth service also limits OTP use.

Verify the live SMTP and Auth flow in staging with a new coach address, bad and
expired codes, resend, signup refresh, invitation copy/revoke/acceptance, a
second browser profile, and coach password reset. Finish with an installed-PWA
check on a physical iPhone. Local tests mock network calls and do not prove live
email delivery or a production deployment.

## Verification

`npm test` runs the actual SQL migrations and Edge handler with a mocked Auth
transport. Coverage includes unverified access denial, distinct same-name teams,
safe retries, suspended/legacy accounts, cross-team access, invitation expiry,
revocation, removal, replacement, one-time use, and player-only permissions.

`python tests/onboarding_browser.py` uses the test-only Vite connection settings
in `tests/auth_mock.py`. It exercises signup, mail errors, incorrect codes,
password visibility, optional invitations, resumed onboarding, uncertain invite
creation retries, later team invites, player signup, revocation, recovery, and
320/390/768/1440-pixel layouts. Screenshots are written to `.test-artifacts/`.

On Windows, if Vitest’s temporary cache directory rejects renames, set `TEMP` and
`TMP` to an ignored writable workspace directory before running tests. No
production application setting needs to change.

Implementation references: [Supabase email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless),
[Supabase passwords and recovery](https://supabase.com/docs/guides/auth/passwords),
and [OWASP token handling](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
