-- Point is disabled until separately configured and verified. No public table access.
create table app_private.point_settings (
 business_id uuid primary key references app_private.businesses(id) on delete cascade,
 enabled boolean not null default false, rate_bps integer not null default 30 check(rate_bps between 0 and 10000),
 vat_bps integer not null default 1600 check(vat_bps between 0 and 10000), tariff_version text not null default 'sasori-0.30-v1',
 updated_at timestamptz not null default clock_timestamp()
);
create table app_private.point_connections (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references app_private.businesses(id) on delete cascade,
 receiver_id text not null, environment text not null check(environment in ('live','sandbox')),
 status text not null check(status in ('connected','revoked','reconnect_required')), tokens_ciphertext text not null,
 expires_at timestamptz, verified_at timestamptz, created_at timestamptz not null default clock_timestamp(),
 refresh_lease_token uuid, refresh_lease_until timestamptz, token_version integer not null default 1,
 unique(business_id,id), unique(receiver_id,environment)
);
create unique index point_one_connected on app_private.point_connections(business_id) where status='connected';
create table app_private.point_oauth_states (
 state_hash bytea primary key, business_id uuid not null references app_private.businesses(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, auth_session_id uuid not null,
 redirect_uri text not null, pkce_ciphertext text, environment text not null check(environment in ('live','sandbox')), expires_at timestamptz not null, consumed_at timestamptz,
 created_at timestamptz not null default clock_timestamp()
);
create table app_private.point_terminals (
 business_id uuid not null, id text not null, connection_id uuid not null, serial text not null,
 branch_id text not null, register_id text not null, branch_name text not null default '', register_name text not null default '',
 mode text not null default 'unknown', verified boolean not null default false, active boolean not null default false,
 physical_steps_pending boolean not null default true, verified_at timestamptz,
 primary key(business_id,id), unique(connection_id,id), unique(connection_id,register_id),
 foreign key(business_id,connection_id) references app_private.point_connections(business_id,id)
);
create table app_private.point_checkouts (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, checkout_attempt_id uuid not null,
 actor_identity uuid not null, terminal_id text not null, connection_id uuid not null, active_attempt_id uuid,
 timezone text not null, rate_bps integer not null, vat_bps integer not null, tariff_version text not null,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(business_id,id), unique(business_id,checkout_attempt_id),
 foreign key(business_id,checkout_attempt_id) references app_private.checkout_attempts(business_id,id),
 foreign key(business_id,terminal_id) references app_private.point_terminals(business_id,id),
 foreign key(business_id,connection_id) references app_private.point_connections(business_id,id)
);
create table app_private.point_attempts (
 id uuid primary key, business_id uuid not null, checkout_id uuid not null, connection_id uuid not null, terminal_id text not null,
 state text not null default 'pending' check(state in ('pending','sent_to_terminal','processing','approved_verified','rejected','cancelled','expired','unknown_review','partially_refunded','refunded')),
 sale_state text not null default 'pending' check(sale_state in ('pending','materialized')),
 idempotency_key uuid not null unique, create_payload jsonb not null, amount_cents bigint not null check(amount_cents between 1 and 9999999999),
 currency text not null default 'MXN' check(currency='MXN'), receiver_id text not null, environment text not null check(environment in ('live','sandbox')),
 external_reference text not null unique, remote_order_id text, payment_id text, status_detail text,
 cancel_capability text not null default 'terminal' check(cancel_capability in ('backend','terminal','unavailable')),
 refunded_cents bigint not null default 0 check(refunded_cents between 0 and amount_cents), verified_at timestamptz, observed_at timestamptz, first_sent_at timestamptz,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(business_id,id), unique(connection_id,remote_order_id),
 foreign key(business_id,checkout_id) references app_private.point_checkouts(business_id,id),
 foreign key(business_id,connection_id) references app_private.point_connections(business_id,id),
 foreign key(business_id,terminal_id) references app_private.point_terminals(business_id,id)
);
alter table app_private.point_checkouts add constraint point_active_attempt_fk foreign key(business_id,active_attempt_id) references app_private.point_attempts(business_id,id) deferrable initially deferred;
-- A terminal reservation has no TTL. An expired worker lease never clears an uncertain bank operation.
create table app_private.point_terminal_reservations (
 business_id uuid not null, connection_id uuid not null, terminal_id text not null, attempt_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(), primary key(connection_id,terminal_id),
 foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id),
 foreign key(business_id,terminal_id) references app_private.point_terminals(business_id,id)
);
create table app_private.point_refund_requests (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, attempt_id uuid not null, actor_identity uuid not null,
 operation_id uuid not null, idempotency_key uuid not null unique, amount_cents bigint not null check(amount_cents>0),
 merchandise_cents bigint not null check(merchandise_cents>=0), tip_cents bigint not null check(tip_cents>=0), reason text not null,
 status text not null default 'pending' check(status in ('pending','unknown_review','confirmed','rejected')), remote_refund_id text,
 created_at timestamptz not null default clock_timestamp(), unique(business_id,id), unique(business_id,operation_id),
 check(amount_cents=merchandise_cents+tip_cents), foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id)
);
create table app_private.point_refunds (
 business_id uuid not null, attempt_id uuid not null, remote_refund_id text not null, amount_cents bigint not null check(amount_cents>0),
 merchandise_cents bigint not null check(merchandise_cents>=0), tip_cents bigint not null check(tip_cents>=0),
 confirmed_at timestamptz not null, recorded_at timestamptz not null default clock_timestamp(),
 primary key(attempt_id,remote_refund_id), check(amount_cents=merchandise_cents+tip_cents),
 foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id)
);
create table app_private.point_jobs (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, connection_id uuid, attempt_id uuid, refund_id uuid,
 kind text not null check(kind in ('create_order','reconcile_order','cancel_order','refund_order','webhook')),
 dedupe_key text not null unique, payload jsonb not null default '{}'::jsonb,
 status text not null default 'queued' check(status in ('queued','leased','done','failed')), attempts integer not null default 0,
 available_at timestamptz not null default clock_timestamp(), lease_token uuid, lease_until timestamptz,
 last_error text, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 foreign key(business_id,connection_id) references app_private.point_connections(business_id,id),
 foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id),
 foreign key(business_id,refund_id) references app_private.point_refund_requests(business_id,id)
);
create index point_job_claim on app_private.point_jobs(available_at,id) where status in ('queued','leased');
create index point_pending_sweep on app_private.point_attempts(updated_at,id) where state in ('pending','sent_to_terminal','processing','unknown_review');
create table app_private.point_operations (
 business_id uuid not null references app_private.businesses(id), operation_id uuid not null, actor_identity uuid not null,
 fingerprint bytea not null, result jsonb not null, created_at timestamptz not null default clock_timestamp(), primary key(business_id,operation_id)
);
create table app_private.point_incidents (
 id uuid primary key default gen_random_uuid(), business_id uuid references app_private.businesses(id), attempt_id uuid,
 code text not null, evidence jsonb not null default '{}'::jsonb, actor_identity uuid, resolved_at timestamptz,
 created_at timestamptz not null default clock_timestamp(), foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id)
);
create table app_private.point_fee_ledger (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references app_private.businesses(id), attempt_id uuid not null,
 source_key text not null unique, kind text not null check(kind in ('charge','refund')), base_cents bigint not null,
 rate_bps integer not null, vat_bps integer not null, tariff_version text not null,
 exact_numerator numeric(30,0) not null, period date not null, occurred_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 check(exact_numerator=base_cents::numeric*rate_bps), foreign key(business_id,attempt_id) references app_private.point_attempts(business_id,id)
);
create index point_fee_period on app_private.point_fee_ledger(business_id,period,vat_bps);
create table app_private.point_statements (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references app_private.businesses(id), period date not null,
 status text not null default 'closed' check(status in ('closed','invoiced')), exact_numerator numeric(30,0) not null,
 net_cents bigint not null, vat_cents bigint not null, total_cents bigint not null, snapshot jsonb not null,
 evidence text, closed_by uuid not null, closed_at timestamptz not null default clock_timestamp(),
 unique(business_id,id), unique(business_id,period), check(total_cents=net_cents+vat_cents)
);
create table app_private.point_statement_lines (
 business_id uuid not null, statement_id uuid not null, vat_bps integer not null, exact_numerator numeric(30,0) not null,
 net_cents bigint not null, vat_cents bigint not null, primary key(statement_id,vat_bps),
 foreign key(business_id,statement_id) references app_private.point_statements(business_id,id)
);
create table app_private.point_commission_payments (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, statement_id uuid not null,
 operation_id uuid not null, amount_cents bigint not null check(amount_cents>0), paid_at timestamptz not null,
 evidence text not null check(char_length(evidence) between 1 and 300), actor_identity uuid not null,
 created_at timestamptz not null default clock_timestamp(), unique(business_id,operation_id),
 foreign key(business_id,statement_id) references app_private.point_statements(business_id,id)
);
create table app_private.sasori_admins (
 user_id uuid primary key references auth.users(id), active boolean not null default false, granted_by text not null,
 reason text not null, granted_at timestamptz not null default clock_timestamp()
);
create table app_private.sasori_admin_audit (
 id uuid primary key default gen_random_uuid(), user_id uuid, actor text not null, action text not null, reason text,
 created_at timestamptz not null default clock_timestamp()
);
create function app_private.point_admin_audit() returns trigger language plpgsql set search_path='' as $$
begin insert into app_private.sasori_admin_audit(user_id,actor,action,reason) values(coalesce(new.user_id,old.user_id),session_user,TG_OP,coalesce(new.reason,old.reason)); return coalesce(new,old); end $$;
create trigger point_admin_change after insert or update or delete on app_private.sasori_admins for each row execute function app_private.point_admin_audit();
create function app_private.point_immutable() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'IMMUTABLE_FINANCIAL_RECORD'; end $$;
create trigger point_immutable_fees before update or delete on app_private.point_fee_ledger for each row execute function app_private.point_immutable();
create trigger point_immutable_refunds before update or delete on app_private.point_refunds for each row execute function app_private.point_immutable();
create trigger point_immutable_payments before update or delete on app_private.point_commission_payments for each row execute function app_private.point_immutable();
do $security$ declare t text; begin
 for t in select unnest(array['point_settings','point_connections','point_oauth_states','point_terminals','point_checkouts','point_attempts','point_terminal_reservations','point_refund_requests','point_refunds','point_jobs','point_operations','point_incidents','point_fee_ledger','point_statements','point_statement_lines','point_commission_payments','sasori_admins','sasori_admin_audit']) loop
  execute format('alter table app_private.%I enable row level security',t); execute format('revoke all on app_private.%I from public,anon,authenticated',t);
 end loop;
end $security$;

-- Extend methods without enabling them for any existing business. SQL, not role names, controls actions.
alter table app_private.sales drop constraint sales_payment_method_check;
alter table app_private.sales add constraint sales_payment_method_check check(payment_method in ('cash','card_external','transfer','card_integrated'));
alter table app_private.checkout_attempts drop constraint checkout_attempts_payment_method_check;
alter table app_private.checkout_attempts add constraint checkout_attempts_payment_method_check check(payment_method in ('cash','card_external','transfer','card_integrated'));
do $patch$ declare d text; begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into d;
 d:=replace(d,'''cash'',''card_external'',''transfer''','''cash'',''card_external'',''transfer'',''card_integrated'''); execute d;
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into d;
 d:=replace(d,'if not (business.profile->''paymentMethods'' ? (p->>''paymentMethod'')) then raise exception ''PAYMENT_METHOD_DISABLED''; end if;',
  'if not ((p->>''paymentMethod''=''card_integrated'' and exists(select 1 from app_private.point_settings ps where ps.business_id=p_business_id and ps.enabled)) or (p->>''paymentMethod''<>''card_integrated'' and business.profile->''paymentMethods'' ? (p->>''paymentMethod''))) then raise exception ''PAYMENT_METHOD_DISABLED''; end if;');
 execute d;
end $patch$;

create function app_private.point_terminal_json(t app_private.point_terminals) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'serial',t.serial,'branchId',t.branch_id,'registerId',t.register_id,'branchName',t.branch_name,'registerName',t.register_name,'mode',t.mode,'verified',t.verified,'active',t.active,'physicalStepsPending',t.physical_steps_pending);
$$;
create function app_private.point_ledger_period(p_business uuid,p_occurred timestamptz) returns date language plpgsql set search_path='' as $$
declare d date; closed date; begin
 d:=date_trunc('month',p_occurred at time zone (select timezone from app_private.businesses where id=p_business))::date;
 select max(period) into closed from app_private.point_statements where business_id=p_business;
 return greatest(d,coalesce((closed+interval '1 month')::date,d));
end $$;
create function app_private.point_report(p_business uuid,p_from date,p_to date,p_cursor text default null) returns jsonb language plpgsql stable set search_path='' as $$
declare zone text; start_at timestamptz; end_at timestamptz; previous_start timestamptz; gross bigint; refunds bigint; count_paid bigint; numerator numeric; vat bigint; details jsonb; result jsonb; rows jsonb; cursor_id uuid;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>365 or p_from<date '2000-01-01' or p_to>date '2100-12-31' then raise exception 'VALIDATION_ERROR'; end if;
 zone:=case when p_business is null then 'UTC' else (select timezone from app_private.businesses where id=p_business) end;
 if zone is null then raise exception 'BUSINESS_ACCESS_DENIED'; end if;
 start_at:=p_from::timestamp at time zone zone; end_at:=(p_to+1)::timestamp at time zone zone; previous_start:=(p_from-(p_to-p_from+1))::timestamp at time zone zone;
 select coalesce(sum(amount_cents),0),count(*) into gross,count_paid from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=start_at and verified_at<end_at;
 select coalesce(sum(r.amount_cents),0) into refunds from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where (p_business is null or r.business_id=p_business) and a.environment='live' and r.confirmed_at>=start_at and r.confirmed_at<end_at;
 select coalesce(sum(exact_numerator),0) into numerator from app_private.point_fee_ledger where (p_business is null or business_id=p_business) and occurred_at>=start_at and occurred_at<end_at;
 select coalesce(sum(round(round(x.n/10000)*x.vat_bps/10000)),0)::bigint into vat from (select vat_bps,sum(exact_numerator) n from app_private.point_fee_ledger where (p_business is null or business_id=p_business) and occurred_at>=start_at and occurred_at<end_at group by vat_bps) x;
 select coalesce(jsonb_agg(jsonb_build_object('terminalId',t.id,'grossCents',coalesce((select sum(amount_cents) from app_private.point_attempts a where a.business_id=t.business_id and a.terminal_id=t.id and a.environment='live' and a.sale_state='materialized' and a.verified_at>=start_at and a.verified_at<end_at),0),
  'refundCents',coalesce((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where a.business_id=t.business_id and a.terminal_id=t.id and a.environment='live' and r.confirmed_at>=start_at and r.confirmed_at<end_at),0),
  'count',(select count(*) from app_private.point_attempts a where a.business_id=t.business_id and a.terminal_id=t.id and a.environment='live' and a.sale_state='materialized' and a.verified_at>=start_at and a.verified_at<end_at)) order by t.business_id,t.id),'[]') into details from app_private.point_terminals t where p_business is null or t.business_id=p_business;
 result:=jsonb_build_object('from',p_from,'to',p_to,'timezone',zone,'asOf',clock_timestamp(),'lastReconciledAt',(select max(observed_at) from app_private.point_attempts where p_business is null or business_id=p_business),
  'grossCents',gross,'refundCents',refunds,'netCents',gross-refunds,'paymentCount',count_paid,'averageTicketCents',case when count_paid>0 then round(gross::numeric/count_paid) else null end,
  'commissionExactNumerator',numerator::text,'commissionNetCents',round(numerator/10000),'commissionVatCents',vat,'commissionTotalCents',round(numerator/10000)+vat,
  'pendingCount',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and state in ('pending','sent_to_terminal','processing','unknown_review')),
  'oldestPendingAt',(select min(created_at) from app_private.point_attempts where (p_business is null or business_id=p_business) and state in ('pending','sent_to_terminal','processing','unknown_review')),
  'otherPayments',coalesce((select jsonb_agg(x) from (select jsonb_build_object('method',payment_method,'totalCents',sum(total_cents),'count',count(*)) x from app_private.sales where (p_business is null or business_id=p_business) and payment_method<>'card_integrated' and created_at>=start_at and created_at<end_at group by payment_method) v),'[]'),
  'terminals',details,'daily',coalesce((select jsonb_agg(jsonb_build_object('date',d::date,'grossCents',coalesce((select sum(amount_cents) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=d::timestamp at time zone zone and verified_at<(d::date+1)::timestamp at time zone zone),0),
   'refundCents',coalesce((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where (p_business is null or r.business_id=p_business) and a.environment='live' and r.confirmed_at>=d::timestamp at time zone zone and r.confirmed_at<(d::date+1)::timestamp at time zone zone),0),
   'count',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=d::timestamp at time zone zone and verified_at<(d::date+1)::timestamp at time zone zone)) order by d) from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d),'[]'),
  'previous',jsonb_build_object('grossCents',coalesce((select sum(amount_cents) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=previous_start and verified_at<start_at),0),
   'refundCents',coalesce((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where (p_business is null or r.business_id=p_business) and a.environment='live' and r.confirmed_at>=previous_start and r.confirmed_at<start_at),0),
   'netCents',coalesce((select sum(amount_cents) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=previous_start and verified_at<start_at),0)-coalesce((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where (p_business is null or r.business_id=p_business) and a.environment='live' and r.confirmed_at>=previous_start and r.confirmed_at<start_at),0),
   'paymentCount',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and verified_at>=previous_start and verified_at<start_at)),
  'costsCents',null,'contributionCents',null,'settlementCents',null,
  'attempts',jsonb_build_object('population','attempts created in requested UTC range, live only','count',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and created_at>=start_at and created_at<end_at),
   'rejected',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and state='rejected' and created_at>=start_at and created_at<end_at),
   'confirmed',(select count(*) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and created_at>=start_at and created_at<end_at),
   'confirmationSecondsP50',(select percentile_cont(0.5) within group(order by extract(epoch from verified_at-created_at)) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and created_at>=start_at and created_at<end_at),
   'confirmationSecondsP95',(select percentile_cont(0.95) within group(order by extract(epoch from verified_at-created_at)) from app_private.point_attempts where (p_business is null or business_id=p_business) and environment='live' and sale_state='materialized' and created_at>=start_at and created_at<end_at)),
  'commissionAccounting',jsonb_build_object('closedNetCents',coalesce((select sum(net_cents) from app_private.point_statements where (p_business is null or business_id=p_business) and period>=date_trunc('month',p_from)::date and period<=date_trunc('month',p_to)::date),0),
   'invoicedNetCents',coalesce((select sum(net_cents) from app_private.point_statements where (p_business is null or business_id=p_business) and status='invoiced' and period>=date_trunc('month',p_from)::date and period<=date_trunc('month',p_to)::date),0),
   'collectedCents',coalesce((select sum(amount_cents) from app_private.point_commission_payments where (p_business is null or business_id=p_business) and paid_at>=start_at and paid_at<end_at),0)),
  'unresolvedIncidents',(select count(*) from app_private.point_incidents where (p_business is null or business_id=p_business) and resolved_at is null));
 if p_business is null then
  cursor_id:=case when p_cursor is null then null else p_cursor::uuid end;
  select coalesce(jsonb_agg(x order by id),'[]') into rows from (select b.id,jsonb_build_object('businessId',b.id,'name',b.name,
   'grossCents',coalesce((select sum(amount_cents) from app_private.point_attempts where business_id=b.id and environment='live' and sale_state='materialized' and verified_at>=start_at and verified_at<end_at),0),
   'refundCents',coalesce((select sum(r.amount_cents) from app_private.point_refunds r join app_private.point_attempts a on a.id=r.attempt_id where r.business_id=b.id and a.environment='live' and r.confirmed_at>=start_at and r.confirmed_at<end_at),0),
   'paymentCount',(select count(*) from app_private.point_attempts where business_id=b.id and environment='live' and sale_state='materialized' and verified_at>=start_at and verified_at<end_at),
   'commissionExactNumerator',coalesce((select sum(l.exact_numerator) from app_private.point_fee_ledger l where l.business_id=b.id and l.occurred_at>=start_at and l.occurred_at<end_at),0)::text,
   'commissionNetCents',round(coalesce((select sum(l.exact_numerator) from app_private.point_fee_ledger l where l.business_id=b.id and l.occurred_at>=start_at and l.occurred_at<end_at),0)/10000)) x from app_private.businesses b where (cursor_id is null or b.id>cursor_id) and exists(select 1 from app_private.point_connections where business_id=b.id) order by b.id limit 101) v;
  result:=result||jsonb_build_object('businesses',case when jsonb_array_length(rows)>100 then rows-100 else rows end,'nextCursor',case when jsonb_array_length(rows)>100 then rows#>>'{99,businessId}' else null end,
   'connectedBusinesses',(select count(distinct business_id) from app_private.point_connections where status='connected' and environment='live'),
   'readyBusinesses',(select count(distinct t.business_id) from app_private.point_terminals t join app_private.point_connections c on c.id=t.connection_id where t.verified and t.active and t.mode='PDV' and not t.physical_steps_pending and c.status='connected' and c.environment='live'),
   'activeBusinesses',(select count(distinct business_id) from app_private.point_attempts where environment='live' and sale_state='materialized' and verified_at>=start_at and verified_at<end_at));
 end if;
 return result;
end $$;

-- Preserve employee-device proof validation/nonce consumption before the new module.
create function public.point_execute(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare employee_id uuid;
begin
 perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
 select id into employee_id from app_private.employees where business_id=p_business_id and user_id=p_user_id and active and deleted_at is null for share;
 perform 1 from app_private.operator_sessions where business_id=p_business_id and user_id=p_user_id and auth_session_id=p_auth_session_id and token_hash=extensions.digest(p_operator_token,'sha256') for share;
 perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
 perform set_config('app.point_session_kind','personal',true);
 return app_private.point_command(p_business_id,employee_id,p_payload-array['action','businessId','operatorToken','deviceToken','deviceProof']);
end $$;
create function public.point_device(p_device_token text,p_operator_token text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; begin
 ctx:=public.account_device('device_context',jsonb_build_object('deviceToken',p_device_token,'operatorToken',p_operator_token));
 if ctx ? 'error' then return ctx; end if;
 perform set_config('app.point_session_kind','device',true);
 return app_private.point_command((ctx#>>'{data,business,id}')::uuid,(ctx#>>'{data,business,employee,id}')::uuid,p_payload-array['action','businessId','operatorToken','deviceToken','deviceProof']);
end $$;
alter function public.account_secure(uuid,uuid,text,jsonb,text,uuid) rename to account_secure_before_point;
alter function public.account_secure_before_point(uuid,uuid,text,jsonb,text,uuid) set schema app_private;
create function public.account_secure(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb,p_device_key_hash text default null,p_proof_nonce uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; begin
 if p_action='point' then
  ctx:=app_private.account_secure_before_point(p_user_id,p_auth_session_id,'context',p_payload,p_device_key_hash,p_proof_nonce);
  if ctx ? 'error' then return ctx; end if;
  return public.point_execute(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken',p_payload);
 end if;
 return app_private.account_secure_before_point(p_user_id,p_auth_session_id,p_action,p_payload,p_device_key_hash,p_proof_nonce);
end $$;
-- Manual statements cannot verify a Point collection or overwrite its snapshots.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_point;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
begin
 if p_payload->>'command' in ('start_checkout','mark_checkout_uncertain','resolve_checkout','update_checkout','record_checkout') and exists(select 1 from app_private.checkout_attempts where business_id=p_business_id and id=(p_payload->>'attemptId')::uuid and payment_method='card_integrated') then raise exception 'POINT_RESULT_UNCERTAIN'; end if;
 if p_payload->>'command'='complete_sale' and p_payload->>'paymentMethod'='card_integrated' then raise exception 'POINT_STATE_INVALID'; end if;
 if p_payload->>'command'='prepare_reversal' and exists(select 1 from app_private.sales where business_id=p_business_id and id=(p_payload->>'saleId')::uuid and payment_method='card_integrated') then raise exception 'POINT_STATE_INVALID'; end if;
 return app_private.pos_command_before_point(p_business_id,p_employee_id,p_payload);
end $$;
-- Existing contexts advertise server capabilities, including recovery after a disconnect.
alter function app_private.employee_context(uuid,boolean) rename to employee_context_before_point;
create function app_private.employee_context(p_employee_id uuid,p_allow_profile boolean) returns jsonb language plpgsql set search_path='' as $$
declare ctx jsonb; begin
 ctx:=app_private.employee_context_before_point(p_employee_id,p_allow_profile);
 return ctx||jsonb_build_object('point',jsonb_build_object('enabled',exists(select 1 from app_private.point_settings where business_id=(ctx->>'id')::uuid and enabled),
  'recoverable',exists(select 1 from app_private.point_checkouts where business_id=(ctx->>'id')::uuid),'admin',exists(select 1 from app_private.sasori_admins a join app_private.employees e on e.user_id=a.user_id where e.id=p_employee_id and a.active)));
end $$;
create function app_private.point_materialize(a app_private.point_attempts) returns void language plpgsql set search_path='' as $$
#variable_conflict use_column
declare c app_private.point_checkouts%rowtype; q app_private.checkout_attempts%rowtype; o app_private.operational_orders%rowtype; s app_private.sales%rowtype; x jsonb; lines jsonb;
begin
 select * into c from app_private.point_checkouts where business_id=a.business_id and id=a.checkout_id for update;
 select * into q from app_private.checkout_attempts where business_id=a.business_id and id=c.checkout_attempt_id for update;
 if q.sale_id is not null then return; end if;
 select * into o from app_private.operational_orders where business_id=a.business_id and id=q.order_id for update;
 if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;
 insert into app_private.sales(business_id,employee_id,operator_name,operation_id,total_cents,item_count,payment_method,timezone,created_at)
  values(a.business_id,q.actor_id,q.operator_name,q.id,q.total_cents,(select sum((x->>'quantity')::integer) from jsonb_array_elements(q.items) x),'card_integrated',c.timezone,a.verified_at) returning * into s;
 insert into app_private.sale_items(business_id,sale_id,line_id,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps,discount_cents)
  select a.business_id,s.id,(x->>'lineId')::uuid,(x->>'productId')::uuid,x->>'name',x->>'category',(x->>'quantity')::integer,(x->>'unitPriceCents')::integer,(x->>'totalCents')::bigint,
   x->>'selectionLabel',(x->>'taxCents')::bigint,x->>'taxTreatment',(x->>'taxBps')::integer,(x->>'discountCents')::bigint from jsonb_array_elements(q.items) x;
 for x in select * from jsonb_array_elements(q.items) loop
  update app_private.order_lines set paid_quantity=paid_quantity+(x->>'quantity')::integer where business_id=a.business_id and order_id=o.id and id=(x->>'lineId')::uuid and paid_quantity+(x->>'quantity')::integer<=quantity;
  if not found then raise exception 'ORDER_CHANGED'; end if;
 end loop;
 select jsonb_agg(jsonb_build_object('lineId',ol.id,'name',ol.kitchen_name,'selectionLabel',ol.selection_label,'note',ol.note,'quantity',ol.paid_quantity-ol.sent_quantity) order by ol.id) into lines
  from app_private.order_lines ol where ol.business_id=a.business_id and ol.order_id=o.id and ol.paid_quantity>ol.sent_quantity;
 if lines is not null then
  insert into app_private.kitchen_batches(business_id,order_id,order_name,table_name,kind,items,actor_id,actor_name) values(a.business_id,o.id,o.name,(select name from app_private.dining_tables where business_id=a.business_id and id=o.table_id),'items',lines,q.actor_id,q.operator_name);
  update app_private.order_lines set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=a.business_id and order_id=o.id;
 end if;
 update app_private.checkout_attempts set status='completed',sale_id=s.id,revision=revision+1,resolver_name='Mercado Pago verificado',resolution_reason='Proveedor verificado',resolved_at=clock_timestamp() where business_id=a.business_id and id=q.id;
 update app_private.operational_orders set frozen=true,status=case when exists(select 1 from app_private.order_lines where business_id=a.business_id and order_id=o.id and quantity>paid_quantity) then 'open' else 'closed' end,revision=revision+1,updated_at=clock_timestamp() where business_id=a.business_id and id=o.id;
 update app_private.point_attempts set sale_state='materialized' where id=a.id;
 if a.environment='live' then
  perform pg_advisory_xact_lock(hashtextextended('point-ledger:'||a.business_id::text,0));
  insert into app_private.point_fee_ledger(business_id,attempt_id,source_key,kind,base_cents,rate_bps,vat_bps,tariff_version,exact_numerator,period,occurred_at)
   values(a.business_id,a.id,'charge:'||a.id::text,'charge',a.amount_cents,c.rate_bps,c.vat_bps,c.tariff_version,a.amount_cents::numeric*c.rate_bps,app_private.point_ledger_period(a.business_id,a.verified_at),a.verified_at) on conflict(source_key) do nothing;
 end if;
end $$;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare p jsonb:=p_payload; con app_private.point_connections%rowtype; a app_private.point_attempts%rowtype; c app_private.point_checkouts%rowtype;
 q app_private.checkout_attempts%rowtype; j app_private.point_jobs%rowtype; r app_private.point_refund_requests%rowtype;
 st app_private.point_oauth_states%rowtype; token uuid; result jsonb; jobs jsonb:='[]'; remote text; observed timestamptz; state text; x jsonb; amount bigint; used bigint; old_refund app_private.point_refunds%rowtype;
begin
 if p_action='oauth_state_create' then
  perform app_private.assert_live_auth((p->>'userId')::uuid,(p->>'authSessionId')::uuid); perform app_private.assert_owner((p->>'userId')::uuid,(p->>'businessId')::uuid);
  if p->>'stateHash' !~ '^[0-9a-f]{64}$' or (p->>'expiresAt')::timestamptz>clock_timestamp()+interval '15 minutes' or (p->>'expiresAt')::timestamptz<=clock_timestamp() then raise exception 'POINT_OAUTH_INVALID'; end if;
  insert into app_private.point_oauth_states(state_hash,business_id,user_id,auth_session_id,redirect_uri,pkce_ciphertext,environment,expires_at)
   values(decode(p->>'stateHash','hex'),(p->>'businessId')::uuid,(p->>'userId')::uuid,(p->>'authSessionId')::uuid,p->>'redirectUri',p->>'verifierCiphertext',p->>'environment',(p->>'expiresAt')::timestamptz);
  return jsonb_build_object('created',true);
 elsif p_action='oauth_state_consume' then
  select * into st from app_private.point_oauth_states where state_hash=decode(p->>'stateHash','hex') for update;
  if not found or st.consumed_at is not null or st.expires_at<=clock_timestamp() or st.business_id<>(p->>'businessId')::uuid or st.user_id<>(p->>'userId')::uuid or st.auth_session_id<>(p->>'authSessionId')::uuid or st.redirect_uri<>p->>'redirectUri' then raise exception 'POINT_OAUTH_INVALID'; end if;
  perform app_private.assert_live_auth(st.user_id,st.auth_session_id); perform app_private.assert_owner(st.user_id,st.business_id);
  update app_private.point_oauth_states set consumed_at=clock_timestamp() where state_hash=st.state_hash;
  return jsonb_build_object('businessId',st.business_id,'environment',st.environment,'verifierCiphertext',st.pkce_ciphertext);
 elsif p_action='connection_save' then
  perform pg_advisory_xact_lock(hashtextextended('point-connection:'||(p->>'businessId'),0));
  select * into con from app_private.point_connections where receiver_id=p->>'receiverId' and environment=p->>'environment' for update;
  if found and con.business_id<>(p->>'businessId')::uuid then raise exception 'POINT_FACT_MISMATCH'; end if;
  if not found then
   update app_private.point_connections set status='reconnect_required' where business_id=(p->>'businessId')::uuid and status='connected';
   insert into app_private.point_connections(business_id,receiver_id,environment,status,tokens_ciphertext,expires_at,verified_at) values((p->>'businessId')::uuid,p->>'receiverId',p->>'environment','connected',p->>'tokensCiphertext',(p->>'expiresAt')::timestamptz,clock_timestamp()) returning * into con;
  else
   update app_private.point_connections set status='reconnect_required' where business_id=con.business_id and id<>con.id and status='connected';
   update app_private.point_connections set status='connected',tokens_ciphertext=p->>'tokensCiphertext',expires_at=(p->>'expiresAt')::timestamptz,verified_at=clock_timestamp(),token_version=token_version+1,refresh_lease_token=null,refresh_lease_until=null where id=con.id returning * into con;
  end if;
  return jsonb_build_object('id',con.id,'businessId',con.business_id,'environment',con.environment,'receiverId',con.receiver_id,'status',con.status,'verifiedAt',con.verified_at);
 elsif p_action in ('connection_get','connection_verified','connection_revoke','refresh_claim','refresh_save','refresh_release') then
  select * into con from app_private.point_connections where id=(p->>'connectionId')::uuid for update;
  if not found then raise exception 'POINT_CONNECTION_REQUIRED'; end if;
  if p_action='connection_verified' then update app_private.point_connections set verified_at=clock_timestamp() where id=con.id returning * into con;
  elsif p_action='connection_revoke' then update app_private.point_connections set status='revoked' where id=con.id returning * into con; update app_private.point_settings set enabled=false where business_id=con.business_id;
  elsif p_action='refresh_claim' then
   if con.status<>'connected' or con.refresh_lease_until>clock_timestamp() then return jsonb_build_object('claimed',false); end if;
   update app_private.point_connections set refresh_lease_token=(p->>'leaseToken')::uuid,refresh_lease_until=clock_timestamp()+interval '60 seconds' where id=con.id returning * into con;
  elsif p_action in ('refresh_save','refresh_release') then
   if con.refresh_lease_token is distinct from (p->>'leaseToken')::uuid or con.refresh_lease_until<=clock_timestamp() then raise exception 'POINT_LEASE_LOST'; end if;
   if p_action='refresh_save' then update app_private.point_connections set tokens_ciphertext=p->>'tokensCiphertext',expires_at=(p->>'expiresAt')::timestamptz,token_version=token_version+1,refresh_lease_token=null,refresh_lease_until=null where id=con.id returning * into con;
   else update app_private.point_connections set status=case when coalesce((p->>'uncertain')::boolean,false) then 'reconnect_required' else status end,refresh_lease_token=null,refresh_lease_until=null where id=con.id returning * into con; end if;
  end if;
  result:=jsonb_build_object('id',con.id,'businessId',con.business_id,'environment',con.environment,'receiverId',con.receiver_id,'tokensCiphertext',con.tokens_ciphertext,'expiresAt',con.expires_at,'status',con.status,'verifiedAt',con.verified_at);
  return case when p_action='refresh_claim' then jsonb_build_object('claimed',true,'connection',result) else result end;
 elsif p_action='terminal_save' then
  select * into con from app_private.point_connections where id=(p->>'connectionId')::uuid;
  if not found or con.status<>'connected' then raise exception 'POINT_CONNECTION_REQUIRED'; end if;
  insert into app_private.point_terminals(business_id,id,connection_id,serial,branch_id,register_id,branch_name,register_name,mode,verified,active,physical_steps_pending,verified_at)
   values(con.business_id,p->>'terminalId',con.id,coalesce(p->>'serial',p->>'terminalId'),coalesce(p->>'storeId',p->>'branchId'),coalesce(p->>'posId',p->>'registerId'),coalesce(p->>'branchName',''),coalesce(p->>'registerName',''),coalesce(p->>'mode','unknown'),coalesce((p->>'verified')::boolean,false),coalesce((p->>'verified')::boolean,false) and coalesce((p->>'physicallyConfirmed')::boolean,false),not coalesce((p->>'physicallyConfirmed')::boolean,false),clock_timestamp())
   on conflict(business_id,id) do update set connection_id=excluded.connection_id,serial=excluded.serial,branch_id=excluded.branch_id,register_id=excluded.register_id,mode=excluded.mode,verified=excluded.verified,active=excluded.active,physical_steps_pending=excluded.physical_steps_pending,verified_at=excluded.verified_at;
  return jsonb_build_object('saved',true);
 elsif p_action='claim_jobs' then
  token:=(p->>'leaseToken')::uuid; if token is null then raise exception 'VALIDATION_ERROR'; end if;
  for j in select pj.* from app_private.point_jobs pj where (pj.status='queued' and pj.available_at<=clock_timestamp() or pj.status='leased' and pj.lease_until<=clock_timestamp()) and pj.attempts<12
   and (pj.kind<>'create_order' or coalesce((p->>'chargesEnabled')::boolean,true) or exists(select 1 from app_private.point_attempts pa where pa.id=pj.attempt_id and pa.first_sent_at is not null))
   order by pj.available_at,pj.id limit greatest(1,least(coalesce((p->>'limit')::integer,10),100)) for update skip locked loop
   update app_private.point_jobs set status='leased',lease_token=token,lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() where id=j.id returning * into j;
   if j.attempt_id is not null then
    update app_private.point_attempts set first_sent_at=case when j.kind='create_order' then coalesce(first_sent_at,clock_timestamp()) else first_sent_at end where id=j.attempt_id returning * into a;
    result:=jsonb_build_object('amountCents',a.amount_cents,'currency',a.currency,'receiverId',a.receiver_id,'environment',a.environment,'externalReference',a.external_reference,'terminalId',a.terminal_id,'remoteOrderId',a.remote_order_id,'paymentId',a.payment_id,'idempotencyKey',a.idempotency_key,'createPayload',a.create_payload,'firstSentAt',a.first_sent_at)||j.payload;
   else result:=j.payload; end if;
   jobs:=jobs||jsonb_build_array(jsonb_build_object('id',j.id,'kind',replace(j.kind,'_order',''),'attemptId',j.attempt_id,'connectionId',j.connection_id,'refundId',j.refund_id,'payload',result,'leaseToken',token));
  end loop;
  return jsonb_build_object('jobs',jobs);
 elsif p_action='record_remote_order' then
  select * into j from app_private.point_jobs where id=(p->>'jobId')::uuid for update;
  if not found or j.status<>'leased' or j.lease_token is distinct from (p->>'leaseToken')::uuid or j.lease_until<=clock_timestamp() or j.attempt_id<>(p->>'attemptId')::uuid then raise exception 'POINT_LEASE_LOST'; end if;
  update app_private.point_attempts set remote_order_id=p->>'remoteOrderId',updated_at=clock_timestamp() where id=j.attempt_id and (remote_order_id is null or remote_order_id=p->>'remoteOrderId');
  if not found then raise exception 'POINT_FACT_MISMATCH'; end if; return jsonb_build_object('saved',true);
 elsif p_action in ('complete_job','fail_job') then
  select * into j from app_private.point_jobs where id=(p->>'id')::uuid for update;
  if not found or j.status<>'leased' or j.lease_token is distinct from (p->>'leaseToken')::uuid or j.lease_until<=clock_timestamp() then raise exception 'POINT_LEASE_LOST'; end if;
  if p_action='complete_job' then update app_private.point_jobs set status='done',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
  else
   update app_private.point_jobs set status=case when attempts>=12 then 'failed' else 'queued' end,available_at=clock_timestamp()+make_interval(secs=>greatest(1,least(coalesce((p->>'delaySeconds')::integer,30),3600))),last_error=left(p->>'code',80),lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=j.id;
   if coalesce((p->>'uncertain')::boolean,false) and j.attempt_id is not null then update app_private.point_attempts set state=case when sale_state='materialized' then state else 'unknown_review' end,status_detail=left(p->>'code',80),updated_at=clock_timestamp() where id=j.attempt_id; end if;
   if j.refund_id is not null and coalesce((p->>'uncertain')::boolean,false) then update app_private.point_refund_requests set status='unknown_review' where id=j.refund_id; end if;
   if j.attempts>=12 then insert into app_private.point_incidents(business_id,attempt_id,code,evidence) values(j.business_id,j.attempt_id,'retries_exhausted',jsonb_build_object('jobId',j.id,'code',left(p->>'code',80))); end if;
  end if;
  return jsonb_build_object('saved',true);
 elsif p_action='webhook_enqueue' then
  remote:=p->>'remoteOrderId'; select * into a from app_private.point_attempts where remote_order_id=remote;
  if not found then return jsonb_build_object('accepted',true,'matched',false); end if;
  insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key,payload) values(a.business_id,a.connection_id,a.id,'webhook','event:'||(p->>'eventKey'),jsonb_build_object('remoteOrderId',remote,'signatureTimestamp',p->>'signatureTimestamp')) on conflict(dedupe_key) do nothing;
  return jsonb_build_object('accepted',true,'matched',true);
 elsif p_action='pending_sweep' then
  for a in select * from app_private.point_attempts where state in ('pending','sent_to_terminal','processing','unknown_review','partially_refunded','approved_verified') and (observed_at is null or observed_at<clock_timestamp()-interval '5 minutes') order by updated_at,id limit greatest(1,least(coalesce((p->>'limit')::integer,100),500)) loop
   if not exists(select 1 from app_private.point_jobs where attempt_id=a.id and status in ('queued','leased')) then insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key) values(a.business_id,a.connection_id,a.id,'reconcile_order','sweep:'||a.id::text||':'||floor(extract(epoch from clock_timestamp())/300)::text) on conflict(dedupe_key) do nothing; end if;
  end loop;
  return jsonb_build_object('queued',true);
 elsif p_action='apply_order' then
  select * into a from app_private.point_attempts where id=(p->>'attemptId')::uuid;
  if not found then raise exception 'POINT_CHECKOUT_NOT_FOUND'; end if;
  select * into c from app_private.point_checkouts where business_id=a.business_id and id=a.checkout_id for update;
  select * into a from app_private.point_attempts where id=(p->>'attemptId')::uuid for update;
  observed:=(p->>'observedAt')::timestamptz;
  state:=case p->>'state' when 'approved' then 'approved_verified' when 'sent' then 'sent_to_terminal' when 'canceled' then 'cancelled' when 'review' then 'unknown_review' else p->>'state' end;
  if (p->>'amountCents')::bigint is distinct from a.amount_cents or p->>'currency' is distinct from a.currency or p->>'receiverId' is distinct from a.receiver_id or p->>'environment' is distinct from a.environment or p->>'externalReference' is distinct from a.external_reference or p->>'remoteOrderId' is null or a.remote_order_id is not null and a.remote_order_id<>p->>'remoteOrderId' then
   insert into app_private.point_incidents(business_id,attempt_id,code,evidence) values(a.business_id,a.id,'provider_fact_mismatch',jsonb_build_object('remoteOrderId',p->>'remoteOrderId','observedAt',observed));
   update app_private.point_attempts set state=case when sale_state='materialized' then point_attempts.state else 'unknown_review' end,status_detail='provider_fact_mismatch' where id=a.id;
   return jsonb_build_object('applied',false,'review',true);
  end if;
  if state not in ('pending','sent_to_terminal','processing','approved_verified','rejected','cancelled','expired','unknown_review','partially_refunded','refunded') then state:='unknown_review'; end if;
  -- Approval facts are supplied only after the adapter confirms processed order and transaction.
  if state in ('approved_verified','partially_refunded','refunded') then
   update app_private.point_attempts set verified_at=coalesce(verified_at,observed,clock_timestamp()),remote_order_id=p->>'remoteOrderId',payment_id=coalesce(p->>'paymentId',payment_id) where id=a.id returning * into a;
   perform app_private.point_materialize(a);
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'refunds','[]'::jsonb)) loop
   amount:=app_private.ops_int(x->'amountCents',1,9999999999);
   select * into old_refund from app_private.point_refunds where attempt_id=a.id and remote_refund_id=x->>'id';
   if found then if old_refund.amount_cents<>amount then raise exception 'POINT_FACT_MISMATCH'; end if; continue; end if;
   if a.sale_state<>'materialized' and not exists(select 1 from app_private.point_attempts where id=a.id and sale_state='materialized') then raise exception 'POINT_STATE_INVALID'; end if;
   select coalesce(sum(amount_cents),0) into used from app_private.point_refunds where attempt_id=a.id;
   if used+amount>a.amount_cents then raise exception 'POINT_REFUND_LIMIT'; end if;
   insert into app_private.point_refunds(business_id,attempt_id,remote_refund_id,amount_cents,merchandise_cents,tip_cents,confirmed_at) values(a.business_id,a.id,x->>'id',amount,amount,0,(x->>'confirmedAt')::timestamptz);
   select * into r from app_private.point_refund_requests where attempt_id=a.id and status in ('pending','unknown_review') and (remote_refund_id=x->>'id' or remote_refund_id is null and amount_cents=amount) order by created_at limit 1 for update;
   if found then update app_private.point_refund_requests set status='confirmed',remote_refund_id=x->>'id' where id=r.id; end if;
   if a.environment='live' then
    perform pg_advisory_xact_lock(hashtextextended('point-ledger:'||a.business_id::text,0));
    insert into app_private.point_fee_ledger(business_id,attempt_id,source_key,kind,base_cents,rate_bps,vat_bps,tariff_version,exact_numerator,period,occurred_at) values(a.business_id,a.id,'refund:'||a.id::text||':'||(x->>'id'),'refund',-amount,c.rate_bps,c.vat_bps,c.tariff_version,-amount::numeric*c.rate_bps,app_private.point_ledger_period(a.business_id,(x->>'confirmedAt')::timestamptz),(x->>'confirmedAt')::timestamptz);
   end if;
  end loop;
  select coalesce(sum(amount_cents),0) into used from app_private.point_refunds where attempt_id=a.id;
  update app_private.point_attempts set state=case when used=amount_cents then 'refunded' when used>0 then 'partially_refunded' when sale_state='materialized' then 'approved_verified' when observed_at>observed then point_attempts.state else state end,
   refunded_cents=used,remote_order_id=p->>'remoteOrderId',payment_id=coalesce(p->>'paymentId',payment_id),status_detail=left(p->>'statusDetail',120),observed_at=greatest(observed_at,observed),updated_at=clock_timestamp(),cancel_capability=coalesce(p->>'cancelCapability',cancel_capability) where id=a.id returning * into a;
  if a.state in ('rejected','cancelled','expired','approved_verified','partially_refunded','refunded') then
   delete from app_private.point_terminal_reservations where attempt_id=a.id;
   if a.sale_state<>'materialized' then update app_private.checkout_attempts set status='aborted',resolved_at=clock_timestamp(),revision=revision+1 where business_id=a.business_id and id=c.checkout_attempt_id; end if;
  else update app_private.checkout_attempts set status='uncertain',revision=revision+1 where business_id=a.business_id and id=c.checkout_attempt_id and status<>'completed'; end if;
  return jsonb_build_object('applied',true,'checkout',app_private.point_checkout_json(c));
 else raise exception 'VALIDATION_ERROR'; end if;
end $$;
create function app_private.point_command(p_business uuid,p_employee uuid,p jsonb) returns jsonb language plpgsql set search_path='' as $$
#variable_conflict use_variable
declare e app_private.employees%rowtype; c app_private.point_checkouts%rowtype; a app_private.point_attempts%rowtype;
 q app_private.checkout_attempts%rowtype; t app_private.point_terminals%rowtype; con app_private.point_connections%rowtype; cfg app_private.point_settings%rowtype;
 op app_private.point_operations%rowtype; st app_private.point_statements%rowtype; cmd text:=p->>'command'; fields text[];
 result jsonb; operation_id uuid; fingerprint bytea; attempt_id uuid; amount bigint; used bigint; vat integer; n numeric; allocated bigint; net bigint; tax bigint; lines jsonb:='[]'; period_date date;
begin
 select * into e from app_private.employees where business_id=p_business and id=p_employee and active and deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if e.user_id is not null then perform app_private.assert_member(e.user_id,p_business); end if;
 fields:=case cmd
 when 'settings' then '{}' when 'recover' then '{}' when 'verify_connection' then '{}' when 'resources' then '{}' when 'disconnect' then '{}'
 when 'oauth_start' then array['operationId']||case when p ? 'environment' then array['environment'] else '{}'::text[] end
 when 'oauth_callback' then array['state']||case when p ? 'error' then array['error'] else array['code'] end when 'create_branch' then array['operationId','name','location'] when 'create_register' then array['operationId','branchId','name']
 when 'link_terminal' then array['operationId','serial','branchId','registerId'] when 'test_terminal' then array['terminalId'] when 'activate' then array['enabled']
 when 'prepare' then array['operationId','checkoutAttemptId','terminalId'] when 'start' then array['operationId','checkoutId']
 when 'status' then array['checkoutId'] when 'cancel' then array['checkoutId'] when 'refund_context' then array['saleId'] when 'incident' then array['operationId','checkoutId','reason']
 when 'refund' then array['operationId','checkoutId','amountCents','merchandiseCents','tipCents','reason']
 when 'merchant_report' then array['from','to'] when 'admin_report' then array['from','to']||case when p ? 'cursor' then array['cursor'] else '{}'::text[] end
 when 'statements' then '{}' when 'close_statement' then array['operationId','period']
 when 'mark_statement_invoiced' then array['operationId','statementId','evidence'] when 'record_commission_payment' then array['operationId','statementId','amountCents','paidAt','evidence'] else null end;
 if fields is null then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.ops_exact(p,array['command']||fields);
 if cmd in ('oauth_start','oauth_callback','create_branch','create_register','verify_connection','resources','disconnect','link_terminal','test_terminal','activate','close_statement','mark_statement_invoiced','record_commission_payment') and e.role<>'owner' then raise exception 'PERMISSION_DENIED'; end if;
 if cmd in ('prepare','start','status','cancel','incident','recover') and not app_private.has_permission(p_business,p_employee,'sales.create') then raise exception 'PERMISSION_DENIED'; end if;
 if cmd in ('refund','refund_context') and not app_private.has_permission(p_business,p_employee,'sales.reverse') then raise exception 'PERMISSION_DENIED'; end if;
 if cmd='refund_context' then
  select pc.* into c from app_private.point_checkouts pc join app_private.checkout_attempts ca on ca.business_id=pc.business_id and ca.id=pc.checkout_attempt_id where pc.business_id=p_business and ca.sale_id=app_private.ops_uuid(p->'saleId');
  if not found then raise exception 'POINT_CHECKOUT_NOT_FOUND'; end if;
  return jsonb_build_object('data',app_private.point_checkout_json(c));
 end if;
 if cmd in ('merchant_report','statements') and not app_private.has_permission(p_business,p_employee,'reports.read') then raise exception 'PERMISSION_DENIED'; end if;
 if cmd='admin_report' then
  if coalesce(current_setting('app.point_session_kind',true),'')='device' or e.user_id is null or not exists(select 1 from app_private.sasori_admins where user_id=e.user_id and active) then raise exception 'POINT_ADMIN_DENIED'; end if;
  insert into app_private.sasori_admin_audit(user_id,actor,action,reason) values(e.user_id,e.user_id::text,'report_read',(p->>'from')||'/'||(p->>'to'));
  return jsonb_build_object('data',app_private.point_report(null,(p->>'from')::date,(p->>'to')::date,p->>'cursor'));
 end if;
 if cmd='merchant_report' then return jsonb_build_object('data',app_private.point_report(p_business,(p->>'from')::date,(p->>'to')::date,null)); end if;
 if p ? 'checkoutId' then
  select * into c from app_private.point_checkouts where business_id=p_business and id=app_private.ops_uuid(p->'checkoutId') for update;
  if not found or cmd<>'refund' and c.actor_identity<>p_employee and not app_private.has_permission(p_business,p_employee,'orders.manage') then raise exception 'POINT_CHECKOUT_NOT_FOUND'; end if;
  select * into a from app_private.point_attempts where business_id=p_business and id=c.active_attempt_id for update;
  select * into q from app_private.checkout_attempts where business_id=p_business and id=c.checkout_attempt_id for update;
 end if;
 if p ? 'operationId' and cmd not in ('oauth_start','create_branch','create_register','link_terminal') then
  operation_id:=app_private.ops_uuid(p->'operationId'); fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
  perform pg_advisory_xact_lock(hashtextextended('point-operation:'||p_business::text||':'||operation_id::text,0));
  select * into op from app_private.point_operations where business_id=p_business and point_operations.operation_id=operation_id;
  if found then if op.actor_identity<>p_employee or op.fingerprint<>fingerprint then raise exception 'OPERATION_CONFLICT'; end if; return jsonb_build_object('data',op.result); end if;
 end if;
 if cmd='settings' then return jsonb_build_object('data',app_private.point_settings_json(p_business,p_employee)); end if;
 if cmd='recover' then return jsonb_build_object('data',jsonb_build_object('checkouts',app_private.point_settings_json(p_business,p_employee)->'pending')); end if;
 if cmd='statements' then return jsonb_build_object('data',jsonb_build_object('statements',coalesce((select jsonb_agg(app_private.point_statement_json(s) order by s.period desc) from app_private.point_statements s where s.business_id=p_business),'[]'::jsonb))); end if;
 select * into cfg from app_private.point_settings where business_id=p_business;
 select * into con from app_private.point_connections where business_id=p_business and status='connected';
 if cmd in ('oauth_start','oauth_callback','create_branch','create_register','verify_connection','resources','link_terminal','test_terminal') then
  if cmd not in ('oauth_start','oauth_callback') and con.id is null then raise exception 'POINT_CONNECTION_REQUIRED'; end if;
  if cmd='oauth_start' and coalesce(p->>'environment','sandbox') not in ('live','sandbox') then raise exception 'VALIDATION_ERROR'; end if;
  if cmd='test_terminal' then select * into t from app_private.point_terminals where business_id=p_business and id=p->>'terminalId'; if not found then raise exception 'POINT_TERMINAL_NOT_READY'; end if; end if;
  result:=jsonb_build_object('backendDirective',jsonb_build_object('kind',cmd,'businessId',p_business,'connectionId',con.id,'environment',coalesce(p->>'environment',con.environment,'sandbox'),'terminalId',t.id,'serial',t.serial,'branchId',t.branch_id,'registerId',t.register_id));
 elsif cmd='activate' then
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
  if p->'enabled'='true'::jsonb and (con.id is null or con.verified_at is null or not exists(select 1 from app_private.point_terminals where business_id=p_business and connection_id=con.id and active and verified and mode='PDV' and not physical_steps_pending)) then raise exception 'POINT_TERMINAL_NOT_READY'; end if;
  insert into app_private.point_settings(business_id,enabled) values(p_business,(p->>'enabled')::boolean) on conflict(business_id) do update set enabled=excluded.enabled,updated_at=clock_timestamp();
  result:=app_private.point_settings_json(p_business,p_employee);
 elsif cmd='disconnect' then
  update app_private.point_settings set enabled=false where business_id=p_business;
  update app_private.point_connections set status='revoked' where business_id=p_business and status='connected';
  result:=app_private.point_settings_json(p_business,p_employee);
 elsif cmd='prepare' then
  if not coalesce(cfg.enabled,false) then raise exception 'POINT_DISABLED'; end if;
  if con.id is null or con.verified_at is null then raise exception 'POINT_CONNECTION_REQUIRED'; end if;
  select * into t from app_private.point_terminals where business_id=p_business and id=p->>'terminalId' and connection_id=con.id for share;
  if not found or not t.active or not t.verified or t.mode<>'PDV' or t.physical_steps_pending then raise exception 'POINT_TERMINAL_NOT_READY'; end if;
  select * into q from app_private.checkout_attempts where business_id=p_business and id=app_private.ops_uuid(p->'checkoutAttemptId') for update;
  if not found or q.actor_identity<>p_employee and not app_private.has_permission(p_business,p_employee,'orders.manage') then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  if q.status<>'prepared' or q.kind<>'payment' or q.payment_method<>'card_integrated' or q.total_cents<=0 then raise exception 'POINT_STATE_INVALID'; end if;
  insert into app_private.point_checkouts(business_id,checkout_attempt_id,actor_identity,terminal_id,connection_id,timezone,rate_bps,vat_bps,tariff_version)
   values(p_business,q.id,p_employee,t.id,con.id,(select timezone from app_private.businesses where id=p_business),cfg.rate_bps,cfg.vat_bps,cfg.tariff_version) returning * into c;
  result:=app_private.point_checkout_json(c);
 elsif cmd='start' then
  if a.id is not null and a.state not in ('rejected','cancelled','expired') then return jsonb_build_object('data',app_private.point_checkout_json(c)); end if;
  if not coalesce(cfg.enabled,false) then raise exception 'POINT_DISABLED'; end if;
  if con.id is null or con.id<>c.connection_id then raise exception 'POINT_CONNECTION_REQUIRED'; end if;
  select * into t from app_private.point_terminals where business_id=p_business and id=c.terminal_id for update;
  if not t.active or not t.verified or t.mode<>'PDV' or t.physical_steps_pending then raise exception 'POINT_TERMINAL_NOT_READY'; end if;
  if exists(select 1 from app_private.point_terminal_reservations where connection_id=con.id and terminal_id=t.id) then raise exception 'POINT_TERMINAL_BUSY'; end if;
  if q.status not in ('prepared','aborted') or q.sale_id is not null then raise exception 'POINT_STATE_INVALID'; end if;
  attempt_id:=gen_random_uuid();
  insert into app_private.point_attempts(id,business_id,checkout_id,connection_id,terminal_id,idempotency_key,create_payload,amount_cents,receiver_id,environment,external_reference)
   values(attempt_id,p_business,c.id,con.id,t.id,attempt_id,jsonb_build_object('type','point','external_reference','sasori_'||attempt_id::text,
    'transactions',jsonb_build_object('payments',jsonb_build_array(jsonb_build_object('amount',to_char(q.total_cents::numeric/100,'FM999999999999990.00')))),
    'config',jsonb_build_object('point',jsonb_build_object('terminal_id',t.id,'print_on_terminal','no_ticket')),'expiration_time','PT15M'),q.total_cents,con.receiver_id,con.environment,'sasori_'||attempt_id::text) returning * into a;
  insert into app_private.point_terminal_reservations(business_id,connection_id,terminal_id,attempt_id) values(p_business,con.id,t.id,attempt_id);
  update app_private.point_checkouts set active_attempt_id=attempt_id,updated_at=clock_timestamp() where id=c.id returning * into c;
  update app_private.checkout_attempts set status='collection_started',resolved_at=null,revision=revision+1 where business_id=p_business and id=q.id;
  insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key) values(p_business,con.id,a.id,'create_order','create:'||a.id::text);
  result:=app_private.point_checkout_json(c);
 elsif cmd='status' then result:=app_private.point_checkout_json(c);
 elsif cmd='cancel' then
  if a.id is null then
   update app_private.checkout_attempts set status='aborted',resolved_at=clock_timestamp(),revision=revision+1 where business_id=p_business and id=q.id;
  elsif a.state in ('pending','sent_to_terminal','processing','unknown_review') then
   if a.cancel_capability='backend' and a.remote_order_id is not null then insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key) values(p_business,a.connection_id,a.id,'cancel_order','cancel:'||a.id::text) on conflict(dedupe_key) do nothing; end if;
  else raise exception 'POINT_STATE_INVALID'; end if;
  result:=app_private.point_checkout_json(c);
 elsif cmd='incident' then
  if a.id is null then raise exception 'POINT_STATE_INVALID'; end if;
  perform app_private.ops_text(p->'reason',1,200);
  insert into app_private.point_incidents(business_id,attempt_id,code,evidence,actor_identity) values(p_business,a.id,'operator_report',jsonb_build_object('reason',p->>'reason'),p_employee);
  result:=app_private.point_checkout_json(c);
 elsif cmd='refund' then
  if a.sale_state<>'materialized' or a.state not in ('approved_verified','partially_refunded') or a.remote_order_id is null or a.verified_at<clock_timestamp()-interval '90 days' then raise exception 'POINT_STATE_INVALID'; end if;
  amount:=app_private.ops_int(p->'amountCents',1,9999999999); perform app_private.ops_int(p->'merchandiseCents',0,9999999999); perform app_private.ops_int(p->'tipCents',0,9999999999); perform app_private.ops_text(p->'reason',1,200);
  -- Current operational snapshots contain merchandise only and no tips. Never invent an allocation.
  if amount<>(p->>'merchandiseCents')::bigint or (p->>'tipCents')::bigint<>0 then raise exception 'POINT_REFUND_ALLOCATION_REQUIRED'; end if;
  select coalesce(sum(r.amount_cents),0) into used from app_private.point_refund_requests r where r.attempt_id=a.id and r.status in ('pending','unknown_review');
  if a.refunded_cents+used+amount>a.amount_cents then raise exception 'POINT_REFUND_LIMIT'; end if;
  insert into app_private.point_refund_requests(business_id,attempt_id,actor_identity,operation_id,idempotency_key,amount_cents,merchandise_cents,tip_cents,reason)
   values(p_business,a.id,p_employee,operation_id,operation_id,amount,amount,0,p->>'reason') returning id into attempt_id;
  insert into app_private.point_jobs(business_id,connection_id,attempt_id,refund_id,kind,dedupe_key,payload) values(p_business,a.connection_id,a.id,attempt_id,'refund_order','refund:'||attempt_id::text,jsonb_build_object('refundAmountCents',amount,'idempotencyKey',operation_id,'totalRefund',amount=a.amount_cents));
  result:=app_private.point_checkout_json(c);
 elsif cmd='close_statement' then
  if p->>'period' !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'VALIDATION_ERROR'; end if;
  period_date:=((p->>'period')||'-01')::date;
  if period_date>=date_trunc('month',clock_timestamp() at time zone (select timezone from app_private.businesses where id=p_business))::date then raise exception 'POINT_STATE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('point-ledger:'||p_business::text,0));
  if exists(select 1 from app_private.point_statements where business_id=p_business and period>=period_date) then raise exception 'POINT_PERIOD_CLOSED'; end if;
  net:=0; tax:=0;
  for vat,n,allocated in
   with buckets as (select l.vat_bps,sum(l.exact_numerator) n from app_private.point_fee_ledger l where l.business_id=p_business and l.period<=period_date group by l.vat_bps),
   ranked as (select b.*,floor(b.n/10000) base,row_number() over(order by mod(b.n,10000) desc,b.vat_bps) rank,
    round(sum(b.n) over()/10000)-sum(floor(b.n/10000)) over() remainder from buckets b)
   select r.vat_bps,r.n,(r.base+case when r.rank<=r.remainder then 1 else 0 end)::bigint from ranked r order by r.vat_bps loop
   amount:=allocated-coalesce((select sum(sl.net_cents) from app_private.point_statement_lines sl join app_private.point_statements ss on ss.id=sl.statement_id where ss.business_id=p_business and ss.period<period_date and sl.vat_bps=vat),0);
   used:=round(allocated::numeric*vat/10000)::bigint-coalesce((select sum(sl.vat_cents) from app_private.point_statement_lines sl join app_private.point_statements ss on ss.id=sl.statement_id where ss.business_id=p_business and ss.period<period_date and sl.vat_bps=vat),0);
   net:=net+amount; tax:=tax+used; lines:=lines||jsonb_build_array(jsonb_build_object('vatBps',vat,'cumulativeNumerator',n::text,'netCents',amount,'vatCents',used));
  end loop;
  insert into app_private.point_statements(business_id,period,exact_numerator,net_cents,vat_cents,total_cents,snapshot,closed_by)
   values(p_business,period_date,coalesce((select sum(exact_numerator) from app_private.point_fee_ledger where business_id=p_business and period=period_date),0),net,tax,net+tax,jsonb_build_object('rounding','cumulative-net-once-largest-remainder-original-VAT','lines',lines,'ledgerIds',coalesce((select jsonb_agg(id order by id) from app_private.point_fee_ledger where business_id=p_business and period<=period_date),'[]')),p_employee) returning * into st;
  insert into app_private.point_statement_lines(business_id,statement_id,vat_bps,exact_numerator,net_cents,vat_cents) select p_business,st.id,(l->>'vatBps')::integer,(l->>'cumulativeNumerator')::numeric,(l->>'netCents')::bigint,(l->>'vatCents')::bigint from jsonb_array_elements(lines) l;
  result:=app_private.point_statement_json(st);
 elsif cmd in ('record_commission_payment','mark_statement_invoiced') then
  select * into st from app_private.point_statements where business_id=p_business and id=app_private.ops_uuid(p->'statementId') for update;
  if not found then raise exception 'POINT_STATE_INVALID'; end if; perform app_private.ops_text(p->'evidence',1,300);
  if cmd='mark_statement_invoiced' then update app_private.point_statements set status='invoiced',evidence=p->>'evidence' where id=st.id returning * into st;
  else
   if st.status<>'invoiced' then raise exception 'POINT_STATE_INVALID'; end if;
   amount:=app_private.ops_int(p->'amountCents',1,9999999999);
   select coalesce(sum(amount_cents),0) into used from app_private.point_commission_payments where statement_id=st.id;
   if used+amount>st.total_cents then raise exception 'POINT_REFUND_LIMIT'; end if;
   if (p->>'paidAt')::timestamptz>clock_timestamp() then raise exception 'VALIDATION_ERROR'; end if;
   insert into app_private.point_commission_payments(business_id,statement_id,operation_id,amount_cents,paid_at,evidence,actor_identity) values(p_business,st.id,operation_id,amount,(p->>'paidAt')::timestamptz,p->>'evidence',p_employee);
  end if;
  result:=app_private.point_statement_json(st);
 else raise exception 'VALIDATION_ERROR'; end if;
 if operation_id is not null then insert into app_private.point_operations(business_id,operation_id,actor_identity,fingerprint,result) values(p_business,operation_id,p_employee,fingerprint,result); end if;
 return jsonb_build_object('data',result);
end $$;
create function app_private.point_checkout_json(c app_private.point_checkouts) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',c.id,'attemptId',a.id,'state',coalesce(a.state,'prepared'),'saleState',coalesce(a.sale_state,'pending'),
 'totalCents',q.total_cents,'refundedCents',coalesce(a.refunded_cents,0),'items',q.items,'checkout',app_private.ops_attempt_json(q),
 'sale',case when q.sale_id is null then null else (select app_private.sale_json(s) from app_private.sales s where s.business_id=c.business_id and s.id=q.sale_id) end,
 'terminal',app_private.point_terminal_json(t),'cancelCapability',coalesce(a.cancel_capability,'unavailable'),'updatedAt',coalesce(a.updated_at,c.updated_at),'statusDetail',a.status_detail,'remoteOrderId',a.remote_order_id)
 from app_private.checkout_attempts q join app_private.point_terminals t on t.business_id=c.business_id and t.id=c.terminal_id
 left join app_private.point_attempts a on a.business_id=c.business_id and a.id=c.active_attempt_id
 where q.business_id=c.business_id and q.id=c.checkout_attempt_id;
$$;
create function app_private.point_statement_json(s app_private.point_statements) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'period',to_char(s.period,'YYYY-MM'),'status',s.status,'exactNumerator',s.exact_numerator::text,'netCents',s.net_cents,'vatCents',s.vat_cents,'totalCents',s.total_cents,
 'collectedCents',coalesce((select sum(p.amount_cents) from app_private.point_commission_payments p where p.business_id=s.business_id and p.statement_id=s.id),0),
 'remainingCents',s.total_cents-coalesce((select sum(p.amount_cents) from app_private.point_commission_payments p where p.business_id=s.business_id and p.statement_id=s.id),0),'closedAt',s.closed_at);
$$;
create function app_private.point_settings_json(p_business uuid,p_employee uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('enabled',coalesce(s.enabled,false),'connection',(select jsonb_build_object('id',c.id,'status',c.status,'environment',c.environment,'receiverId',c.receiver_id,'verifiedAt',c.verified_at) from app_private.point_connections c where c.business_id=p_business order by (c.status='connected') desc,c.created_at desc limit 1),
 'terminals',coalesce((select jsonb_agg(app_private.point_terminal_json(t) order by t.id) from app_private.point_terminals t where t.business_id=p_business),'[]'::jsonb),
 'pending',coalesce((select jsonb_agg(app_private.point_checkout_json(c) order by c.created_at) from app_private.point_checkouts c join app_private.checkout_attempts q on q.business_id=c.business_id and q.id=c.checkout_attempt_id where c.business_id=p_business and q.status in ('prepared','collection_started','uncertain') and (c.actor_identity=p_employee or app_private.has_permission(p_business,p_employee,'orders.manage'))),'[]'::jsonb),
 'permissions',jsonb_build_object('manage',e.role='owner','charge',app_private.has_permission(p_business,p_employee,'sales.create'),'refund',app_private.has_permission(p_business,p_employee,'sales.reverse'),'reports',app_private.has_permission(p_business,p_employee,'reports.read'),'admin',exists(select 1 from app_private.sasori_admins a where a.user_id=e.user_id and a.active)),
 'commission',jsonb_build_object('rateBps',coalesce(s.rate_bps,30),'vatBps',coalesce(s.vat_bps,1600),'version',coalesce(s.tariff_version,'sasori-0.30-v1')),'asOf',clock_timestamp())
 from app_private.employees e left join app_private.point_settings s on s.business_id=p_business where e.business_id=p_business and e.id=p_employee;
$$;
do $grants$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='app_private'::regnamespace and (proname like 'point_%' or proname in ('account_secure_before_point','pos_command_before_point','employee_context_before_point','employee_context','pos_command')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end $grants$;
revoke all on function public.point_service(text,jsonb),public.point_execute(uuid,uuid,uuid,text,jsonb),public.point_device(text,text,jsonb),public.account_secure(uuid,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.point_service(text,jsonb),public.point_execute(uuid,uuid,uuid,text,jsonb),public.point_device(text,text,jsonb),public.account_secure(uuid,uuid,text,jsonb,text,uuid) to service_role;
