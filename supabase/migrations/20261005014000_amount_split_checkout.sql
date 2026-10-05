-- Amount collections retain immutable product/discount/IVA allocations. A partial
-- monetary line has zero newly settled units until its remaining value is paid.
-- No fractional quantities or synthetic products; each confirmed receipt is real.
alter table app_private.checkout_attempts add column amounts_cents jsonb;
alter table app_private.sale_items add column allocated_gross_cents bigint;
alter table app_private.sale_items drop constraint sale_items_quantity_check;
alter table app_private.sale_items add constraint sale_items_quantity_check check(quantity between 0 and 999 and (quantity>0 or allocated_gross_cents is not null));
alter table app_private.sale_items drop constraint sale_items_total_cents_check;
alter table app_private.sale_items add constraint sale_items_total_cents_check check(
 (allocated_gross_cents is null and total_cents=quantity::bigint*unit_price_cents-discount_cents and discount_cents<=quantity::bigint*unit_price_cents)
 or (allocated_gross_cents is not null and allocated_gross_cents between 0 and 9999999999 and discount_cents<=allocated_gross_cents and total_cents=allocated_gross_cents-discount_cents));
alter table app_private.sales drop constraint sales_item_count_check;
alter table app_private.sales add constraint sales_item_count_check check(item_count between 0 and 39960);

create function app_private.ops_amount_parts_valid(parts jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare x jsonb; total numeric:=0;
begin
 if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts) not between 1 and 20 then return false; end if;
 for x in select value from jsonb_array_elements(parts) loop total:=total+app_private.ops_int(x,1,9999999999); end loop;
 return total<=9999999999;
exception when others then return false;
end $$;
alter table app_private.checkout_attempts add constraint checkout_amount_parts check(amounts_cents is null or
 (kind='payment' and app_private.ops_amount_parts_valid(amounts_cents) and total_cents=(amounts_cents->>0)::bigint));

-- Stable line order allocates each incoming cent exactly once. Discount and IVA
-- use the accepted remaining snapshot, with every remainder on its final slice.
create function app_private.ops_amount_line(l app_private.order_lines,p_take bigint) returns jsonb language plpgsql stable set search_path='' as $$
declare paid bigint; discount_paid bigint; tax_paid bigint; remaining bigint; d bigint; t bigint; qty integer;
begin
 select coalesce(sum((i->>'totalCents')::bigint),0)::bigint,coalesce(sum((i->>'discountCents')::bigint),0),coalesce(sum((i->>'taxCents')::bigint),0)
 into paid,discount_paid,tax_paid from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i
 where a.business_id=l.business_id and a.order_id=l.order_id and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text;
 remaining:=l.total_cents-paid;
 if remaining<0 or p_take<0 or p_take>remaining then raise exception 'FINANCIAL_INTEGRITY'; end if;
 qty:=case when p_take=remaining then l.quantity-l.paid_quantity else 0 end;
 d:=case when remaining=0 then l.discount_cents-discount_paid else floor((l.discount_cents-discount_paid)::numeric*p_take/remaining)::bigint end;
 t:=case when remaining=0 then l.tax_cents-tax_paid else floor((l.tax_cents-tax_paid)::numeric*p_take/remaining)::bigint end;
 return jsonb_build_object('lineId',l.id,'productId',l.product_id,'name',l.name,'category',l.category,'selectionLabel',l.selection_label,'quantity',qty,'unitPriceCents',l.unit_price_cents,
 'discountCents',d,'totalCents',p_take,'taxCents',t,'taxBps',l.tax_bps,'taxTreatment',l.tax_treatment,'allocatedGrossCents',p_take+d);
end $$;
create function app_private.ops_amount_quote(p_business uuid,p_order uuid,p_amount bigint) returns jsonb language plpgsql stable set search_path='' as $$
declare l app_private.order_lines%rowtype; paid bigint; remaining bigint; take bigint; available bigint:=p_amount; items jsonb:='[]'::jsonb;
begin
 if p_amount not between 1 and 9999999999 then raise exception 'VALIDATION_ERROR'; end if;
 for l in select * from app_private.order_lines where business_id=p_business and order_id=p_order and quantity>paid_quantity order by id loop
  select coalesce(sum((i->>'totalCents')::bigint),0)::bigint into paid from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i
   where a.business_id=p_business and a.order_id=p_order and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text;
  remaining:=l.total_cents-paid;
  if remaining<0 then raise exception 'FINANCIAL_INTEGRITY'; end if;
  take:=least(remaining,available);
  if take>0 or remaining=0 then items:=items||jsonb_build_array(app_private.ops_amount_line(l,take)); end if;
  available:=available-take;
 end loop;
 if available<>0 then raise exception 'VALIDATION_ERROR'; end if;
 return items;
end $$;
create function app_private.ops_amount_plan(p_business uuid,p_order uuid,parts jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare balance bigint; amount numeric;
begin
 if not app_private.ops_amount_parts_valid(parts) then raise exception 'VALIDATION_ERROR'; end if;
 select (app_private.ops_order_json(o)->>'balanceCents')::bigint into balance from app_private.operational_orders o where business_id=p_business and id=p_order;
 select sum(value::text::bigint) into amount from jsonb_array_elements(parts);
 if amount is distinct from balance::numeric then raise exception 'VALIDATION_ERROR'; end if;
 return app_private.ops_amount_quote(p_business,p_order,(parts->>0)::bigint);
end $$;

do $patch$ declare d text; needle text:=$old$quantity:=app_private.ops_int(i->'quantity',1,999);$old$; begin
 select pg_get_functiondef('app_private.ops_quote_totals_valid(jsonb,bigint,bigint,bigint)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_quote_totals_valid(jsonb,bigint,bigint,bigint)'; end if;
 execute replace(d,needle,$new$quantity:=app_private.ops_int(i->'quantity',case when i ? 'allocatedGrossCents' then 0 else 1 end,999);$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$if total<>quantity*price-discount or discount>quantity*price or tax>total then return false; end if;$old$; begin
 select pg_get_functiondef('app_private.ops_quote_totals_valid(jsonb,bigint,bigint,bigint)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_quote_totals_valid(jsonb,bigint,bigint,bigint)'; end if;
 execute replace(d,needle,$new$if i ? 'allocatedGrossCents' then
   if total<>app_private.ops_int(i->'allocatedGrossCents',0,9999999999)-discount or tax>total then return false; end if;
  elsif total<>quantity*price-discount or discount>quantity*price or tax>total then return false; end if;$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$if a.kind<>'payment' then return; end if;$old$; begin
 select pg_get_functiondef('app_private.ops_assert_payment_quote(app_private.checkout_attempts)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_assert_payment_quote(app_private.checkout_attempts)'; end if;
 execute replace(d,needle,$new$if a.kind<>'payment' then return; end if;
 if a.amounts_cents is not null then
  select * into o from app_private.operational_orders where business_id=a.business_id and id=a.order_id;
  if o.id is null or o.status<>'open' or a.items is distinct from app_private.ops_amount_plan(a.business_id,a.order_id,a.amounts_cents)
   or not app_private.ops_quote_totals_valid(a.items,a.total_cents,a.discount_cents,a.tax_cents) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return;
 end if;
 if exists(select 1 from app_private.checkout_attempts where business_id=a.business_id and order_id=a.order_id and kind='payment' and status='completed' and amounts_cents is not null) then raise exception 'ORDER_LOCKED'; end if;$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$'items','sale_id'$old$; begin
 select pg_get_functiondef('app_private.ops_guard_financial_history()'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_guard_financial_history()'; end if;
 execute replace(d,needle,$new$'items','amounts_cents','sale_id'$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$if count_lines not between 1 and 40$old$; begin
 select pg_get_functiondef('app_private.ops_assert_sale_integrity(uuid,uuid)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_assert_sale_integrity(uuid,uuid)'; end if;
 execute replace(d,needle,$new$if (sale.item_count=0 or exists(select 1 from app_private.sale_items where business_id=p_business and sale_id=p_sale and allocated_gross_cents is not null))
  and not exists(select 1 from app_private.checkout_attempts where business_id=p_business and sale_id=p_sale and status='completed' and amounts_cents is not null) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 if count_lines not between 1 and 40$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$'taxBps',i.tax_bps,'taxTreatment',i.tax_treatment) item$old$; begin
 select pg_get_functiondef('app_private.ops_assert_attempt_integrity(uuid,uuid)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_assert_attempt_integrity(uuid,uuid)'; end if;
 execute replace(d,needle,$new$'taxBps',i.tax_bps,'taxTreatment',i.tax_treatment)||case when i.allocated_gross_cents is null then '{}'::jsonb else jsonb_build_object('allocatedGrossCents',i.allocated_gross_cents) end item$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$if quantity<>l.paid_quantity or paid<>expected_paid or discount<>expected_discount or tax<>expected_tax then raise exception 'FINANCIAL_INTEGRITY'; end if;$old$; begin
 select pg_get_functiondef('app_private.ops_assert_order_integrity(uuid,uuid)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_assert_order_integrity(uuid,uuid)'; end if;
 execute replace(d,needle,$new$if exists(select 1 from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i
   where a.business_id=p_business and a.order_id=p_order and a.kind='payment' and a.status='completed' and a.amounts_cents is not null and i->>'lineId'=l.id::text) then
   if quantity<>l.paid_quantity or paid<expected_paid or paid>l.total_cents or discount<0 or discount>l.discount_cents or tax<0 or tax>l.tax_cents
    or (paid=l.total_cents and (quantity<>l.quantity or discount<>l.discount_cents or tax<>l.tax_cents))
    or (paid<l.total_cents and quantity=l.quantity) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  elsif quantity<>l.paid_quantity or paid<>expected_paid or discount<>expected_discount or tax<>expected_tax then raise exception 'FINANCIAL_INTEGRITY'; end if;$new$);
end $patch$;

alter function app_private.ops_validate(jsonb) rename to ops_validate_before_amount;
create function app_private.ops_validate(p jsonb) returns void language plpgsql set search_path='' as $$
begin
 if p->>'command' in ('prepare_checkout','update_checkout') and p ? 'amountsCents' then
  perform app_private.ops_exact(p,array['command','operationId',case when p->>'command'='prepare_checkout' then 'orderId' else 'attemptId' end,'expectedRevision','items','amountsCents','paymentMethod']);
  perform app_private.ops_uuid(p->'operationId'); perform app_private.ops_uuid(p->case when p->>'command'='prepare_checkout' then 'orderId' else 'attemptId' end);
  perform app_private.ops_int(p->'expectedRevision',1,2147483647);
  if p->'items' is distinct from '[]'::jsonb or not app_private.ops_amount_parts_valid(p->'amountsCents') or p->>'paymentMethod' is null or p->>'paymentMethod' not in ('cash','card_external','transfer','card_integrated') then raise exception 'VALIDATION_ERROR'; end if;
  return;
 end if;
 perform app_private.ops_validate_before_amount(p);
end $$;

do $patch$ declare d text; needle text:=$old$tax_bps,discount_cents)$old$; begin
 select pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.point_materialize(app_private.point_attempts)'; end if;
 execute replace(d,needle,$new$tax_bps,discount_cents,allocated_gross_cents)$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$(x->>'discountCents')::bigint from jsonb_array_elements$old$; begin
 select pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.point_materialize(app_private.point_attempts)'; end if;
 execute replace(d,needle,$new$(x->>'discountCents')::bigint,(x->>'allocatedGrossCents')::bigint from jsonb_array_elements$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$app_private.ops_slice(l,l.quantity-l.paid_quantity)$old$; begin
 select pg_get_functiondef('app_private.ops_assert_adjustment_remaining(uuid,uuid,bigint,jsonb,integer)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_assert_adjustment_remaining(uuid,uuid,bigint,jsonb,integer)'; end if;
 execute replace(d,needle,$new$case when exists(select 1 from app_private.checkout_attempts where business_id=p_business and order_id=p_order and status='completed' and amounts_cents is not null) then app_private.ops_amount_line(l,l.total_cents-(select coalesce(sum((i->>'totalCents')::bigint),0)::bigint from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i where a.business_id=p_business and a.order_id=p_order and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text)) else app_private.ops_slice(l,l.quantity-l.paid_quantity) end$new$);
end $patch$;

do $patch$ declare d text; needle text:=$old$'items',a.items);$old$; begin
 select pg_get_functiondef('app_private.ops_attempt_json(app_private.checkout_attempts)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.ops_attempt_json(app_private.checkout_attempts)'; end if;
 execute replace(d,needle,$new$'items',a.items)||case when a.amounts_cents is null then '{}'::jsonb else jsonb_build_object('amountsCents',a.amounts_cents) end;$new$);
end $patch$;

alter function app_private.ops_line_json(app_private.order_lines) rename to ops_line_json_before_amount;
create function app_private.ops_line_json(l app_private.order_lines) returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_line_json_before_amount(l)||jsonb_build_object(
 'paidTotalCents',coalesce(sum((i->>'totalCents')::bigint),0)::bigint,'paidDiscountCents',coalesce(sum((i->>'discountCents')::bigint),0),'paidTaxCents',coalesce(sum((i->>'taxCents')::bigint),0))
 from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i where a.business_id=l.business_id and a.order_id=l.order_id and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text;
$$;
alter function app_private.ops_order_json(app_private.operational_orders) rename to ops_order_json_before_amount;
create function app_private.ops_order_json(o app_private.operational_orders) returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_order_json_before_amount(o)||jsonb_build_object('amountSplit',exists(select 1 from app_private.checkout_attempts where business_id=o.business_id and order_id=o.id and kind='payment' and status='completed' and amounts_cents is not null),
 'amountPaidParts',(select count(*) from app_private.checkout_attempts where business_id=o.business_id and order_id=o.id and kind='payment' and status='completed' and amounts_cents is not null),
 'amountParts',coalesce((select amounts_cents-0 from app_private.checkout_attempts where business_id=o.business_id and order_id=o.id and kind='payment' and status='completed' and amounts_cents is not null order by resolved_at desc,id desc limit 1),'[]'::jsonb));
$$;

-- Employee analytics were cloned before this migration. Both scopes must read
-- the same immutable allocated gross; zero newly settled units are not zero MXN.
do $patch$ declare d text; signature text; needle text:=$old$sum(quantity::bigint*unit_price_cents)$old$; begin
 foreach signature in array array['app_private.ops_report_window_before_point(uuid,timestamptz,timestamptz)','app_private.ops_employee_report_window_base(uuid,uuid,timestamptz,timestamptz)'] loop
  select pg_get_functiondef(signature::regprocedure) into d;
  if position(needle in d)=0 then raise exception 'Unexpected amount report gross dependency'; end if;
  execute replace(d,needle,$new$sum(total_cents+discount_cents)$new$);
 end loop;
end $patch$;

do $patch$ declare d text; needle text:=$old$'taxBps',i.tax_bps)$old$; begin
 select pg_get_functiondef('app_private.sale_json(app_private.sales,boolean)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount split dependency: app_private.sale_json(app_private.sales,boolean)'; end if;
 execute replace(d,needle,$new$'taxBps',i.tax_bps)||case when i.allocated_gross_cents is null then '{}'::jsonb else jsonb_build_object('allocatedGrossCents',i.allocated_gross_cents) end$new$);
end $patch$;

revoke all on function app_private.ops_amount_parts_valid(jsonb),app_private.ops_amount_line(app_private.order_lines,bigint),app_private.ops_amount_quote(uuid,uuid,bigint),app_private.ops_amount_plan(uuid,uuid,jsonb),app_private.ops_validate(jsonb),app_private.ops_validate_before_amount(jsonb),app_private.ops_line_json(app_private.order_lines),app_private.ops_line_json_before_amount(app_private.order_lines),app_private.ops_order_json(app_private.operational_orders),app_private.ops_order_json_before_amount(app_private.operational_orders) from public,anon,authenticated;

do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('app_private.pos_command_before_point(uuid,uuid,jsonb)'::regprocedure) into d;
needle:=$old$if c in ('save_order','prepare_checkout','record_payment','update_checkout') then$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$if c in ('save_order','prepare_checkout','record_payment','update_checkout') and not (p ? 'amountsCents') then$new$);
needle:=$old$   slices:='[]'::jsonb; total:=0; tax:=0; discount:=0;
   for line in select * from jsonb_array_elements(p->'items') loop$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$   slices:='[]'::jsonb; total:=0; tax:=0; discount:=0;
   if p ? 'amountsCents' then
    slices:=app_private.ops_amount_plan(p_business_id,o.id,p->'amountsCents');
    select sum((x->>'totalCents')::bigint),sum((x->>'taxCents')::bigint),sum((x->>'discountCents')::bigint) into total,tax,discount from jsonb_array_elements(slices) x;
   else
   for line in select * from jsonb_array_elements(p->'items') loop$new$);
needle:=$old$   update app_private.checkout_attempts set payment_method=p->>'paymentMethod',items=slices$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$   end if;
   update app_private.checkout_attempts set amounts_cents=p->'amountsCents',payment_method=p->>'paymentMethod',items=slices$new$);
needle:=$old$   insert into app_private.checkout_attempts(business_id,kind,order_id,shift_id,payment_method,total_cents,tax_cents,discount_cents,items,actor_id,actor_identity,operator_name)
    values(p_business_id,'payment',o.id,s.id,p->>'paymentMethod',total,tax,discount,slices,actor.id,actor.id,actor.name)$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$   end if;
   insert into app_private.checkout_attempts(business_id,kind,order_id,shift_id,payment_method,total_cents,tax_cents,discount_cents,items,actor_id,actor_identity,operator_name,amounts_cents)
    values(p_business_id,'payment',o.id,s.id,p->>'paymentMethod',total,tax,discount,slices,actor.id,actor.id,actor.name,p->'amountsCents')$new$);
needle:=$old$tax_bps,discount_cents)$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$tax_bps,discount_cents,allocated_gross_cents)$new$);
needle:=$old$(x->>'discountCents')::bigint from jsonb_array_elements$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$(x->>'discountCents')::bigint,(x->>'allocatedGrossCents')::bigint from jsonb_array_elements$new$);
needle:=$old$'taxTreatment',coalesce(si.tax_treatment,'legacy')) order by si.line_id)$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$'taxTreatment',coalesce(si.tax_treatment,'legacy'))||case when si.allocated_gross_cents is null then '{}'::jsonb else jsonb_build_object('allocatedGrossCents',si.allocated_gross_cents) end order by si.line_id)$new$);
needle:=$old$pricing:=app_private.ops_slice(l,l.quantity-l.paid_quantity); slices:=slices||jsonb_build_array(pricing);$old$; if position(needle in d)=0 then raise exception 'Unexpected amount dispatch dependency'; end if; d:=replace(d,needle,$new$pricing:=case when exists(select 1 from app_private.checkout_attempts where business_id=p_business_id and order_id=o.id and status='completed' and amounts_cents is not null) then app_private.ops_amount_line(l,l.total_cents-(select coalesce(sum((i->>'totalCents')::bigint),0)::bigint from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i where a.business_id=p_business_id and a.order_id=o.id and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text)) else app_private.ops_slice(l,l.quantity-l.paid_quantity) end; slices:=slices||jsonb_build_array(pricing);$new$);
 execute d;
end $patch$;

do $patch$ declare d text; needle text:=$old$if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;$old$; begin
 select pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure) into d;
 if position(needle in d)=0 then raise exception 'Unexpected amount Point materialization'; end if;
 execute replace(d,needle,needle||' perform app_private.ops_assert_payment_quote(q);');
end $patch$;
