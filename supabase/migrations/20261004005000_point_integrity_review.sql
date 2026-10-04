-- Forward-only review corrections. Accepted receipts and aborted reservations
-- retain their original identities; provider evidence never relies on an operator assertion.
alter table app_private.point_refund_requests add column first_sent_at timestamptz;
create unique index point_refund_request_remote on app_private.point_refund_requests(attempt_id,remote_refund_id) where remote_refund_id is not null;

-- Claim and completion share the same private operation mutex as cash/order commands.
-- Refund delivery keeps a separate clock from the original payment delivery.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('app_private.point_command(uuid,uuid,jsonb)'::regprocedure) into d;
 needle:=$old$ if p ? 'checkoutId' then$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point command version'; end if;
 d:=replace(d,needle,$new$ perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business::text,0));
 if p ? 'checkoutId' then$new$);
 d:=replace(d,$old$if q.status not in ('prepared','aborted') or q.sale_id is not null then raise exception 'POINT_STATE_INVALID'; end if;$old$,
 $new$if q.status<>'prepared' or q.sale_id is not null then raise exception 'POINT_STATE_INVALID'; end if;
  perform 1 from app_private.cash_shifts where business_id=p_business and id=q.shift_id and status='open' for update;
  if not found then raise exception 'SHIFT_NOT_OPEN'; end if;
  perform app_private.ops_assert_payment_quote(q);$new$);
 needle:=$old$  select coalesce(sum(r.amount_cents),0) into used from app_private.point_refund_requests r where r.attempt_id=a.id and r.status in ('pending','unknown_review');$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point refund version'; end if;
 d:=replace(d,needle,$new$  if exists(select 1 from app_private.point_refund_requests r where r.attempt_id=a.id and r.status in ('pending','unknown_review')) then raise exception 'POINT_RESULT_UNCERTAIN'; end if;
$new$||needle);
 execute d;

 select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) into d;
 needle:=$old$  select * into c from app_private.point_checkouts where business_id=a.business_id and id=a.checkout_id for update;$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point apply version'; end if;
 d:=replace(d,needle,$new$  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||a.business_id::text,0));
$new$||needle);
 -- A confirmed external refund of the same amount is not proof of this request.
 d:=replace(d,$old$(remote_refund_id=x->>'id' or remote_refund_id is null and amount_cents=amount)$old$,$new$remote_refund_id=x->>'id'$new$);
 -- Repeated definitive provider events do not rewrite an immutable aborted checkout.
 d:=replace(d,$old$where business_id=a.business_id and id=c.checkout_attempt_id; end if;$old$,
 $new$where business_id=a.business_id and id=c.checkout_attempt_id and status in ('prepared','collection_started','uncertain'); end if;$new$);
 d:=replace(d,$old$and status<>'completed'; end if;$old$,$new$and status in ('prepared','collection_started','uncertain'); end if;$new$);
 d:=replace(d,$old$set status='unknown_review' where id=j.refund_id;$old$,$new$set status='unknown_review' where id=j.refund_id and status in ('pending','unknown_review');$new$);
 -- Jobs whose business was disabled before first dispatch remain queued.
 d:=replace(d,$old$and (pj.kind<>'create_order' or coalesce((p->>'chargesEnabled')::boolean,true) or exists(select 1 from app_private.point_attempts pa where pa.id=pj.attempt_id and pa.first_sent_at is not null))$old$,
 $new$and (pj.kind<>'create_order' or (coalesce((p->>'chargesEnabled')::boolean,false) and exists(select 1 from app_private.point_settings ps where ps.business_id=pj.business_id and ps.enabled) and exists(select 1 from app_private.point_connections pc where pc.business_id=pj.business_id and pc.id=pj.connection_id and pc.status='connected')) or exists(select 1 from app_private.point_attempts pa where pa.id=pj.attempt_id and pa.first_sent_at is not null))$new$);
 needle:=$old$   jobs:=jobs||jsonb_build_array($old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point job version'; end if;
 d:=replace(d,needle,$new$   if j.refund_id is not null then
    update app_private.point_refund_requests set first_sent_at=coalesce(first_sent_at,clock_timestamp()) where id=j.refund_id returning * into r;
    result:=result||jsonb_build_object('refundRequest',jsonb_build_object('id',r.id,'operationId',r.operation_id,'status',r.status,'amountCents',r.amount_cents,'firstSentAt',r.first_sent_at,'remoteRefundId',r.remote_refund_id));
   end if;
$new$||needle);
 execute d;
end $patch$;

-- Persist the refund locator before subsequent GET/materialization can fail.
alter function public.point_service(text,jsonb) rename to point_service_before_integrity;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j app_private.point_jobs%rowtype; r app_private.point_refund_requests%rowtype; remote text:=p_payload->>'remoteRefundId';
begin
 if p_action='record_remote_refund' then
  select * into j from app_private.point_jobs where id=(p_payload->>'jobId')::uuid for update;
  if not found or j.kind<>'refund_order' or j.status<>'leased' or j.lease_token is distinct from (p_payload->>'leaseToken')::uuid
   or j.lease_until<=clock_timestamp() or j.refund_id is distinct from (p_payload->>'refundId')::uuid then raise exception 'POINT_LEASE_LOST'; end if;
  if remote is null or length(remote) not between 1 and 128 then raise exception 'VALIDATION_ERROR'; end if;
  select * into r from app_private.point_refund_requests where business_id=j.business_id and id=j.refund_id for update;
  if r.remote_refund_id is not null and r.remote_refund_id<>remote then raise exception 'POINT_FACT_MISMATCH'; end if;
  update app_private.point_refund_requests set remote_refund_id=remote where id=r.id;
  -- An early webhook can have persisted this refund before the POST locator.
  if exists(select 1 from app_private.point_refunds where attempt_id=r.attempt_id and remote_refund_id=remote and amount_cents=r.amount_cents) then
   update app_private.point_refund_requests set status='confirmed' where id=r.id;
  end if;
  return jsonb_build_object('saved',true);
 end if;
 return public.point_service_before_integrity(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_integrity(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_integrity(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;

-- Recovery presents persisted request identity, never guesses from an amount.
alter function app_private.point_checkout_json(app_private.point_checkouts) rename to point_checkout_json_before_integrity;
create function app_private.point_checkout_json(c app_private.point_checkouts) returns jsonb
language sql stable set search_path='' as $$
 select app_private.point_checkout_json_before_integrity(c)
 || case when c.active_attempt_id is null and q.status='aborted' then jsonb_build_object('state','cancelled') else '{}'::jsonb end
 || jsonb_build_object('updatedAt',greatest(c.updated_at,q.resolved_at,(select a.updated_at from app_private.point_attempts a where a.business_id=c.business_id and a.id=c.active_attempt_id)),'refundRequests',coalesce((select jsonb_agg(jsonb_build_object(
  'id',r.id,'operationId',r.operation_id,'status',r.status,'amountCents',r.amount_cents,'merchandiseCents',r.merchandise_cents,
  'tipCents',r.tip_cents,'reason',r.reason,'remoteRefundId',r.remote_refund_id,'firstSentAt',r.first_sent_at) order by r.created_at,r.id)
  from app_private.point_refund_requests r where r.business_id=c.business_id and r.attempt_id=c.active_attempt_id),'[]'::jsonb))
 from app_private.checkout_attempts q where q.business_id=c.business_id and q.id=c.checkout_attempt_id;
$$;
revoke all on function app_private.point_checkout_json(app_private.point_checkouts),app_private.point_checkout_json_before_integrity(app_private.point_checkouts) from public,anon,authenticated;

-- Materialize only the still-reserved exact snapshot. The deferred receipt graph
-- additionally checks all quantities, discounts, IVA and immutable source linkage.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure) into d;
 needle:=$old$ if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point materialization version'; end if;
 d:=replace(d,needle,needle||$new$
 if q.status not in ('collection_started','uncertain') or q.payment_method<>'card_integrated' or c.active_attempt_id<>a.id or q.total_cents<>a.amount_cents then raise exception 'POINT_STATE_INVALID'; end if;
 perform app_private.ops_assert_payment_quote(q);$new$);
 execute d;
end $patch$;

-- Include verified provider returns in the owner's ordinary financial totals.
-- An amount-only return cannot establish returned units or an item-specific tax
-- allocation, so those gaps are exposed explicitly instead of inventing them.
alter function app_private.ops_report_window(uuid,timestamptz,timestamptz) rename to ops_report_window_before_point;
create function app_private.ops_report_window(p_business uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare report jsonb; refunds bigint; integrated bigint; operators jsonb;
begin
 report:=app_private.ops_report_window_before_point(p_business,p_start,p_end);
 select coalesce(sum(r.amount_cents),0) into refunds from app_private.point_refunds r
  where r.business_id=p_business and r.confirmed_at>=p_start and r.confirmed_at<p_end;
 select coalesce(sum(total_cents),0) into integrated from app_private.sales
  where business_id=p_business and payment_method='card_integrated' and created_at>=p_start and created_at<p_end;
 with values_by_operator as (
  select e->>'name' name,(e->>'salesCents')::bigint sales,(e->>'reversalCents')::bigint reversed from jsonb_array_elements(report->'operators') e
  union all
  select q.operator_name,0::bigint,sum(r.amount_cents)::bigint from app_private.point_refunds r
   join app_private.point_attempts a on a.business_id=r.business_id and a.id=r.attempt_id
   join app_private.point_checkouts c on c.business_id=a.business_id and c.id=a.checkout_id
   join app_private.checkout_attempts q on q.business_id=c.business_id and q.id=c.checkout_attempt_id
   where r.business_id=p_business and r.confirmed_at>=p_start and r.confirmed_at<p_end group by q.operator_name
 ), grouped as (select name,sum(sales) sales,sum(reversed) reversed from values_by_operator group by name)
 select coalesce(jsonb_agg(jsonb_build_object('name',name,'salesCents',sales,'reversalCents',reversed,'netCents',sales-reversed) order by name),'[]'::jsonb) into operators from grouped;
 return report||jsonb_build_object('reversalCents',(report->>'reversalCents')::bigint+refunds,'netCents',(report->>'netCents')::bigint-refunds,
  'unallocatedRefundCents',refunds,'unknownReversalTaxCents',refunds,'operators',operators,
  'payments',(report->'payments')||jsonb_build_array(jsonb_build_object('paymentMethod','card_integrated','salesCents',integrated,'reversalCents',refunds,'netCents',integrated-refunds)));
end $$;
create or replace function app_private.ops_report(p_business uuid,p_day date) returns jsonb
language plpgsql stable set search_path='' as $$
declare zone text;
begin
 select timezone into zone from app_private.businesses where id=p_business;
 return app_private.ops_report_window(p_business,p_day::timestamp at time zone zone,(p_day+1)::timestamp at time zone zone);
end $$;
create view app_private.ops_reporting_reversals as
 select business_id,amount_cents,created_at from app_private.sale_reversals
 union all select business_id,amount_cents,confirmed_at from app_private.point_refunds;
revoke all on app_private.ops_reporting_reversals from public,anon,authenticated;
do $patch$ declare d text; needle text:='join app_private.sale_reversals r'; begin
 select pg_get_functiondef('app_private.ops_report_series(uuid,date,date,text,text,timestamptz)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected financial series version'; end if;
 execute replace(d,needle,'join app_private.ops_reporting_reversals r');
end $patch$;
revoke all on function app_private.ops_report_window(uuid,timestamptz,timestamptz),app_private.ops_report_window_before_point(uuid,timestamptz,timestamptz) from public,anon,authenticated;

-- Extend immutable financial history to provider identities and commission
-- statements. Lifecycle status/locators can advance; accepted money cannot.
create function app_private.point_guard_history() returns trigger language plpgsql set search_path='' as $$
declare old_row jsonb:=to_jsonb(old); new_row jsonb; mutable text[];
begin
 if tg_op='DELETE' then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 new_row:=to_jsonb(new);
 mutable:=case tg_table_name
  when 'point_attempts' then array['state','sale_state','remote_order_id','payment_id','status_detail','cancel_capability','refunded_cents','verified_at','observed_at','first_sent_at','updated_at','last_reconciled_at']
  when 'point_checkouts' then array['active_attempt_id','updated_at']
  when 'point_refund_requests' then array['status','remote_refund_id','first_sent_at']
  when 'point_statements' then array['status','evidence']
  else '{}'::text[] end;
 if old_row-mutable is distinct from new_row-mutable then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 if tg_table_name='point_attempts' then
  if old.remote_order_id is not null and new.remote_order_id is distinct from old.remote_order_id
   or old.payment_id is not null and new.payment_id is distinct from old.payment_id
   or old.first_sent_at is not null and new.first_sent_at is distinct from old.first_sent_at
   or old.verified_at is not null and new.verified_at is distinct from old.verified_at
   or new.refunded_cents<old.refunded_cents
   or old.sale_state='materialized' and new.sale_state<>'materialized' then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 elsif tg_table_name='point_checkouts' then
  if old.active_attempt_id is not null and new.active_attempt_id is distinct from old.active_attempt_id then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 elsif tg_table_name='point_refund_requests' then
  if old.remote_refund_id is not null and new.remote_refund_id is distinct from old.remote_refund_id
   or old.first_sent_at is not null and new.first_sent_at is distinct from old.first_sent_at
   or old.status='confirmed' and new.status<>'confirmed' then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 elsif tg_table_name='point_statements' then
  if old.status='invoiced' and new.status<>'invoiced' then raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['point_attempts','point_checkouts','point_refund_requests','point_statements','point_statement_lines','point_operations'] loop
  execute format('create trigger point_history_immutable before update or delete on app_private.%I for each row execute function app_private.point_guard_history()',t);
 end loop;
end $$;
revoke all on function app_private.point_guard_history() from public,anon,authenticated;

-- Stable authorized actor scope for local durable commission-payment commands.
do $patch$ declare d text; needle text:='jsonb_build_object(''enabled'''; begin
 select pg_get_functiondef('app_private.point_settings_json(uuid,uuid)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected Point settings version'; end if;
 execute replace(d,needle,'jsonb_build_object(''actorId'',p_employee,''enabled''');
end $patch$;

-- A 401 from an old in-flight token cannot revoke a newer OAuth connection.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) into d;
 needle:=$old$elsif p_action='connection_revoke' then update app_private.point_connections$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point connection version'; end if;
 d:=replace(d,needle,$new$elsif p_action='connection_revoke' then
   if p->>'expectedTokenVersion' is null then raise exception 'VALIDATION_ERROR'; end if;
   if con.token_version<>(p->>'expectedTokenVersion')::integer then return jsonb_build_object('revoked',false); end if;
   update app_private.point_connections$new$);
 d:=replace(d,$old$'verifiedAt',con.verified_at)$old$,$new$'verifiedAt',con.verified_at,'tokenVersion',con.token_version)$new$);
 execute d;
end $patch$;
