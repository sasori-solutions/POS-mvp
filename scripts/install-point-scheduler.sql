-- Run only after deploying point-worker and storing the two server-only Vault
-- secrets. This does not activate new collections for any merchant.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$
declare worker_url text; worker_secret text;
begin
  select decrypted_secret into worker_url from vault.decrypted_secrets where name='sasori_point_worker_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name='sasori_point_worker_secret';
  if worker_url is null or worker_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/point-worker$'
    or worker_secret is null or length(worker_secret)<32 then
    raise exception 'Store the exact deployed worker URL and a random worker secret in Vault before scheduling';
  end if;
end $$;
select cron.schedule('sasori-point-reconcile','* * * * *',$job$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='sasori_point_worker_url'),
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='sasori_point_worker_secret')),
    body:='{"limit":20}'::jsonb,
    timeout_milliseconds:=50000
  );
$job$);
commit;
-- Monitor cron.job_run_details AND net._http_response: scheduling success alone
-- does not establish successful HTTP processing. Queue leases survive a dead run.
