-- Award evidence can dwarf ordinary metadata. Omit it only after hashing the
-- actual currently authorized award values, bound to the current access epoch.
-- This remains correct even for service-side repairs outside the normal worker.
create function public.get_workspace_update(p_manifest text,p_epoch text,p_known jsonb default '{}',p_team uuid default null,p_awards text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;awards jsonb;version text;
begin
 result:=public.get_workspace_state(p_manifest,p_epoch,p_known,p_team);
 if p_awards is not null and p_awards !~ '^[0-9a-f]{64}$' then raise exception 'Invalid award cache version' using errcode='22023';end if;
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into awards
 from jsonb_array_elements(coalesce(result->'snapshot'->'achievementAwards','[]'));
 version:=encode(sha256(convert_to((result->>'epoch')||E'\n'||awards::text,'UTF8')),'hex');
 if version=p_awards then result:=jsonb_set(result,'{snapshot,achievementAwards}','[]');end if;
 return result||jsonb_build_object('awardsVersion',version,'awardsUnchanged',coalesce(version=p_awards,false));
end $$;
revoke all on function public.get_workspace_update(text,text,jsonb,uuid,text) from public,anon;
grant execute on function public.get_workspace_update(text,text,jsonb,uuid,text) to authenticated;
