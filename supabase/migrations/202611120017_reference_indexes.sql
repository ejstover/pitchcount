-- Foreign-key checks and removal paths must not scan every unrelated account.
-- Use complete indexes: partial indexes cannot cover inactive historical rows.
create index access_requests_resolved_team on public.access_requests(resolved_team_id);
create index account_provisions_pitcher on public.account_provisions(pitcher_id);
create index coach_signups_team on public.coach_signups(team_id);
create index gc_mappings_pitcher on public.gc_mappings(pitcher_id);
create index goals_updated_by on public.goals(updated_by);
create index operation_receipts_coach on public.operation_receipts(coach_id);
create index player_invitations_account on public.player_invitations(account_id);
create index player_invitations_creator on public.player_invitations(created_by);
