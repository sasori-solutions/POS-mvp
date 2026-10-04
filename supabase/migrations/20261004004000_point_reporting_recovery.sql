-- Authenticated notifications are durable even when the create response has not arrived yet.
create table app_private.point_event_inbox (
 event_key text primary key check(event_key ~ '^[0-9a-f]{64}$'), remote_order_id text not null check(char_length(remote_order_id) between 1 and 128),
 signature_timestamp text not null check(signature_timestamp ~ '^[0-9]{1,20}$'), business_id uuid, attempt_id uuid,
 received_at timestamptz not null default clock_timestamp(), last_received_at timestamptz not null default clock_timestamp(),
 duplicate_count integer not null default 0, processed_at timestamptz,
 foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id)
);
create index point_unmatched_events on app_private.point_event_inbox(remote_order_id) where attempt_id is null;
create table app_private.point_webhook_counters (
 day date primary key, invalid_signatures bigint not null default 0 check(invalid_signatures>=0)
);
alter table app_private.point_event_inbox enable row level security;
alter table app_private.point_webhook_counters enable row level security;
revoke all on app_private.point_event_inbox,app_private.point_webhook_counters from public,anon,authenticated;
create index point_report_attempts on app_private.point_attempts(business_id,environment,verified_at) where sale_state='materialized';
create index point_report_refunds on app_private.point_refunds(business_id,confirmed_at);
create index point_report_inbox on app_private.point_event_inbox(received_at,business_id);
alter table app_private.point_attempts add column last_reconciled_at timestamptz;

alter function public.point_service(text,jsonb) rename to point_service_before_inbox;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a app_private.point_attempts%rowtype; event app_private.point_event_inbox%rowtype; job app_private.point_jobs%rowtype; response jsonb;
begin
 if p_action='webhook_invalid_signature' then
  insert into app_private.point_webhook_counters(day,invalid_signatures) values((clock_timestamp() at time zone 'UTC')::date,1)
   on conflict(day) do update set invalid_signatures=point_webhook_counters.invalid_signatures+1;
  return jsonb_build_object('recorded',true);
 elsif p_action='webhook_enqueue' then
  insert into app_private.point_event_inbox(event_key,remote_order_id,signature_timestamp)
   values(p_payload->>'eventKey',p_payload->>'remoteOrderId',p_payload->>'signatureTimestamp')
   on conflict(event_key) do update set duplicate_count=point_event_inbox.duplicate_count+1,last_received_at=clock_timestamp()
   returning * into event;
  select * into a from app_private.point_attempts where remote_order_id=event.remote_order_id;
  if found then
   update app_private.point_event_inbox set business_id=a.business_id,attempt_id=a.id where event_key=event.event_key;
   insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key,payload)
    values(a.business_id,a.connection_id,a.id,'webhook','event:'||event.event_key,jsonb_build_object('remoteOrderId',a.remote_order_id)) on conflict(dedupe_key) do nothing;
  end if;
  return jsonb_build_object('accepted',true,'matched',a.id is not null);
 elsif p_action='pending_sweep' then
  for event in select e.* from app_private.point_event_inbox e where e.attempt_id is null and exists(select 1 from app_private.point_attempts pa where pa.remote_order_id=e.remote_order_id)
   order by e.received_at,e.event_key limit 100 for update skip locked loop
   select * into a from app_private.point_attempts where remote_order_id=event.remote_order_id;
   update app_private.point_event_inbox set business_id=a.business_id,attempt_id=a.id where event_key=event.event_key;
   insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key,payload)
    values(a.business_id,a.connection_id,a.id,'webhook','event:'||event.event_key,jsonb_build_object('remoteOrderId',a.remote_order_id)) on conflict(dedupe_key) do nothing;
  end loop;
 elsif p_action='apply_order' then
  response:=public.point_service_before_inbox(p_action,p_payload);
  if response->'applied'='true'::jsonb then update app_private.point_attempts set last_reconciled_at=clock_timestamp() where id=(p_payload->>'attemptId')::uuid; end if;
  return response;
 elsif p_action='complete_job' then
  select * into job from app_private.point_jobs where id=(p_payload->>'id')::uuid;
  response:=public.point_service_before_inbox(p_action,p_payload);
  if job.kind='webhook' then update app_private.point_event_inbox set processed_at=coalesce(processed_at,clock_timestamp()) where event_key=substring(job.dedupe_key from 7); end if;
  return response;
 end if;
 return public.point_service_before_inbox(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_inbox(text,jsonb) from public,anon,authenticated;
grant execute on function public.point_service(text,jsonb) to service_role;
-- The previous implementation is only reachable by the definer wrapper.
revoke all on function public.point_service_before_inbox(text,jsonb) from service_role;

alter function app_private.point_report(uuid,date,date,text) rename to point_report_before_metrics;
create function app_private.point_report(p_business uuid,p_from date,p_to date,p_cursor text default null) returns jsonb language plpgsql stable set search_path='' as $$
declare report jsonb; zone text; start_at timestamptz; end_at timestamptz; finance jsonb; attempts jsonb; health jsonb; cohorts jsonb;
begin
 report:=app_private.point_report_before_metrics(p_business,p_from,p_to,p_cursor);
 report:=jsonb_set(report,'{lastReconciledAt}',coalesce((select to_jsonb(max(pa.last_reconciled_at)) from app_private.point_attempts pa where p_business is null or pa.business_id=p_business),'null'::jsonb));
 zone:=report->>'timezone'; start_at:=p_from::timestamp at time zone zone; end_at:=(p_to+1)::timestamp at time zone zone;
 with fees as (
  select l.* from app_private.point_fee_ledger l where (p_business is null or l.business_id=p_business) and l.occurred_at>=start_at and l.occurred_at<end_at
 ), periods as (
  select s.*,coalesce((select sum(cp.amount_cents) from app_private.point_commission_payments cp where cp.statement_id=s.id),0) collected
  from app_private.point_statements s where (p_business is null or s.business_id=p_business) and s.period>=date_trunc('month',p_from)::date and s.period<=date_trunc('month',p_to)::date
 ) select jsonb_build_object(
  'accruedExactNumerator',coalesce((select sum(f.exact_numerator) from fees f where f.kind='charge'),0)::text,
  'adjustmentExactNumerator',coalesce((select sum(f.exact_numerator) from fees f where f.kind='refund'),0)::text,
  'eligibleBaseCents',coalesce((select sum(f.base_cents) from fees f),0),
  'effectiveRate',case when (select sum(f.base_cents) from fees f)>0 then (select sum(f.exact_numerator)/10000/sum(f.base_cents) from fees f) else null end,
  'averageNetPerActiveBusinessCents',case when (select count(distinct pa.business_id) from app_private.point_attempts pa where pa.environment='live' and pa.sale_state='materialized' and (p_business is null or pa.business_id=p_business) and pa.verified_at>=start_at and pa.verified_at<end_at)>0 then
   round((report->>'commissionNetCents')::numeric/(select count(distinct pa.business_id) from app_private.point_attempts pa where pa.environment='live' and pa.sale_state='materialized' and (p_business is null or pa.business_id=p_business) and pa.verified_at>=start_at and pa.verified_at<end_at)) else null end,
  'closedNetCents',coalesce((select sum(s.net_cents) from periods s),0),'invoicedNetCents',coalesce((select sum(s.net_cents) from periods s where s.status='invoiced'),0),
  'invoicedVatCents',coalesce((select sum(s.vat_cents) from periods s where s.status='invoiced'),0),
  'collectedForPeriodsCents',coalesce((select sum(s.collected) from periods s where s.status='invoiced'),0),
  'remainingCents',coalesce((select sum(s.total_cents-s.collected) from periods s where s.status='invoiced'),0),
  'collectedCents',coalesce((select sum(cp.amount_cents) from app_private.point_commission_payments cp where (p_business is null or cp.business_id=p_business) and cp.paid_at>=start_at and cp.paid_at<end_at),0)
 ) into finance;
 with population as(select pa.* from app_private.point_attempts pa where (p_business is null or pa.business_id=p_business) and pa.environment='live' and pa.created_at>=start_at and pa.created_at<end_at)
 select jsonb_build_object('population','Unique live attempts created in the selected local dates; current state at cut',
  'count',count(*),'confirmed',count(*) filter(where sale_state='materialized'),'rejected',count(*) filter(where state='rejected'),
  'rejectionRate',case when count(*)>0 then (count(*) filter(where state='rejected'))::numeric/count(*) else null end,
  'results',coalesce((select jsonb_agg(jsonb_build_object('state',r.state,'count',r.n) order by r.state) from(select p.state,count(*) n from population p group by p.state) r),'[]'),
  'incidentAttempts',(select count(distinct i.attempt_id) from app_private.point_incidents i join population p on p.id=i.attempt_id),
  'confirmationSecondsP50',percentile_cont(0.5) within group(order by extract(epoch from verified_at-created_at)) filter(where sale_state='materialized' and verified_at>=created_at),
  'confirmationSecondsP95',percentile_cont(0.95) within group(order by extract(epoch from verified_at-created_at)) filter(where sale_state='materialized' and verified_at>=created_at)
 ) into attempts from population;
 with events as (select e.* from app_private.point_event_inbox e where (p_business is null or e.business_id=p_business) and e.received_at>=start_at and e.received_at<end_at),
 lag as (select greatest(0,extract(epoch from e.received_at)-case when length(e.signature_timestamp)>10 then e.signature_timestamp::numeric/1000 else e.signature_timestamp::numeric end) seconds from events e where e.signature_timestamp::numeric between 946684800 and 4133980800000)
 select jsonb_build_object('receivedEvents',(select count(*) from events),'duplicates',(select coalesce(sum(e.duplicate_count),0) from events e),
  'invalidSignatures',case when p_business is null then (select coalesce(sum(c.invalid_signatures),0) from app_private.point_webhook_counters c where c.day>=p_from and c.day<=p_to) else null end,
  'eventLagSecondsP50',(select percentile_cont(0.5) within group(order by l.seconds) from lag l),'eventLagSecondsP95',(select percentile_cont(0.95) within group(order by l.seconds) from lag l),
  'unmatchedEvents',case when p_business is null then (select count(*) from app_private.point_event_inbox e where e.attempt_id is null) else null end,
  'queuedJobs',(select count(*) from app_private.point_jobs j where (p_business is null or j.business_id=p_business) and j.status in ('queued','leased')),
  'failedJobs',(select count(*) from app_private.point_jobs j where (p_business is null or j.business_id=p_business) and j.status='failed'),
  'pendingOlderThan15Minutes',(select count(*) from app_private.point_attempts pa where (p_business is null or pa.business_id=p_business) and pa.state in ('pending','sent_to_terminal','processing','unknown_review') and pa.created_at<clock_timestamp()-interval '15 minutes'),
  'reconciliationAgeSeconds',case when report->>'lastReconciledAt' is null then null else greatest(0,extract(epoch from clock_timestamp()-(report->>'lastReconciledAt')::timestamptz)) end
 ) into health;
 report:=report||jsonb_build_object('attempts',attempts,'commissionAccounting',finance,'health',health,'provider',jsonb_build_object('id','mercadopago-point','grossCents',report->'grossCents','refundCents',report->'refundCents','commissionNetCents',report->'commissionNetCents'));
 if p_business is null then
  with firsts as(select pa.business_id,min(pa.verified_at) first_at from app_private.point_attempts pa where pa.environment='live' and pa.sale_state='materialized' group by pa.business_id),
  activity as(select f.business_id,to_char(f.first_at at time zone zone,'YYYY-MM') cohort from firsts f),
  rows as(select ac.cohort,count(distinct ac.business_id) businesses,
   coalesce(sum((select sum(pa.amount_cents) from app_private.point_attempts pa where pa.business_id=ac.business_id and pa.environment='live' and pa.sale_state='materialized' and pa.verified_at>=start_at and pa.verified_at<end_at)),0) gross,
   coalesce(sum((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts pa on pa.id=r.attempt_id where r.business_id=ac.business_id and pa.environment='live' and r.confirmed_at>=start_at and r.confirmed_at<end_at)),0) refunds,
   coalesce(sum((select sum(l.exact_numerator) from app_private.point_fee_ledger l where l.business_id=ac.business_id and l.occurred_at>=start_at and l.occurred_at<end_at)),0) numerator
   from activity ac group by ac.cohort)
  select coalesce(jsonb_agg(jsonb_build_object('cohort',r.cohort,'businesses',r.businesses,'grossCents',r.gross,'refundCents',r.refunds,'commissionExactNumerator',r.numerator::text) order by r.cohort),'[]') into cohorts from rows r;
  report:=report||jsonb_build_object('cohorts',cohorts,'activation',jsonb_build_object(
   'connectedWithFirstPayment',(select count(*) from app_private.point_connections pc where pc.environment='live' and pc.status='connected' and exists(select 1 from app_private.point_attempts pa where pa.business_id=pc.business_id and pa.environment='live' and pa.sale_state='materialized')),
   'firstPaymentSecondsP50',(select percentile_cont(0.5) within group(order by extract(epoch from f.first_at-c.created_at)) from app_private.point_connections c join(select pa.business_id,min(pa.verified_at) first_at from app_private.point_attempts pa where pa.environment='live' and pa.sale_state='materialized' group by pa.business_id) f on f.business_id=c.business_id where c.environment='live' and f.first_at>=c.created_at),
   'firstPaymentSecondsP95',(select percentile_cont(0.95) within group(order by extract(epoch from f.first_at-c.created_at)) from app_private.point_connections c join(select pa.business_id,min(pa.verified_at) first_at from app_private.point_attempts pa where pa.environment='live' and pa.sale_state='materialized' group by pa.business_id) f on f.business_id=c.business_id where c.environment='live' and f.first_at>=c.created_at)),
   'businessDetailTotals',jsonb_build_object('grossCents',report->'grossCents','refundCents',report->'refundCents','paymentCount',report->'paymentCount'));
 end if;
 return report;
end $$;
revoke all on function app_private.point_report(uuid,date,date,text),app_private.point_report_before_metrics(uuid,date,date,text) from public,anon,authenticated;
