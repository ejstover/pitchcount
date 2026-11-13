-- Profiling showed repeated planning of the same current-identity checks in
-- upload wrappers. Cache their query plans, never their authorization results.
-- Preserve each exact SELECT, stable snapshot, security definer, search path and
-- existing ACL. Auth identity and current rows remain runtime query inputs.
do $$declare fn record;definition text;body text;seen integer:=0;begin
 for fn in select p.oid,p.prosrc,p.proretset,p.provolatile,p.prosecdef,l.lanname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname='public' and p.proname=any(array[
   'pw_active','pw_admin','pw_writer','pw_email','pw_player_pitcher',
   'pw_team','pw_edit_team','pw_practice_before_achievements','pw_practice',
   'pw_pitcher_before_achievements','pw_pitcher','pw_edit_pitcher',
   'pw_coach_before_achievements','pw_coach','pw_read_goal_before_achievements','pw_read_goal'])
 loop
  if fn.lanname<>'sql' or fn.proretset or fn.provolatile<>'s' or not fn.prosecdef or lower(ltrim(fn.prosrc,E' \t\n\r')) !~ '^select[[:space:]]' then
   raise exception 'Unexpected permission helper definition: %',fn.oid::regprocedure;
  end if;
  definition:=pg_get_functiondef(fn.oid);
  body:='begin return ('||rtrim(fn.prosrc,E' \t\n\r;')||'); end;';
  definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
  definition:=replace(definition,fn.prosrc,body);
  if position(body in definition)=0 then raise exception 'Permission helper conversion did not match';end if;
  execute definition;seen:=seen+1;
 end loop;
 if seen<>16 then raise exception 'Expected sixteen permission helpers, found %',seen;end if;
end $$;
