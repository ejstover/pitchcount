-- Self-service coaches are distinct from legacy approval requests. A verified
-- signup always creates a NEW team; matching a name never grants membership.
create table public.coach_signups (
 account_id uuid primary key references public.account_provisions on delete cascade,
 team_name text not null check(length(trim(team_name)) between 1 and 200),
 team_id uuid references public.teams on delete set null,
 last_sent_at timestamptz not null default now(), completed_at timestamptz,
 onboarding_finished_at timestamptz
);
create table public.player_invitations (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references public.teams on delete cascade,
 pitcher_id uuid not null references public.pitchers on delete cascade,
 created_by uuid not null references public.coaches on delete cascade,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '7 days',
 revoked_at timestamptz, accepted_at timestamptz,
 account_id uuid references public.account_provisions on delete set null
);
alter table public.coach_signups enable row level security;
alter table public.player_invitations enable row level security;
revoke all on public.coach_signups,public.player_invitations from anon,authenticated;
grant all on public.coach_signups,public.player_invitations to service_role;

-- Returns a boolean rather than raising, so failed attempts remain counted.
create function public.onboarding_limit(p_bucket text,p_max integer) returns boolean language plpgsql set search_path='' as $$
declare hits integer;
begin
 insert into public.request_limits values(p_bucket,now(),1) on conflict(bucket) do update set
 attempts=case when public.request_limits.window_start<now()-interval '1 hour' then 1 else public.request_limits.attempts+1 end,
 window_start=case when public.request_limits.window_start<now()-interval '1 hour' then now() else public.request_limits.window_start end returning attempts into hits;
 delete from public.request_limits where window_start<now()-interval '2 hours';
 return hits<=p_max;
end $$;

create function public.reserve_coach_signup(p_name text,p_email text,p_team text,p_bucket text) returns jsonb language plpgsql set search_path='' as $$
declare provision public.account_provisions; signup public.coach_signups;
begin
 perform pg_advisory_xact_lock(79112834);
 if p_name is null or length(trim(p_name)) not between 1 and 100 or p_team is null or length(trim(p_team)) not between 1 and 200
 or p_email is null or p_email<>lower(trim(p_email)) or length(p_email)>254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid signup details'; end if;
 if not public.onboarding_limit('signup:'||p_bucket,10) then return null; end if;
 select * into provision from public.account_provisions where email=p_email;
 if found then
  select * into signup from public.coach_signups where account_id=provision.id;
  if not found or signup.completed_at is not null or signup.last_sent_at>now()-interval '60 seconds' then return null; end if;
  update public.coach_signups set last_sent_at=now() where account_id=provision.id;
 else
  -- Never convert an earlier request or an existing account into a new signup.
  if exists(select 1 from public.access_requests where email=p_email) then return null; end if;
  insert into public.account_provisions(email,name,role,active) values(p_email,trim(p_name),'coach',false) returning * into provision;
  insert into public.coach_signups(account_id,team_name) values(provision.id,trim(p_team));
 end if;
 return jsonb_build_object('id',provision.id,'email',provision.email);
end $$;

create function public.complete_coach_signup(p_account uuid) returns uuid language plpgsql set search_path='' as $$
declare signup public.coach_signups; tid uuid;
begin
 perform pg_advisory_xact_lock(79112834);
 select * into signup from public.coach_signups where account_id=p_account for update;
 if not found or not exists(select 1 from auth.users u join public.account_provisions p on p.id=u.id
  where u.id=p_account and lower(u.email)=p.email and u.email_confirmed_at is not null and p.role='coach') then raise exception 'Verify your email before creating your team'; end if;
 if signup.completed_at is not null then return signup.team_id; end if;
 if not exists(select 1 from public.coaches where id=p_account and role='coach' and not active) then raise exception 'Signup is unavailable'; end if;
 tid:=gen_random_uuid();
 insert into public.teams(id,name) values(tid,signup.team_name);
 insert into public.team_coaches values(tid,p_account);
 update public.coaches set active=true where id=p_account;
 update public.account_provisions set active=true where id=p_account;
 update public.coach_signups set team_id=tid,completed_at=now() where account_id=p_account;
 return tid;
end $$;

create function public.manage_player_invitation(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path='' as $$
declare tid uuid:=(p_data->>'teamId')::uuid; pid uuid; invite public.player_invitations; label text;
begin
 perform pg_advisory_xact_lock(79112834);
 perform 1 from public.teams where id=tid and not archived for update;
 if not found or not exists(select 1 from public.coaches c where c.id=p_actor and c.active and (c.role='admin'
  or (c.role='coach' and exists(select 1 from public.team_coaches where team_id=tid and coach_id=p_actor)))) then raise exception 'Active team coach access required' using errcode='42501'; end if;
 if p_action='list' then
  return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'pitcherId',i.pitcher_id,'name',p.name,'expiresAt',i.expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at) order by i.created_at desc)
   from public.player_invitations i join public.pitchers p on p.id=i.pitcher_id where i.team_id=tid),'[]'::jsonb);
 elsif p_action='revoke' then
  update public.player_invitations set revoked_at=now() where id=(p_data->>'id')::uuid and team_id=tid and accepted_at is null;
  return '{}'::jsonb;
 elsif p_action<>'create' then raise exception 'Unknown invitation action'; end if;
 if p_data->>'requestId' is not null then
  select * into invite from public.player_invitations where id=(p_data->>'requestId')::uuid;
  if found then
   if invite.created_by<>p_actor or invite.team_id<>tid or invite.token_hash<>p_data->>'tokenHash' then raise exception 'Invitation request ID has already been used'; end if;
   return jsonb_build_object('id',invite.id,'pitcherId',invite.pitcher_id,'expiresAt',invite.expires_at);
  end if;
 end if;
 if not public.onboarding_limit('invite:'||p_actor::text,100) then return jsonb_build_object('limited',true); end if;
 if (p_data->>'tokenHash') is null or (p_data->>'tokenHash') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid invitation'; end if;
 pid:=(p_data->>'pitcherId')::uuid;
 if pid is null then
  label:=trim(p_data->>'name');
  if label is null or length(label) not between 1 and 100 then raise exception 'Enter a player name of at most 100 characters'; end if;
  pid:=gen_random_uuid(); insert into public.pitchers(id,name,owner_id) values(pid,label,p_actor);
  insert into public.team_pitchers values(tid,pid,true);
 elsif not exists(select 1 from public.pitchers p join public.team_pitchers m on m.pitcher_id=p.id where p.id=pid and not p.archived and m.team_id=tid and m.active)
 then raise exception 'Choose an active pitcher on this team'; end if;
 if exists(select 1 from public.player_accounts where pitcher_id=pid) then raise exception 'This player already has an account. Use account recovery instead.'; end if;
 -- Generating a replacement invalidates all earlier links for this player.
 update public.player_invitations set revoked_at=now() where pitcher_id=pid and accepted_at is null and revoked_at is null;
 insert into public.player_invitations(id,team_id,pitcher_id,created_by,token_hash) values(coalesce((p_data->>'requestId')::uuid,gen_random_uuid()),tid,pid,p_actor,p_data->>'tokenHash') returning * into invite;
 return jsonb_build_object('id',invite.id,'pitcherId',pid,'expiresAt',invite.expires_at);
end $$;

-- A link is a private, short-lived capability for exactly one roster player.
create function public.player_invitation_details(p_hash text) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('teamName',t.name,'playerName',p.name,'expiresAt',i.expires_at)
 from public.player_invitations i join public.teams t on t.id=i.team_id join public.pitchers p on p.id=i.pitcher_id
 join public.coaches c on c.id=i.created_by
 where i.token_hash=p_hash and i.revoked_at is null and i.accepted_at is null and i.expires_at>now()
 and not t.archived and not p.archived and c.active and (c.role='admin' or (c.role='coach' and exists(select 1 from public.team_coaches where team_id=i.team_id and coach_id=c.id)))
 and exists(select 1 from public.team_pitchers where team_id=i.team_id and pitcher_id=i.pitcher_id and active)
 and not exists(select 1 from public.player_accounts where pitcher_id=i.pitcher_id);
$$;

create function public.reserve_invited_player(p_hash text,p_username text) returns jsonb language plpgsql set search_path='' as $$
declare invite public.player_invitations; provision public.account_provisions;
begin
 perform pg_advisory_xact_lock(79112834);
 if public.player_invitation_details(p_hash) is null then raise exception 'This invitation is unavailable or expired. Ask your coach for a new link.'; end if;
 if p_username is null or p_username !~ '^[a-z0-9][a-z0-9_.-]{2,23}$' then raise exception 'Invalid player username'; end if;
 select * into invite from public.player_invitations where token_hash=p_hash for update;
 if invite.account_id is not null then
  select * into provision from public.account_provisions where id=invite.account_id;
  if provision.username<>p_username then raise exception 'Continue with the username originally chosen for this link, or ask your coach for a replacement.'; end if;
 else
  if exists(select 1 from public.account_provisions where username=p_username) or exists(select 1 from public.coaches where username=p_username) then raise exception 'That username is unavailable. Choose another.'; end if;
  insert into public.account_provisions(email,name,role,username,active)
   select gen_random_uuid()::text||'@players.pitchwork.invalid',name,'player',p_username,false from public.pitchers where id=invite.pitcher_id returning * into provision;
  update public.player_invitations set account_id=provision.id where id=invite.id;
 end if;
 return jsonb_build_object('id',provision.id,'email',provision.email);
end $$;

create function public.complete_player_invitation(p_hash text,p_account uuid) returns void language plpgsql set search_path='' as $$
declare invite public.player_invitations;
begin
 perform pg_advisory_xact_lock(79112834);
 select * into invite from public.player_invitations where token_hash=p_hash and account_id=p_account for update;
 if not found or public.player_invitation_details(p_hash) is null then raise exception 'This invitation is unavailable or expired. Ask your coach for a new link.'; end if;
 if not exists(select 1 from auth.users u join public.coaches c on c.id=u.id where u.id=p_account and u.email_confirmed_at is not null and c.role='player' and not c.active) then raise exception 'Player setup is incomplete'; end if;
 insert into public.player_accounts values(p_account,invite.pitcher_id);
 update public.account_provisions set active=true,pitcher_id=invite.pitcher_id where id=p_account;
 update public.coaches set active=true where id=p_account;
 update public.player_invitations set accepted_at=now() where id=invite.id;
end $$;

revoke all on function public.onboarding_limit(text,integer),public.reserve_coach_signup(text,text,text,text),public.complete_coach_signup(uuid),public.manage_player_invitation(uuid,text,jsonb),public.player_invitation_details(text),public.reserve_invited_player(text,text),public.complete_player_invitation(text,uuid) from public,anon,authenticated;
grant execute on function public.onboarding_limit(text,integer),public.reserve_coach_signup(text,text,text,text),public.complete_coach_signup(uuid),public.manage_player_invitation(uuid,text,jsonb),public.player_invitation_details(text),public.reserve_invited_player(text,text),public.complete_player_invitation(text,uuid) to service_role;
