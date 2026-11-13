-- Old installed clients still call this endpoint. They must never scan unrelated
-- tenants or receive a silently truncated workspace. Larger scopes explicitly
-- require the paged client, leaving existing browser/offline records intact.
alter function public.get_workspace() rename to pw_legacy_workspace_reference;
revoke all on function public.pw_legacy_workspace_reference() from public,anon,authenticated;
create function public.get_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare context jsonb;actor uuid;pid uuid;teams uuid[];ids uuid[]:='{}';r record;
 result jsonb;bytes bigint:=0;rows integer;resource text;
begin
 context:=public.workspace_query_context();
 if context is null then
  return '{"teams":[],"coaches":[],"pitchers":[],"teamCoaches":[],"teamPitchers":[],"invitations":[],"sessions":[],"events":[],"deletions":[],"gcSummaries":[],"gcMappings":[],"goals":[],"achievementSessions":[],"achievementEvents":[],"achievementRecords":[],"achievementAwards":[],"teamChallenges":[],"achievementEvaluation":null}'::jsonb;
 end if;
 if context->>'role'='admin' then
  -- Preserve the small, original global admin view during client upgrades. Check
  -- every contributing table with an early row/byte bound before its old reader.
  foreach resource in array array['coaches','teams','pitchers','team_coaches','team_pitchers','invitations','practices','removal_visibility','gc_summaries','gc_mappings','goals','achievement_records','achievement_awards','team_challenges'] loop
   rows:=0;
   for r in execute format('select octet_length(row_to_json(t)::text) bytes from public.%I t limit 1001',resource) loop
    rows:=rows+1;bytes:=bytes+r.bytes;
    if rows>1000 or bytes>8388608 then raise exception 'Update Pitchwork to synchronize larger workspaces. Your saved work remains on this device.' using errcode='54000';end if;
   end loop;
  end loop;
  return public.pw_legacy_workspace_reference();
 end if;
 actor:=(context->>'actorId')::uuid;pid:=(context->>'pitcherId')::uuid;
 teams:=array(select jsonb_array_elements_text(context->'teams')::uuid);
 result:=public.workspace_metadata_from_context(context);bytes:=octet_length(result::text);
 for r in
  with candidates as (
   (select id from public.practices where team_id=any(teams) limit 1001)
   union (select id from public.practices where team_id is null and recorder_id=actor limit 1001)
   union (select id from public.practices where pid is not null and data->'pitcherIds' ? pid::text limit 1001)
   limit 1001
  ) select p.id,octet_length(p.data::text)+octet_length(p.events::text) bytes from public.practices p where p.id in(select id from candidates)
 loop
  ids:=array_append(ids,r.id);bytes:=bytes+r.bytes;
  if cardinality(ids)>1000 or bytes>8388608 then raise exception 'Update Pitchwork to synchronize larger workspaces. Your saved work remains on this device.' using errcode='54000';end if;
 end loop;
 with readable as materialized (
  select p.*,coalesce(p.team_id=any(teams),false) or p.team_id is null and p.recorder_id=actor visible from public.practices p where p.id=any(ids)
 ), projected as materialized (
  select public.achievement_project_practice(p::public.practices,pid,actor) data from public.practices p where p.id=any(ids) and pid is not null and p.data->'pitcherIds' ? pid::text
 ) select result||jsonb_build_object(
  'sessions',coalesce((select jsonb_agg(p.data||jsonb_build_object('archived',p.archived)) from readable p where visible),'[]'),
  'events',coalesce((select jsonb_agg(e) from readable p cross join lateral jsonb_array_elements(p.events)e where visible),'[]'),
  'achievementSessions',coalesce((select jsonb_agg(data->'session') from projected where data is not null),'[]'),
  'achievementEvents',coalesce((select jsonb_agg(e) from projected p cross join lateral jsonb_array_elements(p.data->'events')e),'[]')) into result;
 if octet_length(result::text)>8388608 then raise exception 'Update Pitchwork to synchronize larger workspaces. Your saved work remains on this device.' using errcode='54000';end if;
 return result;
end $$;
revoke all on function public.get_workspace() from public,anon;
grant execute on function public.get_workspace() to authenticated;
