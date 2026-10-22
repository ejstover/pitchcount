select
 (select count(*) from public.achievement_jobs) as players_queued,
 (select count(*) from public.achievement_jobs where processed_revision<revision) as pending,
 (select count(*) from public.achievement_jobs where last_error is not null) as errors,
 (select count(*) from public.achievement_awards where data->>'status'='qualified') as confirmed_awards,
 (select count(*) from cron.job where jobname='pitchwork-achievements' and active) as active_schedules,
 has_function_privilege('anon','public.achievement_input(uuid)','execute') as anonymous_source_access,
 has_table_privilege('anon','public.achievement_records','select') as anonymous_activity_access,
 (select jsonb_agg(r) from (select id,status_code,timed_out,error_msg from net._http_response order by created desc limit 3) r) as worker_responses;
