-- The generic plan for a nullable player/global OR can scan the entire due
-- backlog for one player's claim. Separate plans keep the primary-key lookup
-- independent of backlog size without changing leases or worker authorization.
create or replace function public.achievement_claim(p_player uuid default null,p_limit integer default 10)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'Invalid worker batch';end if;
 if p_player is null then
  with candidates as materialized (
   select pitcher_id from public.achievement_jobs
   where next_evaluate_at<=now() and (leased_until is null or leased_until<now())
   order by next_evaluate_at,requested_at,pitcher_id limit p_limit for update skip locked
  ), claimed as (
   update public.achievement_jobs j set lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes'
   from candidates c where j.pitcher_id=c.pitcher_id returning j.pitcher_id,j.revision,j.lease_token
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 else
  with candidates as materialized (
   select pitcher_id from public.achievement_jobs
   where pitcher_id=p_player and (revision>processed_revision or next_evaluate_at<=now())
    and (leased_until is null or leased_until<now()) for update skip locked
  ), claimed as (
   update public.achievement_jobs j set lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes'
   from candidates c where j.pitcher_id=c.pitcher_id returning j.pitcher_id,j.revision,j.lease_token
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 end if;
 return result;
end $$;
revoke all on function public.achievement_claim(uuid,integer) from public,anon,authenticated;
grant execute on function public.achievement_claim(uuid,integer) to service_role;
