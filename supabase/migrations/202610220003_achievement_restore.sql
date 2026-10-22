-- Extend the existing atomic restore's reference map rather than creating account links.
do $migration$
declare source text;
begin
 select prosrc into source from pg_proc where oid='public.gc_restore(jsonb)'::regprocedure;
 source:=replace(source,'for item in select value from jsonb_array_elements(b->''teams'') loop',
 $insert$for item in select value from jsonb_array_elements(coalesce(b->'achievementRecords','[]')) loop
  if m ? (item->>'id') then raise exception 'Duplicate activity identifier';end if;
  m:=m||jsonb_build_object(item->>'id',gen_random_uuid());
 end loop;
 for item in select value from jsonb_array_elements(b->'teams') loop$insert$);
 source:=replace(source,'s:=s||jsonb_build_object(''recorderId''', 's:=s||jsonb_build_object(''originSessionId'',case when item->>''recovered''=''true'' then item->>''originSessionId'' else coalesce(item->>''originSessionId'',item->>''id'') end,''recorderId''');
 source:=regexp_replace(source,'\s*end\s*$', $append$
 for item in select value from jsonb_array_elements(coalesce(b->'achievementRecords','[]')) loop
  if not (m ? (item->>'pitcherId')) then raise exception 'Missing activity pitcher';end if;
  if item->>'kind'='profile' then
   -- Login links, pinned awards and personal profile settings do not transfer.
   continue;
  end if;
  s:=item->'data';
  for pair in select * from jsonb_each_text(m) loop s:=replace(s::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;end loop;
  insert into public.achievement_records(id,pitcher_id,kind,revision,data,created_at) values((m->>(item->>'id'))::uuid,(m->>(item->>'pitcherId'))::uuid,item->>'kind',1,s,(item->>'createdAt')::timestamptz);
 end loop;
end
$append$);
 execute 'create or replace function public.gc_restore(input jsonb) returns void language plpgsql set search_path='''''||' as '||quote_literal(source);
end $migration$;
