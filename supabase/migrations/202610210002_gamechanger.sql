-- GameChanger summaries are independent of the authoritative practice event stream.
create table public.gc_summaries (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams,
 season_key text not null, revision integer not null check(revision>0), data jsonb not null,
 unique(team_id,season_key)
);
create table public.gc_summary_pitchers (
 summary_id uuid references public.gc_summaries on delete cascade,
 pitcher_id uuid references public.pitchers on delete restrict, primary key(summary_id,pitcher_id)
);
create table public.gc_mappings (
 team_id uuid references public.teams on delete cascade, season_key text not null,
 source_key text not null, pitcher_id uuid not null references public.pitchers on delete cascade,
 primary key(team_id,season_key,source_key)
);
alter table public.gc_summaries enable row level security;
alter table public.gc_summary_pitchers enable row level security;
alter table public.gc_mappings enable row level security;
create policy gc_read on public.gc_summaries for select to authenticated using(public.pw_team(team_id));
create policy gc_players_read on public.gc_summary_pitchers for select to authenticated using(exists(select 1 from public.gc_summaries s where s.id=summary_id and public.pw_team(s.team_id)));
create policy gc_mapping_read on public.gc_mappings for select to authenticated using(public.pw_team(team_id));
revoke all on public.gc_summaries,public.gc_summary_pitchers,public.gc_mappings from public,anon,authenticated;
grant select on public.gc_summaries,public.gc_summary_pitchers,public.gc_mappings to authenticated;
grant all on public.gc_summaries,public.gc_summary_pitchers,public.gc_mappings to service_role;

create function public.gc_key(v text) returns text language sql immutable set search_path='' as $$
 select lower(regexp_replace(trim(normalize(v,NFKC)),'\s+',' ','g'))
$$;

create function public.gc_validate_stats(stats jsonb, required_counts boolean) returns void language plpgsql set search_path='' as $$
declare k text; v jsonb;
begin
 if jsonb_typeof(stats) is distinct from 'object' then raise exception 'Invalid GameChanger statistics'; end if;
 foreach k in array array['pitches','batters','walks','strikeouts','games','outs','hits','runs','earnedRuns','hitBatters','wildPitches','strikePct','firstPitchPct','era','whip'] loop
  v:=stats->k;
  if v is null or (v='null' and required_counts and k in ('pitches','batters','walks','strikeouts')) then raise exception 'Missing GameChanger count: %',k; end if;
  if v<>'null' then
   if jsonb_typeof(v)<>'number' then raise exception 'Invalid GameChanger number: %',k; end if;
   if (v::text)::numeric<0 or (v::text)::numeric>9007199254740991 then raise exception 'Invalid GameChanger number: %',k; end if;
   if k not in ('strikePct','firstPitchPct','era','whip') and trunc((v::text)::numeric)<>(v::text)::numeric then raise exception 'GameChanger counts must be integers'; end if;
   if k in ('strikePct','firstPitchPct') and (v::text)::numeric>100 then raise exception 'GameChanger percentage exceeds 100'; end if;
  end if;
 end loop;
end
$$;

create function public.gc_validate_content(s jsonb) returns void language plpgsql set search_path='' as $$
declare p jsonb; start_date date; end_date date;
begin
 if jsonb_typeof(s->'season') is distinct from 'string' or length(trim(s->>'season')) not between 1 and 150
 or jsonb_typeof(s->'fileName') is distinct from 'string' or length(s->>'fileName')>500
 or coalesce(s->>'coverageStart','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(s->>'coverageEnd','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose a season and valid coverage dates'; end if;
 start_date:=(s->>'coverageStart')::date; end_date:=(s->>'coverageEnd')::date;
 if start_date>end_date then raise exception 'Coverage start must precede its end'; end if;
 if jsonb_typeof(s->'players') is distinct from 'array' or jsonb_array_length(s->'players') not between 1 and 500 then raise exception 'Choose at least one pitcher (maximum 500)'; end if;
 if jsonb_typeof(s->'warnings') is distinct from 'array' or exists(select 1 from jsonb_array_elements(s->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Invalid import warnings'; end if;
 for p in select value from jsonb_array_elements(s->'players') loop
  if jsonb_typeof(p->'name') is distinct from 'string' or length(trim(p->>'name')) not between 1 and 200
   or jsonb_typeof(p->'jersey') is distinct from 'string' or length(p->>'jersey')>50
   or jsonb_typeof(p->'sourceKey') is distinct from 'string' or length(p->>'sourceKey') not between 1 and 300
   or jsonb_typeof(p->'pitcherId') is distinct from 'string' then raise exception 'Invalid GameChanger player identity'; end if;
  perform (p->>'pitcherId')::uuid;
  perform public.gc_validate_stats(p->'stats',true);
  if jsonb_typeof(p->'sourceValues') is distinct from 'object' then raise exception 'Invalid source pitching values'; end if;
  if exists(select 1 from jsonb_each(p->'sourceValues') v where jsonb_typeof(v.value)<>'string') then raise exception 'Invalid source pitching value'; end if;
 end loop;
 if (select count(distinct row_item->>'sourceKey') from jsonb_array_elements(s->'players') row_item)<>jsonb_array_length(s->'players')
 or (select count(distinct row_item->>'pitcherId') from jsonb_array_elements(s->'players') row_item)<>jsonb_array_length(s->'players') then raise exception 'Each source player must map to a different pitcher'; end if;
 if s->'teamTotals' is null then raise exception 'Missing team totals field'; end if;
 if s->'teamTotals'<>'null' then perform public.gc_validate_stats(s->'teamTotals',false); end if;
end
$$;

-- JSONB provides order-independent object equality; sort players and normalize numeric source formatting.
create function public.gc_semantic(s jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('coverageStart',s->'coverageStart','coverageEnd',s->'coverageEnd','teamTotals',s->'teamTotals',
 'players',(select jsonb_agg(jsonb_build_object('sourceKey',p->'sourceKey','pitcherId',p->'pitcherId','name',public.gc_key(p->>'name'),'jersey',p->'jersey','stats',p->'stats',
 'sourceValues',(select jsonb_object_agg(key,case when upper(trim(value)) in ('','-','N/A') then 'null'::jsonb when value~'^(\d+(\.\d*)?|\.\d+)$' then to_jsonb(value::numeric) else to_jsonb(value) end) from jsonb_each_text(p->'sourceValues')))
 order by p->>'sourceKey') from jsonb_array_elements(s->'players') p))
$$;

create function public.gc_save(s jsonb, tid uuid, expected integer, actor uuid) returns void language plpgsql set search_path='' as $$
declare old public.gc_summaries; sid uuid; rev integer; p jsonb; content jsonb; sk text:=public.gc_key(s->>'season');
begin
 perform public.gc_validate_content(s);
 select * into old from public.gc_summaries where team_id=tid and season_key=sk for update;
 if s ? 'expectedSummaryId' and s->>'expectedSummaryId' is distinct from old.id::text then raise exception 'GameChanger summary changed. Refresh and review the preview again.' using errcode='40001'; end if;
 if old.id is not null and public.gc_semantic(old.data)=public.gc_semantic(s) then return; end if;
 if expected is null or expected<>coalesce(old.revision,0) then raise exception 'GameChanger summary changed. Refresh and review the preview again.' using errcode='40001'; end if;
 for p in select value from jsonb_array_elements(s->'players') loop
  if not exists(select 1 from public.pitchers where id=(p->>'pitcherId')::uuid)
  or not exists(select 1 from public.team_pitchers where team_id=tid and pitcher_id=(p->>'pitcherId')::uuid) then raise exception 'Choose a pitcher on this team' using errcode='42501'; end if;
 end loop;
 sid:=coalesce(old.id,gen_random_uuid()); rev:=coalesce(old.revision,0)+1;
 content:=jsonb_build_object('id',sid,'teamId',tid,'season',trim(s->>'season'),'coverageStart',s->>'coverageStart','coverageEnd',s->>'coverageEnd',
 'fileName',s->>'fileName','players',(select jsonb_agg(row_item order by row_item->>'sourceKey') from jsonb_array_elements(s->'players') row_item),'teamTotals',s->'teamTotals','warnings',s->'warnings',
 'revision',rev,'importedBy',actor,'importedByName',(select name from public.coaches where id=actor),'updatedAt',now(),'fingerprint',md5(public.gc_semantic(s)::text));
 insert into public.gc_summaries(id,team_id,season_key,revision,data) values(sid,tid,sk,rev,content)
 on conflict(id) do update set revision=excluded.revision,data=excluded.data;
 delete from public.gc_summary_pitchers where summary_id=sid;
 for p in select value from jsonb_array_elements(s->'players') loop
  insert into public.gc_summary_pitchers values(sid,(p->>'pitcherId')::uuid);
  insert into public.gc_mappings values(tid,sk,p->>'sourceKey',(p->>'pitcherId')::uuid)
   on conflict(team_id,season_key,source_key) do update set pitcher_id=excluded.pitcher_id;
 end loop;
end
$$;

-- Summary references keep historical players visible after roster removal.
create or replace function public.pw_pitcher(p uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.pw_active() and (exists(select 1 from public.pitchers where id=p and owner_id=auth.uid())
 or exists(select 1 from public.team_pitchers where pitcher_id=p and active and public.pw_team(team_id))
 or exists(select 1 from public.practices where public.pw_practice(team_id,recorder_id) and data->'pitcherIds' ? p::text)
 or exists(select 1 from public.gc_summary_pitchers gp join public.gc_summaries s on s.id=gp.summary_id where gp.pitcher_id=p and public.pw_team(s.team_id)))
$$;

create function public.pw_removal_gc_core(kind text,id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare label text; allowed boolean:=false; archived boolean:=false; ab jsonb:='[]'; db jsonb:='[]'; practices jsonb; hidden integer;
 assignments integer:=0; invites integer:=0; owned integer:=0;
begin
 if not public.pw_active() then raise insufficient_privilege; end if;
 if kind='team' then
  select name,t.archived into label,archived from public.teams t where t.id=pw_removal_gc_core.id and public.pw_team(t.id);
  allowed:=public.pw_edit_team(id);
  select count(*) into assignments from public.team_pitchers where team_id=id;
  assignments:=assignments+(select count(*) from public.team_coaches where team_id=id);
  select count(*) into invites from public.invitations where team_id=id;
 elsif kind='pitcher' then
  select name,p.archived into label,archived from public.pitchers p where p.id=pw_removal_gc_core.id and public.pw_pitcher(p.id);
  allowed:=public.pw_remove_pitcher(id);
  select count(*) into assignments from public.team_pitchers where pitcher_id=id;
  if exists(select 1 from public.team_pitchers where pitcher_id=id and active) then ab:=ab||jsonb_build_array('Remove this pitcher from active team rosters first.'); end if;
 elsif kind='session' then
  select coalesce(nullif(data->>'name',''),'Bullpen practice'),p.archived into label,archived from public.practices p where p.id=pw_removal_gc_core.id and public.pw_practice(team_id,recorder_id);
  allowed:=public.pw_writer() and exists(select 1 from public.practices p where p.id=pw_removal_gc_core.id and public.pw_practice(team_id,recorder_id));
 elsif kind='coach' and public.pw_admin() then
  select email into label from public.coaches c where c.id=pw_removal_gc_core.id and c.role<>'admin';
  allowed:=label is not null;
  select count(*) into assignments from public.team_coaches where coach_id=id;
  select count(*) into owned from public.pitchers where owner_id=id;
  select count(*) into invites from public.invitations where email=label;
  if exists(select 1 from public.team_coaches m join public.teams t on t.id=m.team_id where m.coach_id=id and not t.archived and not exists(
   select 1 from public.team_coaches other join public.coaches c on c.id=other.coach_id where other.team_id=m.team_id and c.id<>pw_removal_gc_core.id and c.active and c.role in ('admin','coach'))) then
   ab:=ab||jsonb_build_array('Assign another active coach to each active team first.');
   db:=db||jsonb_build_array('Assign another active coach to each active team first.');
  end if;
 elsif kind='request' and public.pw_admin() then
  select email into label from public.access_requests r where r.id=pw_removal_gc_core.id;
  allowed:=label is not null;
 else raise exception 'Removal access denied' using errcode='42501';
 end if;
 if label is null then raise exception 'Record is unavailable' using errcode='42501'; end if;
 if not allowed then
  ab:=ab||jsonb_build_array('You cannot remove this record globally. Remove its team assignment or contact an admin.');
  db:=db||jsonb_build_array('You cannot remove this record globally. Remove its team assignment or contact an admin.');
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(nullif(p.data->>'name',''),'Bullpen practice'))) filter(where public.pw_practice(p.team_id,p.recorder_id)),'[]'),
 count(*) filter(where not public.pw_practice(p.team_id,p.recorder_id)) into practices,hidden from public.practices p
 where (kind='team' and p.team_id=id) or (kind='pitcher' and p.data->'pitcherIds' ? id::text) or (kind='coach' and p.recorder_id=id);
 if jsonb_array_length(practices)+hidden>0 then db:=db||jsonb_build_array('Delete all related practices individually before permanently deleting this record.'); end if;
 if exists(select 1 from public.practices p where p.data->>'status'<>'ended' and
 ((kind='team' and p.team_id=id) or (kind='pitcher' and p.data->'pitcherIds' ? id::text) or (kind='session' and p.id=pw_removal_gc_core.id))) then
  ab:=ab||jsonb_build_array('End related ongoing practices first.');
  db:=db||jsonb_build_array('End related ongoing practices first.');
 end if;
 return jsonb_build_object('name',label,'canRemove',allowed,'archiveBlockers',ab,'deleteBlockers',db,'practices',practices,'hiddenPractices',hidden,'assignments',assignments,'invitations',invites,'ownedPitchers',owned);
end
$$;
create or replace function public.removal_preview(kind text,id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare result jsonb;
begin
 result:=public.pw_removal_gc_core(kind,id);
 if (kind='team' and exists(select 1 from public.gc_summaries where team_id=id))
 or (kind='pitcher' and exists(select 1 from public.gc_summary_pitchers where pitcher_id=id)) then
  result:=jsonb_set(result,'{deleteBlockers}',(result->'deleteBlockers')||jsonb_build_array('Remove related GameChanger summaries in Settings before permanently deleting this record.'));
 end if;
 return result;
end
$$;

alter function public.get_workspace() rename to pw_workspace_gc_core;
create function public.get_workspace() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return public.pw_workspace_gc_core()||jsonb_build_object(
 'gcSummaries',coalesce((select jsonb_agg(data) from public.gc_summaries where public.pw_team(team_id)),'[]'),
 'gcMappings',coalesce((select jsonb_agg(jsonb_build_object('teamId',team_id,'season',season_key,'sourceKey',source_key,'pitcherId',pitcher_id)) from public.gc_mappings where public.pw_team(team_id) and public.pw_pitcher(pitcher_id)),'[]'));
end
$$;

-- Version 4 restores use fresh identifiers throughout, including GC row and mapping references.
create function public.gc_restore(input jsonb) returns void language plpgsql set search_path='' as $$
declare b jsonb:=input->'backup'; m jsonb:='{}'; item jsonb; p jsonb; s jsonb; source jsonb; newid uuid; key text; pair record; rows jsonb;
begin
 if b->>'format' is distinct from 'pitchwork-backup' or b->>'version' is distinct from '4' then raise exception 'Unsupported backup'; end if;
 foreach key in array array['teams','pitchers','teamPitchers','sessions','events','gcSummaries','gcMappings'] loop
  if jsonb_typeof(b->key) is distinct from 'array' then raise exception 'Invalid backup list: %',key; end if;
 end loop;
 for item in select value from jsonb_array_elements(b->'teams') loop
  if m ? (item->>'id') then raise exception 'Duplicate backup identifier'; end if;
  newid:=gen_random_uuid(); m:=m||jsonb_build_object(item->>'id',newid);
  insert into public.teams(id,name,archived) values(newid,item->>'name',coalesce((item->>'archived')::boolean,false));
  insert into public.team_coaches values(newid,auth.uid());
 end loop;
 for item in select value from jsonb_array_elements(b->'pitchers') loop
  if m ? (item->>'id') then raise exception 'Duplicate backup identifier'; end if;
  newid:=gen_random_uuid(); m:=m||jsonb_build_object(item->>'id',newid);
  insert into public.pitchers(id,name,jersey,owner_id,archived) values(newid,item->>'name',item->>'jersey',auth.uid(),(item->>'archived')::boolean);
 end loop;
 for item in select value from jsonb_array_elements(b->'teamPitchers') loop
  insert into public.team_pitchers values((m->>(item->>'teamId'))::uuid,(m->>(item->>'pitcherId'))::uuid,(item->>'active')::boolean);
 end loop;
 for item in select value from jsonb_array_elements(b->'sessions') loop
  if m ? (item->>'id') or m ? (item->>'initialAppearanceId') then raise exception 'Duplicate backup identifier'; end if;
  m:=m||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'initialAppearanceId',gen_random_uuid());
 end loop;
 for item in select value from jsonb_array_elements(b->'events') loop
  if m ? (item->>'id') or m ? (item->>'nextAppearanceId') then raise exception 'Duplicate backup identifier'; end if;
  m:=m||jsonb_build_object(item->>'id',gen_random_uuid(),item->>'nextAppearanceId',gen_random_uuid());
 end loop;
 if exists(select 1 from jsonb_array_elements(b->'events') e where not exists(select 1 from jsonb_array_elements(b->'sessions') bs where bs->>'id'=e->>'sessionId')) then raise exception 'Orphan backup event'; end if;
 for item in select value from jsonb_array_elements(b->'sessions') loop
  if item->>'teamId' is not null and not exists(select 1 from public.teams where id=(m->>(item->>'teamId'))::uuid) then raise exception 'Missing backup team'; end if;
  if exists(select 1 from jsonb_array_elements_text(item->'pitcherIds') pid where not exists(select 1 from public.pitchers where id=(m->>pid)::uuid)) then raise exception 'Missing backup pitcher'; end if;
  select coalesce(jsonb_agg(value order by (value->>'sequence')::integer),'[]') into source from jsonb_array_elements(b->'events') where value->>'sessionId'=item->>'id';
  s:=item;
  for pair in select * from jsonb_each_text(m) loop
   s:=replace(s::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
   source:=replace(source::text,to_jsonb(pair.key)::text,to_jsonb(pair.value)::text)::jsonb;
  end loop;
  s:=s||jsonb_build_object('recorderId',auth.uid(),'deviceId',(input->>'deviceId')::uuid,'revision',1,'recovered',true);
  perform public.validate_practice(s,source);
  insert into public.practices(id,team_id,recorder_id,device_id,revision,data,events,archived) values((s->>'id')::uuid,(s->>'teamId')::uuid,auth.uid(),(input->>'deviceId')::uuid,1,s,source,coalesce((item->>'archived')::boolean,false));
 end loop;
 for item in select value from jsonb_array_elements(b->'gcSummaries') loop
  rows:='[]';
  if not exists(select 1 from public.teams where id=(m->>(item->>'teamId'))::uuid) then raise exception 'Missing backup GC team'; end if;
  for p in select value from jsonb_array_elements(item->'players') loop
   if not exists(select 1 from public.pitchers where id=(m->>(p->>'pitcherId'))::uuid) then raise exception 'Missing backup GC pitcher'; end if;
   rows:=rows||jsonb_build_array(p||jsonb_build_object('pitcherId',m->>(p->>'pitcherId')));
   -- Historical imports can reference an inactive roster membership.
   insert into public.team_pitchers values((m->>(item->>'teamId'))::uuid,(m->>(p->>'pitcherId'))::uuid,false) on conflict do nothing;
  end loop;
  if exists(select 1 from public.gc_summaries where team_id=(m->>(item->>'teamId'))::uuid and season_key=public.gc_key(item->>'season')) then raise exception 'Duplicate backup team season'; end if;
  perform public.gc_save(item||jsonb_build_object('players',rows),(m->>(item->>'teamId'))::uuid,0,auth.uid());
 end loop;
 for item in select value from jsonb_array_elements(b->'gcMappings') loop
  insert into public.gc_mappings values((m->>(item->>'teamId'))::uuid,public.gc_key(item->>'season'),item->>'sourceKey',(m->>(item->>'pitcherId'))::uuid)
   on conflict(team_id,season_key,source_key) do update set pitcher_id=excluded.pitcher_id;
 end loop;
end
$$;

alter function public.manage(text,jsonb) rename to pw_manage_gc_core;
create function public.manage(action text,input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare tid uuid; sk text; p jsonb; prior public.operation_receipts; op uuid; expected integer;
begin
 if action not in ('importGameChanger','removeGameChanger') and not(action='restore' and input->'backup'->>'version'='4') then return public.pw_manage_gc_core(action,input); end if;
 perform pg_advisory_xact_lock(79112834);
 if not public.pw_writer() then raise exception 'Approved coach access required' using errcode='42501'; end if;
 op:=(input->>'operationId')::uuid;
 if op is null then raise exception 'Missing import operation ID'; end if;
 if action<>'restore' then
  tid:=(input->>'teamId')::uuid; sk:=public.gc_key(input->>'season');
  if not public.pw_edit_team(tid) or not exists(select 1 from public.teams where id=tid) then raise exception 'Team access denied' using errcode='42501'; end if;
 end if;
 select * into prior from public.operation_receipts where id=op;
 if prior.id is not null then
  if prior.coach_id<>auth.uid() or prior.request<>jsonb_build_object('hash',md5(jsonb_build_object('action',action,'input',input)::text)) then raise exception 'Operation ID already used for a different request'; end if;
  return '{}';
 end if;
 if action='restore' then perform public.gc_restore(input);
 else
  expected:=(input->>'expectedRevision')::integer;
  if expected is null or expected<0 then raise exception 'Missing expected revision'; end if;
  if action='removeGameChanger' then
   if input ? 'expectedSummaryId' and input->>'expectedSummaryId' is distinct from (select id::text from public.gc_summaries where team_id=tid and season_key=sk) then raise exception 'GameChanger summary changed. Refresh and review again.' using errcode='40001'; end if;
   if expected<>coalesce((select revision from public.gc_summaries where team_id=tid and season_key=sk),0) then raise exception 'GameChanger summary changed. Refresh and review again.' using errcode='40001'; end if;
   delete from public.gc_summaries where team_id=tid and season_key=sk;
  else
   if exists(select 1 from public.teams where id=tid and archived) then raise exception 'Reactivate this team before importing'; end if;
   if input->'coverageConfirmed' is distinct from 'true'::jsonb then raise exception 'Confirm the export coverage'; end if;
   perform public.gc_validate_content(input);
   if jsonb_typeof(input->'newPitchers') is distinct from 'array' then raise exception 'Invalid new pitcher list'; end if;
   for p in select value from jsonb_array_elements(input->'newPitchers') loop
    if not exists(select 1 from jsonb_array_elements(input->'players') row where row->>'pitcherId'=p->>'id') then raise exception 'New pitcher is not used in this import'; end if;
    if exists(select 1 from public.record_tombstones where kind='pitcher' and id=(p->>'id')::uuid) then raise exception 'Pitcher was permanently deleted'; end if;
    insert into public.pitchers(id,name,jersey,owner_id) values((p->>'id')::uuid,p->>'name',p->>'jersey',auth.uid());
    insert into public.team_pitchers values(tid,(p->>'id')::uuid,true);
   end loop;
   perform public.gc_save(input,tid,expected,auth.uid());
  end if;
 end if;
 insert into public.operation_receipts values(op,auth.uid(),1,jsonb_build_object('hash',md5(jsonb_build_object('action',action,'input',input)::text)));
 return '{}';
end
$$;

revoke execute on function public.gc_key(text),public.gc_validate_stats(jsonb,boolean),public.gc_validate_content(jsonb),public.gc_semantic(jsonb),public.gc_save(jsonb,uuid,integer,uuid),public.gc_restore(jsonb),public.pw_manage_gc_core(text,jsonb),public.pw_workspace_gc_core(),public.pw_removal_gc_core(text,uuid) from public,anon,authenticated;
revoke execute on function public.manage(text,jsonb),public.get_workspace(),public.removal_preview(text,uuid) from public,anon;
grant execute on function public.manage(text,jsonb),public.get_workspace(),public.removal_preview(text,uuid) to authenticated;
grant execute on function public.removal_preview(text,uuid),public.pw_removal_gc_core(text,uuid) to service_role;
