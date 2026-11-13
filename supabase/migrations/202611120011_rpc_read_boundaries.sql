-- Supported clients (including the original client) read through workspace RPCs.
-- Raw table scans with per-row visibility functions could evaluate millions of
-- tenants before finding a small authorized set. Close this unused API surface;
-- keep RLS enabled and every existing policy as defense in depth.
revoke select on public.teams,public.team_coaches,public.pitchers,public.team_pitchers,
 public.invitations,public.practices,public.removal_visibility,public.gc_summaries,
 public.gc_mappings,public.gc_summary_pitchers,public.goals,public.player_accounts,
 public.achievement_records,public.achievement_awards,public.team_challenges
 from authenticated;
-- Retain only the cheap indexed self-profile read. Peer/admin data remains in
-- the independently authorized workspace/directory functions.
drop policy teammate_read on public.coaches;
create policy teammate_read on public.coaches for select to authenticated
 using(id=(select auth.uid()) and (select public.pw_active()));
