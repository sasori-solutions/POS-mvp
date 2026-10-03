-- Operational corrections found by real local concurrency and synthetic UI testing.
-- The original operations migration is retained; this also normalizes its validator revision.
alter table app_private.checkout_attempts add constraint checkout_attempts_business_fk
 foreign key(business_id) references app_private.businesses(id) on delete cascade;

-- Accepted counter retries use the accepted scope, while fresh commands authorize the
-- current table/order after acquiring the business mutex. A later table move must not
-- make an old accepted counter save or payment mutate or expose the new table account.
do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:='perform app_private.ops_validate(p);';
 replacement:=needle||$body$
 if c in ('save_order','prepare_checkout') then
  select jsonb_agg(i order by i->>'lineId') into lines from jsonb_array_elements(p->'items') i;
  p:=jsonb_set(p,'{items}',lines);
 end if;
$body$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational validator call'; end if;
 definition:=replace(definition,needle,replacement);
 needle:='own_counter:=o.id is not null and o.actor_id=actor.id and o.table_id is null;';
 replacement:=needle||$body$
  if not own_counter and o.actor_id=actor.id and create_sales and p ? 'operationId' then
   own_counter:=exists(select 1 from app_private.pos_operations accepted
    where accepted.business_id=p_business_id and accepted.operation_id=(p->>'operationId')::uuid and accepted.actor_id=actor.id
     and accepted.payload_fingerprint=extensions.digest((p-'operationId')::text,'sha256')
     and case when c in ('save_order','begin_order_checkout','resume_order_service','close_order') then accepted.result->'tableId'='null'::jsonb
      when c='prepare_checkout' then (select event.payload->'tableId' from app_private.order_events event
       where event.business_id=p_business_id and event.order_id=o.id and event.revision<=(p->>'expectedRevision')::integer and event.kind in ('save_order','move_order')
       order by event.revision desc,event.created_at desc,event.id desc limit 1)='null'::jsonb else false end);
  end if;
$body$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational counter authorization'; end if;
 execute replace(definition,needle,replacement);
end $patch$;

create or replace function app_private.ops_validate(p jsonb) returns void language plpgsql set search_path='' as $$
#variable_conflict use_column
declare c text:=p->>'command'; fields text[]; i jsonb; d jsonb; k text;
begin
 fields:=case c
 when 'operations' then '{}' when 'orders' then '{}' when 'shifts' then '{}' when 'kitchen' then '{}' when 'tables' then '{}'
 when 'activate_operations' then array['operationId'] when 'open_shift' then array['operationId','openingCents']
 when 'cash_movement' then array['operationId','shiftId','expectedRevision','kind','amountCents','reason']
 when 'begin_shift_close' then array['operationId','shiftId','expectedRevision'] when 'abort_shift_close' then array['operationId','shiftId','expectedRevision']
 when 'close_shift' then array['operationId','shiftId','expectedRevision','countedCents']
 when 'order' then array['orderId']
 when 'save_order' then array['operationId','orderId','expectedRevision','name','tableId','items']
 when 'set_order_discount' then array['operationId','orderId','expectedRevision','discount']
 when 'cancel_order' then array['operationId','orderId','expectedRevision','reason']
 when 'send_order' then array['operationId','orderId','expectedRevision']
 when 'begin_order_checkout' then array['operationId','orderId','expectedRevision']
 when 'resume_order_service' then array['operationId','orderId','expectedRevision']
 when 'close_order' then array['operationId','orderId','expectedRevision']
 when 'move_order' then array['operationId','orderId','expectedRevision','tableId']
 when 'save_table' then array['operationId','tableId','expectedRevision','name','active']
 when 'set_kitchen_status' then array['operationId','batchId','expectedRevision','status']
 when 'prepare_checkout' then array['operationId','orderId','expectedRevision','items','paymentMethod']
 when 'attempt' then array['attemptId']
 when 'start_checkout' then array['operationId','attemptId','expectedRevision']
 when 'mark_checkout_uncertain' then array['operationId','attemptId','expectedRevision']
 when 'resolve_checkout' then array['operationId','attemptId','expectedRevision','resolution','confirmed','reason']
 when 'prepare_reversal' then array['operationId','saleId','reason']
 when 'prepare_waiver' then array['operationId','orderId','expectedRevision','reason']
 when 'confirm_waiver' then array['operationId','waiverId','expectedRevision','confirmed']
 when 'report' then array['date'] else null end;
 if fields is null then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.ops_exact(p,array['command']||fields);
 for k in select unnest(array['operationId','orderId','shiftId','batchId','attemptId','saleId','waiverId']) loop
  if p ? k then perform app_private.ops_uuid(p->k); end if;
 end loop;
 if p ? 'tableId' and p->'tableId'<>'null'::jsonb then perform app_private.ops_uuid(p->'tableId'); end if;
 if p ? 'expectedRevision' and (p->'expectedRevision'<>'null'::jsonb or c not in ('save_order','save_table')) then perform app_private.ops_int(p->'expectedRevision',1,2147483647); end if;
 for k in select unnest(array['openingCents','countedCents','amountCents']) loop
  if p ? k then perform app_private.ops_int(p->k,case when k='amountCents' then 1 else 0 end,9999999999); end if;
 end loop;
 if p ? 'reason' then perform app_private.ops_text(p->'reason',1,200); end if;
 if p ? 'name' then perform app_private.ops_text(p->'name',1,case when c='save_table' then 60 else 100 end); end if;
 if c='cash_movement' and (jsonb_typeof(p->'kind') is distinct from 'string' or p->>'kind' not in ('in','out')) or c='save_table' and jsonb_typeof(p->'active') is distinct from 'boolean'
 or c='prepare_checkout' and (jsonb_typeof(p->'paymentMethod') is distinct from 'string' or p->>'paymentMethod' not in ('cash','card_external','transfer'))
 or c='set_kitchen_status' and (jsonb_typeof(p->'status') is distinct from 'string' or p->>'status' not in ('preparing','ready','delivered'))
 or c='resolve_checkout' and (jsonb_typeof(p->'resolution') is distinct from 'string' or p->>'resolution' not in ('complete','abort') or p->'confirmed' is distinct from 'true'::jsonb)
 or c='confirm_waiver' and p->'confirmed' is distinct from 'true'::jsonb then raise exception 'VALIDATION_ERROR'; end if;
 if c='save_order' or c='prepare_checkout' then
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 40 then raise exception 'VALIDATION_ERROR'; end if;
  if (select count(distinct i->>'lineId') from jsonb_array_elements(p->'items') i)<>jsonb_array_length(p->'items') then raise exception 'VALIDATION_ERROR'; end if;
  for i in select * from jsonb_array_elements(p->'items') loop
   perform app_private.ops_uuid(i->'lineId'); perform app_private.ops_int(i->'quantity',1,999);
   if c='save_order' then
    perform app_private.ops_exact(i,array['lineId','productId','quantity','unitPriceCents','version','note']||case when i ? 'selection' then array['selection'] else '{}'::text[] end);
    perform app_private.ops_uuid(i->'productId'); perform app_private.ops_int(i->'unitPriceCents',0,99999999); perform app_private.ops_int(i->'version',1,2147483647); perform app_private.ops_text(i->'note',0,160);
    if i ? 'selection' then
     perform app_private.ops_exact(i->'selection',array['variationId','modifierIds','variablePriceCents']);
     if i#>'{selection,variationId}'<>'null'::jsonb then perform app_private.ops_uuid(i#>'{selection,variationId}'); end if;
     if i#>'{selection,variablePriceCents}'<>'null'::jsonb then perform app_private.ops_int(i#>'{selection,variablePriceCents}',0,99999999); end if;
     if jsonb_typeof(i#>'{selection,modifierIds}') is distinct from 'array' or jsonb_array_length(i#>'{selection,modifierIds}')>24
      or (select count(distinct m) from jsonb_array_elements(i#>'{selection,modifierIds}') m)<>jsonb_array_length(i#>'{selection,modifierIds}') then raise exception 'VALIDATION_ERROR'; end if;
     for d in select * from jsonb_array_elements(i#>'{selection,modifierIds}') loop perform app_private.ops_uuid(d); end loop;
    end if;
   else perform app_private.ops_exact(i,array['lineId','quantity']); end if;
  end loop;
 end if;
 if c='set_order_discount' and p->'discount'<>'null'::jsonb then
  d:=p->'discount'; perform app_private.ops_exact(d,array['kind','value','reason']);
  if jsonb_typeof(d->'kind') is distinct from 'string' or d->>'kind' not in ('fixed','percent') then raise exception 'VALIDATION_ERROR'; end if;
  perform app_private.ops_int(d->'value',0,case when d->>'kind'='fixed' then 9999999999 else 10000 end); perform app_private.ops_text(d->'reason',1,200);
 end if;
 if c='report' and (jsonb_typeof(p->'date') is distinct from 'string' or p->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or to_char((p->>'date')::date,'YYYY-MM-DD')<>p->>'date') then raise exception 'VALIDATION_ERROR'; end if;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_ERROR';
end; $$;

create or replace function app_private.ops_report(p_business uuid,p_day date) returns jsonb language plpgsql stable set search_path='' as $$
declare timezone_name text; start_at timestamptz; end_at timestamptz; result jsonb;
begin
 select timezone into timezone_name from app_private.businesses where id=p_business;
 start_at:=p_day::timestamp at time zone timezone_name; end_at:=(p_day+1)::timestamp at time zone timezone_name;
 -- Effective date is the server business day. Corrections remain on their own date.
 with s as (select * from app_private.sales where business_id=p_business and created_at>=start_at and created_at<end_at),
 i as (select i.* from app_private.sale_items i join s on s.id=i.sale_id and s.business_id=i.business_id),
 r as (select * from app_private.sale_reversals where business_id=p_business and created_at>=start_at and created_at<end_at),
 ri as (select i.* from app_private.sale_items i join r on r.sale_id=i.sale_id and r.business_id=i.business_id)
 select jsonb_build_object('date',p_day,'timezone',timezone_name,
 'grossCents',coalesce((select sum(quantity::bigint*unit_price_cents) from i),0),'discountCents',coalesce((select sum(discount_cents) from i),0),
 'salesCents',coalesce((select sum(total_cents) from s),0),'taxCents',coalesce((select sum(tax_cents) from i),0),
 'reversalCents',coalesce((select sum(amount_cents) from r),0),'reversalTaxCents',coalesce((select sum(tax_cents) from r),0),
 'netCents',coalesce((select sum(total_cents) from s),0)-coalesce((select sum(amount_cents) from r),0),'saleCount',(select count(*) from s),
 'waivedCents',coalesce((select sum(amount_cents) from app_private.balance_waivers where business_id=p_business and status='completed' and resolved_at>=start_at and resolved_at<end_at),0),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('paymentMethod',method,'salesCents',sales,'reversalCents',reversed,'netCents',sales-reversed) order by method)
  from (select method,coalesce((select sum(total_cents) from s where payment_method=method),0) sales,coalesce((select sum(amount_cents) from r where payment_method=method),0) reversed from unnest(array['cash','card_external','transfer']) method) p),'[]'::jsonb),
 'operators',coalesce((select jsonb_agg(jsonb_build_object('name',name,'salesCents',sales,'reversalCents',reversed,'netCents',sales-reversed) order by name)
  from (select name,coalesce((select sum(total_cents) from s where operator_name=name),0) sales,coalesce((select sum(amount_cents) from r where original_operator_name=name),0) reversed
   from (select operator_name name from s union select original_operator_name name from r) names) p),'[]'::jsonb),
 'products',coalesce((select jsonb_agg(jsonb_build_object('productId',product_id,'name',name,'quantity',quantity,'salesCents',total,'taxCents',tax,
  'reversalQuantity',reversed_quantity,'reversalCents',reversed,'reversalTaxCents',reversed_tax,'netCents',total-reversed,'netTaxCents',tax-reversed_tax) order by name,product_id)
  from (select keys.product_id,keys.name,
   coalesce((select sum(i.quantity) from i where i.product_id=keys.product_id and i.name=keys.name),0) quantity,
   coalesce((select sum(i.total_cents) from i where i.product_id=keys.product_id and i.name=keys.name),0) total,
   coalesce((select sum(i.tax_cents) from i where i.product_id=keys.product_id and i.name=keys.name),0) tax,
   coalesce((select sum(ri.quantity) from ri where ri.product_id=keys.product_id and ri.name=keys.name),0) reversed_quantity,
   coalesce((select sum(ri.total_cents) from ri where ri.product_id=keys.product_id and ri.name=keys.name),0) reversed,
   coalesce((select sum(ri.tax_cents) from ri where ri.product_id=keys.product_id and ri.name=keys.name),0) reversed_tax
   from (select product_id,name from i union select product_id,name from ri) keys) p),'[]'::jsonb),
 'cashDifferences',coalesce((select jsonb_agg(jsonb_build_object('shiftId',id,'closedAt',closed_at,'expectedCents',expected_cents,'countedCents',counted_cents,'differenceCents',difference_cents) order by closed_at,id)
  from app_private.cash_shifts where business_id=p_business and status='closed' and closed_at>=start_at and closed_at<end_at),'[]'::jsonb)) into result;
 return result;
end; $$;
