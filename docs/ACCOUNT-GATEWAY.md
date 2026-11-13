# Verified account gateway

Status: prepared and tested locally; not deployed. This is a launch dependency,
not evidence of 5,000-user capacity. Production hosting, DNS and secrets have not
been changed.

## Hosting choice

Use Cloudflare Pages with the narrowly routed Function in
`functions/api/accounts.ts`. Public DNS currently points `count.twelvefs.com` at
GitHub Pages and the domain uses Google nameservers. Pages supports a custom
subdomain through a CNAME without moving the entire DNS zone. Keep the existing
production origin and exact frontend Supabase URL value to preserve installed
apps, IndexedDB records and the current authentication storage namespace.

Start with a separate `pitchwork-staging` Pages project and an isolated Supabase
project. The generated `_routes.json` invokes Functions only for `/api/accounts`;
other assets use the static CDN. The generated `_headers` supplies the static
security policy and immutable fingerprinted-asset caching. Function responses
set their own security headers and `no-store`. GitHub Pages does not execute
this Function or apply that header file.

## Trust boundary

The Function requires real platform `request.cf` metadata and reads
`CF-Connecting-IP` under Cloudflare's documented incoming-header contract. It
rejects missing metadata, invalid addresses and Class E Pseudo IPv4 addresses.
If a Cloudflare zone is used, keep Pseudo IPv4 **Off** or **Add Header**; do not
use **Overwrite Headers**. An alternate caller-supplied IPv6/forwarding header
does not establish a trusted address. Other Workers controlled by the same
account/zone remain part of the trusted infrastructure.

The gateway validates the origin, public action and bounded JSON body, then
creates new upstream headers. Incoming Authorization, cookies, forwarding and
proof headers are discarded. Only a public Supabase API key is allowed there.
No database administrative key belongs in the Pages environment or frontend.

An HMAC binds the exact body bytes, configured app origin, actual address and
timestamp. The account function accepts proofs for at most 60 seconds, with 10
seconds of future clock tolerance. It rejects unsigned public actions before
rate counters, provisioning or Auth calls. A replay retains the same address
and body and still consumes the applicable attempt limits. The proof establishes
network provenance only: it never grants account, player, team or admin access.
Authenticated profile/admin operations retain fresh user verification and SQL
authorization and continue to use the direct authenticated endpoint.

IPv4 rate buckets use the verified address; IPv6 buckets use its /64 network.
Provider Auth forwarding uses the full verified address on a fresh per-request
client. The shared service client is never mutated.

## Configuration and staging sequence

1. Create isolated staging resources after approving their cost. Use a distinct
   Supabase project and Pages hostname, synthetic identities and a private SMTP
   sink. Preserve Auth, password, confirmation, role, RLS and rate protections.
2. Copy `wrangler.example.jsonc` to ignored `wrangler.jsonc`. Set public
   `APP_URL`, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` to the staging origin
   and project. The frontend's two `VITE_SUPABASE_*` values must match that same
   project. Do not mix staging and production credentials.
3. Generate 32 cryptographically random bytes encoded as 64 lowercase hex
   characters. Store that value as `ACCOUNT_PROXY_SECRET` in the Pages secret
   store and the isolated Supabase function secrets. Never put it in a `VITE_`
   variable, source control, workflow output, request logs or chat. Existing
   application secrets, including the rate salt, are still required.
4. Set the account function's `APP_URL` to the identical staging origin and its
   allowed origins accordingly. Apply the reviewed migration chain before the
   updated function. Public actions fail closed until the signing key matches.
5. For scalable server-side Auth, ensure the function has a modern
   `SUPABASE_SECRET_KEYS.default` value beginning `sb_secret_`, enable the
   provider's `security_sb_forwarded_for_enabled` setting, then set
   `AUTH_TRUSTED_IP_FORWARDING=1` on the function. A legacy service-role JWT with
   that flag is rejected. The setting is not enabled automatically by this code.
6. Build the frontend and Pages Function. The Pages upload must include the
   compiled Function, `_routes.json` and `_headers`; a static-only upload is
   insufficient. Configure Function quota exhaustion to **fail closed**. For
   capacity tests, select a quota/plan that can accommodate the measured traffic.
7. On the hosted staging hostname, verify TLS, actual response headers, static
   caching and every public account flow. Direct unsigned public function calls
   and forged forwarding headers must fail. Verify real per-client provider Auth
   behavior, including distinct users behind one NAT and IPv6 address changes.
   Do not disable protections or inflate limits to make a load test pass.
8. Prove bot/abuse protection for direct Supabase Auth endpoints as well as this
   gateway. HMAC provenance is not a CAPTCHA or a complete admission-control
   system. This remains an unverified launch gate.

The local CLI is not signed in to Cloudflare. No cloud project was created.
The CI Pages publisher requires `PITCHWORK_ACCOUNT_GATEWAY_READY=true` before
publishing this revision. Leave it unset during migration; the recommended Pages
deployment does not use GitHub's static Pages publisher. That variable is an
operator attestation, not an automated hosted-security certificate.

## Production cutover and rollback

After staging acceptance, associate `count.twelvefs.com` with the production
Pages project before changing its CNAME. Verify TLS issuance and the DNS
provider's TTL/CAA settings. Move only the app subdomain when authorized.
Preserve the production Supabase project and exact frontend URL value.

Coordinate the function and frontend release in a controlled account-flow
maintenance window. Older cached clients call the public function directly;
after proof enforcement they receive the instruction to open the current app.
There is no unsigned compatibility fallback. Already authenticated private
requests and offline recording retain their existing paths, but do not claim
zero downtime for old sign-up, verification, username-login or recovery screens.
Verify installed-PWA updates with pending records before cutover.

Record the preceding hosting/function versions and DNS values. Roll back a
failed release as a coordinated frontend/function/hosting operation, preserving
all source data, receipts and pending offline work. Do not remove proof checks,
weaken authorization or restore caller-controlled IP headers as a quick fix.

For signing-key rotation, first deploy the backend with the new current key and
the old key as `ACCOUNT_PROXY_PREVIOUS_SECRET`, then switch the gateway to the
new key. After the maximum proof lifetime plus clock tolerance and in-flight
requests have elapsed, remove the previous key. Keep clocks synchronized.

## Local checks

`npm run test:account-gateway` exercises actual loopback HTTP transport, socket
address provenance, forged host/origin/forwarding headers, credential removal
and oversized fixed/streamed bodies. `npm run test:local-api` also verifies an
unsigned rejection, a signed request and a real synthetic player session through
the actual local Edge/Auth/API/SQL stack. Small browser fixtures cover the public
forms. None of these proves a deployed network boundary or peak capacity.

Local Vite uses only the socket peer and `ACCOUNT_PROXY_SECRET` from the ignored
server environment. The development adapter is not a production gateway.
`npm run preview` serves static output; its account forms need mocked transport
or a proper gateway. Vite denies `.dev.vars*`, `.wrangler`, private artifacts and
environment files; a CI canary verifies those restrictions.

`npm run test:build-secrets` verifies that signing keys with a public `VITE_`
prefix, private/non-anon API keys and credential-bearing project URLs stop the
build before browser emission. It also builds with a synthetic private server
key and scans every emitted file to prove that the value is absent.

The pinned CLI `wrangler@4.161.0 pages functions build functions --outdir
.test-artifacts/account-pages-bundle` compiles the adapter without uploading it.
Use the same reviewed CLI version for the eventual deployment.

Primary references: [Pages custom subdomains](https://developers.cloudflare.com/pages/configuration/custom-domains/),
[Function routing and quota failure](https://developers.cloudflare.com/pages/functions/routing/),
[Cloudflare incoming headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
[Supabase Auth forwarding](https://supabase.com/docs/guides/auth/rate-limits).
