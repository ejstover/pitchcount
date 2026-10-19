-- All data mutations use authenticated functions; no browser has direct write grants.
create table public.teams (
  id uuid primary key, name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.team_coaches (
  team_id uuid references public.teams on delete restrict, coach_id uuid references public.coaches on delete restrict,
  primary key (team_id, coach_id)
);
create index on public.team_coaches(coach_id);
create table public.pitchers (
  id uuid primary key, name text not null check (length(trim(name)) > 0), jersey text not null default '',
  owner_id uuid not null references public.coaches, archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.team_pitchers (
  team_id uuid references public.teams, pitcher_id uuid references public.pitchers,
  active boolean not null default true, primary key (team_id, pitcher_id)
);
create index on public.team_pitchers(pitcher_id);
create table public.invitations (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams,
  email text not null check (email = lower(trim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  team_name text not null, created_at timestamptz not null default now(), unique(team_id,email)
);
create table public.practices (
  id uuid primary key, team_id uuid references public.teams, recorder_id uuid not null references public.coaches,
  device_id uuid not null, revision integer not null check(revision > 0),
  data jsonb not null, events jsonb not null check(jsonb_typeof(events) = 'array')
);
create index on public.practices(team_id);
create index on public.practices(recorder_id);
create table public.operation_receipts (
  id uuid primary key, coach_id uuid not null references public.coaches, revision integer not null,
  request jsonb not null
);

create function public.pw_active() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.coaches where id=auth.uid() and active)
$$;
create function public.pw_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.coaches where id=auth.uid() and active and role='admin')
$$;
create function public.pw_writer() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.coaches where id=auth.uid() and active and role in ('admin','coach'))
$$;
create function public.pw_email() returns text language sql stable security definer set search_path = '' as $$
  select lower(email) from public.coaches where id=auth.uid() and active
$$;
create function public.pw_team(t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_active() and (public.pw_admin() or exists(select 1 from public.team_coaches where team_id=t and coach_id=auth.uid()))
$$;
create function public.pw_edit_team(t uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_writer() and public.pw_team(t)
$$;
create function public.pw_practice(t uuid, recorder uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_active() and (case when t is null then recorder=auth.uid() else public.pw_team(t) end)
$$;
create function public.pw_pitcher(p uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_active() and (
    exists(select 1 from public.pitchers where id=p and owner_id=auth.uid())
    or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_team(team_id))
    or exists(select 1 from public.practices where public.pw_practice(team_id,recorder_id) and data->'pitcherIds' ? p::text)
  )
$$;
create function public.pw_edit_pitcher(p uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_writer() and (public.pw_admin()
    or exists(select 1 from public.pitchers where id=p and owner_id=auth.uid())
    or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_edit_team(team_id)))
$$;
create function public.pw_coach(c uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.pw_active() and (c=auth.uid() or public.pw_admin() or exists(
    select 1 from public.team_coaches where coach_id=c and public.pw_team(team_id)))
$$;

alter table public.teams enable row level security;
alter table public.team_coaches enable row level security;
alter table public.pitchers enable row level security;
alter table public.team_pitchers enable row level security;
alter table public.invitations enable row level security;
alter table public.practices enable row level security;
alter table public.operation_receipts enable row level security;
create policy team_read on public.teams for select to authenticated using (public.pw_team(id));
create policy team_coach_read on public.team_coaches for select to authenticated using (public.pw_team(team_id));
create policy pitcher_read on public.pitchers for select to authenticated using (public.pw_pitcher(id));
create policy team_pitcher_read on public.team_pitchers for select to authenticated using (public.pw_team(team_id) and public.pw_pitcher(pitcher_id));
create policy invitation_read on public.invitations for select to authenticated using (public.pw_team(team_id) or email=public.pw_email());
create policy practice_read on public.practices for select to authenticated using (public.pw_practice(team_id,recorder_id));
-- The auth migration owns coaches and its self/admin policy. This adds teammate visibility.
create policy teammate_read on public.coaches for select to authenticated using (public.pw_coach(id));
revoke all on public.teams,public.team_coaches,public.pitchers,public.team_pitchers,public.invitations,public.practices,public.operation_receipts from anon,authenticated;
grant all on public.teams,public.team_coaches,public.pitchers,public.team_pitchers,public.invitations,public.practices,public.operation_receipts to service_role;
grant select on public.teams,public.team_coaches,public.pitchers,public.team_pitchers,public.invitations,public.practices to authenticated;

create function public.get_workspace() returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'teams',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'createdAt',created_at,'updatedAt',updated_at)) from public.teams),'[]'),
    'coaches',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'role',role,'active',active)) from public.coaches),'[]'),
    'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'jersey',jersey,'ownerId',owner_id,'archived',archived,'createdAt',created_at,'updatedAt',updated_at)) from public.pitchers),'[]'),
    'teamCoaches',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'coachId',coach_id)) from public.team_coaches),'[]'),
    'teamPitchers',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'pitcherId',pitcher_id,'active',active)) from public.team_pitchers),'[]'),
    'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'teamId',team_id,'email',email,'teamName',team_name,'createdAt',created_at)) from public.invitations),'[]'),
    'sessions',coalesce((select jsonb_agg(data) from public.practices),'[]'),
    'events',coalesce((select jsonb_agg(e) from public.practices cross join lateral jsonb_array_elements(events) e),'[]')
  )
$$;

-- Validate the authoritative event stream, including projection after undo.
create function public.validate_practice(s jsonb, source jsonb) returns void language plpgsql set search_path = '' as $$
declare e jsonb; n integer:=0; balls integer:=0; strikes integer:=0; ends integer:=0;
  current_id text:=s->>'initialAppearanceId'; current_pitcher text:=s->>'initialPitcherId';
  reserved text[]:=array[s->>'initialAppearanceId']; identifiers text[]:=array[s->>'initialAppearanceId'];
  participants text[]; v text; required_key text;
begin
  if jsonb_typeof(s)<>'object' or jsonb_typeof(source)<>'array' or jsonb_typeof(s->'pitcherIds')<>'array'
    or not (s ?& array['id','name','notes','startedAt','updatedAt','endedAt','status','initialPitcherId','initialAppearanceId','selectedPitcherId','pitcherIds','nextSequence','teamId','recorderId','deviceId','revision'])
    or jsonb_typeof(s->'name')<>'string' or jsonb_typeof(s->'notes')<>'string'
    or (s->>'status') not in ('active','paused','ended') or (s->>'revision')::integer<1 then
    raise exception 'Invalid practice' using errcode='22023';
  end if;
  foreach required_key in array array['id','status','initialPitcherId','initialAppearanceId','selectedPitcherId','startedAt','updatedAt','recorderId','deviceId'] loop
    if jsonb_typeof(s->required_key) is distinct from 'string' then raise exception 'Invalid practice field'; end if;
  end loop;
  if jsonb_typeof(s->'revision') is distinct from 'number' or jsonb_typeof(s->'nextSequence') is distinct from 'number' then raise exception 'Invalid revision or sequence'; end if;
  perform (s->>'id')::uuid, (s->>'recorderId')::uuid, (s->>'deviceId')::uuid,
    (s->>'startedAt')::timestamptz, (s->>'updatedAt')::timestamptz, current_id::uuid;
  select array_agg(x) into participants from jsonb_array_elements_text(s->'pitcherIds') x;
  if participants is null or cardinality(participants)<>(select count(distinct x) from unnest(participants) x)
    or not current_pitcher=any(participants) or not (s->>'selectedPitcherId')=any(participants) then raise exception 'Invalid participants'; end if;
  foreach v in array participants loop perform v::uuid; end loop;
  for e in select value from jsonb_array_elements(source) loop
    n:=n+1;
    foreach required_key in array array['id','sessionId','pitcherId','appearanceId','nextAppearanceId','timestamp','kind'] loop
      if jsonb_typeof(e->required_key) is distinct from 'string' then raise exception 'Invalid event field'; end if;
    end loop;
    if jsonb_typeof(e->'sequence') is distinct from 'number' then raise exception 'Invalid event sequence'; end if;
    if not (e ?& array['id','sessionId','pitcherId','appearanceId','nextAppearanceId','sequence','timestamp','kind','voidedAt'])
      or (e->>'sessionId') is distinct from (s->>'id') or (e->>'sequence')::integer<>n
      or not (e->>'pitcherId')=any(participants) or not (e->>'appearanceId')=any(reserved)
      or (e->>'kind') not in ('pitch','next','reset','switch','end')
      or (e->>'nextAppearanceId')=any(reserved) or (e->>'id')=any(identifiers) then raise exception 'Invalid event references or sequence'; end if;
    perform (e->>'id')::uuid, (e->>'appearanceId')::uuid, (e->>'nextAppearanceId')::uuid, (e->>'timestamp')::timestamptz;
    identifiers:=array_append(identifiers,e->>'id'); reserved:=array_append(reserved,e->>'nextAppearanceId');
    if e->>'kind'='pitch' then
      if (e->>'pitchType') is null or (e->>'pitchType') not in ('ball','called','swinging','foul','inPlay')
        or (e ? 'pitchLocation' and ((e->>'pitchLocation') is null or (e->>'pitchLocation') not in ('upIn','upOut','downIn','downOut','middle'))) then raise exception 'Invalid pitch'; end if;
      if e->>'voidedAt' is not null then perform (e->>'voidedAt')::timestamptz; continue; end if;
    elsif e->>'voidedAt' is not null or e ? 'pitchType' or e ? 'pitchLocation' then raise exception 'Invalid boundary'; end if;
    if ends>0 or (e->>'kind'<>'switch' and (e->>'pitcherId')<>current_pitcher) then raise exception 'Invalid event order'; end if;
    if e->>'kind'='pitch' then
      if (e->>'appearanceId')<>current_id then raise exception 'Invalid batter'; end if;
      if e->>'pitchType'='ball' then balls:=balls+1;
      elsif e->>'pitchType' in ('called','swinging') or (e->>'pitchType'='foul' and strikes<2) then strikes:=strikes+1; end if;
      if balls=4 or strikes=3 or e->>'pitchType'='inPlay' then current_id:=e->>'nextAppearanceId'; balls:=0; strikes:=0; end if;
    elsif e->>'kind'='end' then ends:=ends+1;
    else
      current_id:=e->>'nextAppearanceId'; balls:=0; strikes:=0;
      if e->>'kind'='switch' then current_pitcher:=e->>'pitcherId'; end if;
    end if;
  end loop;
  if (s->>'nextSequence')::integer<>n+1 or current_pitcher<>(s->>'selectedPitcherId')
    or (s->>'status'='ended' and (ends<>1 or s->>'endedAt' is null or source->-1->>'kind'<>'end'))
    or (s->>'status'<>'ended' and (ends<>0 or s->>'endedAt' is not null)) then raise exception 'Practice status disagrees with events'; end if;
end
$$;

create function public.upload_practice(operation jsonb) returns integer language plpgsql security definer set search_path = '' as $$
declare s jsonb:=operation->'session'; source jsonb:=operation->'events'; prior public.practices;
  receipt public.operation_receipts; sid uuid:=(s->>'id')::uuid; tid uuid:=(s->>'teamId')::uuid;
  expected integer:=(operation->>'expectedRevision')::integer; p text; e jsonb; old_event jsonb;
begin
  if not public.pw_writer() then raise exception 'Account cannot record practices' using errcode='42501'; end if;
  if (s->>'recorderId')::uuid<>auth.uid() or not public.pw_practice(tid,auth.uid()) then raise exception 'Team access was removed' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sid::text,0));
  select * into receipt from public.operation_receipts where id=(operation->>'id')::uuid;
  if found then
    if receipt.coach_id<>auth.uid() or receipt.request<>operation then raise exception 'Operation identifier already used' using errcode='40001'; end if;
    return receipt.revision;
  end if;
  select * into prior from public.practices where id=sid for update;
  if found then
    if prior.recorder_id<>auth.uid() or prior.device_id<>(s->>'deviceId')::uuid then raise exception 'This practice belongs to another recorder' using errcode='42501'; end if;
    if prior.team_id is distinct from tid or prior.data->>'initialPitcherId' is distinct from s->>'initialPitcherId'
      or prior.data->>'initialAppearanceId' is distinct from s->>'initialAppearanceId'
      or prior.data->>'startedAt' is distinct from s->>'startedAt' or prior.data->>'recovered'='true' then raise exception 'Practice identity cannot change' using errcode='42501'; end if;
    if prior.revision<>expected then raise exception 'Practice revision conflict; saved work retained on device' using errcode='40001'; end if;
    if jsonb_array_length(source)<jsonb_array_length(prior.events) then raise exception 'Events cannot be deleted'; end if;
    for old_event in select value from jsonb_array_elements(prior.events) loop
      e:=source->((old_event->>'sequence')::integer-1);
      if (e-'voidedAt')<>(old_event-'voidedAt') or (old_event->>'voidedAt' is not null and e->>'voidedAt' is distinct from old_event->>'voidedAt') then raise exception 'Recorded events cannot change'; end if;
    end loop;
    if prior.data->>'status'='ended' and (source<>prior.events or s->>'status'<>'ended' or s->>'endedAt' is distinct from prior.data->>'endedAt') then raise exception 'Practice has ended'; end if;
  elsif expected<>0 then raise exception 'Practice revision conflict' using errcode='40001'; end if;
  if (s->>'revision')::integer<=expected or s->>'recovered'='true' then raise exception 'Invalid revision'; end if;
  perform public.validate_practice(s,source);
  for p in select jsonb_array_elements_text(s->'pitcherIds') loop
    if not coalesce(prior.data->'pitcherIds' ? p,false) then
      if not public.pw_pitcher(p::uuid) or exists(select 1 from public.pitchers where id=p::uuid and archived)
        or (tid is not null and not exists(select 1 from public.team_pitchers where team_id=tid and pitcher_id=p::uuid and active)) then
        raise exception 'Pitcher is not available on this team' using errcode='42501';
      end if;
    end if;
  end loop;
  insert into public.practices values(sid,tid,auth.uid(),(s->>'deviceId')::uuid,(s->>'revision')::integer,s,source)
    on conflict(id) do update set revision=excluded.revision,data=excluded.data,events=excluded.events;
  insert into public.operation_receipts values((operation->>'id')::uuid,auth.uid(),(s->>'revision')::integer,operation);
  return (s->>'revision')::integer;
end
$$;

create function public.manage(action text, input jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare tid uuid; pid uuid; cid uuid; iid uuid; invite_email text; t public.teams; inv public.invitations; item jsonb;
  b jsonb; mapping jsonb:='{}'; oldid text; newid uuid; s jsonb; source jsonb; pair record;
begin
  if not public.pw_writer() then raise exception 'Account cannot manage teams' using errcode='42501'; end if;
  tid:=(input->>'teamId')::uuid;
  if action='saveTeam' then
    tid:=(input->>'id')::uuid;
    perform pg_advisory_xact_lock(hashtextextended(tid::text,0));
    if exists(select 1 from public.teams where id=tid) then
      if not public.pw_edit_team(tid) then raise exception 'Team access denied' using errcode='42501'; end if;
      update public.teams set name=trim(input->>'name'),updated_at=now() where id=tid;
      update public.invitations set team_name=trim(input->>'name') where team_id=tid;
    else
      insert into public.teams(id,name) values(tid,trim(input->>'name'));
      insert into public.team_coaches values(tid,auth.uid());
    end if;
  elsif action='savePitcher' then
    pid:=(input->>'id')::uuid;
    perform pg_advisory_xact_lock(hashtextextended(pid::text,0));
    if exists(select 1 from public.pitchers where id=pid) then
      if not public.pw_edit_pitcher(pid) then raise exception 'Pitcher access denied' using errcode='42501'; end if;
      update public.pitchers set name=trim(input->>'name'),jersey=trim(input->>'jersey'),updated_at=now() where id=pid;
    else
      insert into public.pitchers(id,name,jersey,owner_id) values(pid,trim(input->>'name'),trim(input->>'jersey'),auth.uid());
    end if;
    if jsonb_typeof(input->'teamIds')<>'array' then raise exception 'Teams must be a list'; end if;
    for oldid in select jsonb_array_elements_text(input->'teamIds') loop
      if not public.pw_edit_team(oldid::uuid) then raise exception 'Team access denied' using errcode='42501'; end if;
    end loop;
    update public.team_pitchers set active=false where pitcher_id=pid and public.pw_edit_team(team_id);
    for oldid in select distinct jsonb_array_elements_text(input->'teamIds') loop
      insert into public.team_pitchers values(oldid::uuid,pid,true) on conflict(team_id,pitcher_id) do update set active=true;
    end loop;
  elsif action='archivePitcher' then
    pid:=(input->>'pitcherId')::uuid;
    if not public.pw_edit_pitcher(pid) then raise exception 'Pitcher access denied' using errcode='42501'; end if;
    if (input->>'archived')::boolean and exists(select 1 from public.team_pitchers where pitcher_id=pid and active) then raise exception 'Remove this pitcher from all team rosters before archiving'; end if;
    if (input->>'archived')::boolean and exists(select 1 from public.practices where data->>'status'<>'ended' and data->>'selectedPitcherId'=pid::text) then raise exception 'Change pitchers or end the ongoing practice before archiving'; end if;
    update public.pitchers set archived=(input->>'archived')::boolean,updated_at=now() where id=pid;
  elsif action='acceptInvitation' then
    iid:=(input->>'id')::uuid;
    select * into inv from public.invitations where id=iid for update;
    if not found and exists(select 1 from public.team_coaches where team_id=tid and coach_id=auth.uid()) then return '{}'::jsonb; end if;
    if not found or inv.email<>public.pw_email() then raise exception 'Invitation is unavailable for this account' using errcode='42501'; end if;
    insert into public.team_coaches values(inv.team_id,auth.uid()) on conflict do nothing;
    delete from public.invitations where id=iid;
  elsif action='restore' then
    -- New UUIDs and new team memberships prevent an imported file from granting access or overwriting shared work.
    b:=input->'backup'; iid:=(input->>'operationId')::uuid;
    perform pg_advisory_xact_lock(hashtextextended(iid::text,0));
    if exists(select 1 from public.operation_receipts where id=iid and coach_id=auth.uid() and request=input) then return '{}'::jsonb; end if;
    if not (b ?& array['teams','pitchers','teamPitchers','sessions','events']) or jsonb_typeof(b->'teams')<>'array' or jsonb_typeof(b->'pitchers')<>'array' or jsonb_typeof(b->'teamPitchers')<>'array' or jsonb_typeof(b->'sessions')<>'array' or jsonb_typeof(b->'events')<>'array' then raise exception 'Invalid backup lists'; end if;
    if exists(select 1 from jsonb_array_elements(b->'events') e where not exists(select 1 from jsonb_array_elements(b->'sessions') backup_session where backup_session->>'id'=e->>'sessionId')) then raise exception 'Orphan backup event'; end if;
    if exists(select 1 from jsonb_array_elements(b->'sessions') backup_session cross join lateral jsonb_array_elements_text(backup_session->'pitcherIds') p where not exists(select 1 from jsonb_array_elements(b->'pitchers') q where q->>'id'=p)) then raise exception 'Missing backup pitcher'; end if;
    if b->>'format'<>'pitchwork-backup' or b->>'version'<>'2' then raise exception 'Unsupported backup'; end if;
    for item in select value from jsonb_array_elements(b->'teams') loop
      newid:=gen_random_uuid(); mapping:=mapping||jsonb_build_object(item->>'id',newid);
      insert into public.teams(id,name) values(newid,item->>'name');
      insert into public.team_coaches values(newid,auth.uid());
    end loop;
    for item in select value from jsonb_array_elements(b->'pitchers') loop
      newid:=gen_random_uuid(); mapping:=mapping||jsonb_build_object(item->>'id',newid);
      insert into public.pitchers(id,name,jersey,owner_id,archived) values(newid,item->>'name',item->>'jersey',auth.uid(),(item->>'archived')::boolean);
    end loop;
    for item in select value from jsonb_array_elements(b->'teamPitchers') loop
      insert into public.team_pitchers values((mapping->>(item->>'teamId'))::uuid,(mapping->>(item->>'pitcherId'))::uuid,(item->>'active')::boolean);
    end loop;
    for item in select value from jsonb_array_elements(b->'sessions') loop
      mapping:=mapping||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'initialAppearanceId',gen_random_uuid());
    end loop;
    for item in select value from jsonb_array_elements(b->'events') loop
      mapping:=mapping||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'nextAppearanceId',gen_random_uuid());
    end loop;
    for item in select value from jsonb_array_elements(b->'sessions') loop
      select coalesce(jsonb_agg(value order by (value->>'sequence')::integer),'[]') into source from jsonb_array_elements(b->'events') where value->>'sessionId'=item->>'id';
      s:=item;
      for pair in select * from jsonb_each_text(mapping) loop
        s:=replace(s::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
        source:=replace(source::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
      end loop;
      s:=s||jsonb_build_object('recorderId',auth.uid(),'deviceId',(input->>'deviceId')::uuid,'revision',1,'recovered',true);
      perform public.validate_practice(s,source);
      for oldid in select jsonb_array_elements_text(s->'pitcherIds') loop
        if not exists(select 1 from public.pitchers where id=oldid::uuid and owner_id=auth.uid()) then raise exception 'Missing restored pitcher'; end if;
      end loop;
      insert into public.practices values((s->>'id')::uuid,(s->>'teamId')::uuid,auth.uid(),(input->>'deviceId')::uuid,1,s,source);
    end loop;
    insert into public.operation_receipts values(iid,auth.uid(),1,input);
  else
    if not public.pw_edit_team(tid) then raise exception 'Team access denied' using errcode='42501'; end if;
    select * into t from public.teams where id=tid for update;
    if action='setPitcher' then
      pid:=(input->>'pitcherId')::uuid;
      if not public.pw_pitcher(pid) then raise exception 'Pitcher access denied' using errcode='42501'; end if;
      insert into public.team_pitchers values(tid,pid,(input->>'active')::boolean) on conflict(team_id,pitcher_id) do update set active=excluded.active;
    elsif action='invite' then
      invite_email:=lower(trim(input->>'email'));
      insert into public.invitations(team_id,email,team_name) values(tid,invite_email,t.name) on conflict(team_id,email) do nothing;
    elsif action='cancelInvitation' then
      delete from public.invitations where id=(input->>'id')::uuid and team_id=tid;
    elsif action='removeCoach' then
      cid:=(input->>'coachId')::uuid;
      if exists(select 1 from public.team_coaches where team_id=tid and coach_id=cid) then
        if (select count(*) from public.team_coaches tc join public.coaches c on c.id=tc.coach_id where tc.team_id=tid and c.active and c.role in ('coach','admin'))<=1
          and exists(select 1 from public.coaches where id=cid and active and role in ('coach','admin')) then raise exception 'A team must retain at least one active coach'; end if;
        delete from public.team_coaches where team_id=tid and coach_id=cid;
      end if;
    else raise exception 'Unknown team action'; end if;
  end if;
  return '{}'::jsonb;
end
$$;

revoke execute on function public.validate_practice(jsonb,jsonb) from public,anon,authenticated;
revoke execute on function public.manage(text,jsonb),public.upload_practice(jsonb),public.get_workspace() from public,anon;
grant execute on function public.manage(text,jsonb),public.upload_practice(jsonb),public.get_workspace() to authenticated;
-- Helpers return only predicates about the caller; never accept a caller-supplied identity.
revoke execute on function public.pw_active(),public.pw_admin(),public.pw_writer(),public.pw_email(),public.pw_team(uuid),public.pw_edit_team(uuid),public.pw_practice(uuid,uuid),public.pw_pitcher(uuid),public.pw_edit_pitcher(uuid),public.pw_coach(uuid) from public,anon;
grant execute on function public.pw_active(),public.pw_admin(),public.pw_writer(),public.pw_email(),public.pw_team(uuid),public.pw_edit_team(uuid),public.pw_practice(uuid,uuid),public.pw_pitcher(uuid),public.pw_edit_pitcher(uuid),public.pw_coach(uuid) to authenticated;
