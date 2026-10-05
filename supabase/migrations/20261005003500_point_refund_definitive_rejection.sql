-- A documented refusal of the first partial refund does not reserve money
-- forever. Only a current worker lease plus a verified, unchanged order may
-- reject the request. No financial ledger, receipt or sale is changed here.
alter function public.point_service(text,jsonb) rename to point_service_before_refund_decline;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j app_private.point_jobs%rowtype; a app_private.point_attempts%rowtype; r app_private.point_refund_requests%rowtype;
begin
 if p_action='refund_declined' then
  select * into j from app_private.point_jobs where id=(p_payload->>'jobId')::uuid for update;
  if not found or j.kind<>'refund_order' or j.status<>'leased'
   or j.lease_token is distinct from (p_payload->>'leaseToken')::uuid or j.lease_until<=clock_timestamp()
   or j.refund_id is distinct from (p_payload->>'refundId')::uuid then raise exception 'POINT_LEASE_LOST'; end if;
  select * into a from app_private.point_attempts where business_id=j.business_id and id=j.attempt_id for update;
  select * into r from app_private.point_refund_requests where business_id=j.business_id and id=j.refund_id for update;
  if not found or r.attempt_id is distinct from a.id or a.connection_id is distinct from j.connection_id
   or r.status not in ('pending','unknown_review') or r.remote_refund_id is not null or r.first_sent_at is null
   or a.state<>'approved_verified' or a.sale_state<>'materialized' or a.verified_at is null or a.refunded_cents<>0
   or a.remote_order_id is null or a.payment_id is null or a.observed_at is null
   or r.amount_cents>=a.amount_cents
   or (j.payload->>'refundAmountCents')::bigint is distinct from r.amount_cents
   or (j.payload->>'idempotencyKey')::uuid is distinct from r.idempotency_key
   or (p_payload->>'refundAmountCents')::bigint is distinct from r.amount_cents
   or (p_payload->>'idempotencyKey')::uuid is distinct from r.idempotency_key
   or p_payload->>'code' is distinct from 'unsupported_partially_refunds'
   or p_payload->>'state' is distinct from 'approved' or p_payload->'verified' is distinct from 'true'::jsonb
   or p_payload->'refunds' is distinct from '[]'::jsonb
   or p_payload->>'remoteOrderId' is distinct from a.remote_order_id
   or p_payload->>'paymentId' is distinct from a.payment_id
   or (p_payload->>'amountCents')::bigint is distinct from a.amount_cents
   or p_payload->>'currency' is distinct from a.currency or p_payload->>'receiverId' is distinct from a.receiver_id
   or p_payload->>'environment' is distinct from a.environment or p_payload->>'externalReference' is distinct from a.external_reference
   or p_payload->>'observedAt' is null or (p_payload->>'observedAt')::timestamptz<a.observed_at
   or exists(select 1 from app_private.point_refunds where business_id=a.business_id and attempt_id=a.id)
   then raise exception 'POINT_FACT_MISMATCH'; end if;
  update app_private.point_refund_requests set status='rejected' where id=r.id;
  update app_private.point_attempts set updated_at=clock_timestamp() where id=a.id;
  update app_private.point_jobs set status='done',last_error='unsupported_partially_refunds',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
  return jsonb_build_object('saved',true);
 end if;
 return public.point_service_before_refund_decline(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_refund_decline(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_refund_decline(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;
