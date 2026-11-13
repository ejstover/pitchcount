-- Run once after deploying the achievements function. Store secrets through the
-- Supabase Vault UI: achievement_worker_secret and achievement_worker_url.
-- Optional achievement_worker_parallelism (integer 1–64, default 16) controls
-- bounded worker fan-out. Tune against queue age and measured database load.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname='pitchwork-achievements';
select cron.schedule('pitchwork-achievements','* * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_url'),
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_secret')),
  body:='{}'::jsonb,
  timeout_milliseconds:=120000
 ) from generate_series(1,least(64,greatest(1,coalesce(
  (select decrypted_secret::integer from vault.decrypted_secrets where name='achievement_worker_parallelism'),16))));
$job$);
