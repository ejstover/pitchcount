create table public.account_provisions (
  id uuid primary key default gen_random_uuid(), email text not null unique check (email = lower(trim(email))),
  name text not null, role text not null default 'coach' check (role in ('admin','coach','viewer'))
);
create unique index one_provisioned_admin on public.account_provisions(role) where role = 'admin';
create table public.coaches (
  id uuid primary key references auth.users on delete cascade, email text not null unique,
  name text not null, role text not null check (role in ('admin','coach','viewer')), active boolean not null default true
);
create unique index one_admin on public.coaches(role) where role = 'admin';
create table public.access_requests (
  id uuid primary key default gen_random_uuid(), name text not null, email text not null unique,
  requested_team text not null, status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create table public.request_limits (bucket text primary key, window_start timestamptz not null, attempts integer not null);
alter table public.account_provisions enable row level security;
alter table public.coaches enable row level security;
alter table public.access_requests enable row level security;
alter table public.request_limits enable row level security;
revoke all on public.account_provisions,public.coaches,public.access_requests,public.request_limits from anon,authenticated;
grant select on public.coaches to authenticated;
grant all on public.account_provisions,public.coaches,public.access_requests,public.request_limits to service_role;
create policy coach_self_read on public.coaches for select to authenticated using (id = auth.uid());

-- Only the server Admin API knows the preallocated account UUID. Approving an
-- email never permits public sign-up to race account creation or set a password.
create function public.before_user_created(event jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.account_provisions where id::text = event->'user'->>'id' and email = lower(event->'user'->>'email')) then
    return '{}'::jsonb;
  end if;
  return '{"error":{"http_code":403,"message":"An admin must create your account. Request access in Pitchwork."}}'::jsonb;
end;
$$;
revoke all on function public.before_user_created(jsonb) from public,anon,authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;
create function public.profile_from_provision() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.coaches(id,email,name,role)
    select id,email,name,role from public.account_provisions where id = new.id and email = lower(new.email);
  return new;
end;
$$;
create trigger provision_profile after insert on auth.users for each row execute function public.profile_from_provision();

create function public.bootstrap_admin(p_email text,p_name text) returns uuid language plpgsql set search_path = '' as $$
declare result uuid;
begin
  if length(trim(p_name)) not between 1 and 100 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Invalid admin details'; end if;
  insert into public.account_provisions(email,name,role) values(lower(trim(p_email)),trim(p_name),'admin') on conflict(email) do nothing;
  select id into result from public.account_provisions where email = lower(trim(p_email)) and role = 'admin';
  if result is null then raise exception 'Admin is already configured'; end if;
  return result;
end;
$$;

-- Service-only RPC. Recheck admin status under a lock at mutation time. The
-- team_coaches table is created by the following team migration.
create function public.account_action(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql set search_path = '' as $$
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
    if exists(select 1 from public.team_coaches m where m.coach_id = target
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
create function public.submit_access_request(p_name text,p_email text,p_team text,p_bucket text) returns void language plpgsql set search_path = '' as $$
declare hits integer;
begin
  insert into public.request_limits values(p_bucket,now(),1) on conflict(bucket) do update set
    attempts = case when public.request_limits.window_start < now() - interval '1 hour' then 1 else public.request_limits.attempts + 1 end,
    window_start = case when public.request_limits.window_start < now() - interval '1 hour' then now() else public.request_limits.window_start end
    returning attempts into hits;
  if hits > 5 then return; end if;
  delete from public.request_limits where window_start < now() - interval '2 hours';
  if not exists(select 1 from public.account_provisions where email = p_email) then
    insert into public.access_requests(name,email,requested_team) values(p_name,p_email,p_team) on conflict(email) do nothing;
  end if;
end;
$$;
revoke all on function public.bootstrap_admin(text,text),public.account_action(uuid,text,jsonb),
  public.submit_access_request(text,text,text,text),public.profile_from_provision() from public,anon,authenticated;
grant execute on function public.bootstrap_admin(text,text),public.account_action(uuid,text,jsonb),
  public.submit_access_request(text,text,text,text) to service_role;
