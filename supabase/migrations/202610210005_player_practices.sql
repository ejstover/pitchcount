-- Players record only their own independent practices. Coaching predicates stay unchanged.
-- Reuse the existing complete event validation, append-only history, revision and receipt checks.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.pw_upload_practice_core(jsonb)'::regprocedure);
 definition:=replace(definition,'pw_upload_practice_core','pw_upload_player_core');
 definition:=replace(definition,'if not public.pw_writer() then','if public.pw_player_pitcher() is null then');
 execute definition;
end $$;
alter function public.upload_practice(jsonb) rename to pw_upload_before_players;
create function public.upload_practice(operation jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare pid uuid:=public.pw_player_pitcher(); s jsonb:=operation->'session';
begin
 if pid is null then return public.pw_upload_before_players(operation); end if;
 perform pg_advisory_xact_lock(79112834);
 if s->>'teamId' is not null or s->'pitcherIds' is distinct from jsonb_build_array(pid)
 or s->>'initialPitcherId' is distinct from pid::text or s->>'selectedPitcherId' is distinct from pid::text
 or exists(select 1 from jsonb_array_elements(operation->'events') as pitch(value) where pitch.value->>'pitcherId' is distinct from pid::text or pitch.value->>'kind'='switch') then
  raise exception 'Players cannot record team or other-player practices' using errcode='42501';
 end if;
 if exists(select 1 from public.record_tombstones where (kind='session' and id=(s->>'id')::uuid) or (kind='pitcher' and id=pid)) then
  raise exception 'Practice or player was deleted' using errcode='40001';
 end if;
 if exists(select 1 from public.practices where id=(s->>'id')::uuid and archived)
 or exists(select 1 from public.pitchers where id=pid and archived) then raise exception 'Practice or pitcher is archived' using errcode='40001'; end if;
 return public.pw_upload_player_core(operation);
end $$;
revoke all on function public.pw_upload_player_core(jsonb),public.pw_upload_before_players(jsonb) from public,anon,authenticated;
revoke all on function public.upload_practice(jsonb) from public,anon;
grant execute on function public.upload_practice(jsonb) to authenticated;
