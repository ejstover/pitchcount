alter table public.account_provisions add column username text unique;
create function public.prepare_username_player(p_actor uuid,p_pitcher uuid,p_username text) returns jsonb language plpgsql set search_path='' as $$
declare provision public.account_provisions;actor public.coaches;label text;
begin
 perform pg_advisory_xact_lock(79112834);
 select * into actor from public.coaches where id=p_actor and active and role in ('admin','coach');
 if not found or not exists(select 1 from public.pitchers where id=p_pitcher and not archived and (owner_id=p_actor or actor.role='admin')) then raise exception 'Only the player owner or admin can provision this player' using errcode='42501';end if;
 if p_username !~ '^[a-z0-9][a-z0-9_.-]{2,23}$' then raise exception 'Use 3–24 lowercase letters, numbers, dots, underscores or hyphens';end if;
 select name into label from public.pitchers where id=p_pitcher;
 select * into provision from public.account_provisions where username=p_username;
 if found then
  if provision.pitcher_id<>p_pitcher then raise exception 'Username unavailable';end if;
 else
  select ap.* into provision from public.account_provisions ap join public.player_accounts pa on pa.account_id=ap.id where pa.pitcher_id=p_pitcher;
  if found then update public.account_provisions set username=p_username where id=provision.id returning * into provision;
  else insert into public.account_provisions(email,name,role,pitcher_id,username) values(gen_random_uuid()::text||'@players.pitchwork.invalid',label,'player',p_pitcher,p_username) returning * into provision;end if;
 end if;
 return jsonb_build_object('id',provision.id,'email',provision.email,'username',provision.username);
end $$;
revoke all on function public.prepare_username_player(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_username_player(uuid,uuid,text) to service_role;
