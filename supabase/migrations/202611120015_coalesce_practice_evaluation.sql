-- Derived awards need not replay lifetime history after every pitch. Anchor a
-- short window to the last successful evaluation; continued writing never moves
-- the deadline indefinitely. Urgent changes retain priority until committed.
alter table public.achievement_jobs add column evaluation_urgent boolean not null default true;
create or replace function public.achievement_dirty(p uuid) returns void language sql set search_path='' as $$
 insert into public.achievement_jobs(pitcher_id) select p where exists(select 1 from public.player_accounts where pitcher_id=p)
 on conflict(pitcher_id) do update set revision=public.achievement_jobs.revision+1,
  requested_at=now(),next_evaluate_at=least(public.achievement_jobs.next_evaluate_at,now()),evaluation_urgent=true
$$;
create function public.achievement_practice_dirty(p uuid,urgent boolean) returns void language sql set search_path='' as $$
 insert into public.achievement_jobs(pitcher_id,evaluation_urgent) select p,urgent where exists(select 1 from public.player_accounts where pitcher_id=p)
 on conflict(pitcher_id) do update set revision=public.achievement_jobs.revision+1,requested_at=now(),
  next_evaluate_at=case when urgent or public.achievement_jobs.evaluation_urgent and public.achievement_jobs.revision>public.achievement_jobs.processed_revision
   then least(public.achievement_jobs.next_evaluate_at,now())
   else greatest(now(),coalesce(public.achievement_jobs.evaluated_at+interval '15 seconds',now())) end,
  evaluation_urgent=urgent or public.achievement_jobs.evaluation_urgent and public.achievement_jobs.revision>public.achievement_jobs.processed_revision
$$;
revoke all on function public.achievement_practice_dirty(uuid,boolean) from public,anon,authenticated;
create or replace function public.achievement_source_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare item text;ids jsonb:='[]';urgent boolean;
begin
 if tg_table_name='practices' then
  if tg_op<>'INSERT' then ids:=ids||(old.data->'pitcherIds');end if;
  if tg_op<>'DELETE' then ids:=ids||(new.data->'pitcherIds');end if;
  if tg_op='DELETE' then urgent:=true;
  elsif tg_op='INSERT' then urgent:=new.data->>'status'='ended';
  else urgent:=new.data->>'status'='ended' or new.archived is distinct from old.archived
    or new.team_id is distinct from old.team_id or jsonb_array_length(new.events)<=jsonb_array_length(old.events);
  end if;
  for item in select distinct value from jsonb_array_elements_text(ids) order by value loop
   perform public.achievement_practice_dirty(item::uuid,urgent);
  end loop;
 else
  if tg_op<>'INSERT' then perform public.achievement_dirty(old.pitcher_id);end if;
  if tg_op<>'DELETE' and (tg_op='INSERT' or new.pitcher_id is distinct from old.pitcher_id) then perform public.achievement_dirty(new.pitcher_id);end if;
 end if;
 return null;
end $$;
do $$declare definition text;old text;begin
 definition:=replace(pg_get_functiondef('public.achievement_claim(uuid,integer)'::regprocedure),chr(13),'');
 old:='where pitcher_id=p_player and (revision>processed_revision or next_evaluate_at<=now())';
 if position(old in definition)=0 then raise exception 'Foreground evaluation scheduling did not match';end if;
 execute replace(definition,old,'where pitcher_id=p_player and next_evaluate_at<=now()');
 definition:=replace(pg_get_functiondef('public.achievement_finish(uuid,bigint,uuid,jsonb)'::regprocedure),chr(13),'');
 old:='update public.achievement_jobs set lease_token=null,leased_until=null,';
 if position(old in definition)=0 then raise exception 'Completed evaluation scheduling did not match';end if;
 -- The stale-worker branch has no trailing comma, so its priority is retained.
 execute replace(definition,old,'update public.achievement_jobs set lease_token=null,leased_until=null,evaluation_urgent=false,');
end $$;
