-- Skip history pages only when the complete, current authorized version set
-- matches the client's digest. The digest is a cache hint, never an access grant.
create function public.workspace_practice_manifest(context jsonb) returns text
language plpgsql stable set search_path='' as $$
declare result text;
begin
 with ids as materialized (
  select (context->>'actorId')::uuid actor,(context->>'pitcherId')::uuid pid,
   array(select jsonb_array_elements_text(context->'teams')::uuid) teams
 ), candidates as (
  select p.id from public.practices p,ids i where p.team_id=any(i.teams)
  union select p.id from public.practices p,ids i where p.team_id is null and p.recorder_id=i.actor
  union select p.id from public.practices p,ids i where i.pid is not null and p.data->'pitcherIds' ? i.pid::text
 ), versions as (
  select p.id,p.revision::text||':'||p.archived::text||':'||
   (coalesce(p.team_id=any(i.teams),false) or p.team_id is null and p.recorder_id=i.actor)::text||':'||coalesce(i.pid::text,'') version
  from public.practices p join candidates c on c.id=p.id cross join ids i
 ) select encode(sha256(convert_to((context->>'epoch')||E'\n'||coalesce(string_agg(id::text||':'||version,E'\n' order by id),''),'UTF8')),'hex') into result from versions;
 return result;
end $$;
revoke all on function public.workspace_practice_manifest(jsonb) from public,anon,authenticated;

create function public.get_workspace_state(p_manifest text,p_epoch text,p_known jsonb default '{}',p_team uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare context jsonb;manifest text;
begin
 context:=public.workspace_query_context(p_team);
 if context is null then raise exception 'Account unavailable' using errcode='42501';end if;
 if p_team is not null and context->>'role'<>'admin' then raise exception 'Admin workspace access required' using errcode='42501';end if;
 if p_manifest is null or p_manifest !~ '^[0-9a-f]{64}$' or p_epoch is null or p_epoch !~ '^[0-9a-f]{32}$'
  or jsonb_typeof(p_known) is distinct from 'object' or octet_length(p_known::text)>1000000 then
  raise exception 'Invalid workspace state' using errcode='22023';
 end if;
 if p_epoch=context->>'epoch' then
  manifest:=public.workspace_practice_manifest(context);
  if manifest=p_manifest then
   return jsonb_build_object('epoch',context->>'epoch','manifest',manifest,'unchanged',true,
    'snapshot',public.workspace_metadata_from_context(context),'items','[]'::jsonb,'next',null);
  end if;
 end if;
 -- A missing, extra, changed or newly unauthorized record forces an ordinary
 -- complete manifest. Existing pagination checks and exact-version hints apply.
 return public.get_workspace_page(null,p_known,50,null,p_team)||jsonb_build_object('unchanged',false);
end $$;
revoke all on function public.get_workspace_state(text,text,jsonb,uuid) from public,anon;
grant execute on function public.get_workspace_state(text,text,jsonb,uuid) to authenticated;
