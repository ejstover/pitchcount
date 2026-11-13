-- CASE around the goal scope concealed the indexed team/player predicates.
-- Both branches retain exactly the same visibility rules, including coach goals.
create index goals_team on public.goals(team_id);
do $$declare definition text;old text;replacement text;begin
 definition:=pg_get_functiondef('public.workspace_metadata_from_context(jsonb)'::regprocedure);
 old:='case when g.scope=''personal'' then g.pitcher_id=i.pid or g.pitcher_id=any(i.roster) else g.team_id=any(i.teams) end';
 replacement:='((g.scope=''personal'' and (g.pitcher_id=i.pid or g.pitcher_id=any(i.roster))) or (g.scope<>''personal'' and g.team_id=any(i.teams)))';
 if position(old in definition)=0 then raise exception 'Goal scope migration did not match';end if;
 execute replace(definition,old,replacement);
end $$;
