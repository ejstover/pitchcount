-- Read-only launch diagnostics. Run as a staging/production operator.
-- Outputs operational counts and table names, never practice content or secrets.
select now()-next_evaluate_at as oldest_due_age,next_evaluate_at
from public.achievement_jobs where next_evaluate_at<=now()
order by next_evaluate_at limit 1;

select count(*) as leased_jobs,
 count(*) filter(where leased_until<now()) as expired_leases
from public.achievement_jobs where leased_until is not null;

select mode,granted,count(*) as connections
from pg_locks where locktype='advisory' and classid=0 and objid=79112834 and objsubid=1
group by mode,granted order by mode,granted;

select state,wait_event_type,count(*) as connections
from pg_stat_activity where datname=current_database()
group by state,wait_event_type order by count(*) desc;

select relname,n_live_tup,n_dead_tup,last_autovacuum,last_autoanalyze,
 pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_stat_user_tables where schemaname='public'
order by pg_total_relation_size(relid) desc;
