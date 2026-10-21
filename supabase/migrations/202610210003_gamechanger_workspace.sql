-- Read the roster and GC tables under the same lock used by their writers.
-- Otherwise a replacement that creates pitchers could commit between the core
-- workspace read and the GC read, returning rows whose players are absent.
create or replace function public.get_workspace() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(79112834);
 return public.pw_workspace_gc_core()||jsonb_build_object(
 'gcSummaries',coalesce((select jsonb_agg(data) from public.gc_summaries where public.pw_team(team_id)),'[]'),
 'gcMappings',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'season',season_key,'sourceKey',source_key,'pitcherId',pitcher_id)) from public.gc_mappings where public.pw_team(team_id) and public.pw_pitcher(pitcher_id)),'[]'));
end
$$;
