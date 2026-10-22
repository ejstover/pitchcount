-- Idempotently retry dirty evaluation work; never changes practice/activity evidence.
update public.achievement_jobs set next_evaluate_at=now() where processed_revision<revision;
select net.http_post(
 url:=(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_url'),
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='achievement_worker_secret')),
 body:='{}'::jsonb,timeout_milliseconds:=120000
) as backfill_request;
