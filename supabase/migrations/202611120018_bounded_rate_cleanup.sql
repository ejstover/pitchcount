-- Count the current attempt before bounded, nonblocking expiry maintenance.
-- Never make a sign-in/signup delete an arbitrarily large historical backlog.
create index request_limits_expiry_bucket on public.request_limits(window_start,bucket);
create function public.prune_request_limits(p_hours integer) returns integer
language plpgsql set search_path='' as $$
declare removed integer;
begin
 if p_hours is null or p_hours not in(2,24) then raise exception 'Invalid limit retention';end if;
 with expired as materialized (
  select bucket from public.request_limits where window_start<now()-p_hours*interval '1 hour'
  order by window_start,bucket limit 64 for update skip locked
 ), deleted as (
  delete from public.request_limits r using expired e where r.bucket=e.bucket returning 1
 ) select count(*) into removed from deleted;
 return removed;
end $$;
revoke all on function public.prune_request_limits(integer) from public,anon,authenticated;
grant execute on function public.prune_request_limits(integer) to service_role;
do $$declare signature text;definition text;old text;hours integer;begin
 foreach signature in array array['public.onboarding_limit(text,integer)','public.player_login_limit(text)'] loop
  definition:=replace(pg_get_functiondef(signature::regprocedure),chr(13),'');
  hours:=case when signature like '%onboarding%' then 2 else 24 end;
  old:='delete from public.request_limits where window_start<now()-interval '||quote_literal(case when hours=2 then '2 hours' else '1 day' end)||';';
  if position(old in definition)=0 then raise exception 'Rate expiry migration did not match %',signature;end if;
  execute replace(definition,old,'perform public.prune_request_limits('||hours::text||');');
 end loop;
end $$;
