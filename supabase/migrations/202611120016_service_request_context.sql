-- Service-only contexts eliminate sequential API hops. The Edge handler obtains
-- p_actor from GoTrue verification, never from a request body. Browser roles
-- cannot execute these functions or supply a trusted context.
create function public.account_context(p_actor uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb;
begin
 select jsonb_build_object('profile',to_jsonb(c),
  'pitcherId',case when c.role='player' then (select pa.pitcher_id from public.player_accounts pa where pa.account_id=c.id) end,
  'onboardingTeamId',case when c.role='coach' then (select s.team_id from public.coach_signups s where s.account_id=c.id and s.onboarding_finished_at is null) end,
  'requestStatus',case when not c.active then (select r.status from public.access_requests r where r.account_id=c.id) end)
 into result from public.coaches c where c.id=p_actor;
 return result;
end $$;
create function public.achievement_prepare(p_actor uuid) returns jsonb
language plpgsql set search_path='' as $$
declare account public.coaches;pid uuid;jobs jsonb;job jsonb;previous jsonb;
begin
 select * into account from public.coaches where id=p_actor;
 if not found or not account.active then return jsonb_build_object('kind','denied');end if;
 if account.role<>'player' then return jsonb_build_object('kind','notPlayer');end if;
 select pitcher_id into pid from public.player_accounts where account_id=p_actor;
 if pid is null then return jsonb_build_object('kind','missingLink');end if;
 jobs:=public.achievement_claim(pid,1);job:=jobs->0;
 if job is null then return jsonb_build_object('kind','ready','pitcherId',pid,'job',null);end if;
 -- The job row stays locked only while its source is assembled, not while the
 -- Edge worker runs rules. Finish still checks both revision and lease token.
 select coalesce(jsonb_agg(w.data),'[]') into previous from public.achievement_awards w where w.pitcher_id=pid;
 return jsonb_build_object('kind','ready','pitcherId',pid,'job',job,'input',public.achievement_input(pid),'previous',previous);
end $$;
revoke all on function public.account_context(uuid),public.achievement_prepare(uuid) from public,anon,authenticated;
grant execute on function public.account_context(uuid),public.achievement_prepare(uuid) to service_role;
