-- Ordinary scoring must not serialize every user behind a single exclusive lock.
-- Structural/account changes retain the exclusive gate, so access revocation,
-- deletion tombstones, and roster checks remain atomic with scoring.
do $$
declare signature text; definition text;
begin
 foreach signature in array array[
  'public.upload_practice(jsonb)',
  'public.pw_upload_before_achievements(jsonb)',
  'public.pw_upload_before_players(jsonb)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=replace(definition,'pg_advisory_xact_lock(79112834)', 'pg_advisory_xact_lock_shared(79112834)');
  execute definition;
 end loop;
 definition:=pg_get_functiondef('public.upload_practice(jsonb)'::regprocedure);
 definition:=replace(definition,'perform pg_advisory_xact_lock_shared(79112834);',
  'perform pg_advisory_xact_lock_shared(79112834);'||chr(10)||
  ' perform pg_advisory_xact_lock(hashtextextended(''activity:''||pid::text,0));');
 execute definition;
 -- Player activities serialize per player (including creates without an existing
 -- row), while unrelated players can save concurrently. Keep structural branches
 -- exclusive. Lock ordering is always gate -> player -> practice -> job row.
 -- Migration files can have CRLF endings on Windows. Normalize the stored
 -- function body before matching a statement across a line boundary.
 definition:=replace(pg_get_functiondef('public.manage(text,jsonb)'::regprocedure),chr(13),'');
 definition:=replace(definition,
  'perform pg_advisory_xact_lock(79112834);'||chr(10)||' opid:=',
  'perform pg_advisory_xact_lock_shared(79112834);'||chr(10)||
  ' perform pg_advisory_xact_lock(hashtextextended(''activity:''||pid::text,0));'||chr(10)||
  ' if public.pw_player_pitcher() is distinct from pid then raise exception ''Linked player access required'' using errcode=''42501'';end if;'||chr(10)||' opid:=');
 definition:=replace(definition,'elsif action=''saveTeamChallenge'' then',
  'elsif action=''saveTeamChallenge'' then perform pg_advisory_xact_lock(79112834);');
 if position('hashtextextended(''activity:''||pid::text,0)' in definition)=0 then raise exception 'Player activity concurrency migration did not match its source function';end if;
 execute definition;
end $$;

-- Every query in a workspace read uses the calling statement's MVCC snapshot.
-- Sessions and events remain consistent while unrelated scoring commits proceed.
alter function public.get_workspace() stable;
alter function public.pw_workspace_before_achievements() stable;
alter function public.pw_workspace_before_goals() stable;
alter function public.pw_workspace_gc_core() stable;
alter function public.achievement_player_workspace(uuid,uuid) stable;

-- A team practice can dirty several players. Acquire job rows in a common order
-- even when concurrent practices list those players in a different order.
create or replace function public.achievement_source_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare item text; ids jsonb:='[]';
begin
 if tg_table_name='practices' then
  if tg_op<>'INSERT' then ids:=ids||(old.data->'pitcherIds');end if;
  if tg_op<>'DELETE' then ids:=ids||(new.data->'pitcherIds');end if;
  for item in select distinct value from jsonb_array_elements_text(ids) order by value loop perform public.achievement_dirty(item::uuid);end loop;
 else
  if tg_op<>'INSERT' then perform public.achievement_dirty(old.pitcher_id);end if;
  if tg_op<>'DELETE' and (tg_op='INSERT' or new.pitcher_id is distinct from old.pitcher_id) then perform public.achievement_dirty(new.pitcher_id);end if;
 end if;
 return null;
end $$;

-- History containment and authorization joins must use indexes as the total
-- population grows. jsonb_ops supports the ? operator used by player history.
create index practices_pitcher_ids on public.practices using gin ((data->'pitcherIds'));
create index pitchers_owner on public.pitchers(owner_id,id);
create index team_coaches_actor_team on public.team_coaches(coach_id,team_id);
create index team_pitchers_player_team on public.team_pitchers(pitcher_id,team_id) where active;
create index invitations_email on public.invitations(email);
create index removal_visibility_viewer on public.removal_visibility(viewer_id,kind,id);
create index gc_summary_pitchers_player on public.gc_summary_pitchers(pitcher_id,summary_id);
create index goals_pitcher on public.goals(pitcher_id);
create index achievement_records_player on public.achievement_records(pitcher_id,id);
create index achievement_deleted_player on public.achievement_deleted(pitcher_id);
create index achievement_awards_player on public.achievement_awards(pitcher_id,id);
create index team_challenges_team on public.team_challenges(team_id);
create index achievement_jobs_due on public.achievement_jobs(next_evaluate_at,requested_at,pitcher_id);
create index request_limits_expiry on public.request_limits(window_start);
create index player_invitations_team on public.player_invitations(team_id,created_at);
create index player_invitations_pitcher on public.player_invitations(pitcher_id);

-- A short claim transaction leases bounded work. Evaluation happens outside the
-- transaction; expired leases recover crashed workers. Revision + lease tokens
-- fence stale workers and prevent one worker from releasing another's claim.
alter table public.achievement_jobs add column lease_token uuid, add column leased_until timestamptz;
create function public.achievement_claim(p_player uuid default null,p_limit integer default 10)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid worker batch';end if;
 with candidates as materialized (
  select pitcher_id from public.achievement_jobs
  where (p_player is null and next_evaluate_at<=now() or p_player=pitcher_id and (revision>processed_revision or next_evaluate_at<=now()))
   and (leased_until is null or leased_until<now())
  order by next_evaluate_at,requested_at,pitcher_id limit p_limit for update skip locked
 ), claimed as (
  update public.achievement_jobs j set lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes'
  from candidates c where j.pitcher_id=c.pitcher_id returning j.pitcher_id,j.revision,j.lease_token
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 return result;
end $$;
create function public.achievement_finish(p uuid,expected bigint,token uuid,awards jsonb)
returns boolean language plpgsql set search_path='' as $$
declare tz text;
begin
 perform 1 from public.achievement_jobs where pitcher_id=p and lease_token=token and leased_until>now() for update;
 if not found then return false;end if;
 if not public.achievement_commit(p,expected,awards) then
  update public.achievement_jobs set lease_token=null,leased_until=null where pitcher_id=p;
  return false;
 end if;
 select coalesce(data->>'timezone','UTC') into tz from public.achievement_records where pitcher_id=p and kind='profile';
 -- Rules depend on local calendar dates. Unchanged lifetime history needs one
 -- daily pass, not 96 complete replays/day. Spread midnight work over 15 minutes.
 update public.achievement_jobs set lease_token=null,leased_until=null,
  next_evaluate_at=(((now() at time zone coalesce(tz,'UTC'))::date+1)::timestamp at time zone coalesce(tz,'UTC'))
   + ((hashtextextended(p::text,1) & 2147483647) % 900)*interval '1 second'
 where pitcher_id=p;
 return true;
end $$;
create function public.achievement_fail(p uuid,token uuid,expected bigint) returns void language sql set search_path='' as $$
 update public.achievement_jobs set lease_token=null,leased_until=null,
  last_error='Evaluation failed; inspect rule and source validation',next_evaluate_at=case when revision<>expected then now() else now()+interval '15 minutes' end
 where pitcher_id=p and lease_token=token
$$;
-- Changing source data makes work immediately eligible, rather than waiting for
-- the last periodic evaluation's scheduled time.
create or replace function public.achievement_dirty(p uuid) returns void language sql set search_path='' as $$
 insert into public.achievement_jobs(pitcher_id) select p where exists(select 1 from public.player_accounts where pitcher_id=p)
 on conflict(pitcher_id) do update set revision=public.achievement_jobs.revision+1,
  requested_at=now(),next_evaluate_at=least(public.achievement_jobs.next_evaluate_at,now())
$$;
delete from public.achievement_jobs j where not exists(select 1 from public.player_accounts p where p.pitcher_id=j.pitcher_id);
create function public.achievement_unlinked() returns trigger language plpgsql security definer set search_path='' as $$
begin
 delete from public.achievement_jobs where pitcher_id=old.pitcher_id and not exists(select 1 from public.player_accounts where pitcher_id=old.pitcher_id);
 return null;
end $$;
create trigger achievement_player_unlink after delete on public.player_accounts for each row execute function public.achievement_unlinked();
revoke all on function public.achievement_unlinked() from public,anon,authenticated;
revoke all on function public.achievement_claim(uuid,integer),public.achievement_finish(uuid,bigint,uuid,jsonb),public.achievement_fail(uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.achievement_claim(uuid,integer),public.achievement_finish(uuid,bigint,uuid,jsonb),public.achievement_fail(uuid,uuid,bigint) to service_role;
