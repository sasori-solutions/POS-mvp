-- Personal analytics resolve the employee from the authorized operator. No caller
-- can choose another employee, and existing report grants are not expanded.
create or replace function app_private.permission_keys()
returns text[] language sql immutable set search_path='' as $$
 select array['catalog.read','catalog.manage','catalog.availability','sales.create','sales.read_own','sales.read_all','sales.discount','sales.reverse','orders.read','orders.manage','orders.cancel','kitchen.read','kitchen.operate','cash.read','cash.open','cash.move','cash.close','reports.read','reports.read_own','tables.manage']::text[];
$$;

-- Preserve the accepted financial definition and immutable item snapshots, with
-- employee ID predicates (never names) on both original sales and their refunds.
do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_report_window_before_point(uuid,timestamptz,timestamptz)'::regprocedure) into definition;
 needle:='app_private.ops_report_window_before_point(p_business uuid, p_start timestamp with time zone, p_end timestamp with time zone)';
 if position(needle in definition)=0 then raise exception 'Unexpected employee report base'; end if;
 definition:=replace(definition,needle,'app_private.ops_employee_report_window_base(p_business uuid, p_employee uuid, p_start timestamp with time zone, p_end timestamp with time zone)');
 needle:='select * from app_private.sales where business_id=p_business and';
 if position(needle in definition)=0 then raise exception 'Unexpected employee sales predicate'; end if;
 definition:=replace(definition,needle,'select * from app_private.sales where business_id=p_business and employee_id=p_employee and');
 needle:='select * from app_private.sale_reversals where business_id=p_business and';
 if position(needle in definition)=0 then raise exception 'Unexpected employee reversal predicate'; end if;
 definition:=replace(definition,needle,'select r.* from app_private.sale_reversals r where business_id=p_business and exists(select 1 from app_private.sales original where original.business_id=r.business_id and original.id=r.sale_id and original.employee_id=p_employee) and');
 needle:='from app_private.balance_waivers where business_id=p_business and';
 if position(needle in definition)=0 then raise exception 'Unexpected employee waiver predicate'; end if;
 definition:=replace(definition,needle,'from app_private.balance_waivers where business_id=p_business and actor_id=p_employee and');
 needle:='from app_private.cash_shifts where business_id=p_business and';
 if position(needle in definition)=0 then raise exception 'Unexpected employee drawer predicate'; end if;
 definition:=replace(definition,needle,'from app_private.cash_shifts where false and business_id=p_business and');
 execute definition;
end $migration$;

-- Provider refunds belong to the employee on the original immutable receipt,
-- even when another authorized person handles the refund or materialization.
create view app_private.ops_employee_reporting_reversals as
 select r.business_id,s.employee_id,r.amount_cents,r.created_at
 from app_private.sale_reversals r join app_private.sales s on s.business_id=r.business_id and s.id=r.sale_id
 union all
 select r.business_id,s.employee_id,r.amount_cents,r.confirmed_at
 from app_private.point_refunds r
 join app_private.point_attempts a on a.business_id=r.business_id and a.id=r.attempt_id
 join app_private.point_checkouts c on c.business_id=a.business_id and c.id=a.checkout_id
 join app_private.checkout_attempts q on q.business_id=c.business_id and q.id=c.checkout_attempt_id
 join app_private.sales s on s.business_id=q.business_id and s.id=q.sale_id;

create function app_private.ops_employee_report_window(p_business uuid,p_employee uuid,p_start timestamptz,p_end timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare report jsonb; refunds bigint; integrated bigint;
begin
 report:=app_private.ops_employee_report_window_base(p_business,p_employee,p_start,p_end);
 select coalesce(sum(r.amount_cents),0) into refunds from app_private.point_refunds r
 join app_private.point_attempts a on a.business_id=r.business_id and a.id=r.attempt_id
 join app_private.point_checkouts c on c.business_id=a.business_id and c.id=a.checkout_id
 join app_private.checkout_attempts q on q.business_id=c.business_id and q.id=c.checkout_attempt_id
 join app_private.sales s on s.business_id=q.business_id and s.id=q.sale_id
 where r.business_id=p_business and s.employee_id=p_employee and r.confirmed_at>=p_start and r.confirmed_at<p_end;
 select coalesce(sum(total_cents),0) into integrated from app_private.sales
 where business_id=p_business and employee_id=p_employee and payment_method='card_integrated' and created_at>=p_start and created_at<p_end;
 return report||jsonb_build_object(
  'reversalCents',(report->>'reversalCents')::bigint+refunds,'netCents',(report->>'netCents')::bigint-refunds,
  'unallocatedRefundCents',refunds,'unknownReversalTaxCents',refunds,
  'operators','[]'::jsonb,'cashDifferences','[]'::jsonb,
  'payments',(report->'payments')||jsonb_build_array(jsonb_build_object('paymentMethod','card_integrated','salesCents',integrated,'reversalCents',refunds,'netCents',integrated-refunds)));
end; $$;

-- Reuse the calendar/DST/partial-window rules, changing only data scope.
do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_report_series(uuid,date,date,text,text,timestamptz)'::regprocedure) into definition;
 needle:='app_private.ops_report_series(p_business uuid, p_first date, p_last date, p_period text, p_zone text, p_cutoff timestamp with time zone)';
 if position(needle in definition)=0 then raise exception 'Unexpected employee series signature'; end if;
 definition:=replace(definition,needle,'app_private.ops_employee_report_series(p_business uuid, p_employee uuid, p_first date, p_last date, p_period text, p_zone text, p_cutoff timestamp with time zone)');
 needle:='join app_private.sales s on s.business_id=p_business';
 if position(needle in definition)=0 then raise exception 'Unexpected employee series sales'; end if;
 definition:=replace(definition,needle,needle||' and s.employee_id=p_employee');
 needle:='join app_private.ops_reporting_reversals r on r.business_id=p_business';
 if position(needle in definition)=0 then raise exception 'Unexpected employee series reversals'; end if;
 definition:=replace(definition,needle,'join app_private.ops_employee_reporting_reversals r on r.business_id=p_business and r.employee_id=p_employee');
 execute definition;

 select pg_get_functiondef('app_private.ops_period_report_at(uuid,date,text,timestamptz)'::regprocedure) into definition;
 needle:='app_private.ops_period_report_at(p_business uuid, p_date date, p_period text, p_as_of timestamp with time zone)';
 if position(needle in definition)=0 then raise exception 'Unexpected employee calendar signature'; end if;
 definition:=replace(definition,needle,'app_private.ops_employee_period_report_at(p_business uuid, p_employee uuid, p_date date, p_period text, p_as_of timestamp with time zone)');
 definition:=replace(definition,'app_private.ops_report_window(p_business,','app_private.ops_employee_report_window(p_business,p_employee,');
 definition:=replace(definition,'app_private.ops_report_series(p_business,','app_private.ops_employee_report_series(p_business,p_employee,');
 execute definition;
end $migration$;

alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_employee_metrics;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
begin
 if p_payload->>'command'='report_own_period' then
  -- Exact existing report validation rejects actor IDs, names and any other keys.
  perform app_private.ops_validate((p_payload-array['action','businessId','operatorToken','deviceToken','command'])||jsonb_build_object('command','report_period'));
  if not app_private.has_permission(p_business_id,p_employee_id,'reports.read_own') then raise exception 'PERMISSION_DENIED'; end if;
  return jsonb_build_object('data',app_private.ops_employee_period_report_at(p_business_id,p_employee_id,(p_payload->>'date')::date,p_payload->>'period',clock_timestamp()));
 end if;
 return app_private.pos_command_before_employee_metrics(p_business_id,p_employee_id,p_payload);
end; $$;

revoke all on app_private.ops_employee_reporting_reversals from public,anon,authenticated;
grant select on app_private.ops_employee_reporting_reversals to service_role;
revoke all on function app_private.ops_employee_report_window_base(uuid,uuid,timestamptz,timestamptz),app_private.ops_employee_report_window(uuid,uuid,timestamptz,timestamptz),app_private.ops_employee_report_series(uuid,uuid,date,date,text,text,timestamptz),app_private.ops_employee_period_report_at(uuid,uuid,date,text,timestamptz),app_private.pos_command_before_employee_metrics(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.ops_employee_report_window_base(uuid,uuid,timestamptz,timestamptz),app_private.ops_employee_report_window(uuid,uuid,timestamptz,timestamptz),app_private.ops_employee_report_series(uuid,uuid,date,date,text,text,timestamptz),app_private.ops_employee_period_report_at(uuid,uuid,date,text,timestamptz),app_private.pos_command_before_employee_metrics(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) to service_role;
