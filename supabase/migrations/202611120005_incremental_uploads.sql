-- Transport receipts contain hashes only. The authoritative practice receipt is
-- still produced by the existing fully validating upload function.
create table public.practice_delta_receipts (
 id uuid primary key references public.operation_receipts(id) on delete cascade,
 request_hash text not null
);
alter table public.practice_delta_receipts enable row level security;
revoke all on public.practice_delta_receipts from public,anon,authenticated;
grant all on public.practice_delta_receipts to service_role;

create function public.upload_practice_delta(delta jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare s jsonb:=delta->'session';sid uuid:=(s->>'id')::uuid;tid uuid:=(s->>'teamId')::uuid;
 actor uuid:=auth.uid();pid uuid;expected integer:=(delta->>'expectedRevision')::integer;
 opid uuid:=(delta->>'id')::uuid;prior public.practices;receipt public.operation_receipts;
 stored_hash text;source jsonb;change jsonb;seq integer;seen integer[]:='{}';operation jsonb;result integer;
begin
 if not public.pw_active() then raise exception 'Account cannot record practices' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(79112834);
 pid:=public.pw_player_pitcher();
 if pid is not null then perform pg_advisory_xact_lock(hashtextextended('activity:'||pid::text,0));end if;
 if not(public.pw_writer() or pid is not null) or (s->>'recorderId')::uuid is distinct from actor or not public.pw_practice(tid,actor) then raise exception 'Team access was removed' using errcode='42501';end if;
 if jsonb_typeof(delta->'appendEvents') is distinct from 'array' or jsonb_typeof(delta->'voidedEvents') is distinct from 'array'
 or jsonb_typeof(delta->'baseEventCount') is distinct from 'number' or expected is null or opid is null or sid is null then raise exception 'Invalid practice delta' using errcode='22023';end if;
 if pid is not null and (tid is not null or s->'pitcherIds' is distinct from jsonb_build_array(pid) or s->>'initialPitcherId' is distinct from pid::text or s->>'selectedPitcherId' is distinct from pid::text) then raise exception 'Players cannot record team or other-player practices' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(sid::text,0));
 -- These checks precede receipt acknowledgement just as in the full protocol.
 if exists(select 1 from public.record_tombstones where kind='session' and id=sid or kind='team' and id=tid or kind='pitcher' and s->'pitcherIds' ? id::text) then raise exception 'A practice or related record was permanently deleted. Export unsynced work for recovery.' using errcode='40001';end if;
 if exists(select 1 from public.teams where id=tid and archived) then raise exception 'This team is archived' using errcode='40001';end if;
 select * into prior from public.practices where id=sid for update;
 if found and (prior.recorder_id<>actor or prior.device_id is distinct from (s->>'deviceId')::uuid) then raise exception 'This practice belongs to another recorder' using errcode='42501';end if;
 if prior.archived then raise exception 'This practice is archived' using errcode='40001';end if;
 select r.* into receipt from public.operation_receipts r where r.id=opid;
 if found then
  select request_hash into stored_hash from public.practice_delta_receipts where id=opid;
  if receipt.coach_id<>actor or stored_hash is distinct from encode(sha256(convert_to(delta::text,'UTF8')),'hex') then raise exception 'Operation identifier already used' using errcode='40001';end if;
  return receipt.revision;
 end if;
 if expected<>coalesce(prior.revision,0) then raise exception 'Practice revision conflict; saved work retained on device' using errcode='40001';end if;
 source:=coalesce(prior.events,'[]');
 if (delta->>'baseEventCount')::integer<>jsonb_array_length(source) then raise exception 'Practice event base changed' using errcode='40001';end if;
 for change in select value from jsonb_array_elements(delta->'voidedEvents') loop
  seq:=(change->>'sequence')::integer;
  if jsonb_typeof(change) is distinct from 'object' or (change-array['sequence','voidedAt'])<>'{}'::jsonb or seq is null or seq<1 or seq>jsonb_array_length(source) or seq=any(seen) or jsonb_typeof(change->'voidedAt') is distinct from 'string' then raise exception 'Invalid undo delta' using errcode='22023';end if;
  seen:=array_append(seen,seq);
  source:=jsonb_set(source,array[(seq-1)::text,'voidedAt'],change->'voidedAt',false);
 end loop;
 source:=source||(delta->'appendEvents');
 operation:=(delta-'baseEventCount'-'appendEvents'-'voidedEvents')||jsonb_build_object('events',source);
 -- Recorder/device/team identity, immutable old events, undo rules, sequential
 -- append validation, player/drill scope, tombstones and receipts all run here.
 result:=public.upload_practice(operation);
 insert into public.practice_delta_receipts values(opid,encode(sha256(convert_to(delta::text,'UTF8')),'hex'));
 return result;
end $$;
revoke all on function public.upload_practice_delta(jsonb) from public,anon;
grant execute on function public.upload_practice_delta(jsonb) to authenticated;

-- Metadata-only saves should retain the existing out-of-line event value.
do $$ declare signature text;definition text;begin
 foreach signature in array array['public.pw_upload_practice_core(jsonb)','public.pw_upload_player_core(jsonb)','public.pw_player_upload_core(jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=replace(definition,'events=excluded.events','events=case when public.practices.events=excluded.events then public.practices.events else excluded.events end');
  execute definition;
 end loop;
end $$;
