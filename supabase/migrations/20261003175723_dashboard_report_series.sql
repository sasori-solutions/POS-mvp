-- Additive report data for owner charts. Existing commands, filters and financial
-- definitions retain their authorization, calendar and immutable snapshots.
create index sale_reversals_report_idx on app_private.sale_reversals(business_id,created_at);

create function app_private.ops_report_series(p_business uuid,p_first date,p_last date,p_period text,p_zone text,p_cutoff timestamptz)
returns jsonb language sql stable set search_path='' as $$
 with bounds as (
  select p_first::timestamp at time zone p_zone first_at,(p_last+1)::timestamp at time zone p_zone last_at
 ), buckets as (
  select bucket start_at,least(bucket+interval '1 hour',b.last_at) end_at
  from bounds b cross join lateral generate_series(b.first_at,b.last_at-interval '1 microsecond',interval '1 hour') bucket
  where p_period='day'
  union all
  select day::timestamp at time zone p_zone,(day::date+1)::timestamp at time zone p_zone
  from generate_series(p_first::timestamp,p_last::timestamp,interval '1 day') day where p_period<>'day'
 ), labels as (
  select *,to_char(start_at at time zone p_zone,'HH24:MI') hour_label,
   row_number() over(partition by to_char(start_at at time zone p_zone,'HH24:MI') order by start_at)-1 occurrence
  from buckets
 ), sales as (
  select b.start_at,sum(s.total_cents) cents,count(*) receipts
  from buckets b join app_private.sales s on s.business_id=p_business
   and s.created_at>=b.start_at and s.created_at<least(b.end_at,p_cutoff)
  group by b.start_at
 ), reversals as (
  select b.start_at,sum(r.amount_cents) cents
  from buckets b join app_private.sale_reversals r on r.business_id=p_business
   and r.created_at>=b.start_at and r.created_at<least(b.end_at,p_cutoff)
  group by b.start_at
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'start',b.start_at,'end',b.end_at,
  'slot',case when p_period='day' then 'hour:'||b.hour_label||':'||b.occurrence
   else 'day:'||lpad(((b.start_at at time zone p_zone)::date-p_first+1)::text,2,'0') end,
  'label',case when p_period='day' then b.hour_label else to_char(b.start_at at time zone p_zone,'DD Mon') end,
  'salesCents',coalesce(s.cents,0),'reversalCents',coalesce(r.cents,0),
  'netCents',coalesce(s.cents,0)-coalesce(r.cents,0),'saleCount',coalesce(s.receipts,0),
  'future',b.start_at>=p_cutoff) order by b.start_at),'[]'::jsonb)
 from labels b left join sales s on s.start_at=b.start_at left join reversals r on r.start_at=b.start_at;
$$;

-- Count the instants corresponding to a local cutoff, including repeated/missing
-- times at DST transitions. Nearby offsets are derived from the same IANA zone.
create function app_private.ops_local_cutoff(p_local timestamp,p_zone text)
returns table(instant timestamptz,matches bigint) language sql stable set search_path='' as $$
 with offsets as (
  select distinct (sample at time zone p_zone)-(sample at time zone 'UTC') offset_value
  from generate_series((p_local at time zone p_zone)-interval '2 days',(p_local at time zone p_zone)+interval '2 days',interval '1 hour') sample
 ), candidates as (
  select (p_local-offset_value) at time zone 'UTC' candidate from offsets
 ), valid as (
  select candidate from candidates where candidate at time zone p_zone=p_local
 )
 select coalesce(min(candidate),p_local at time zone p_zone),count(*) from valid;
$$;

-- Keep the accepted transport free of caller-supplied time. The private helper
-- provides one fixed asOf to every total and bucket in this snapshot.
create function app_private.ops_period_report_at(p_business uuid,p_date date,p_period text,p_as_of timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare zone text; first_day date; last_day date; previous_first date; previous_last date;
 local_now timestamp; start_at timestamptz; end_at timestamptz; cutoff timestamptz;
 previous_start timestamptz; previous_end timestamptz; previous_cutoff timestamptz;
 partial boolean; comparable boolean; previous_local timestamp; current_matches bigint; previous_matches bigint;
begin
 if p_period not in ('day','week','month') or p_period is null or p_date not between date '2000-01-01' and date '2100-12-31' or p_date is null or p_as_of is null then raise exception 'VALIDATION_ERROR'; end if;
 select timezone into zone from app_private.businesses where id=p_business;
 if zone is null then raise exception 'BUSINESS_ACCESS_DENIED'; end if;
 local_now:=p_as_of at time zone zone;
 first_day:=case p_period when 'day' then p_date when 'week' then date_trunc('week',p_date::timestamp)::date else date_trunc('month',p_date::timestamp)::date end;
 last_day:=case p_period when 'day' then first_day when 'week' then first_day+6 else (first_day+interval '1 month'-interval '1 day')::date end;
 previous_first:=case p_period when 'day' then first_day-1 when 'week' then first_day-7 else (first_day-interval '1 month')::date end;
 previous_last:=first_day-1;
 start_at:=first_day::timestamp at time zone zone; end_at:=(last_day+1)::timestamp at time zone zone;
 previous_start:=previous_first::timestamp at time zone zone; previous_end:=first_day::timestamp at time zone zone;
 cutoff:=greatest(start_at,least(end_at,p_as_of));
 partial:=p_as_of>=start_at and p_as_of<end_at;
 comparable:=p_as_of>=start_at;
 if p_as_of<start_at then previous_cutoff:=previous_start;
 elsif not partial then previous_cutoff:=previous_end;
 else
  previous_local:=previous_first+(local_now::date-first_day)+local_now::time;
  select c.instant,c.matches into previous_cutoff,previous_matches from app_private.ops_local_cutoff(previous_local,zone) c;
  select c.matches into current_matches from app_private.ops_local_cutoff(local_now,zone) c;
  previous_cutoff:=greatest(previous_start,least(previous_end,previous_cutoff));
  comparable:=local_now::date-first_day<first_day-previous_first
   and current_matches=1 and previous_matches=1
   and cutoff-start_at=previous_cutoff-previous_start;
 end if;
 return jsonb_build_object('period',p_period,'startDate',first_day,'endDate',last_day,'timezone',zone,
  'partial',partial,'asOf',p_as_of,'cutoff',cutoff,'previousCutoff',previous_cutoff,
  'comparisonStartDate',previous_first,'comparisonEndDate',previous_last,'comparisonComparable',comparable,
  'totals',app_private.ops_report_window(p_business,start_at,cutoff),
  'previous',app_private.ops_report_window(p_business,previous_start,previous_cutoff),
  'series',app_private.ops_report_series(p_business,first_day,last_day,p_period,zone,cutoff),
  'previousSeries',app_private.ops_report_series(p_business,previous_first,previous_last,p_period,zone,previous_cutoff));
end;
$$;

create or replace function app_private.ops_period_report(p_business uuid,p_date date,p_period text)
returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_period_report_at(p_business,p_date,p_period,clock_timestamp());
$$;

revoke all on function app_private.ops_report_series(uuid,date,date,text,text,timestamptz),app_private.ops_local_cutoff(timestamp,text),app_private.ops_period_report_at(uuid,date,text,timestamptz) from public,anon,authenticated;
grant execute on function app_private.ops_report_series(uuid,date,date,text,text,timestamptz),app_private.ops_local_cutoff(timestamp,text),app_private.ops_period_report_at(uuid,date,text,timestamptz) to service_role;
