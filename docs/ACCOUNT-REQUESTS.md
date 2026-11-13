# Verified player and coach account requests

Player requests collect name, username, email, and optional team name. Coach requests collect name, email, and required team name. No pitcher is selected during signup. Username rules are 3–24 characters using letters, numbers, dots, underscores, or hyphens; storage is lowercase.

A request reserves a Supabase identity with an unconfirmed email and an inactive profile. The email code confirms ownership only. It does not activate the profile, create a pitcher, assign a team, or return a browser session. The admin approves verified requests and privately shares the existing password setup link.

Approval creates a new pitcher for a player, owned initially by the approving admin. Team names match active teams by trimmed, case-insensitive equality. One match is reused, no matches create a team, and multiple matches require an admin choice. Archived teams are excluded. Players get roster membership; coaches get coaching membership. A player without a team starts with independent practices. Repeated approvals reuse all records. Linking and deduplication of historical pitchers are separate work.

## SMTP and template setup

Live rollout is awaiting a chosen SMTP provider, verified sender, and delivery test address. No SMTP password belongs in this repository or frontend environment variables.

1. Choose an SMTP provider and verify its sender address/domain, including the DNS records required by that provider.
2. In the linked Supabase project's **Authentication → Email / SMTP settings**, enable custom SMTP and enter the provider's host, port, username, password, sender email, and sender name. Configure hosted email OTP expiry to 3600 seconds and an appropriate send rate.
3. In **Authentication → Email Templates → Magic Link**, use subject **Your Pitchwork verification code** and the contents of `supabase/templates/verification.html`. The code must use `{{ .Token }}`. This endpoint uses `signInWithOtp` for a pre-created identity, so the Magic Link template is the one to customize. Do not replace the password recovery template.
4. Keep the before-user-created hook installed. Public signup remains blocked; only preallocated provisions can create identities. Keep email confirmations enabled. For local Supabase, the checked-in config uses the same code template and the local mail inbox; local inbox testing does not verify external SMTP delivery.

## Deployment order

Deploy only after SMTP and the hosted Magic Link template are ready. From the repository:

```powershell
npx --no-install supabase db push --dry-run
# Expected pending migration for the currently linked project:
# 202610220004_account_requests.sql
npx --no-install supabase db push --yes
npx --no-install supabase functions deploy accounts --use-api
```

Then publish the tested frontend through the existing GitHub Pages workflow. The migration and accounts function must precede the frontend. The migration preserves existing accounts, links, usernames, statistics, and historical requests. Existing pending requests default to Coach and must verify email before approval; the admin can send their verification email from request review.

The new function deliberately retires direct `create` calls in favor of `request` followed by `approve_request`. Coordinate the backend/frontend release: the old public form does not include code entry. Existing account login and existing-player coach shortcuts remain supported.

## Real delivery acceptance check

Use a real mailbox after SMTP setup. Submit a player request without a team; receive the code, check wrong/expired/reused code handling and resend, verify email, and confirm no app access before approval. Have the admin approve it, open the private setup link, choose a password, and sign in using the player username. Confirm one new pitcher and independent practice access. Submit a coach request with a new team name and confirm approval creates that team and coaching membership. Also test a matching existing team and a player joining that team. Record results without storing OTPs or setup links.

## Interfaces and checks

- Public `request`: `name`, `email`, `role`, `requestedTeam`, and player `username`. A successful response is generic; duplicate emails never disclose account status. Username conflicts have a field-level error. Mail failures return 503 with retry instructions. Resend uses the same request payload and limits.
- Public `verify_request`: `email` and `code`; uses Supabase `verifyOtp` and returns only a status message, never access or refresh tokens.
- Admin `list` includes role, username, provisioned `account_id`, verification timestamp, and resolved team on requests. Admin `approve_request` takes `requestId` and optional `teamId` for ambiguity resolution and returns a private password setup link.
- Normal account mutation cannot activate an unapproved provision, even if its request row is removed. Rejected identities stay inactive. Approval checks Supabase's confirmed email directly, not browser-supplied verification state.
- `npm test`, `npm run typecheck`, and `npm run build` cover the database and actual accounts handler with mocked Supabase transport. Browser fixtures `tests/account_requests_browser.py` and `tests/auth_ui.py` cover the form and admin flow. Their mock mail checks do not establish real deliverability.
