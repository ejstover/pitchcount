# Initial hosted capacity test

Prepared November 12, 2026. Not provisioned, approved or run. Production remains
untouched. This moves the database and traffic generation off the shared gaming
PC; it does not assume that its failed local peaks define production capacity.

**Current instruction: continue local work without paid resources.** The user
selected that option when asked about the proposed $100 round. The paid setup
below is a retained future option, not a pending or granted spending approval.
Do not create or upgrade cloud resources, purchase SMTP services or start paid
testing from this document. Local correctness and efficiency work continues;
hosted production-equivalent capacity remains unverified.

The user also clarified that initial adoption will be gradual. The 5,000-user
round below is a future growth-validation option and does not block merging the
locally verified code or planning a small initial rollout. Security and correct
hosting setup remain release requirements at every cohort size.

## Selected resources

| Component | Initial selection | Scope |
| --- | --- | --- |
| Backend | Separate Supabase Pro staging project, us-east-1, 2XL: dedicated 8 vCPU / 32 GB RAM; start with 32 GB disk | Synthetic data only; no production project resizing or copying private user data |
| Frontend and account gateway | Separate Cloudflare Pages project with the reviewed account Function | Staging hostname, matching signing secret and Supabase project; no production DNS change |
| Main traffic generator | Separate GitHub-hosted Linux runner, initially 4 CPU / 16 GB | This repository is public; standard public-repository runner time is currently free. Validate generator headroom rather than treating saturation as an app failure |
| SMTP | Isolated test sink for email checks | No delivery to real users; confirm provider quotas before email/OTP capacity claims |

No paid resource is created before explicit spending approval. Cloudflare CLI
authentication is still needed. Use account sign-in/secret stores; never paste
administrative keys or passwords into chat. A runner change or paid SMTP service
must stay inside the approved total; otherwise stop and present the revised cost.

## Initial cost and stop conditions

Proposed approval: **up to $100 total for the first hosted testing round**, not
an ongoing monthly authorization. Limit backend running time to **eight hours**
for this round. Save reports, then remove only the newly created synthetic test
resources that are no longer needed and cancel a dedicated testing subscription
if unused. Do not change production billing or delete existing resources.

The published 2XL compute price is $0.562/hour, about **$4.50 for eight hours**.
A new Pro organization starts at $25/month; a Workers paid subscription starts at
$5/month if required. Storage, egress, function invocations, any SMTP service and
taxes are additional. Those base amounts are not a complete bill or an automatic
hard billing cap. Review the actual account quote before provisioning and bound
test duration, traffic and retained resources within the approved total. Stop
before the remaining allowance is insufficient; billing metrics can lag.

Use service-specific traffic budgets and do not treat provider spend-cap settings
as covering compute. No larger machine, extra paid generator or recurring test
schedule is authorized by this proposal alone.

## Acceptance work

1. Apply the reviewed migrations and deploy the matching backend and gateway to
   staging. Verify real hosted TLS, headers, static caching, signed address
   provenance, provider forwarding and direct-endpoint abuse controls first.
2. Seed two million background account/profile identities and representative
   practices, memberships, private activity and achievement jobs. Validate actual
   Auth schema coverage and disk use; the existing native fixture alone is not
   proof of a hosted two-million-user Auth database. Use synthetic data only.
3. Use distinct ordinary authenticated sessions. Ramp 1,000, 3,000 and 5,000
   simultaneous users with 20% and 100% recording workloads. Target 30-minute peak
   holds plus a soak, fitting only the scenarios that can be completed honestly
   within the first round's budget and runtime. Report anything not completed.
   Set `PITCHWORK_LOAD_MIN_PEAK_SECONDS=1800` and allow extra time for ramp and
   startup (for example 1,920 total seconds with a 60-second ramp). Require the
   report's full-population hold to meet the target and driver event-loop p99 to
   stay within 50 ms. A generator-limited run does not qualify backend capacity.
4. Measure latency/error rate, connection and lock waits, backend CPU/memory,
   disk/WAL/maintenance, worker backlog age and generator CPU/event-loop/network
   headroom. Separate a generator limit from backend saturation. Stop early on
   unexpected authorization or data-integrity failures.
5. Verify same-practice conflicts, unrelated progress, revocation, complete
   acknowledged writes, retry receipts and private-record isolation during load.
   Exercise reconnects and worker recovery instead of checking request rate alone.
6. Keep interactive signup/OTP/login capacity separate from returning-session
   throughput. One runner has a shared network address; do not spoof client IPs,
   disable CAPTCHA or raise provider limits to manufacture an authentication
   result. Prove legitimate shared-NAT behavior and SMTP delivery/queue limits
   separately. Unverified authentication workloads remain launch gates.

Pass criteria remain those in [SCALABILITY.md](SCALABILITY.md): zero scope or
integrity failures, the documented latency/error budgets, sufficient generator
headroom and stable worker/maintenance behavior. Passing a short warm run does
not certify all workloads or establish the final production hardware size.

## Sources

Prices and runner specifications were checked against the official
[Supabase compute table](https://supabase.com/docs/guides/platform/compute-and-disk),
[Supabase plan pricing](https://supabase.com/pricing),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
and [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
