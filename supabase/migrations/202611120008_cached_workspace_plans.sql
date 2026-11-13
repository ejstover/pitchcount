-- SQL-language helpers with SET search_path/security-definer boundaries cannot
-- inline; PostgreSQL 17 rebuilds their plans for each outer query.
-- PL/pgSQL retains the prepared visibility/metadata queries across requests on
-- each pooled connection. Keep the same stable snapshot, body, ACL and role.
do $$declare fn record;definition text;body text;begin
 for fn in select p.oid,p.prosrc,l.lanname from pg_proc p join pg_language l on l.oid=p.prolang
  where p.oid in('public.workspace_query_context(uuid)'::regprocedure,
                'public.workspace_metadata_from_context(jsonb)'::regprocedure)
 loop
  if fn.lanname<>'sql' then raise exception 'Unexpected workspace helper language';end if;
  definition:=pg_get_functiondef(fn.oid);
  body:='begin return ('||rtrim(fn.prosrc,E' \t\n\r;')||'); end;';
  definition:=replace(definition,'LANGUAGE sql','LANGUAGE plpgsql');
  definition:=replace(definition,fn.prosrc,body);
  if position(body in definition)=0 or position('LANGUAGE plpgsql' in definition)=0 then
   raise exception 'Workspace plan-cache migration did not match';
  end if;
  execute definition;
 end loop;
end $$;
