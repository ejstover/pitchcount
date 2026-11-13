-- Structural revisions fence multi-request downloads. Scoring does not update
-- this row: thousands of independent scorers never contend on a global counter.
create table public.workspace_structure (scope text primary key,revision bigint not null default 1);
alter table public.workspace_structure enable row level security;
revoke all on public.workspace_structure from public,anon,authenticated;
grant all on public.workspace_structure to service_role;
create function public.workspace_structure_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare d jsonb; rows jsonb:='[]';keys text[]:='{}';k text;
begin
 if tg_op<>'INSERT' then rows:=rows||jsonb_build_array(to_jsonb(old));end if;
 if tg_op<>'DELETE' then rows:=rows||jsonb_build_array(to_jsonb(new));end if;
 for d in select value from jsonb_array_elements(rows) loop
  if tg_table_name='teams' then keys:=array_append(keys,'team:'||(d->>'id'));end if;
  if tg_table_name='coaches' then keys:=array_append(keys,'actor:'||(d->>'id'));end if;
  if tg_table_name='pitchers' then keys:=array_append(keys,'pitcher:'||(d->>'id'));end if;
  if d->>'team_id' is not null then keys:=array_append(keys,'team:'||(d->>'team_id'));end if;
  if d->>'pitcher_id' is not null then keys:=array_append(keys,'pitcher:'||(d->>'pitcher_id'));end if;
  if d->>'email' is not null then keys:=array_append(keys,'email:'||(d->>'email'));end if;
  foreach k in array array['owner_id','coach_id','account_id','viewer_id'] loop
   if d->>k is not null then keys:=array_append(keys,'actor:'||(d->>k));end if;
  end loop;
 end loop;
 for k in select distinct value from unnest(keys) value order by value loop
  insert into public.workspace_structure(scope) values(k) on conflict(scope) do update set revision=public.workspace_structure.revision+1;
 end loop;
 return null;
end $$;
do $$ declare t text;begin
 foreach t in array array['teams','coaches','pitchers','team_coaches','team_pitchers','invitations','player_accounts','gc_summaries','gc_mappings','goals','team_challenges','removal_visibility'] loop
  execute format('create trigger workspace_structure_changed after insert or update or delete on public.%I for each row execute function public.workspace_structure_changed()',t);
 end loop;
end $$;

-- Resolve access once, using indexed membership joins rather than evaluating a
-- security-definer predicate once for every tenant's row in the database.
create function public.pw_visible_teams(p_team uuid default null) returns setof uuid language sql stable security definer set search_path='' as $$
 select t.id from public.teams t where t.id=p_team and (select public.pw_admin())
 union
 select tc.team_id from public.team_coaches tc join public.coaches c on c.id=tc.coach_id
 where c.id=(select auth.uid()) and c.active and c.role in ('admin','coach','viewer')
 union
 select tp.team_id from public.team_pitchers tp join public.teams t on t.id=tp.team_id join public.pitchers p on p.id=tp.pitcher_id
 where tp.pitcher_id=(select public.pw_player_pitcher()) and tp.active and not t.archived and not p.archived
$$;
create function public.pw_visible_practices(p_team uuid default null) returns setof uuid language sql stable security definer set search_path='' as $$
 select p.id from public.practices p where p.team_id in (select public.pw_visible_teams(p_team))
 union
 select p.id from public.practices p where (select public.pw_active()) and p.team_id is null and p.recorder_id=(select auth.uid())
$$;
create function public.pw_visible_pitchers(p_team uuid default null) returns setof uuid language sql stable security definer set search_path='' as $$
 with teams as materialized(select public.pw_visible_teams(p_team) id)
 select id from public.pitchers where (select public.pw_writer()) and owner_id=(select auth.uid())
 union select public.pw_player_pitcher() where public.pw_player_pitcher() is not null
 union select tp.pitcher_id from public.team_pitchers tp where tp.active and tp.team_id in (select id from teams)
 union select jsonb_array_elements_text(p.data->'pitcherIds')::uuid from public.practices p where p.id in (select public.pw_visible_practices(p_team))
 union select gp.pitcher_id from public.gc_summary_pitchers gp join public.gc_summaries gs on gs.id=gp.summary_id where gs.team_id in (select id from teams)
$$;

create function public.pw_workspace_epoch(p_team uuid default null) returns text language sql stable security definer set search_path='' as $$
 with teams as materialized(select public.pw_visible_teams(p_team) id),scopes as (
  select 'actor:'||auth.uid() scope union select 'email:'||public.pw_email()
  union select 'team:'||id from teams
  union select 'pitcher:'||public.pw_visible_pitchers(p_team)
  union select 'actor:'||tc.coach_id from public.team_coaches tc where tc.team_id in(select id from teams)
 ) select md5(coalesce(string_agg(r.scope||':'||coalesce(v.revision,0)::text,',' order by r.scope),''))
 from scopes r left join public.workspace_structure v on v.scope=r.scope
$$;

-- One source practice becomes either a normal visible practice, a private player
-- projection, or both. Reuse the existing projection rules without scanning all
-- of that player's history for every page.
create function public.achievement_project_practice(p public.practices,pid uuid,actor uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare filtered jsonb:='[]'; e jsonb; previous_pid text; s jsonb;
begin
 if p.recorder_id=actor and p.team_id is null then s:=p.data||jsonb_build_object('archived',p.archived);filtered:=p.events;
 else
  for e in select value from jsonb_array_elements(p.events) order by (value->>'sequence')::integer loop
   if e->>'pitcherId'=pid::text then filtered:=filtered||jsonb_build_array(e);
   elsif e->>'kind'='switch' and previous_pid=pid::text then filtered:=filtered||jsonb_build_array((e-'pitchType'-'pitchLocation'-'intendedTarget'-'drillId')||jsonb_build_object('kind','reset','pitcherId',pid));end if;
   previous_pid:=e->>'pitcherId';
  end loop;
  if filtered='[]'::jsonb then return null;end if;
  s:=jsonb_build_object('id',p.id,'name','Recorded practice','notes','','startedAt',p.data->'startedAt','updatedAt',p.data->'updatedAt','endedAt',p.data->'endedAt','status',p.data->'status','initialPitcherId',pid,'initialAppearanceId',filtered->0->'appearanceId','selectedPitcherId',pid,'pitcherIds',jsonb_build_array(pid),'nextSequence',p.data->'nextSequence','teamId',null,'recorderId',actor,'deviceId',actor,'revision',p.revision,'recovered',true,'originSessionId',case when p.data->>'recovered'='true' then p.data->>'originSessionId' else p.id::text end,'archived',p.archived);
 end if;
 return jsonb_build_object('session',s,'events',filtered);
end $$;

create function public.get_workspace_metadata(p_team uuid default null) returns jsonb language sql stable security definer set search_path='' as $$
 with teams as materialized(select public.pw_visible_teams(p_team) id),
 pitchers as materialized(select public.pw_visible_pitchers(p_team) id),
 actor as materialized(select auth.uid() id,public.pw_active() active,public.pw_admin() admin,public.pw_player_pitcher() pid,public.pw_email() email),
 peers as materialized(
  select c.id from public.coaches c,actor a where a.active and c.id=a.id
  union select tc.coach_id from public.team_coaches tc where tc.team_id in(select id from teams)
 )
 select jsonb_build_object(
 'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'archived',t.archived,'createdAt',t.created_at,'updatedAt',t.updated_at)) from public.teams t where t.id in(select id from teams)),'[]'),
 'coaches',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email,'role',c.role,'active',c.active)||case when c.id=a.id then jsonb_build_object('pitcherId',a.pid) else '{}'::jsonb end) from public.coaches c,actor a where c.id in(select id from peers)),'[]'),
 'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'jersey',p.jersey,'ownerId',p.owner_id,'archived',p.archived,'createdAt',p.created_at,'updatedAt',p.updated_at)) from public.pitchers p where p.id in(select id from pitchers)),'[]'),
 'teamCoaches',coalesce((select jsonb_agg(jsonb_build_object('teamId',tc.team_id,'coachId',tc.coach_id)) from public.team_coaches tc where tc.team_id in(select id from teams)),'[]'),
 'teamPitchers',coalesce((select jsonb_agg(jsonb_build_object('teamId',tp.team_id,'pitcherId',tp.pitcher_id,'active',tp.active)) from public.team_pitchers tp where tp.team_id in(select id from teams) and tp.pitcher_id in(select id from pitchers)),'[]'),
 'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'teamId',i.team_id,'email',i.email,'teamName',i.team_name,'createdAt',i.created_at)) from public.invitations i,actor a where a.active and (i.team_id in(select id from teams) or i.email=a.email)),'[]'),
 'deletions',coalesce((select jsonb_agg(jsonb_build_object('kind',v.kind,'id',v.id)) from public.removal_visibility v,actor a where a.active and v.viewer_id=a.id),'[]'),
 'gcSummaries',coalesce((select jsonb_agg(s.data) from public.gc_summaries s where s.team_id in(select id from teams)),'[]'),
 'gcMappings',coalesce((select jsonb_agg(jsonb_build_object('teamId',m.team_id,'season',m.season_key,'sourceKey',m.source_key,'pitcherId',m.pitcher_id)) from public.gc_mappings m where m.team_id in(select id from teams) and m.pitcher_id in(select id from pitchers)),'[]'),
 'goals',coalesce((select jsonb_agg(public.pw_goal_json(g)) from public.goals g,actor a where a.active and case when g.scope='personal' then g.pitcher_id=a.pid or g.pitcher_id in(select tp.pitcher_id from public.team_pitchers tp where tp.active and tp.team_id in(select id from teams)) else g.team_id in(select id from teams) end),'[]'),
 'achievementRecords',coalesce((select jsonb_agg(public.achievement_record_json(r)) from public.achievement_records r,actor a where r.pitcher_id=a.pid),'[]'),
 'achievementAwards',coalesce((select jsonb_agg(w.data) from public.achievement_awards w,actor a where w.pitcher_id=a.pid),'[]'),
 'teamChallenges',coalesce((select jsonb_agg(c.data||jsonb_build_object('id',c.id,'teamId',c.team_id)) from public.team_challenges c where c.team_id in(select id from teams)),'[]'),
 'achievementEvaluation',(select jsonb_build_object('revision',j.revision,'processedRevision',j.processed_revision,'nextEvaluateAt',j.next_evaluate_at) from public.achievement_jobs j,actor a where j.pitcher_id=a.pid),
 'sessions','[]'::jsonb,'events','[]'::jsonb,'achievementSessions','[]'::jsonb,'achievementEvents','[]'::jsonb)
$$;

-- A bounded keyset manifest: unchanged practices return just ID/version, changed
-- ones return their atomic session+events. Known versions are hints, never grants.
create function public.get_workspace_page(p_after uuid default null,p_known jsonb default '{}',p_limit integer default 50,p_epoch text default null,p_team uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare epoch text;pid uuid:=public.pw_player_pitcher(); actor uuid:=auth.uid();teams uuid[];result jsonb;items jsonb:='[]';r record;version text;item jsonb;last_id uuid; n integer:=0;bytes integer:=0;more boolean:=false;
begin
 if not public.pw_active() then raise exception 'Account unavailable' using errcode='42501';end if;
 if p_team is not null and not public.pw_admin() then raise exception 'Admin workspace access required' using errcode='42501';end if;
 if p_limit is null or p_limit not between 1 and 100 or jsonb_typeof(p_known) is distinct from 'object' or octet_length(p_known::text)>1000000 then raise exception 'Invalid sync page' using errcode='22023';end if;
 epoch:=public.pw_workspace_epoch(p_team);
 if p_epoch is not null and p_epoch<>epoch then raise exception 'Workspace changed; retry sync' using errcode='40001';end if;
 result:=jsonb_build_object('epoch',epoch);
 if p_after is null then result:=result||jsonb_build_object('snapshot',public.get_workspace_metadata(p_team));end if;
 select coalesce(array_agg(id),'{}') into teams from public.pw_visible_teams(p_team) id;
 for r in
  with candidates as (
   (select id from public.practices where team_id=any(teams) and (p_after is null or id>p_after) order by id limit p_limit)
   union
   (select id from public.practices where team_id is null and recorder_id=actor and (p_after is null or id>p_after) order by id limit p_limit)
   union
   (select id from public.practices where pid is not null and data->'pitcherIds' ? pid::text and (p_after is null or id>p_after) order by id limit p_limit)
  )
  select p.*,coalesce(p.team_id=any(teams),false) or p.team_id is null and p.recorder_id=actor visible from public.practices p
  where p.id in(select id from candidates) order by p.id limit p_limit
 loop
  version:=r.revision::text||':'||r.archived::text||':'||r.visible::text||':'||coalesce(pid::text,'');
  -- Also bound payload bytes: a page of large practices must not become a
  -- hundreds-of-megabytes response. One atomic practice is the minimum unit.
  if n>0 and bytes+(case when p_known->>r.id::text=version then 128 else pg_column_size(r.data)+pg_column_size(r.events) end)>1048576 then more:=true;exit;end if;
  last_id:=r.id;n:=n+1;
  item:=jsonb_build_object('id',r.id,'version',version);
  if p_known->>r.id::text is distinct from version then
   if r.visible then item:=item||jsonb_build_object('session',r.data||jsonb_build_object('archived',r.archived),'events',r.events);end if;
   if pid is not null and r.data->'pitcherIds' ? pid::text then
    item:=item||jsonb_build_object('achievement',public.achievement_project_practice(row(r.id,r.team_id,r.recorder_id,r.device_id,r.revision,r.data,r.events,r.archived)::public.practices,pid,auth.uid()));
   end if;
  end if;
  bytes:=bytes+octet_length(item::text);
  items:=items||jsonb_build_array(item);
 end loop;
 return result||jsonb_build_object('items',items,'next',case when more or n=p_limit then last_id else null end);
end $$;
create index practices_team_cursor on public.practices(team_id,id);
create index practices_private_cursor on public.practices(recorder_id,id) where team_id is null;
revoke all on function public.workspace_structure_changed(),public.pw_workspace_epoch(uuid),public.pw_visible_teams(uuid),public.pw_visible_practices(uuid),public.pw_visible_pitchers(uuid),public.achievement_project_practice(public.practices,uuid,uuid),public.get_workspace_metadata(uuid) from public,anon,authenticated;
revoke all on function public.get_workspace_page(uuid,jsonb,integer,text,uuid) from public,anon;
grant execute on function public.get_workspace_page(uuid,jsonb,integer,text,uuid) to authenticated;
