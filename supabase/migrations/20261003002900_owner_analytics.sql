-- Reuse the accepted daily financial definition over a bounded timestamp window.
-- This preserves snapshots, effective refund dates and product refund allocations.
do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_report(uuid,date)'::regprocedure) into definition;
 needle:='app_private.ops_report(p_business uuid, p_day date)';
 if position(needle in definition)=0 then raise exception 'Unexpected report signature'; end if;
 definition:=replace(definition,needle,'app_private.ops_report_window(p_business uuid, p_start timestamp with time zone, p_end timestamp with time zone)');
 needle:='start_at:=p_day::timestamp at time zone timezone_name; end_at:=(p_day+1)::timestamp at time zone timezone_name;';
 if position(needle in definition)=0 then raise exception 'Unexpected report boundaries'; end if;
 definition:=replace(definition,needle,'start_at:=p_start; end_at:=p_end;');
 definition:=replace(definition,'''date'',p_day','''date'',(p_start at time zone timezone_name)::date');
 execute definition;
end $migration$;

create function app_private.ops_period_report(p_business uuid,p_date date,p_period text) returns jsonb
language plpgsql stable set search_path='' as $$
declare zone text; first_day date; last_day date; previous_first date; previous_last date;
 now_at timestamptz:=clock_timestamp(); local_now timestamp; start_at timestamptz; end_at timestamptz;
 cutoff timestamptz; previous_cutoff timestamptz; previous_start timestamptz; previous_end timestamptz;
 partial boolean; points jsonb;
begin
 if p_period not in ('day','week','month') or p_period is null or p_date not between date '2000-01-01' and date '2100-12-31' or p_date is null then raise exception 'VALIDATION_ERROR'; end if;
 select timezone into zone from app_private.businesses where id=p_business;
 if zone is null then raise exception 'BUSINESS_ACCESS_DENIED'; end if;
 local_now:=now_at at time zone zone;
 first_day:=case p_period when 'day' then p_date when 'week' then date_trunc('week',p_date::timestamp)::date else date_trunc('month',p_date::timestamp)::date end;
 last_day:=case p_period when 'day' then first_day when 'week' then first_day+6 else (first_day+interval '1 month'-interval '1 day')::date end;
 previous_first:=case p_period when 'day' then first_day-1 when 'week' then first_day-7 else (first_day-interval '1 month')::date end;
 previous_last:=first_day-1;
 start_at:=first_day::timestamp at time zone zone; end_at:=(last_day+1)::timestamp at time zone zone;
 previous_start:=previous_first::timestamp at time zone zone; previous_end:=first_day::timestamp at time zone zone;
 cutoff:=greatest(start_at,least(end_at,now_at));
 partial:=now_at>=start_at and now_at<end_at;
 previous_cutoff:=case when now_at<start_at then previous_start when partial then
  least(previous_end,(previous_first+(local_now::date-first_day)+local_now::time) at time zone zone) else previous_end end;
 if p_period='day' then
  select coalesce(jsonb_agg(jsonb_build_object('start',bucket,'label',to_char(bucket at time zone zone,'HH24:MI'),
   'salesCents',coalesce((select sum(s.total_cents) from app_private.sales s where s.business_id=p_business and s.created_at>=bucket and s.created_at<least(bucket+interval '1 hour',cutoff)),0),
   'future',bucket>=cutoff) order by bucket),'[]'::jsonb) into points
   from generate_series(start_at,end_at-interval '1 microsecond',interval '1 hour') bucket;
 else
  select coalesce(jsonb_agg(jsonb_build_object('start',day::timestamp at time zone zone,'label',to_char(day,'DD Mon'),
   'salesCents',coalesce((select sum(s.total_cents) from app_private.sales s where s.business_id=p_business and s.created_at>=day::timestamp at time zone zone and s.created_at<least((day::date+1)::timestamp at time zone zone,cutoff)),0),
   'future',day::timestamp at time zone zone>=cutoff) order by day),'[]'::jsonb) into points
   from generate_series(first_day::timestamp,last_day::timestamp,interval '1 day') day;
 end if;
 return jsonb_build_object('period',p_period,'startDate',first_day,'endDate',last_day,'timezone',zone,'partial',partial,'asOf',now_at,
  'comparisonStartDate',previous_first,'comparisonEndDate',previous_last,
  'comparisonComparable',now_at>=start_at and (not partial or local_now::date-first_day<first_day-previous_first),
  'totals',app_private.ops_report_window(p_business,start_at,cutoff),
  'previous',app_private.ops_report_window(p_business,previous_start,previous_cutoff),'series',points);
end; $$;

-- Preserve the existing validator/authorization/retry transport and add a read only command.
do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into definition;
 needle:='when ''report'' then array[''date'']';
 if position(needle in definition)=0 then raise exception 'Unexpected report validator'; end if;
 definition:=replace(definition,needle,needle||' when ''report_period'' then array[''date'',''period'']');
 needle:='if c=''report'' and';
 if position(needle in definition)=0 then raise exception 'Unexpected report date validation'; end if;
 definition:=replace(definition,needle,'if c in (''report'',''report_period'') and');
 needle:='exception when invalid_datetime_format';
 if position(needle in definition)=0 then raise exception 'Unexpected validator exception'; end if;
 definition:=replace(definition,needle,$body$
 if c='report_period' and (jsonb_typeof(p->'period') is distinct from 'string' or p->>'period' not in ('day','week','month') or (p->>'date')::date not between date '2000-01-01' and date '2100-12-31') then raise exception 'VALIDATION_ERROR'; end if;
 exception when invalid_datetime_format$body$);
 execute definition;
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:='when ''report'' then ''reports.read''';
 if position(needle in definition)=0 then raise exception 'Unexpected report permission'; end if;
 definition:=replace(definition,needle,needle||' when ''report_period'' then ''reports.read''');
 needle:='(''activate_operations'',''report'')';
 if position(needle in definition)=0 then raise exception 'Unexpected report availability'; end if;
 definition:=replace(definition,needle,'(''activate_operations'',''report'',''report_period'')');
 needle:='elsif c=''report'' then return jsonb_build_object(''data'',app_private.ops_report(p_business_id,(p->>''date'')::date));';
 if position(needle in definition)=0 then raise exception 'Unexpected report dispatch'; end if;
 definition:=replace(definition,needle,needle||' elsif c=''report_period'' then return jsonb_build_object(''data'',app_private.ops_period_report(p_business_id,(p->>''date'')::date,p->>''period''));');
 -- Refund-only staff need the current shift state and authorized reversal recovery.
 -- Existing response projections still redact drawer amounts and unrelated orders/payments.
 needle:='or app_private.has_permission(p_business_id,actor.id,''kitchen.read'')) then raise exception ''PERMISSION_DENIED'';';
 if position(needle in definition)=0 then raise exception 'Unexpected operations reader authorization'; end if;
 definition:=replace(definition,needle,'or app_private.has_permission(p_business_id,actor.id,''kitchen.read'') or app_private.has_permission(p_business_id,actor.id,''sales.reverse'')) then raise exception ''PERMISSION_DENIED'';');
 execute definition;
end $migration$;

revoke all on function app_private.ops_report_window(uuid,timestamptz,timestamptz),app_private.ops_period_report(uuid,date,text) from public,anon,authenticated;
grant execute on function app_private.ops_report_window(uuid,timestamptz,timestamptz),app_private.ops_period_report(uuid,date,text) to service_role;
