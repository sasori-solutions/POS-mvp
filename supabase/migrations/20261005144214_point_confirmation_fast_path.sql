-- An authorized active checkout may wake the same leased queue used by cron.
-- These hints are private server metadata: they neither confirm money nor let
-- a browser select another tenant/attempt for privileged background work.
alter function app_private.point_command(uuid,uuid,jsonb) rename to point_command_before_fast_reconciliation;
create function app_private.point_command(p_business uuid,p_employee uuid,p jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare response jsonb; a app_private.point_attempts%rowtype;
begin
 response:=app_private.point_command_before_fast_reconciliation(p_business,p_employee,p);
 if not response ? 'error' and p->>'command' in ('start','status','cancel','simulate') then
  select pa.* into a from app_private.point_checkouts pc join app_private.point_attempts pa
   on pa.business_id=pc.business_id and pa.id=pc.active_attempt_id
   where pc.business_id=p_business and pc.id=(p->>'checkoutId')::uuid;
  if a.id is not null and a.sale_state<>'materialized' and a.state in ('pending','sent_to_terminal','processing','unknown_review') then
   response:=jsonb_set(response,'{data,backendWork}',jsonb_build_object('businessId',p_business,'attemptId',a.id));
  end if;
 end if;
 return response;
end $$;
revoke all on function app_private.point_command(uuid,uuid,jsonb),app_private.point_command_before_fast_reconciliation(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- Keep every existing claim condition (charges/settings, original identity,
-- replay clock, refund delivery) and narrow it only when both IDs are supplied.
-- Per-attempt claim serialization also protects distinct webhook/create jobs
-- from obtaining simultaneous provider leases for one payment.
do $patch$ declare definition text; needle text; begin
 select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) into definition;
 needle:=$old$  token:=(p->>'leaseToken')::uuid; if token is null then raise exception 'VALIDATION_ERROR'; end if;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected Point claim validation'; end if;
 definition:=replace(definition,needle,needle||$new$
  if (p ? 'attemptId') is distinct from (p ? 'businessId') or p ? 'attemptId' and ((p->>'attemptId')::uuid is null or (p->>'businessId')::uuid is null) then raise exception 'VALIDATION_ERROR'; end if;$new$);
 needle:=$old$and pj.attempts<12$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected Point claim selection'; end if;
 definition:=replace(definition,needle,needle||$new$
   and (not p ? 'attemptId' or pj.attempt_id=(p->>'attemptId')::uuid and pj.business_id=(p->>'businessId')::uuid)
   and not exists(select 1 from app_private.point_jobs busy where busy.attempt_id=pj.attempt_id and busy.status='leased' and busy.lease_until>clock_timestamp())$new$);
 needle:=$old$   update app_private.point_jobs set status='leased',lease_token=token$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected Point claim lease'; end if;
 definition:=replace(definition,needle,$new$   if j.attempt_id is not null then
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('point-worker:'||j.attempt_id::text,0)) then continue; end if;
    if exists(select 1 from app_private.point_jobs busy where busy.attempt_id=j.attempt_id and busy.status='leased' and busy.lease_until>clock_timestamp()) then continue; end if;
   end if;
$new$||needle);
 execute definition;
end $patch$;

alter function public.point_service(text,jsonb) rename to point_service_before_fast_reconciliation;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a app_private.point_attempts%rowtype; response jsonb; queued boolean:=false;
begin
 if p_action='reconcile_now' then
  if (p_payload->>'businessId')::uuid is null or (p_payload->>'attemptId')::uuid is null then raise exception 'VALIDATION_ERROR'; end if;
  -- Shared with claiming so a new wake cannot race a provider lease. This is
  -- intentionally non-blocking; a concurrent invocation or cron owns recovery.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('point-worker:'||(p_payload->>'attemptId')::uuid::text,0)) then return jsonb_build_object('queued',false); end if;
  select * into a from app_private.point_attempts where business_id=(p_payload->>'businessId')::uuid and id=(p_payload->>'attemptId')::uuid for update;
  if a.id is not null and a.sale_state<>'materialized' and a.state in ('pending','sent_to_terminal','processing','unknown_review')
   and a.remote_order_id is not null
   and (a.last_reconciled_at is null or a.last_reconciled_at<=clock_timestamp()-interval '3 seconds')
   and not exists(select 1 from app_private.point_jobs j where j.attempt_id=a.id and j.status in ('queued','leased')) then
   insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key)
    values(a.business_id,a.connection_id,a.id,'reconcile_order','active-read:'||a.id::text||':'||floor(extract(epoch from clock_timestamp())/3)::text)
    on conflict(dedupe_key) do nothing;
   queued:=found;
  end if;
  return jsonb_build_object('queued',queued);
 end if;
 response:=public.point_service_before_fast_reconciliation(p_action,p_payload);
 if p_action='webhook_enqueue' and response->'matched'='true'::jsonb then
  select * into a from app_private.point_attempts where remote_order_id=p_payload->>'remoteOrderId';
  if a.id is not null then response:=response||jsonb_build_object('businessId',a.business_id,'attemptId',a.id); end if;
 end if;
 return response;
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_fast_reconciliation(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_fast_reconciliation(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;
