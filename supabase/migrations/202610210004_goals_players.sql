-- Keep existing account IDs/table names; roster links never confer coaching rights.
alter table public.coaches drop constraint coaches_role_check;
alter table public.coaches add constraint coaches_role_check check(role in ('admin','coach','viewer','player'));
alter table public.account_provisions drop constraint account_provisions_role_check;
alter table public.account_provisions add constraint account_provisions_role_check check(role in ('admin','coach','viewer','player'));
alter table public.account_provisions add column pitcher_id uuid references public.pitchers on delete set null;
create unique index provisioned_player_pitcher on public.account_provisions(pitcher_id) where role='player';
create table public.player_accounts (
 account_id uuid primary key references public.coaches on delete cascade,
 pitcher_id uuid not null unique references public.pitchers on delete cascade
);
alter table public.player_accounts enable row level security;
revoke all on public.player_accounts from public,anon,authenticated;
grant all on public.player_accounts to service_role;
grant select on public.player_accounts to authenticated;
create policy player_link_read on public.player_accounts for select to authenticated using(account_id=auth.uid() and public.pw_active());

create or replace function public.profile_from_provision() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.coaches(id,email,name,role) select id,email,name,role from public.account_provisions where id=new.id and email=lower(new.email);
 insert into public.player_accounts select id,pitcher_id from public.account_provisions where id=new.id and role='player';
 return new;
end
$$;
create function public.pw_player_pitcher() returns uuid language sql stable security definer set search_path='' as $$
 select p.pitcher_id from public.player_accounts p join public.coaches c on c.id=p.account_id where c.id=auth.uid() and c.active and c.role='player'
$$;
create or replace function public.pw_team(t uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin()
 or exists(select 1 from public.team_coaches tc join public.coaches c on c.id=tc.coach_id where tc.team_id=t and c.id=auth.uid() and c.role in ('coach','viewer'))
 or exists(select 1 from public.team_pitchers tp join public.teams tm on tm.id=tp.team_id join public.pitchers p on p.id=tp.pitcher_id
 where tp.team_id=t and tp.pitcher_id=public.pw_player_pitcher() and tp.active and not tm.archived and not p.archived))
$$;
create or replace function public.pw_practice(t uuid,recorder uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin() or case when t is null then recorder=auth.uid() else public.pw_team(t) end)
$$;
create or replace function public.pw_pitcher(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin() or p=public.pw_player_pitcher()
 or (public.pw_writer() and exists(select 1 from public.pitchers where id=p and owner_id=auth.uid()))
 or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_team(team_id))
 or exists(select 1 from public.practices where public.pw_practice(team_id,recorder_id) and data->'pitcherIds' ? p::text)
 or exists(select 1 from public.gc_summary_pitchers gp join public.gc_summaries gs on gs.id=gp.summary_id where gp.pitcher_id=p and public.pw_team(gs.team_id)))
$$;

alter function public.account_action(uuid,text,jsonb) rename to pw_account_before_players;
create function public.account_action(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path='' as $$
declare target uuid; pid uuid; provision public.account_provisions;
begin
 perform pg_advisory_xact_lock(79112834);
 if not exists(select 1 from public.coaches where id=p_actor and active and role='admin') then raise exception 'Admin access required' using errcode='42501'; end if;
 if p_action='preparePlayer' then
  pid:=(p_data->>'pitcherId')::uuid;
  if pid is null or not exists(select 1 from public.pitchers where id=pid) then raise exception 'Choose an existing pitcher'; end if;
  insert into public.account_provisions(email,name,role,pitcher_id) values(lower(trim(p_data->>'email')),p_data->>'name','player',pid) on conflict(email) do nothing;
  select * into provision from public.account_provisions where email=lower(trim(p_data->>'email'));
  if provision.role<>'player' or provision.pitcher_id is distinct from pid then raise exception 'This email already has a different account or pitcher link'; end if;
  return jsonb_build_object('id',provision.id);
 elsif p_action='update' and exists(select 1 from public.coaches where id=(p_data->>'id')::uuid and role='player') then
  target:=(p_data->>'id')::uuid; pid:=(p_data->>'pitcherId')::uuid;
  if jsonb_typeof(p_data->'active') is distinct from 'boolean' or p_data->'teamIds' is distinct from '[]'::jsonb then raise exception 'Players cannot receive coaching assignments'; end if;
  if pid is null or not exists(select 1 from public.pitchers where id=pid) then raise exception 'Choose an existing pitcher'; end if;
  update public.account_provisions set pitcher_id=pid where id=target;
  insert into public.player_accounts values(target,pid) on conflict(account_id) do update set pitcher_id=excluded.pitcher_id;
  update public.coaches set active=(p_data->>'active')::boolean where id=target;
  update public.access_requests set status='approved' where email=(select email from public.coaches where id=target);
  return '{}';
 elsif p_action='prepare' and exists(select 1 from public.account_provisions where email=lower(trim(p_data->>'email')) and role='player') then
  raise exception 'This email already has a player account';
 end if;
 return public.pw_account_before_players(p_actor,p_action,p_data);
end
$$;

create table public.goals (
 id uuid primary key, scope text not null check(scope in ('team','coach','personal')),
 team_id uuid references public.teams on delete cascade, pitcher_id uuid references public.pitchers on delete cascade,
 metric text not null check(metric in ('total','balls','positive','strikePct','firstPitchPct','batters','walks','strikeouts','walkPct','pitchesPerBatter')),
 direction text not null check(direction in ('min','max')), target numeric not null check(target>=0 and target<'Infinity'::numeric),
 revision integer not null check(revision>0), updated_at timestamptz not null default now(), updated_by uuid references public.coaches on delete set null,
 check((scope='team' and team_id is not null and pitcher_id is null) or (scope='coach' and team_id is not null and pitcher_id is not null) or (scope='personal' and team_id is null and pitcher_id is not null)),
 check(metric not in ('strikePct','firstPitchPct') or direction='min'), check(metric not in ('walkPct','pitchesPerBatter') or direction='max'),
 check(metric not in ('strikePct','firstPitchPct','walkPct') or target<=100),
 check(metric in ('strikePct','firstPitchPct','walkPct','pitchesPerBatter') or (target=trunc(target) and target<=9007199254740991))
);
create unique index team_goal_metric on public.goals(team_id,metric) where scope='team';
create unique index coach_goal_metric on public.goals(team_id,pitcher_id,metric) where scope='coach';
create unique index personal_goal_metric on public.goals(pitcher_id,metric) where scope='personal';
alter table public.goals enable row level security;
revoke all on public.goals from public,anon,authenticated;
grant all on public.goals to service_role;
grant select on public.goals to authenticated;
create function public.pw_read_goal(s text,t uuid,p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin() or case when s='personal' then p=public.pw_player_pitcher()
 or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_team(team_id)) else public.pw_team(t) end)
$$;
create policy goal_read on public.goals for select to authenticated using(public.pw_read_goal(scope,team_id,pitcher_id));
create function public.pw_goal_json(g public.goals) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',g.id,'scope',g.scope,'teamId',g.team_id,'pitcherId',g.pitcher_id,'metric',g.metric,'direction',g.direction,'target',g.target,'revision',g.revision,'updatedAt',g.updated_at,'updatedBy',g.updated_by)
$$;

alter function public.get_workspace() rename to pw_workspace_before_goals;
create function public.get_workspace() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform pg_advisory_xact_lock_shared(79112834);
 result:=public.pw_workspace_before_goals();
 return result||jsonb_build_object('goals',coalesce((select jsonb_agg(public.pw_goal_json(g)) from public.goals g where public.pw_read_goal(scope,team_id,pitcher_id)),'[]'),
 'coaches',coalesce((select jsonb_agg(c||case when c->>'id'=auth.uid()::text then jsonb_build_object('pitcherId',public.pw_player_pitcher()) else '{}'::jsonb end) from jsonb_array_elements(result->'coaches') c),'[]'));
end
$$;

alter function public.manage(text,jsonb) rename to pw_manage_before_goals;
create function public.manage(action text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.goals; prior public.goals; op public.operation_receipts; expected integer; receipt_id uuid; request_hash jsonb;
begin
 if action not in ('saveGoal','deleteGoal') and not(action='restore' and input->'backup'->>'version'='5') then return public.pw_manage_before_goals(action,input); end if;
 perform pg_advisory_xact_lock(79112834);
 if action='restore' then
  if not public.pw_writer() then raise exception 'Approved coach access required' using errcode='42501'; end if;
  receipt_id:=(input->>'operationId')::uuid;
  request_hash:=jsonb_build_object('hash',md5(jsonb_build_object('action',action,'input',input)::text));
  if receipt_id is null then raise exception 'Missing restore operation ID'; end if;
  select * into op from public.operation_receipts where id=receipt_id;
  if found then
   if op.coach_id<>auth.uid() or op.request<>request_hash then raise exception 'Operation ID already used for a different request'; end if;
   return '{}';
  end if;
  perform public.gc_restore(input);
  insert into public.operation_receipts values(receipt_id,auth.uid(),1,request_hash);
  return '{}';
 end if;
 if not public.pw_active() then raise exception 'Active account required' using errcode='42501'; end if;
 g.id:=(input->>'id')::uuid;
 select * into prior from public.goals where id=g.id;
 if action='deleteGoal' then
  if prior.id is null then raise exception 'Goal changed. Refresh and review again.' using errcode='40001'; end if;
  g:=prior;
 else
  g.scope:=input->>'scope'; g.team_id:=(input->>'teamId')::uuid; g.pitcher_id:=(input->>'pitcherId')::uuid;
  g.metric:=input->>'metric'; g.direction:=input->>'direction'; g.target:=(input->>'target')::numeric;
  if prior.id is not null and (g.scope is distinct from prior.scope or g.team_id is distinct from prior.team_id or g.pitcher_id is distinct from prior.pitcher_id or g.metric is distinct from prior.metric) then raise exception 'Goal identity cannot change'; end if;
 end if;
 if g.scope='personal' then
  if g.pitcher_id is distinct from public.pw_player_pitcher() or g.pitcher_id is null then raise exception 'Only the linked player may edit personal goals' using errcode='42501'; end if;
 else
  if not public.pw_edit_team(g.team_id) then raise exception 'Team goal access denied' using errcode='42501'; end if;
  if exists(select 1 from public.teams where id=g.team_id and archived) then raise exception 'Reactivate this team before editing goals'; end if;
  if g.scope='coach' and not exists(select 1 from public.team_pitchers where team_id=g.team_id and pitcher_id=g.pitcher_id and active) then raise exception 'Choose a pitcher on this team'; end if;
 end if;
 if exists(select 1 from public.pitchers where id=g.pitcher_id and archived) then raise exception 'Reactivate this pitcher before editing goals'; end if;
 expected:=(input->>'expectedRevision')::integer;
 if expected is null or expected<0 or expected<>coalesce(prior.revision,0) then raise exception 'Goal changed. Refresh and review again.' using errcode='40001'; end if;
 if action='deleteGoal' then delete from public.goals where id=g.id;
 else
  if g.id is null or jsonb_typeof(input->'target') is distinct from 'number' then raise exception 'Invalid goal'; end if;
  insert into public.goals(id,scope,team_id,pitcher_id,metric,direction,target,revision,updated_by)
  values(g.id,g.scope,g.team_id,g.pitcher_id,g.metric,g.direction,g.target,expected+1,auth.uid())
  on conflict(id) do update set direction=excluded.direction,target=excluded.target,revision=excluded.revision,updated_at=now(),updated_by=auth.uid();
  select * into g from public.goals where id=g.id;
  return public.pw_goal_json(g);
 end if;
 return '{}';
exception when unique_violation then raise exception 'Goal changed. Refresh and review again.' using errcode='40001';
end
$$;

revoke all on function public.pw_player_pitcher(),public.pw_read_goal(text,uuid,uuid),public.pw_goal_json(public.goals),public.pw_workspace_before_goals(),public.pw_manage_before_goals(text,jsonb),public.pw_account_before_players(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.pw_player_pitcher(),public.pw_read_goal(text,uuid,uuid) to authenticated;
grant execute on function public.pw_account_before_players(uuid,text,jsonb) to service_role;
revoke all on function public.get_workspace(),public.manage(text,jsonb) from public,anon;
grant execute on function public.get_workspace(),public.manage(text,jsonb) to authenticated;
revoke all on function public.account_action(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_action(uuid,text,jsonb) to service_role;

-- Restore copies retain targets, never account links or authorship privileges.
create or replace function public.gc_restore(input jsonb) returns void language plpgsql set search_path='' as $$
declare b jsonb:=input->'backup'; m jsonb:='{}'; item jsonb; p jsonb; s jsonb; source jsonb; newid uuid; key text; pair record; rows jsonb;
begin
 if b->>'format' is distinct from 'pitchwork-backup' or b->>'version' not in ('4','5') then raise exception 'Unsupported backup'; end if;
 foreach key in array array['teams','pitchers','teamPitchers','sessions','events','gcSummaries','gcMappings'] loop
  if jsonb_typeof(b->key) is distinct from 'array' then raise exception 'Invalid backup list: %',key; end if;
 end loop;
 for item in select value from jsonb_array_elements(b->'teams') loop
  if m ? (item->>'id') then raise exception 'Duplicate backup identifier'; end if;
  newid:=gen_random_uuid(); m:=m||jsonb_build_object(item->>'id',newid);
  insert into public.teams(id,name,archived) values(newid,item->>'name',coalesce((item->>'archived')::boolean,false));
  insert into public.team_coaches values(newid,auth.uid());
 end loop;
 for item in select value from jsonb_array_elements(b->'pitchers') loop
  if m ? (item->>'id') then raise exception 'Duplicate backup identifier'; end if;
  newid:=gen_random_uuid(); m:=m||jsonb_build_object(item->>'id',newid);
  insert into public.pitchers(id,name,jersey,owner_id,archived) values(newid,item->>'name',item->>'jersey',auth.uid(),(item->>'archived')::boolean);
 end loop;
 for item in select value from jsonb_array_elements(b->'teamPitchers') loop
  insert into public.team_pitchers values((m->>(item->>'teamId'))::uuid,(m->>(item->>'pitcherId'))::uuid,(item->>'active')::boolean);
 end loop;
 for item in select value from jsonb_array_elements(b->'sessions') loop
  if m ? (item->>'id') or m ? (item->>'initialAppearanceId') then raise exception 'Duplicate backup identifier'; end if;
  m:=m||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'initialAppearanceId',gen_random_uuid());
 end loop;
 for item in select value from jsonb_array_elements(b->'events') loop
  if m ? (item->>'id') or m ? (item->>'nextAppearanceId') then raise exception 'Duplicate backup identifier'; end if;
  m:=m||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'nextAppearanceId',gen_random_uuid());
 end loop;
 if exists(select 1 from jsonb_array_elements(b->'events') e where not exists(select 1 from jsonb_array_elements(b->'sessions') bs where bs->>'id'=e->>'sessionId')) then raise exception 'Orphan backup event'; end if;
 for item in select value from jsonb_array_elements(b->'sessions') loop
  if item->>'teamId' is not null and not exists(select 1 from public.teams where id=(m->>(item->>'teamId'))::uuid) then raise exception 'Missing backup team'; end if;
  if exists(select 1 from jsonb_array_elements_text(item->'pitcherIds') pid where not exists(select 1 from public.pitchers where id=(m->>pid)::uuid)) then raise exception 'Missing backup pitcher'; end if;
  select coalesce(jsonb_agg(value order by (value->>'sequence')::integer),'[]') into source from jsonb_array_elements(b->'events') where value->>'sessionId'=item->>'id';
  s:=item;
  for pair in select * from jsonb_each_text(m) loop
   s:=replace(s::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
   source:=replace(source::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
  end loop;
  s:=s||jsonb_build_object('recorderId',auth.uid(),'deviceId',(input->>'deviceId')::uuid,'revision',1,'recovered',true);
  perform public.validate_practice(s,source);
  insert into public.practices(id,team_id,recorder_id,device_id,revision,data,events,archived) values((s->>'id')::uuid,(s->>'teamId')::uuid,auth.uid(),(input->>'deviceId')::uuid,1,s,source,coalesce((item->>'archived')::boolean,false));
 end loop;
 for item in select value from jsonb_array_elements(b->'gcSummaries') loop
  rows:='[]';
  if not exists(select 1 from public.teams where id=(m->>(item->>'teamId'))::uuid) then raise exception 'Missing backup GC team'; end if;
  for p in select value from jsonb_array_elements(item->'players') loop
   if not exists(select 1 from public.pitchers where id=(m->>(p->>'pitcherId'))::uuid) then raise exception 'Missing backup GC pitcher'; end if;
   rows:=rows||jsonb_build_array(p||jsonb_build_object('pitcherId',m->>(p->>'pitcherId')));
   -- Historical imports can reference an inactive roster membership.
   insert into public.team_pitchers values((m->>(item->>'teamId'))::uuid,(m->>(p->>'pitcherId'))::uuid,false) on conflict do nothing;
  end loop;
  if exists(select 1 from public.gc_summaries where team_id=(m->>(item->>'teamId'))::uuid and season_key=public.gc_key(item->>'season')) then raise exception 'Duplicate backup team season'; end if;
  perform public.gc_save(item||jsonb_build_object('players',rows),(m->>(item->>'teamId'))::uuid,0,auth.uid());
 end loop;
 for item in select value from jsonb_array_elements(b->'gcMappings') loop
  insert into public.gc_mappings values((m->>(item->>'teamId'))::uuid,public.gc_key(item->>'season'),item->>'sourceKey',(m->>(item->>'pitcherId'))::uuid)
   on conflict(team_id,season_key,source_key) do update set pitcher_id=excluded.pitcher_id;
 end loop;

 if b->>'version'='5' then
  if jsonb_typeof(b->'goals') is distinct from 'array' then raise exception 'Invalid backup goals'; end if;
  for item in select value from jsonb_array_elements(b->'goals') loop
   if (item->>'teamId' is not null and not (m ? (item->>'teamId'))) or (item->>'pitcherId' is not null and not (m ? (item->>'pitcherId'))) then raise exception 'Missing backup goal reference'; end if;
   insert into public.goals(id,scope,team_id,pitcher_id,metric,direction,target,revision,updated_by)
   values(gen_random_uuid(),item->>'scope',(m->>(item->>'teamId'))::uuid,(m->>(item->>'pitcherId'))::uuid,item->>'metric',item->>'direction',(item->>'target')::numeric,1,null);
  end loop;
 end if;

end
$$;
