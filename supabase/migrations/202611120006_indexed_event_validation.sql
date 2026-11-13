-- Retain a private reference for deterministic migration equivalence checks.
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.validate_practice(jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'public.validate_practice','public.pw_validate_practice_reference');
 execute definition;
end $$;
revoke all on function public.pw_validate_practice_reference(jsonb,jsonb) from public,anon,authenticated;

-- Growing text arrays and scanning them for every event made validation
-- quadratic. Check identifier uniqueness once, then use an indexed JSON object
-- to validate that each appearance was reserved by an EARLIER source event.
create or replace function public.validate_practice(s jsonb, source jsonb) returns void language plpgsql set search_path='' as $$
declare e jsonb;n integer:=0;balls integer:=0;strikes integer:=0;ends integer:=0;
 current_id text:=s->>'initialAppearanceId';current_pitcher text:=s->>'initialPitcherId';
 appearances jsonb;participants text[];v text;required_key text;event_count bigint;unique_ids bigint;unique_next bigint;collision boolean;
begin
 if jsonb_typeof(s)<>'object' or jsonb_typeof(source)<>'array' or jsonb_typeof(s->'pitcherIds')<>'array'
 or not(s ?& array['id','name','notes','startedAt','updatedAt','endedAt','status','initialPitcherId','initialAppearanceId','selectedPitcherId','pitcherIds','nextSequence','teamId','recorderId','deviceId','revision'])
 or jsonb_typeof(s->'name')<>'string' or jsonb_typeof(s->'notes')<>'string'
 or s->>'status' not in('active','paused','ended') or (s->>'revision')::integer<1 then raise exception 'Invalid practice' using errcode='22023';end if;
 foreach required_key in array array['id','status','initialPitcherId','initialAppearanceId','selectedPitcherId','startedAt','updatedAt','recorderId','deviceId'] loop
  if jsonb_typeof(s->required_key) is distinct from 'string' then raise exception 'Invalid practice field';end if;
 end loop;
 if jsonb_typeof(s->'revision') is distinct from 'number' or jsonb_typeof(s->'nextSequence') is distinct from 'number' then raise exception 'Invalid revision or sequence';end if;
 perform (s->>'id')::uuid,(s->>'recorderId')::uuid,(s->>'deviceId')::uuid,(s->>'startedAt')::timestamptz,(s->>'updatedAt')::timestamptz,current_id::uuid;
 select array_agg(x) into participants from jsonb_array_elements_text(s->'pitcherIds') x;
 if participants is null or cardinality(participants)<>(select count(distinct x) from unnest(participants) x)
 or not current_pitcher=any(participants) or not(s->>'selectedPitcherId')=any(participants) then raise exception 'Invalid participants';end if;
 foreach v in array participants loop perform v::uuid;end loop;
 select count(*),count(distinct value->>'id'),count(distinct value->>'nextAppearanceId'),
  bool_or(value->>'id'=current_id or value->>'nextAppearanceId'=current_id)
 into event_count,unique_ids,unique_next,collision from jsonb_array_elements(source);
 if event_count<>unique_ids or event_count<>unique_next or coalesce(collision,false) then raise exception 'Invalid event references or sequence';end if;
 select coalesce(jsonb_object_agg(value->>'nextAppearanceId',ordinality),'{}')||jsonb_build_object(current_id,0)
 into appearances from jsonb_array_elements(source) with ordinality;
 for e in select value from jsonb_array_elements(source) loop
  n:=n+1;
  foreach required_key in array array['id','sessionId','pitcherId','appearanceId','nextAppearanceId','timestamp','kind'] loop
   if jsonb_typeof(e->required_key) is distinct from 'string' then raise exception 'Invalid event field';end if;
  end loop;
  if jsonb_typeof(e->'sequence') is distinct from 'number' then raise exception 'Invalid event sequence';end if;
  if not(e ?& array['id','sessionId','pitcherId','appearanceId','nextAppearanceId','sequence','timestamp','kind','voidedAt'])
  or (e->>'sessionId') is distinct from (s->>'id') or (e->>'sequence')::integer<>n
  or not(e->>'pitcherId')=any(participants)
  or coalesce((appearances->>(e->>'appearanceId'))::bigint,9223372036854775807)>=n
  or e->>'kind' not in('pitch','next','reset','switch','end') then raise exception 'Invalid event references or sequence';end if;
  perform (e->>'id')::uuid,(e->>'appearanceId')::uuid,(e->>'nextAppearanceId')::uuid,(e->>'timestamp')::timestamptz;
  if e->>'kind'='pitch' then
   if e->>'pitchType' is null or e->>'pitchType' not in('ball','called','swinging','foul','inPlay')
   or (e ? 'pitchLocation' and (e->>'pitchLocation' is null or e->>'pitchLocation' not in('upIn','upOut','downIn','downOut','middle'))) then raise exception 'Invalid pitch';end if;
   if e->>'voidedAt' is not null then perform (e->>'voidedAt')::timestamptz;continue;end if;
  elsif e->>'voidedAt' is not null or e ? 'pitchType' or e ? 'pitchLocation' then raise exception 'Invalid boundary';end if;
  if ends>0 or (e->>'kind'<>'switch' and e->>'pitcherId'<>current_pitcher) then raise exception 'Invalid event order';end if;
  if e->>'kind'='pitch' then
   if e->>'appearanceId'<>current_id then raise exception 'Invalid batter';end if;
   if e->>'pitchType'='ball' then balls:=balls+1;
   elsif e->>'pitchType' in('called','swinging') or (e->>'pitchType'='foul' and strikes<2) then strikes:=strikes+1;end if;
   if balls=4 or strikes=3 or e->>'pitchType'='inPlay' then current_id:=e->>'nextAppearanceId';balls:=0;strikes:=0;end if;
  elsif e->>'kind'='end' then ends:=ends+1;
  else
   current_id:=e->>'nextAppearanceId';balls:=0;strikes:=0;
   if e->>'kind'='switch' then current_pitcher:=e->>'pitcherId';end if;
  end if;
 end loop;
 if (s->>'nextSequence')::integer<>n+1 or current_pitcher<>s->>'selectedPitcherId'
 or (s->>'status'='ended' and (ends<>1 or s->>'endedAt' is null or source->-1->>'kind'<>'end'))
 or (s->>'status'<>'ended' and (ends<>0 or s->>'endedAt' is not null)) then raise exception 'Practice status disagrees with events';end if;
end $$;
