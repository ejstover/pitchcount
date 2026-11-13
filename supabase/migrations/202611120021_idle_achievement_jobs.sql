-- Only the trusted evaluator decides that its validated source has no remaining
-- calendar-dependent work. Preserve the original lease/revision/owner checks.
-- Old workers can keep using achievement_finish during a rolling deployment.
alter table public.achievement_jobs add column rules_requested_at timestamptz not null default now();
create index achievement_jobs_rule_refresh on public.achievement_jobs(rules_requested_at,pitcher_id);

-- Operator rollout: drain old worker versions, retain one fixed cutoff, then
-- request bounded batches until remaining=false. Skipped locked rows remain
-- eligible; a zero-sized batch alone never means the refresh is complete.
create function public.achievement_requeue_rules(p_cutoff timestamptz,p_limit integer default 1000)
returns jsonb language plpgsql set search_path='' as $$
declare changed integer;
begin
 if p_cutoff is null or not isfinite(p_cutoff) or p_cutoff>now() then
  raise exception 'Invalid rules refresh cutoff' using errcode='22023';
 end if;
 with candidates as (
  select pitcher_id from public.achievement_jobs where rules_requested_at<p_cutoff
  order by rules_requested_at,pitcher_id limit greatest(1,least(coalesce(p_limit,1000),1000)) for update skip locked
 ) update public.achievement_jobs j set rules_requested_at=p_cutoff,revision=j.revision+1,
  requested_at=now(),next_evaluate_at=least(j.next_evaluate_at,now()),evaluation_urgent=true
 from candidates c where j.pitcher_id=c.pitcher_id;
 get diagnostics changed=row_count;
 return jsonb_build_object('updated',changed,'remaining',exists(select 1 from public.achievement_jobs where rules_requested_at<p_cutoff));
end $$;

create function public.achievement_finish_scheduled(p uuid,expected bigint,token uuid,awards jsonb,
 p_calendar_pending boolean,p_evaluated_at timestamptz) returns boolean
language plpgsql set search_path='' as $$
declare tz text;
begin
 if p_evaluated_at is null or not isfinite(p_evaluated_at) or p_evaluated_at>now()+interval '1 minute' then
  raise exception 'Invalid evaluation timestamp' using errcode='22023';
 end if;
 if not public.achievement_finish(p,expected,token,awards) then return false;end if;
 -- The original finish holds the job row through this transaction. A source
 -- write that follows it still advances the revision and makes work due again.
 if p_calendar_pending is false then
  update public.achievement_jobs set next_evaluate_at='infinity' where pitcher_id=p;
 else
  select coalesce(data->>'timezone','UTC') into tz from public.achievement_records where pitcher_id=p and kind='profile';
  -- An evaluation begun before local midnight must not skip the new day if its
  -- commit crosses midnight. Leave the calendar work immediately eligible.
  if (p_evaluated_at at time zone coalesce(tz,'UTC'))::date<(now() at time zone coalesce(tz,'UTC'))::date then
   update public.achievement_jobs set next_evaluate_at=now() where pitcher_id=p;
  end if;
 end if;
 return true;
end $$;
revoke all on function public.achievement_finish_scheduled(uuid,bigint,uuid,jsonb,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.achievement_finish_scheduled(uuid,bigint,uuid,jsonb,boolean,timestamptz) to service_role;
revoke all on function public.achievement_requeue_rules(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.achievement_requeue_rules(timestamptz,integer) to service_role;
