-- Player-private records, durable evaluation and additive compatibility with coaching goals.
alter table public.coaches add column username text unique check(username is null or username ~ '^[a-z0-9][a-z0-9_.-]{2,23}$');
create table public.achievement_records (
 id uuid primary key, pitcher_id uuid not null references public.pitchers on delete cascade,
 kind text not null check(kind in ('profile','season','goal','plan','checkin','drill','participation','scrapbook')),
 revision integer not null check(revision>0), data jsonb not null check(jsonb_typeof(data)='object'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index achievement_profile on public.achievement_records(pitcher_id) where kind='profile';
create table public.achievement_deleted (id uuid primary key,pitcher_id uuid not null references public.pitchers on delete cascade);
create table public.achievement_awards (id text primary key,pitcher_id uuid not null references public.pitchers on delete cascade,data jsonb not null);
create table public.achievement_jobs (
 pitcher_id uuid primary key references public.pitchers on delete cascade, revision bigint not null default 1,
 processed_revision bigint not null default 0, requested_at timestamptz not null default now(), next_evaluate_at timestamptz not null default now(),
 last_error text, evaluated_at timestamptz
);
create table public.team_challenges (id uuid primary key,team_id uuid not null references public.teams on delete cascade,data jsonb not null);
alter table public.achievement_records enable row level security;
alter table public.achievement_deleted enable row level security;
alter table public.achievement_awards enable row level security;
alter table public.achievement_jobs enable row level security;
alter table public.team_challenges enable row level security;
revoke all on public.achievement_records,public.achievement_deleted,public.achievement_awards,public.achievement_jobs,public.team_challenges from public,anon,authenticated;
grant all on public.achievement_records,public.achievement_deleted,public.achievement_awards,public.achievement_jobs,public.team_challenges to service_role;
grant select on public.achievement_records,public.achievement_awards,public.team_challenges to authenticated;
create policy activity_self on public.achievement_records for select to authenticated using(pitcher_id=public.pw_player_pitcher());
create policy awards_self on public.achievement_awards for select to authenticated using(pitcher_id=public.pw_player_pitcher());
create policy challenge_read on public.team_challenges for select to authenticated using(public.pw_team(team_id));
create function public.achievement_record_json(r public.achievement_records) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',r.id,'pitcherId',r.pitcher_id,'kind',r.kind,'data',r.data,'revision',r.revision,'createdAt',r.created_at,'updatedAt',r.updated_at)
$$;
create function public.achievement_dirty(p uuid) returns void language sql set search_path='' as $$
 insert into public.achievement_jobs(pitcher_id) select p where exists(select 1 from public.pitchers where id=p)
 on conflict(pitcher_id) do update set revision=public.achievement_jobs.revision+1,requested_at=now()
$$;
create function public.achievement_source_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare item text;
begin
 if tg_table_name='practices' then
  if tg_op<>'INSERT' then for item in select jsonb_array_elements_text(old.data->'pitcherIds') loop perform public.achievement_dirty(item::uuid);end loop;end if;
  if tg_op<>'DELETE' then for item in select jsonb_array_elements_text(new.data->'pitcherIds') loop perform public.achievement_dirty(item::uuid);end loop;end if;
 else
  if tg_op<>'INSERT' then perform public.achievement_dirty(old.pitcher_id);end if;
  if tg_op<>'DELETE' then perform public.achievement_dirty(new.pitcher_id);end if;
 end if;
 return null;
end $$;
create trigger achievement_practice_change after insert or update or delete on public.practices for each row execute function public.achievement_source_changed();
create trigger achievement_record_change after insert or update or delete on public.achievement_records for each row execute function public.achievement_source_changed();
create trigger achievement_player_link after insert or update on public.player_accounts for each row execute function public.achievement_source_changed();
insert into public.achievement_jobs(pitcher_id) select id from public.pitchers;

-- Player access never exposes the rest of a team practice or another player's goals.
alter function public.pw_practice(uuid,uuid) rename to pw_practice_before_achievements;
create function public.pw_practice(t uuid,recorder uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_practice_before_achievements(t,recorder) or public.pw_player_pitcher() is not null and t is null and recorder=auth.uid()
$$;
alter function public.pw_pitcher(uuid) rename to pw_pitcher_before_achievements;
create function public.pw_pitcher(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_pitcher_before_achievements(p)
$$;
alter function public.pw_coach(uuid) rename to pw_coach_before_achievements;
create function public.pw_coach(c uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_coach_before_achievements(c)
$$;
alter function public.pw_read_goal(text,uuid,uuid) rename to pw_read_goal_before_achievements;
create function public.pw_read_goal(s text,t uuid,p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_read_goal_before_achievements(s,t,p)
$$;
-- Renaming functions retains old policy OIDs: replace the policies explicitly.
drop policy practice_read on public.practices;
create policy practice_read on public.practices for select to authenticated using(public.pw_practice(team_id,recorder_id));
drop policy pitcher_read on public.pitchers;
create policy pitcher_read on public.pitchers for select to authenticated using(public.pw_pitcher(id));
drop policy teammate_read on public.coaches;
create policy teammate_read on public.coaches for select to authenticated using(public.pw_coach(id));
drop policy goal_read on public.goals;
create policy goal_read on public.goals for select to authenticated using(public.pw_read_goal(scope,team_id,pitcher_id));
drop policy team_pitcher_read on public.team_pitchers;
create policy team_pitcher_read on public.team_pitchers for select to authenticated using(public.pw_team(team_id) and public.pw_pitcher(pitcher_id));
drop policy team_coach_read on public.team_coaches;
create policy team_coach_read on public.team_coaches for select to authenticated using(public.pw_player_pitcher() is null and public.pw_team(team_id));
drop policy invitation_read on public.invitations;
create policy invitation_read on public.invitations for select to authenticated using(public.pw_player_pitcher() is null and (public.pw_team(team_id) or email=public.pw_email()));
drop policy gc_read on public.gc_summaries;
create policy gc_read on public.gc_summaries for select to authenticated using(public.pw_team(team_id));
drop policy gc_players_read on public.gc_summary_pitchers;
create policy gc_players_read on public.gc_summary_pitchers for select to authenticated using(exists(select 1 from public.gc_summaries s where s.id=summary_id and public.pw_team(s.team_id)));
drop policy gc_mapping_read on public.gc_mappings;
create policy gc_mapping_read on public.gc_mappings for select to authenticated using(public.pw_team(team_id));

create function public.achievement_player_workspace(pid uuid,actor uuid) returns jsonb language plpgsql set search_path='' as $$
declare sessions jsonb:='[]'; events jsonb:='[]'; p public.practices; filtered jsonb; e jsonb; previous_pid text; s jsonb; owned boolean;
begin
 for p in select * from public.practices where data->'pitcherIds' ? pid::text loop
  owned:=p.recorder_id=actor and p.team_id is null;
  if owned then s:=p.data||jsonb_build_object('archived',p.archived);filtered:=p.events;
  else
   filtered:='[]';previous_pid:=null;
   for e in select value from jsonb_array_elements(p.events) order by (value->>'sequence')::integer loop
    if e->>'pitcherId'=pid::text then filtered:=filtered||jsonb_build_array(e);
    elsif e->>'kind'='switch' and previous_pid=pid::text then filtered:=filtered||jsonb_build_array((e-'pitchType'-'pitchLocation'-'intendedTarget'-'drillId')||jsonb_build_object('kind','reset','pitcherId',pid));end if;
    previous_pid:=e->>'pitcherId';
   end loop;
   if filtered='[]'::jsonb then continue;end if;
   s:=jsonb_build_object('id',p.id,'name','Recorded practice','notes','','startedAt',p.data->'startedAt','updatedAt',p.data->'updatedAt','endedAt',p.data->'endedAt','status',p.data->'status','initialPitcherId',pid,'initialAppearanceId',filtered->0->'appearanceId','selectedPitcherId',pid,'pitcherIds',jsonb_build_array(pid),'nextSequence',p.data->'nextSequence','teamId',null,'recorderId',actor,'deviceId',actor,'revision',p.revision,'recovered',true,'originSessionId',case when p.data->>'recovered'='true' then p.data->>'originSessionId' else p.id::text end,'archived',p.archived);
  end if;
  sessions:=sessions||jsonb_build_array(s);events:=events||filtered;
 end loop;
 return jsonb_build_object('sessions',sessions,'events',events,'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'jersey',jersey,'ownerId',actor,'archived',archived,'createdAt',created_at,'updatedAt',updated_at)) from public.pitchers where id=pid),'[]'));
end $$;
alter function public.get_workspace() rename to pw_workspace_before_achievements;
create function public.get_workspace() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; own_data jsonb; pid uuid:=public.pw_player_pitcher();
begin
 result:=public.pw_workspace_before_achievements();
 if pid is not null then
  own_data:=public.achievement_player_workspace(pid,auth.uid());
  result:=result||jsonb_build_object('achievementSessions',own_data->'sessions','achievementEvents',own_data->'events');
 end if;
 return result||jsonb_build_object('achievementRecords',coalesce((select jsonb_agg(public.achievement_record_json(r)) from public.achievement_records r where pitcher_id=pid),'[]'),
 'achievementAwards',coalesce((select jsonb_agg(data) from public.achievement_awards where pitcher_id=pid),'[]'),
 'teamChallenges',coalesce((select jsonb_agg(data||jsonb_build_object('id',id,'teamId',team_id)) from public.team_challenges where public.pw_team(team_id)),'[]'),
 'achievementEvaluation',(select jsonb_build_object('revision',revision,'processedRevision',processed_revision) from public.achievement_jobs where pitcher_id=pid));
end $$;

-- Reuse the complete event validation/revision checks without widening coaching rights.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.pw_upload_practice_core(jsonb)'::regprocedure);
 definition:=replace(definition,'pw_upload_practice_core','pw_player_upload_core');
 definition:=replace(definition,'if not public.pw_writer() then','if public.pw_player_pitcher() is null then');
 execute definition;
end $$;
alter function public.upload_practice(jsonb) rename to pw_upload_before_achievements;
create function public.upload_practice(operation jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare pid uuid:=public.pw_player_pitcher();s jsonb:=operation->'session';e jsonb;result integer;
begin
 if pid is null then return public.pw_upload_before_achievements(operation);end if;
 perform pg_advisory_xact_lock(79112834);
 if s->>'teamId' is not null or s->'pitcherIds' is distinct from jsonb_build_array(pid) or s->>'initialPitcherId'<>pid::text or s->>'selectedPitcherId'<>pid::text
 or exists(select 1 from jsonb_array_elements(operation->'events') as pitch(value) where pitch.value->>'pitcherId'<>pid::text or pitch.value->>'kind'='switch') then raise exception 'Players cannot record team or other-player practices' using errcode='42501';end if;
 if exists(select 1 from public.record_tombstones where (kind='session' and id=(s->>'id')::uuid) or (kind='pitcher' and id=pid)) then raise exception 'Practice or player was deleted' using errcode='40001';end if;
 if exists(select 1 from public.practices where id=(s->>'id')::uuid and archived) then raise exception 'Practice archived' using errcode='40001';end if;
 for e in select value from jsonb_array_elements(operation->'events') loop
  if e ? 'intendedTarget' and (e->>'kind'<>'pitch' or e->>'intendedTarget' not in ('upIn','upOut','downIn','downOut','middle')) then raise exception 'Invalid intended target';end if;
  if e ? 'drillId' and not exists(select 1 from public.achievement_records r where r.id=(e->>'drillId')::uuid and r.pitcher_id=pid and r.kind='drill' and r.data->>'sessionId'=s->>'id' and coalesce((r.data->>'startSequence')::integer,1)<=(e->>'sequence')::integer) then raise exception 'Start your drill before recording target pitches';end if;
 end loop;
 return public.pw_player_upload_core(operation);
end $$;

alter function public.manage(text,jsonb) rename to pw_manage_before_achievements;
create function public.manage(action text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare pid uuid:=public.pw_player_pitcher();r jsonb:=input->'record';d jsonb:=r->'data';k text:=r->>'kind';rid uuid:=(r->>'id')::uuid;prior public.achievement_records;receipt public.operation_receipts;opid uuid;hash jsonb;expected integer;today text;tz text;practice public.practices;label text;
begin
 if pid is not null and action in ('removalPreview','archiveRecord','deleteRecord') and input->>'kind'='session' then
  perform pg_advisory_xact_lock(79112834);
  select * into practice from public.practices where id=(input->>'id')::uuid and recorder_id=auth.uid() and team_id is null;
  if not found then raise exception 'Only your own independent practices can be removed' using errcode='42501';end if;
  label:=coalesce(nullif(practice.data->>'name',''),'Bullpen practice');
  if action='removalPreview' then return jsonb_build_object('name',label,'canRemove',true,'archiveBlockers',case when practice.data->>'status'<>'ended' then '["End this practice first"]'::jsonb else '[]'::jsonb end,'deleteBlockers',case when practice.data->>'status'<>'ended' then '["End this practice first"]'::jsonb else '[]'::jsonb end,'practices','[]'::jsonb,'hiddenPractices',0,'assignments',0,'invitations',0);end if;
  if practice.data->>'status'<>'ended' then raise exception 'End this practice first';end if;
  if action='archiveRecord' then update public.practices set archived=(input->>'archived')::boolean where id=practice.id;
  else
   if input->>'confirmation' is distinct from label then raise exception 'Type the practice name to delete it';end if;
   insert into public.record_tombstones(kind,id) values('session',practice.id) on conflict do nothing;
   insert into public.removal_visibility(viewer_id,kind,id) values(auth.uid(),'session',practice.id) on conflict do nothing;
   delete from public.practices where id=practice.id;
  end if;
  return '{}';
 elsif action='saveTeamChallenge' then
  if not public.pw_edit_team((input->>'teamId')::uuid) then raise exception 'Team challenge access denied' using errcode='42501';end if;
  if length(trim(input->>'name')) not between 1 and 80 or length(input->>'description')>1000 or (input->>'start')::date>(input->>'end')::date then raise exception 'Invalid challenge';end if;
  insert into public.team_challenges values((input->>'id')::uuid,(input->>'teamId')::uuid,input-'id'-'teamId') on conflict(id) do update set data=excluded.data where public.team_challenges.team_id=excluded.team_id;
  return '{}';
 elsif action<>'saveAchievementRecord' then return public.pw_manage_before_achievements(action,input);end if;
 if pid is null or pid::text is distinct from r->>'pitcherId' then raise exception 'Linked player access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(79112834);
 opid:=(input->>'id')::uuid;hash:=jsonb_build_object('hash',md5(input::text));
 select * into receipt from public.operation_receipts where id=opid;
 if found then if receipt.coach_id<>auth.uid() or receipt.request<>hash then raise exception 'Operation ID already used' using errcode='40001';end if;return '{}';end if;
 select * into prior from public.achievement_records where id=rid;
 expected:=(input->>'expectedRevision')::integer;
 if expected is null or expected<>coalesce(prior.revision,0) or prior.pitcher_id is not null and prior.pitcher_id<>pid or exists(select 1 from public.achievement_deleted where id=rid) then raise exception 'Activity changed. Export your pending work and review the server version.' using errcode='40001';end if;
 if prior.id is not null and prior.kind<>k then raise exception 'Activity type cannot change' using errcode='22023';end if;
 select coalesce(data->>'timezone','UTC') into tz from public.achievement_records where pitcher_id=pid and kind='profile';
 today:=to_char(now() at time zone coalesce(tz,'UTC'),'YYYY-MM-DD');
 if (r->>'createdAt')::timestamptz>now()+interval '5 minutes' then raise exception 'Activity clock is ahead; check your device time' using errcode='22023';end if;
 if jsonb_typeof(d) is distinct from 'object' or length(d::text)>5000 then raise exception 'Invalid activity' using errcode='22023';end if;
 if (case k
 when 'profile' then d ?& array['sport','ageBand','timezone','pins','sound'] and jsonb_typeof(d->'pins')='array'
 when 'season' then d ?& array['name','start','end']
 when 'goal' then d ?& array['metric','scope','target','effectiveFrom']
 when 'plan' then d ?& array['date','activity']
 when 'checkin' then d ?& array['date','action']
 when 'drill' then d ?& array['date','type','complete'] and jsonb_typeof(d->'complete')='boolean'
 when 'participation' then d ?& array['date','challengeId','complete'] and jsonb_typeof(d->'complete')='boolean'
 when 'scrapbook' then d ?& array['seasonId','goalReviewed','learning','favorite'] and jsonb_typeof(d->'goalReviewed')='boolean'
 else false end) is not true then raise exception 'Required activity fields are missing' using errcode='22023';end if;
 if input->>'deleted'='true' then
  if k='goal' then raise exception 'Pause a goal to preserve its history' using errcode='22023';end if;
  delete from public.achievement_records where id=rid;
  insert into public.achievement_deleted values(rid,pid);
 else
  if k='profile' then
   if prior.id is not null and d->>'timezone' is distinct from prior.data->>'timezone' then raise exception 'Achievement timezone is fixed to preserve dated editions' using errcode='22023';end if;
   if d->>'sport' not in ('baseball','softball') or d->>'ageBand' not in ('8–10','11–13','14–18') or not exists(select 1 from pg_timezone_names where name=d->>'timezone') or jsonb_array_length(d->'pins')>3 or jsonb_typeof(d->'sound') is distinct from 'boolean' then raise exception 'Invalid player settings' using errcode='22023';end if;
  elsif k='season' then
   if length(trim(d->>'name')) not between 1 and 80 or (d->>'start')::date>(d->>'end')::date or exists(select 1 from public.achievement_records where pitcher_id=pid and kind='season' and id<>rid and (data->>'start')::date<=(d->>'end')::date and (data->>'end')::date>=(d->>'start')::date) then raise exception 'Achievement seasons must have valid, nonoverlapping dates' using errcode='22023';end if;
  elsif k='goal' then
   if d->>'metric' not in ('strike','firstPitch','walk','target','practice','habit','reflection','pitches') or d->>'scope' not in ('week','month','season') or jsonb_typeof(d->'target') is distinct from 'number' or (d->>'target')::numeric<=0 or (d->>'target')::numeric>'9007199254740991'::numeric or (d->>'metric' in ('strike','firstPitch','walk','target') and (d->>'target')::numeric>100) then raise exception 'Invalid personal goal' using errcode='22023';end if;
   if prior.id is not null and (d-'pausedAt')<>(prior.data-'pausedAt') then raise exception 'Create a new goal version; existing targets are frozen' using errcode='22023';end if;
   if prior.data ? 'pausedAt' and not (d ? 'pausedAt') then raise exception 'Resume with a new goal version' using errcode='22023';end if;
   if prior.id is null and (d->>'effectiveFrom')::date<today::date then raise exception 'Goals cannot be backdated' using errcode='22023';end if;
   if prior.id is null and exists(select 1 from public.achievement_records where pitcher_id=pid and kind='goal' and data->>'metric'=d->>'metric' and data->>'scope'=d->>'scope' and coalesce(data->>'seasonId','')=coalesce(d->>'seasonId','')) then
    if d->>'scope'='week' and (d->>'effectiveFrom')::date<today::date+(7-extract(dow from today::date)::integer)
    or d->>'scope'='month' and (d->>'effectiveFrom')::date<(date_trunc('month',today::date)+interval '1 month')::date
    or d->>'scope'='season' then raise exception 'Changed goals begin next window; choose a new season for seasonal goals' using errcode='22023';end if;
   end if;
   if d ? 'pausedAt' and d->>'pausedAt'<>today then raise exception 'Goal pauses begin today' using errcode='22023';end if;
   if d->>'scope'='season' and not exists(select 1 from public.achievement_records where id=(d->>'seasonId')::uuid and pitcher_id=pid and kind='season') then raise exception 'Choose your season' using errcode='22023';end if;
  elsif k in ('plan','checkin','drill','participation') then
   perform (d->>'date')::date;
   if k<>'plan' and d->>'date'>today then raise exception 'Complete activities before logging them' using errcode='22023';end if;
   if k='plan' and d->>'activity' not in ('practice','rest','offseason') then raise exception 'Invalid plan' using errcode='22023';end if;
   if k='checkin' and d->>'action' not in ('warmup','cooldown','readiness','rest','adaptation','gear','routine','focus','reflection','learning','nextStep','visualization','reset','feedbackAsked','feedbackApplied','encouragement','setup','cleanup','sharedLearning','commitment') then raise exception 'Invalid check-in' using errcode='22023';end if;
   if k='drill' and d->>'type' not in ('target','firstPitch','count','balance','finish','fielding','left','right') then raise exception 'Invalid drill' using errcode='22023';end if;
   if k='participation' and not exists(select 1 from public.team_challenges where id=(d->>'challengeId')::uuid and public.pw_team(team_id) and d->>'date'>=data->>'start' and d->>'date'<=data->>'end') then raise exception 'Choose a current team challenge' using errcode='22023';end if;
  elsif k='scrapbook' then
   if not exists(select 1 from public.achievement_records where id=(d->>'seasonId')::uuid and pitcher_id=pid and kind='season' and data->>'end'<today) then raise exception 'Choose a completed season' using errcode='22023';end if;
  else raise exception 'Invalid activity type' using errcode='22023';end if;
  insert into public.achievement_records(id,pitcher_id,kind,revision,data,created_at) values(rid,pid,k,expected+1,d,coalesce(prior.created_at,(r->>'createdAt')::timestamptz,now()))
  on conflict(id) do update set revision=excluded.revision,data=excluded.data,updated_at=now();
 end if;
 insert into public.operation_receipts values(opid,auth.uid(),expected+1,hash);
 return '{}';
end $$;

create function public.achievement_input(p uuid) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('sessions',coalesce((select jsonb_agg(data) from public.practices where data->'pitcherIds' ? p::text),'[]'),
 'events',coalesce((select jsonb_agg(e) from public.practices cross join lateral jsonb_array_elements(events) e where data->'pitcherIds' ? p::text),'[]'),
 'achievementRecords',coalesce((select jsonb_agg(public.achievement_record_json(r)) from public.achievement_records r where pitcher_id=p),'[]'))
$$;
create function public.achievement_commit(p uuid,expected bigint,awards jsonb) returns boolean language plpgsql set search_path='' as $$
declare item jsonb;
begin
 perform 1 from public.achievement_jobs where pitcher_id=p and revision=expected for update;
 if not found then return false;end if;
 for item in select value from jsonb_array_elements(awards) loop
  if item->>'pitcherId'<>p::text then raise exception 'Invalid award owner';end if;
  insert into public.achievement_awards values(item->>'id',p,item) on conflict(id) do update set data=excluded.data where public.achievement_awards.pitcher_id=p;
 end loop;
 update public.achievement_jobs set processed_revision=expected,evaluated_at=now(),next_evaluate_at=now()+interval '15 minutes',last_error=null where pitcher_id=p;
 return true;
end $$;
create function public.player_login_limit(p_bucket text) returns void language plpgsql set search_path='' as $$
declare n integer;
begin
 insert into public.request_limits values('login:'||p_bucket,now(),1) on conflict(bucket) do update set attempts=case when public.request_limits.window_start<now()-interval '15 minutes' then 1 else public.request_limits.attempts+1 end,window_start=case when public.request_limits.window_start<now()-interval '15 minutes' then now() else public.request_limits.window_start end returning attempts into n;
 if n>20 then raise exception 'Try signing in again later';end if;
 delete from public.request_limits where window_start<now()-interval '1 day';
end $$;
-- Everything below the public wrappers is server-only.
revoke all on function public.achievement_record_json(public.achievement_records),public.achievement_dirty(uuid),public.achievement_source_changed(),public.achievement_player_workspace(uuid,uuid),public.achievement_input(uuid),public.achievement_commit(uuid,bigint,jsonb),public.player_login_limit(text),public.pw_player_upload_core(jsonb),public.pw_upload_before_achievements(jsonb),public.pw_workspace_before_achievements(),public.pw_manage_before_achievements(text,jsonb),public.pw_practice_before_achievements(uuid,uuid),public.pw_pitcher_before_achievements(uuid),public.pw_coach_before_achievements(uuid),public.pw_read_goal_before_achievements(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.achievement_record_json(public.achievement_records),public.achievement_input(uuid),public.achievement_commit(uuid,bigint,jsonb),public.player_login_limit(text) to service_role;
revoke all on function public.get_workspace(),public.manage(text,jsonb),public.upload_practice(jsonb),public.pw_practice(uuid,uuid),public.pw_pitcher(uuid),public.pw_coach(uuid),public.pw_read_goal(text,uuid,uuid) from public,anon;
grant execute on function public.get_workspace(),public.manage(text,jsonb),public.upload_practice(jsonb),public.pw_practice(uuid,uuid),public.pw_pitcher(uuid),public.pw_coach(uuid),public.pw_read_goal(text,uuid,uuid) to authenticated;
