-- Compute visibility once per page. Nested security-definer set functions caused
-- repeated planning/authorization work even when a user had only one small team.
-- The resulting context is PRIVATE: callers cannot submit or execute one.
create function public.workspace_query_context(p_team uuid default null) returns jsonb
language sql stable security definer set search_path='' as $$
 with actor as materialized (
  select c.id,c.role,lower(c.email) email,case when c.role='player' then pa.pitcher_id else null end pid
  from public.coaches c left join public.player_accounts pa on pa.account_id=c.id
  where c.id=(select auth.uid()) and c.active
 ), teams as materialized (
  select t.id from public.teams t,actor a where a.role='admin' and t.id=p_team
  union select tc.team_id from public.team_coaches tc,actor a where tc.coach_id=a.id and a.role in('admin','coach','viewer')
  union select tp.team_id from public.team_pitchers tp join public.teams t on t.id=tp.team_id join public.pitchers p on p.id=tp.pitcher_id,actor a
   where tp.pitcher_id=a.pid and tp.active and not t.archived and not p.archived
 ), roster as materialized (
  select distinct tp.pitcher_id id from public.team_pitchers tp where tp.active and tp.team_id in(select id from teams)
 ), histories as materialized (
  select p.id,p.data from public.practices p where p.team_id in(select id from teams)
  union all select p.id,p.data from public.practices p,actor a where p.team_id is null and p.recorder_id=a.id
 ), pitchers as materialized (
  select p.id from public.pitchers p,actor a where p.owner_id=a.id and a.role in('admin','coach')
  union select a.pid from actor a where a.pid is not null
  union select id from roster
  union select jsonb_array_elements_text(h.data->'pitcherIds')::uuid from histories h
  union select gp.pitcher_id from public.gc_summary_pitchers gp join public.gc_summaries gs on gs.id=gp.summary_id where gs.team_id in(select id from teams)
 ), peers as materialized (
  select id from actor union select tc.coach_id from public.team_coaches tc where tc.team_id in(select id from teams)
 ), scopes as materialized (
  select 'actor:'||id scope from peers union select 'email:'||email from actor
  union select 'team:'||id from teams union select 'pitcher:'||id from pitchers
 ), epoch as (
  select md5(coalesce(string_agg(s.scope||':'||coalesce(v.revision,0)::text,',' order by s.scope),'')) value
  from scopes s left join public.workspace_structure v on v.scope=s.scope
 ) select jsonb_build_object('actorId',a.id,'role',a.role,'email',a.email,'pitcherId',a.pid,'epoch',(select value from epoch),
  'teams',coalesce((select jsonb_agg(id) from teams),'[]'),
  'pitchers',coalesce((select jsonb_agg(id) from pitchers),'[]'),
  'rosterPitchers',coalesce((select jsonb_agg(id) from roster),'[]'),
  'peers',coalesce((select jsonb_agg(id) from peers),'[]')) from actor a
$$;

create function public.workspace_metadata_from_context(context jsonb) returns jsonb
language sql stable set search_path='' as $$
 with ids as materialized (
  select (context->>'actorId')::uuid actor,(context->>'pitcherId')::uuid pid,context->>'email' email,
   array(select jsonb_array_elements_text(context->'teams')::uuid) teams,
   array(select jsonb_array_elements_text(context->'pitchers')::uuid) pitchers,
   array(select jsonb_array_elements_text(context->'rosterPitchers')::uuid) roster,
   array(select jsonb_array_elements_text(context->'peers')::uuid) peers
 ) select jsonb_build_object(
 'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'archived',t.archived,'createdAt',t.created_at,'updatedAt',t.updated_at)) from public.teams t,ids i where t.id=any(i.teams)),'[]'),
 'coaches',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email,'role',c.role,'active',c.active)||case when c.id=i.actor then jsonb_build_object('pitcherId',i.pid) else '{}'::jsonb end) from public.coaches c,ids i where c.id=any(i.peers)),'[]'),
 'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'jersey',p.jersey,'ownerId',p.owner_id,'archived',p.archived,'createdAt',p.created_at,'updatedAt',p.updated_at)) from public.pitchers p,ids i where p.id=any(i.pitchers)),'[]'),
 'teamCoaches',coalesce((select jsonb_agg(jsonb_build_object('teamId',tc.team_id,'coachId',tc.coach_id)) from public.team_coaches tc,ids i where tc.team_id=any(i.teams)),'[]'),
 'teamPitchers',coalesce((select jsonb_agg(jsonb_build_object('teamId',tp.team_id,'pitcherId',tp.pitcher_id,'active',tp.active)) from public.team_pitchers tp,ids i where tp.team_id=any(i.teams) and tp.pitcher_id=any(i.pitchers)),'[]'),
 'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'teamId',r.team_id,'email',r.email,'teamName',r.team_name,'createdAt',r.created_at)) from public.invitations r,ids i where r.team_id=any(i.teams) or r.email=i.email),'[]'),
 'deletions',coalesce((select jsonb_agg(jsonb_build_object('kind',v.kind,'id',v.id)) from public.removal_visibility v,ids i where v.viewer_id=i.actor),'[]'),
 'gcSummaries',coalesce((select jsonb_agg(s.data) from public.gc_summaries s,ids i where s.team_id=any(i.teams)),'[]'),
 'gcMappings',coalesce((select jsonb_agg(jsonb_build_object('teamId',m.team_id,'season',m.season_key,'sourceKey',m.source_key,'pitcherId',m.pitcher_id)) from public.gc_mappings m,ids i where m.team_id=any(i.teams) and m.pitcher_id=any(i.pitchers)),'[]'),
 'goals',coalesce((select jsonb_agg(public.pw_goal_json(g)) from public.goals g,ids i where case when g.scope='personal' then g.pitcher_id=i.pid or g.pitcher_id=any(i.roster) else g.team_id=any(i.teams) end),'[]'),
 'achievementRecords',coalesce((select jsonb_agg(public.achievement_record_json(r)) from public.achievement_records r,ids i where r.pitcher_id=i.pid),'[]'),
 'achievementAwards',coalesce((select jsonb_agg(w.data) from public.achievement_awards w,ids i where w.pitcher_id=i.pid),'[]'),
 'teamChallenges',coalesce((select jsonb_agg(c.data||jsonb_build_object('id',c.id,'teamId',c.team_id)) from public.team_challenges c,ids i where c.team_id=any(i.teams)),'[]'),
 'achievementEvaluation',(select jsonb_build_object('revision',j.revision,'processedRevision',j.processed_revision,'nextEvaluateAt',j.next_evaluate_at) from public.achievement_jobs j,ids i where j.pitcher_id=i.pid),
 'sessions','[]'::jsonb,'events','[]'::jsonb,'achievementSessions','[]'::jsonb,'achievementEvents','[]'::jsonb)
$$;
revoke all on function public.workspace_query_context(uuid),public.workspace_metadata_from_context(jsonb) from public,anon,authenticated;

-- Keep paging/version/cache/byte-budget behavior unchanged. Only the private
-- source of the authorization context and metadata changes.
do $$declare definition text;old text;replacement text;begin
 definition:=replace(pg_get_functiondef('public.get_workspace_page(uuid,jsonb,integer,text,uuid)'::regprocedure),chr(13),'');
 definition:=replace(definition,'pid uuid:=public.pw_player_pitcher(); actor uuid:=auth.uid();','context jsonb;pid uuid; actor uuid;');
 old:='if not public.pw_active() then raise exception ''Account unavailable'' using errcode=''42501'';end if;'||chr(10)||' if p_team is not null and not public.pw_admin() then raise exception ''Admin workspace access required'' using errcode=''42501'';end if;';
 replacement:='context:=public.workspace_query_context(p_team);'||chr(10)||
  ' if context is null then raise exception ''Account unavailable'' using errcode=''42501'';end if;'||chr(10)||
  ' if p_team is not null and context->>''role''<>''admin'' then raise exception ''Admin workspace access required'' using errcode=''42501'';end if;'||chr(10)||
  ' actor:=(context->>''actorId'')::uuid;pid:=(context->>''pitcherId'')::uuid;';
 if position(old in definition)=0 then raise exception 'Workspace context migration did not match access checks';end if;
 definition:=replace(definition,old,replacement);
 definition:=replace(definition,'epoch:=public.pw_workspace_epoch(p_team);','epoch:=context->>''epoch'';');
 definition:=replace(definition,'public.get_workspace_metadata(p_team)','public.workspace_metadata_from_context(context)');
 definition:=replace(definition,'select coalesce(array_agg(id),''{}'') into teams from public.pw_visible_teams(p_team) id;','teams:=array(select jsonb_array_elements_text(context->''teams'')::uuid);');
 if position('workspace_metadata_from_context(context)' in definition)=0 or position('public.pw_visible_teams(p_team)' in definition)>0 or position('public.pw_workspace_epoch(p_team)' in definition)>0 then raise exception 'Workspace context migration was incomplete';end if;
 execute definition;
end $$;
