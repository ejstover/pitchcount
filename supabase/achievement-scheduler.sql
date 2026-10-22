-- Run once after deploying the achievements function. Store secrets through the
-- Supabase Vault UI: achievement_worker_secret and achievement_worker_url.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname='pitchwork-achievements';
select cron.schedule('pitchwork-achievements','*/15 * * * *',$job$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_url'),
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_secret')),
  body:='{}'::jsonb,
  timeout_milliseconds:=120000
 );
$job$);
