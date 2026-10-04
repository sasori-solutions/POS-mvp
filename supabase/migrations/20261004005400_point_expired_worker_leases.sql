-- A worker can die after its final claim without calling fail_job. Close that
-- expired lease durably so it cannot suppress reconciliation forever. This does
-- not release a terminal or change any payment/refund fact.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('public.point_service(text,jsonb)'::regprocedure) into d;
 needle:=$old$ if p_action='record_remote_refund' then$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point recovery wrapper'; end if;
 execute replace(d,needle,$new$ if p_action='pending_sweep' then
  with expired as (
   update app_private.point_jobs set status='failed',last_error='POINT_LEASE_EXHAUSTED',lease_token=null,lease_until=null,updated_at=clock_timestamp()
   where status='leased' and lease_until<=clock_timestamp() and attempts>=12
   returning id,business_id,attempt_id
  ) insert into app_private.point_incidents(business_id,attempt_id,code,evidence)
   select business_id,attempt_id,'retries_exhausted',jsonb_build_object('jobId',id,'code','POINT_LEASE_EXHAUSTED') from expired;
 end if;
$new$||needle);
end $patch$;
