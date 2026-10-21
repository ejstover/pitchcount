-- Removal metadata and private, durable anti-replay markers.
alter table public.teams add column archived boolean not null default false;
alter table public.practices add column archived boolean not null default false;
create table public.record_tombstones(kind text not null,id uuid not null,primary key(kind,id));
create table public.removal_visibility(kind text not null,id uuid not null,viewer_id uuid not null,primary key(kind,id,viewer_id));
create table public.account_deletions(id uuid primary key,confirmation_hash text not null);
alter table public.record_tombstones enable row level security;
alter table public.removal_visibility enable row level security;
alter table public.account_deletions enable row level security;
revoke all on public.record_tombstones,public.removal_visibility,public.account_deletions from public,anon,authenticated;
grant all on public.record_tombstones,public.removal_visibility,public.account_deletions to service_role;
-- Receipts must not keep copies of deleted pitches, notes, names, or backups.
update public.operation_receipts set request=jsonb_build_object('hash',md5(request::text));

create or replace function public.pw_practice(t uuid,recorder uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin() or case when t is null then recorder=auth.uid() else public.pw_team(t) end)
$$;
create or replace function public.pw_pitcher(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (public.pw_admin() or exists(select 1 from public.pitchers where id=p and owner_id=auth.uid())
 or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_team(team_id))
 or exists(select 1 from public.practices where public.pw_practice(team_id,recorder_id) and data->'pitcherIds' ? p::text))
$$;
create function public.pw_remove_pitcher(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_writer() and exists(select 1 from public.pitchers where id=p) and (public.pw_admin()
 or exists(select 1 from public.pitchers where id=p and owner_id=auth.uid())
 or (exists(select 1 from public.team_pitchers where pitcher_id=p)
 and not exists(select 1 from public.team_pitchers where pitcher_id=p and not public.pw_edit_team(team_id))))
$$;
create function public.pw_upload_practice_core(operation jsonb) returns integer language plpgsql security definer set search_path = '' as $$
declare s jsonb:=operation->'session'; source jsonb:=operation->'events'; prior public.practices;
  receipt public.operation_receipts; sid uuid:=(s->>'id')::uuid; tid uuid:=(s->>'teamId')::uuid;
  expected integer:=(operation->>'expectedRevision')::integer; p text; e jsonb; old_event jsonb;
begin
  if not public.pw_writer() then raise exception 'Account cannot record practices' using errcode='42501'; end if;
  if (s->>'recorderId')::uuid<>auth.uid() or not public.pw_practice(tid,auth.uid()) then raise exception 'Team access was removed' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sid::text,0));
  select * into receipt from public.operation_receipts where id=(operation->>'id')::uuid;
  if found then
    if receipt.coach_id<>auth.uid() or receipt.request<>jsonb_build_object('hash',md5(operation::text)) then raise exception 'Operation identifier already used' using errcode='40001'; end if;
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
  insert into public.practices(id,team_id,recorder_id,device_id,revision,data,events) values(sid,tid,auth.uid(),(s->>'deviceId')::uuid,(s->>'revision')::integer,s,source)
    on conflict(id) do update set revision=excluded.revision,data=excluded.data,events=excluded.events;
  insert into public.operation_receipts values((operation->>'id')::uuid,auth.uid(),(s->>'revision')::integer,jsonb_build_object('hash',md5(operation::text)));
  return (s->>'revision')::integer;
end
$$;

create function public.pw_manage_core(action text, input jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
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
    update public.team_pitchers set active=false where pitcher_id=pid and public.pw_edit_team(team_id) and exists(select 1 from public.teams available_team where available_team.id=team_id and not available_team.archived);
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
    if exists(select 1 from public.operation_receipts where id=iid and coach_id=auth.uid() and request=jsonb_build_object('hash',md5(input::text))) then return '{}'::jsonb; end if;
    if not (b ?& array['teams','pitchers','teamPitchers','sessions','events']) or jsonb_typeof(b->'teams')<>'array' or jsonb_typeof(b->'pitchers')<>'array' or jsonb_typeof(b->'teamPitchers')<>'array' or jsonb_typeof(b->'sessions')<>'array' or jsonb_typeof(b->'events')<>'array' then raise exception 'Invalid backup lists'; end if;
    if exists(select 1 from jsonb_array_elements(b->'events') e where not exists(select 1 from jsonb_array_elements(b->'sessions') backup_session where backup_session->>'id'=e->>'sessionId')) then raise exception 'Orphan backup event'; end if;
    if exists(select 1 from jsonb_array_elements(b->'sessions') backup_session cross join lateral jsonb_array_elements_text(backup_session->'pitcherIds') p where not exists(select 1 from jsonb_array_elements(b->'pitchers') q where q->>'id'=p)) then raise exception 'Missing backup pitcher'; end if;
    if b->>'format'<>'pitchwork-backup' or b->>'version' not in ('2','3') then raise exception 'Unsupported backup'; end if;
    for item in select value from jsonb_array_elements(b->'teams') loop
      newid:=gen_random_uuid(); mapping:=mapping||jsonb_build_object(item->>'id',newid);
      insert into public.teams(id,name,archived) values(newid,item->>'name',coalesce((item->>'archived')::boolean,false));
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
      insert into public.practices(id,team_id,recorder_id,device_id,revision,data,events) values((s->>'id')::uuid,(s->>'teamId')::uuid,auth.uid(),(input->>'deviceId')::uuid,1,s,source);
      update public.practices set archived=coalesce((item->>'archived')::boolean,false) where id=(s->>'id')::uuid;
    end loop;
    insert into public.operation_receipts values(iid,auth.uid(),1,jsonb_build_object('hash',md5(input::text)));
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
        if not t.archived and (select count(*) from public.team_coaches tc join public.coaches c on c.id=tc.coach_id where tc.team_id=tid and c.active and c.role in ('coach','admin'))<=1
          and exists(select 1 from public.coaches where id=cid and active and role in ('coach','admin')) then raise exception 'A team must retain at least one active coach'; end if;
        delete from public.team_coaches where team_id=tid and coach_id=cid;
      end if;
    else raise exception 'Unknown team action'; end if;
  end if;
  return '{}'::jsonb;
end
$$;

create function public.pw_account_action_core(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb; target uuid; member jsonb;
begin
  perform 1 from public.coaches where id = p_actor and role = 'admin' and active for update;
  if not found then raise insufficient_privilege using message = 'Admin access required'; end if;
  if p_action = 'prepare' then
    insert into public.account_provisions(email,name) values(lower(trim(p_data->>'email')),p_data->>'name') on conflict(email) do nothing;
    select jsonb_build_object('id',id) into result from public.account_provisions where email = lower(trim(p_data->>'email')) and role <> 'admin';
    if result is null then raise exception 'This account cannot be modified'; end if;
    return result;
  elsif p_action = 'update' then
    target := (p_data->>'id')::uuid;
    perform 1 from public.teams where id in (select team_id from public.team_coaches where coach_id = target) order by id for update;
    update public.coaches set active = (p_data->>'active')::boolean where id = target and role <> 'admin';
    if not found then raise exception 'Coach account not found'; end if;
    -- Keep last-coach protection, including account suspension.
    if exists(select 1 from public.team_coaches m where m.coach_id = target and exists(select 1 from public.teams t where t.id=m.team_id and not t.archived)
      and (not (p_data->>'active')::boolean or not (p_data->'teamIds' @> jsonb_build_array(m.team_id::text)))
      and not exists(select 1 from public.team_coaches other join public.coaches c on c.id = other.coach_id
        where other.team_id = m.team_id and other.coach_id <> target and c.active and c.role in ('admin','coach'))) then
      raise exception 'Assign another active coach before removing or suspending the last coach on a team';
    end if;
    delete from public.team_coaches where coach_id = target;
    for member in select * from jsonb_array_elements(p_data->'teamIds') loop
      insert into public.team_coaches(team_id,coach_id) values((member#>>'{}')::uuid,target) on conflict do nothing;
    end loop;
    update public.access_requests set status = 'approved' where email = (select email from public.coaches where id = target);
  elsif p_action = 'reject' then
    update public.access_requests set status = 'rejected' where id = (p_data->>'id')::uuid and status = 'pending';
  else raise exception 'Unknown account action';
  end if;
  return '{}'::jsonb;
end;
$$;

-- Only callers who could see a record receive its deletion marker.
create function public.pw_mark_deleted(k text,target uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.removal_visibility
 select k,target,c.id from public.coaches c where c.role='admin'
 or (k='team' and exists(select 1 from public.team_coaches where team_id=target and coach_id=c.id))
 or (k='coach' and (c.id=target or exists(select 1 from public.team_coaches a join public.team_coaches b using(team_id) where a.coach_id=target and b.coach_id=c.id)))
 or (k='session' and exists(select 1 from public.practices p where p.id=target and (p.recorder_id=c.id or exists(select 1 from public.team_coaches where team_id=p.team_id and coach_id=c.id))))
 or (k='pitcher' and (exists(select 1 from public.pitchers where id=target and owner_id=c.id)
 or exists(select 1 from public.team_pitchers a join public.team_coaches b using(team_id) where a.pitcher_id=target and b.coach_id=c.id)
 or exists(select 1 from public.practices p where p.data->'pitcherIds' ? target::text and (p.recorder_id=c.id or exists(select 1 from public.team_coaches where team_id=p.team_id and coach_id=c.id)))))
 on conflict do nothing;
 insert into public.record_tombstones values(k,target) on conflict do nothing;
end
$$;

create function public.removal_preview(kind text,id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare label text; allowed boolean:=false; archived boolean:=false; ab jsonb:='[]'; db jsonb:='[]'; practices jsonb; hidden integer;
 assignments integer:=0; invites integer:=0; owned integer:=0;
begin
 if not public.pw_active() then raise insufficient_privilege; end if;
 if kind='team' then
  select name,t.archived into label,archived from public.teams t where t.id=removal_preview.id and public.pw_team(t.id);
  allowed:=public.pw_edit_team(id);
  select count(*) into assignments from public.team_pitchers where team_id=id;
  assignments:=assignments+(select count(*) from public.team_coaches where team_id=id);
  select count(*) into invites from public.invitations where team_id=id;
 elsif kind='pitcher' then
  select name,p.archived into label,archived from public.pitchers p where p.id=removal_preview.id and public.pw_pitcher(p.id);
  allowed:=public.pw_remove_pitcher(id);
  select count(*) into assignments from public.team_pitchers where pitcher_id=id;
  if exists(select 1 from public.team_pitchers where pitcher_id=id and active) then ab:=ab||jsonb_build_array('Remove this pitcher from active team rosters first.'); end if;
 elsif kind='session' then
  select coalesce(nullif(data->>'name',''),'Bullpen practice'),p.archived into label,archived from public.practices p where p.id=removal_preview.id and public.pw_practice(team_id,recorder_id);
  allowed:=public.pw_writer() and exists(select 1 from public.practices p where p.id=removal_preview.id and public.pw_practice(team_id,recorder_id));
 elsif kind='coach' and public.pw_admin() then
  select email into label from public.coaches c where c.id=removal_preview.id and c.role<>'admin';
  allowed:=label is not null;
  select count(*) into assignments from public.team_coaches where coach_id=id;
  select count(*) into owned from public.pitchers where owner_id=id;
  select count(*) into invites from public.invitations where email=label;
  if exists(select 1 from public.team_coaches m join public.teams t on t.id=m.team_id where m.coach_id=id and not t.archived and not exists(
   select 1 from public.team_coaches other join public.coaches c on c.id=other.coach_id where other.team_id=m.team_id and c.id<>removal_preview.id and c.active and c.role in ('admin','coach'))) then
   ab:=ab||jsonb_build_array('Assign another active coach to each active team first.');
   db:=db||jsonb_build_array('Assign another active coach to each active team first.');
  end if;
 elsif kind='request' and public.pw_admin() then
  select email into label from public.access_requests r where r.id=removal_preview.id;
  allowed:=label is not null;
 else raise exception 'Removal access denied' using errcode='42501';
 end if;
 if label is null then raise exception 'Record is unavailable' using errcode='42501'; end if;
 if not allowed then
  ab:=ab||jsonb_build_array('You cannot remove this record globally. Remove its team assignment or contact an admin.');
  db:=db||jsonb_build_array('You cannot remove this record globally. Remove its team assignment or contact an admin.');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(nullif(p.data->>'name',''),'Bullpen practice'))) filter(where public.pw_practice(p.team_id,p.recorder_id)),'[]'),
 count(*) filter(where not public.pw_practice(p.team_id,p.recorder_id)) into practices,hidden from public.practices p
 where (kind='team' and p.team_id=id) or (kind='pitcher' and p.data->'pitcherIds' ? id::text) or (kind='coach' and p.recorder_id=id);
 if jsonb_array_length(practices)+hidden>0 then db:=db||jsonb_build_array('Delete all related practices individually before permanently deleting this record.'); end if;
 if exists(select 1 from public.practices p where p.data->>'status'<>'ended' and
 ((kind='team' and p.team_id=id) or (kind='pitcher' and p.data->'pitcherIds' ? id::text) or (kind='session' and p.id=removal_preview.id))) then
  ab:=ab||jsonb_build_array('End related ongoing practices first.');
  db:=db||jsonb_build_array('End related ongoing practices first.');
 end if;
 return jsonb_build_object('name',label,'canRemove',allowed,'archiveBlockers',ab,'deleteBlockers',db,'practices',practices,'hiddenPractices',hidden,'assignments',assignments,'invitations',invites,'ownedPitchers',owned);
end
$$;

-- A shared transaction lock covers legacy mutations and removals. It prevents
-- dependency checks racing new practices, assignments, or account changes.
create or replace function public.manage(action text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text:=input->>'kind'; target uuid; preview jsonb; want_archive boolean; t uuid;
begin
 perform pg_advisory_xact_lock(79112834);
 if not public.pw_writer() then raise exception 'Account cannot manage teams' using errcode='42501'; end if;
 if action in ('removalPreview','archiveRecord','deleteRecord') then
  target:=(input->>'id')::uuid;
  if k not in ('team','pitcher','session') then raise exception 'Use account administration for this record'; end if;
  if action='deleteRecord' and exists(select 1 from public.removal_visibility where kind=k and id=target and viewer_id=auth.uid()) then return '{}'; end if;
  preview:=public.removal_preview(k,target);
  if action='removalPreview' then return preview; end if;
  if not (preview->>'canRemove')::boolean then raise exception 'Removal access denied' using errcode='42501'; end if;
  if action='archiveRecord' then
   if jsonb_typeof(input->'archived') is distinct from 'boolean' then raise exception 'Choose archive or reactivate'; end if;
   want_archive:=(input->>'archived')::boolean;
   if want_archive and jsonb_array_length(preview->'archiveBlockers')>0 then raise exception '%',preview->'archiveBlockers'->>0; end if;
   if k='team' then
    if not want_archive and not exists(select 1 from public.team_coaches m join public.coaches c on c.id=m.coach_id where m.team_id=target and c.active and c.role in ('coach','admin')) then raise exception 'Assign an active coach before reactivating this team'; end if;
    update public.teams set archived=want_archive,updated_at=now() where id=target;
    if want_archive then delete from public.invitations where team_id=target; end if;
   elsif k='pitcher' then update public.pitchers set archived=want_archive,updated_at=now() where id=target;
   else update public.practices set archived=want_archive where id=target;
   end if;
  else
   if input->>'confirmation' is distinct from preview->>'name' then raise exception 'Type the displayed name to confirm deletion'; end if;
   if jsonb_array_length(preview->'deleteBlockers')>0 then raise exception '%',preview->'deleteBlockers'->>0; end if;
   perform public.pw_mark_deleted(k,target);
   if k='session' then delete from public.practices where id=target;
   elsif k='pitcher' then delete from public.team_pitchers where pitcher_id=target; delete from public.pitchers where id=target;
   else
    delete from public.invitations where team_id=target;
    delete from public.team_pitchers where team_id=target;
    delete from public.team_coaches where team_id=target;
    delete from public.teams where id=target;
   end if;
  end if;
  return '{}';
 end if;
 if action in ('saveTeam','savePitcher') then
  k:=case when action='saveTeam' then 'team' else 'pitcher' end;
  if exists(select 1 from public.record_tombstones where kind=k and id=(input->>'id')::uuid) then raise exception 'This record was permanently deleted' using errcode='40001'; end if;
 end if;
 if action='archivePitcher' then
  return public.manage('archiveRecord',jsonb_build_object('kind','pitcher','id',input->>'pitcherId','archived',input->'archived'));
 end if;
 if action in ('saveTeam','invite','acceptInvitation') or (action='setPitcher' and (input->>'active')::boolean) then
  t:=case when action='saveTeam' then (input->>'id')::uuid when action='acceptInvitation' then (select team_id from public.invitations where id=(input->>'id')::uuid) else (input->>'teamId')::uuid end;
  if exists(select 1 from public.teams where id=t and archived) then raise exception 'Reactivate the team before changing its roster or invitations'; end if;
 end if;
 if action='savePitcher' and exists(select 1 from jsonb_array_elements_text(input->'teamIds') x join public.teams t on t.id=x::uuid where t.archived) then raise exception 'Archived teams cannot receive assignments'; end if;
 if action='setPitcher' and (input->>'active')::boolean and exists(select 1 from public.pitchers where id=(input->>'pitcherId')::uuid and archived) then raise exception 'Reactivate the pitcher first'; end if;
 return public.pw_manage_core(action,input);
end
$$;

create or replace function public.upload_practice(operation jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare sid uuid:=(operation->'session'->>'id')::uuid; tid uuid:=(operation->'session'->>'teamId')::uuid;
begin
 perform pg_advisory_xact_lock(79112834);
 if exists(select 1 from public.record_tombstones where (kind='session' and id=sid) or (kind='team' and id=tid)
 or (kind='pitcher' and operation->'session'->'pitcherIds' ? id::text)) then raise exception 'A practice or related record was permanently deleted. Export unsynced work for recovery.' using errcode='40001'; end if;
 if exists(select 1 from public.practices where id=sid and archived) then raise exception 'This practice is archived' using errcode='40001'; end if;
 if exists(select 1 from public.teams where id=tid and archived) then raise exception 'This team is archived' using errcode='40001'; end if;
 return public.pw_upload_practice_core(operation);
end
$$;

alter function public.get_workspace() rename to pw_workspace_core;
create function public.get_workspace() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.pw_active() then return '{"teams":[],"coaches":[],"pitchers":[],"teamCoaches":[],"teamPitchers":[],"invitations":[],"sessions":[],"events":[],"deletions":[]}'::jsonb; end if;
 -- Core is an invoker function: explicitly apply the same visibility predicates.
 select jsonb_build_object(
 'teams',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'archived',archived,'createdAt',created_at,'updatedAt',updated_at)) from public.teams where public.pw_team(id)),'[]'),
 'coaches',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'role',role,'active',active)) from public.coaches where public.pw_coach(id)),'[]'),
 'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'jersey',jersey,'ownerId',owner_id,'archived',archived,'createdAt',created_at,'updatedAt',updated_at)) from public.pitchers where public.pw_pitcher(id)),'[]'),
 'teamCoaches',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'coachId',coach_id)) from public.team_coaches where public.pw_team(team_id)),'[]'),
 'teamPitchers',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'pitcherId',pitcher_id,'active',active)) from public.team_pitchers where public.pw_team(team_id) and public.pw_pitcher(pitcher_id)),'[]'),
 'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'teamId',team_id,'email',email,'teamName',team_name,'createdAt',created_at)) from public.invitations where public.pw_team(team_id) or email=public.pw_email()),'[]'),
 'sessions',coalesce((select jsonb_agg(data||jsonb_build_object('archived',archived)) from public.practices where public.pw_practice(team_id,recorder_id)),'[]'),
 'events',coalesce((select jsonb_agg(e) from public.practices cross join lateral jsonb_array_elements(events) e where public.pw_practice(team_id,recorder_id)),'[]'),
 'deletions',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'id',id)) from public.removal_visibility where viewer_id=auth.uid()),'[]')) into result;
 return result;
end
$$;

create or replace function public.account_action(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path='' as $$
declare k text:=p_data->>'kind'; target uuid:=(p_data->>'id')::uuid; preview jsonb; label text;
begin
 perform pg_advisory_xact_lock(79112834);
 perform 1 from public.coaches where id=p_actor and role='admin' and active for update;
 if not found then raise exception 'Admin access required' using errcode='42501'; end if;
 -- Service calls must evaluate preview predicates as the verified administrator.
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 if p_action='retryDeletion' then
  if exists(select 1 from public.account_deletions where id=target) then return jsonb_build_object('deleteAuthId',target); end if;
  return '{}';
 end if;
 if p_action in ('removalPreview','deleteRecord','suspendRecord','finishDeletion') then
  if k not in ('coach','request') then raise exception 'Unsupported account removal'; end if;
  if p_action='finishDeletion' then delete from public.account_deletions where id=target; return '{}'; end if;
  if p_action='deleteRecord' and exists(select 1 from public.account_deletions where id=target and confirmation_hash=md5(p_data->>'confirmation')) then return jsonb_build_object('deleteAuthId',target); end if;
  if p_action='deleteRecord' and exists(select 1 from public.removal_visibility where kind=k and id=target and viewer_id=p_actor) then return '{}'; end if;
  preview:=public.removal_preview(k,target);
  if p_action='removalPreview' then return preview; end if;
  if not (preview->>'canRemove')::boolean then raise insufficient_privilege; end if;
  if p_action='suspendRecord' then
   if k<>'coach' then raise exception 'Only accounts can be suspended'; end if;
   if jsonb_array_length(preview->'archiveBlockers')>0 then raise exception '%',preview->'archiveBlockers'->>0; end if;
   update public.coaches set active=false where id=target; return '{}';
  end if;
  if p_data->>'confirmation' is distinct from preview->>'name' then raise exception 'Type the displayed email to confirm deletion'; end if;
  if jsonb_array_length(preview->'deleteBlockers')>0 then raise exception '%',preview->'deleteBlockers'->>0; end if;
  perform public.pw_mark_deleted(k,target);
  if k='request' then delete from public.access_requests where id=target; return '{}'; end if;
  label:=preview->>'name';
  update public.coaches set active=false where id=target;
  update public.pitchers set owner_id=p_actor where owner_id=target;
  delete from public.team_coaches where coach_id=target;
  delete from public.invitations where email=label;
  delete from public.access_requests where email=label;
  delete from public.operation_receipts where coach_id=target;
  delete from public.account_provisions where id=target;
  delete from public.coaches where id=target;
  insert into public.account_deletions values(target,md5(label)) on conflict do nothing;
  return jsonb_build_object('deleteAuthId',target);
 end if;
 return public.pw_account_action_core(p_actor,p_action,p_data);
end
$$;

revoke execute on function public.pw_manage_core(text,jsonb),public.pw_upload_practice_core(jsonb),public.pw_account_action_core(uuid,text,jsonb),public.pw_workspace_core(),public.pw_mark_deleted(text,uuid) from public,anon,authenticated;
revoke execute on function public.removal_preview(text,uuid),public.pw_remove_pitcher(uuid) from public,anon;
grant execute on function public.removal_preview(text,uuid),public.pw_remove_pitcher(uuid) to authenticated;
revoke execute on function public.get_workspace() from public,anon;
grant execute on function public.get_workspace() to authenticated;
grant execute on function public.account_action(uuid,text,jsonb) to service_role;

-- account_action is an invoker RPC restricted to the trusted service role.
grant execute on function public.pw_account_action_core(uuid,text,jsonb),public.removal_preview(text,uuid),public.pw_mark_deleted(text,uuid) to service_role;
