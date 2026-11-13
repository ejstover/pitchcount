-- Request identities can verify email but cannot read or write workspace data.
alter table public.account_provisions add column active boolean not null default true;
alter table public.access_requests
 add column role text not null default 'coach' check(role in ('coach','player')),
 add column username text check(username is null or username ~ '^[a-z0-9][a-z0-9_.-]{2,23}$'),
 add column account_id uuid unique references public.account_provisions(id) on delete set null,
 add column verified_at timestamptz,
 add column last_verification_sent_at timestamptz,
 add column resolved_team_id uuid references public.teams(id) on delete set null;

create or replace function public.profile_from_provision() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.coaches(id,email,name,role,active,username)
 select id,email,name,role,active,username from public.account_provisions where id=new.id and email=lower(new.email);
 insert into public.player_accounts select id,pitcher_id from public.account_provisions where id=new.id and role='player' and pitcher_id is not null;
 return new;
end $$;

create function public.reserve_access_request(p_name text,p_email text,p_team text,p_role text,p_username text,p_bucket text)
returns jsonb language plpgsql set search_path='' as $$
declare hits integer; r public.access_requests; provision public.account_provisions;
begin
 perform pg_advisory_xact_lock(79112834);
 if p_role not in ('coach','player') or length(trim(p_name)) not between 1 and 100
 or p_email<>lower(trim(p_email)) or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(p_email)>254
 or p_team is null or length(trim(p_team))>200 or (p_role='coach' and trim(p_team)='')
 or (p_role='player' and (p_username is null or p_username !~ '^[a-z0-9][a-z0-9_.-]{2,23}$')) then raise exception 'Invalid account request'; end if;
 insert into public.request_limits values(p_bucket,now(),1) on conflict(bucket) do update set
 attempts=case when public.request_limits.window_start<now()-interval '1 hour' then 1 else public.request_limits.attempts+1 end,
 window_start=case when public.request_limits.window_start<now()-interval '1 hour' then now() else public.request_limits.window_start end returning attempts into hits;
 if hits>5 then return null; end if;
 delete from public.request_limits where window_start<now()-interval '2 hours';
 select * into r from public.access_requests where email=p_email for update;
 if found and (r.status<>'pending' or r.last_verification_sent_at>now()-interval '60 seconds') then return null; end if;
 if r.account_id is null then
  if exists(select 1 from public.account_provisions where email=p_email) then return null; end if;
  if p_role='player' and (exists(select 1 from public.account_provisions where username=p_username)
   or exists(select 1 from public.coaches where username=p_username)) then return jsonb_build_object('usernameUnavailable',true); end if;
  -- Legacy requests keep their submitted identity. A fresh submission supplies the account type.
  insert into public.account_provisions(email,name,role,username,active)
   values(p_email,trim(p_name),p_role,case when p_role='player' then p_username end,false) returning * into provision;
  insert into public.access_requests(name,email,requested_team,role,username,account_id)
   values(trim(p_name),p_email,trim(p_team),p_role,provision.username,provision.id)
   on conflict(email) do update set role=excluded.role,username=excluded.username,account_id=excluded.account_id
   returning * into r;
 end if;
 update public.access_requests set last_verification_sent_at=now() where id=r.id;
 return jsonb_build_object('id',r.account_id,'email',r.email);
end $$;

create function public.sync_request_verification() returns void language sql set search_path='' as $$
 update public.access_requests r set verified_at=u.email_confirmed_at
 from auth.users u where u.id=r.account_id and lower(u.email)=r.email and u.email_confirmed_at is not null and r.verified_at is null;
$$;

create function public.approve_access_request(p_actor uuid,p_request uuid,p_team uuid default null) returns jsonb language plpgsql set search_path='' as $$
declare r public.access_requests; pid uuid; tid uuid; matches integer;
begin
 perform pg_advisory_xact_lock(79112834);
 if not exists(select 1 from public.coaches where id=p_actor and active and role='admin') then raise exception 'Admin access required' using errcode='42501'; end if;
 select * into r from public.access_requests where id=p_request for update;
 if not found or r.status='rejected' then raise exception 'Request is unavailable'; end if;
 if r.status='approved' then return jsonb_build_object('id',r.account_id); end if;
 if r.account_id is null or not exists(select 1 from auth.users where id=r.account_id and lower(email)=r.email and email_confirmed_at is not null) then raise exception 'Email verification is required before approval'; end if;
 if not exists(select 1 from public.coaches where id=r.account_id and not active and role=r.role) then raise exception 'Pending identity is unavailable'; end if;
 if trim(r.requested_team)<>'' then
  select count(*),min(id::text)::uuid into matches,tid from public.teams where not archived and lower(trim(name))=lower(trim(r.requested_team));
  if p_team is not null then
   if not exists(select 1 from public.teams where id=p_team and not archived and lower(trim(name))=lower(trim(r.requested_team))) then raise exception 'Choose a matching active team'; end if;
   tid:=p_team;
  elsif matches>1 then raise exception 'Multiple teams match. Select the correct team before approval';
  elsif matches=0 then
   tid:=gen_random_uuid(); insert into public.teams(id,name) values(tid,trim(r.requested_team));
  end if;
 end if;
 if r.role='player' then
  select pitcher_id into pid from public.account_provisions where id=r.account_id;
  if pid is null then
   pid:=gen_random_uuid(); insert into public.pitchers(id,name,owner_id) values(pid,r.name,p_actor);
   update public.account_provisions set pitcher_id=pid where id=r.account_id;
  end if;
  insert into public.player_accounts values(r.account_id,pid) on conflict(account_id) do nothing;
  if tid is not null then insert into public.team_pitchers(team_id,pitcher_id,active) values(tid,pid,true) on conflict(team_id,pitcher_id) do update set active=true; end if;
 elsif tid is not null then
  insert into public.team_coaches values(tid,r.account_id) on conflict do nothing;
 end if;
 update public.account_provisions set active=true where id=r.account_id;
 update public.coaches set active=true where id=r.account_id;
 update public.access_requests set status='approved',verified_at=(select email_confirmed_at from auth.users where id=r.account_id),resolved_team_id=tid where id=r.id;
 return jsonb_build_object('id',r.account_id);
end $$;

-- Existing admin operations must never bypass verification/approval for a pending identity.
alter function public.account_action(uuid,text,jsonb) rename to pw_account_before_requests;
create function public.account_action(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(79112834);
 if not exists(select 1 from public.coaches where id=p_actor and active and role='admin') then raise exception 'Admin access required' using errcode='42501'; end if;
 if (p_action in ('prepare','preparePlayer') and exists(select 1 from public.account_provisions where email=lower(trim(p_data->>'email')) and not active))
 or (p_action='update' and exists(select 1 from public.account_provisions where id=(p_data->>'id')::uuid and not active)) then raise exception 'Use verified request approval for this account'; end if;
 return public.pw_account_before_requests(p_actor,p_action,p_data);
end $$;
revoke all on function public.reserve_access_request(text,text,text,text,text,text),public.sync_request_verification(),public.approve_access_request(uuid,uuid,uuid),public.account_action(uuid,text,jsonb),public.pw_account_before_requests(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_access_request(text,text,text,text,text,text),public.sync_request_verification(),public.approve_access_request(uuid,uuid,uuid),public.account_action(uuid,text,jsonb) to service_role;
