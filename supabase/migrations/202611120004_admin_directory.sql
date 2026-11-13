-- Administration is a bounded directory, never a download of every account.
create index coaches_active_cursor on public.coaches(active,id);
create index coaches_name_prefix on public.coaches(lower(name) text_pattern_ops);
create index coaches_email_prefix on public.coaches(lower(email) text_pattern_ops);
create index coaches_username_prefix on public.coaches(lower(username) text_pattern_ops);
create index teams_name_prefix on public.teams(lower(name) text_pattern_ops);
create index access_requests_pending_cursor on public.access_requests(id) where status='pending';
create index access_requests_unverified on public.access_requests(account_id) where verified_at is null;
create function public.confirm_access_request(p_account uuid) returns void language sql set search_path='' as $$
 update public.access_requests r set verified_at=u.email_confirmed_at from auth.users u
 where r.account_id=p_account and u.id=p_account and lower(u.email)=r.email and u.email_confirmed_at is not null and r.verified_at is null
$$;
revoke all on function public.confirm_access_request(uuid) from public,anon,authenticated;
grant execute on function public.confirm_access_request(uuid) to service_role;

create function public.admin_find_teams(p_actor uuid,p_search text) returns jsonb language plpgsql stable set search_path='' as $$
declare pattern text;result jsonb;
begin
 if not exists(select 1 from public.coaches where id=p_actor and active and role='admin') then raise exception 'Admin access required' using errcode='42501';end if;
 if p_search is null or length(trim(p_search)) not between 1 and 100 then raise exception 'Enter a team name';end if;
 pattern:=replace(replace(replace(lower(trim(p_search)),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 select coalesce(jsonb_agg(to_jsonb(t)),'[]') into result from (
  select id,name,archived from public.teams where lower(name) like pattern order by lower(name),id limit 25
 ) t;
 return result;
end $$;
create function public.admin_directory(p_actor uuid,p_after uuid default null,p_request_after uuid default null,p_filter text default 'active',p_search text default '')
returns jsonb language plpgsql stable set search_path='' as $$
declare pattern text;result jsonb;
begin
 if not exists(select 1 from public.coaches where id=p_actor and active and role='admin') then raise exception 'Admin access required' using errcode='42501';end if;
 if p_filter is null or p_filter not in('active','archived','all') or p_search is null or length(p_search)>100 then raise exception 'Invalid directory filter';end if;
 pattern:=replace(replace(replace(lower(trim(p_search)),E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 with profiles as materialized (
  select c.* from public.coaches c where (p_after is null or c.id>p_after)
   and (p_filter='all' or c.active=(p_filter='active'))
   and (p_search='' or lower(c.name) like pattern or lower(c.email) like pattern or lower(c.username) like pattern)
   and not exists(select 1 from public.access_requests r where r.account_id=c.id and r.status<>'approved')
  order by c.id limit 50
 ), requests as materialized (
  select r.* from public.access_requests r where r.status='pending' and (p_request_after is null or r.id>p_request_after) order by r.id limit 50
 ), memberships as materialized(select tc.* from public.team_coaches tc where tc.coach_id in(select id from profiles))
 select jsonb_build_object(
  'profiles',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('pitcherId',pa.pitcher_id) order by c.id) from profiles c left join public.player_accounts pa on pa.account_id=c.id),'[]'),
  'requests',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from requests r),'[]'),
  'memberships',coalesce((select jsonb_agg(to_jsonb(m)) from memberships m),'[]'),
  'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'archived',t.archived)) from public.teams t where t.id in(select team_id from memberships)),'[]'),
  'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'jersey',p.jersey,'ownerId',p.owner_id,'archived',p.archived,'createdAt',p.created_at,'updatedAt',p.updated_at)) from public.pitchers p where p.id in(select pa.pitcher_id from public.player_accounts pa where pa.account_id in(select id from profiles))),'[]'),
  'pendingDeletions',coalesce((select jsonb_agg(jsonb_build_object('id',d.id)) from (select id from public.account_deletions order by id limit 50) d),'[]'),
  'nextProfiles',(select id from profiles where (select count(*) from profiles)=50 order by id desc limit 1),
  'nextRequests',(select id from requests where (select count(*) from requests)=50 order by id desc limit 1)
 ) into result;
 return result;
end $$;
revoke all on function public.admin_find_teams(uuid,text),public.admin_directory(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.admin_find_teams(uuid,text),public.admin_directory(uuid,uuid,uuid,text,text) to service_role;

-- Removal previews can link to an unrelated team's practice. Load just that one
-- read-only review record, rather than restoring a global admin workspace.
create function public.inspect_practice(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.practices;
begin
 if not public.pw_admin() then raise exception 'Admin access required' using errcode='42501';end if;
 select * into p from public.practices where id=p_id;
 if not found then return null;end if;
 return jsonb_build_object(
  'sessions',jsonb_build_array(p.data||jsonb_build_object('archived',p.archived)), 'events',p.events,
  'pitchers',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'jersey',r.jersey,'ownerId',r.owner_id,'archived',r.archived,'createdAt',r.created_at,'updatedAt',r.updated_at)) from public.pitchers r where r.id in(select jsonb_array_elements_text(p.data->'pitcherIds')::uuid)),'[]'),
  'teams',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'archived',t.archived,'createdAt',t.created_at,'updatedAt',t.updated_at)) from public.teams t where t.id=p.team_id),'[]'));
end $$;
revoke all on function public.inspect_practice(uuid) from public,anon;
grant execute on function public.inspect_practice(uuid) to authenticated;
