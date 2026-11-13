-- Evaluation must still validate the source revision and advance its job, but
-- unchanged derived evidence does not need a new heap tuple or index/WAL work.
-- Preserve the existing service ACL, owner check and revision fence verbatim.
do $$
declare definition text;needle text:='where public.achievement_awards.pitcher_id=p;';
begin
 definition:=replace(pg_get_functiondef('public.achievement_commit(uuid,bigint,jsonb)'::regprocedure),chr(13),'');
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
  raise exception 'Unexpected achievement commit definition';
 end if;
 definition:=replace(definition,needle,'where public.achievement_awards.pitcher_id=p and public.achievement_awards.data is distinct from excluded.data;');
 execute definition;
end $$;
