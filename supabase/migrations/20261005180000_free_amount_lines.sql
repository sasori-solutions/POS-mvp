-- Explicit amount lines preserve real financial snapshots without a catalog row.
-- Existing product payloads, accepted receipts, actor checks and permissions remain intact.
alter table app_private.order_lines alter column product_id drop not null;
alter table app_private.order_lines add column line_kind text not null default 'product';
alter table app_private.order_lines add constraint order_line_origin check(
 (line_kind='product' and product_id is not null)
 or (line_kind='amount' and product_id is null and product_version=1 and selection is null
  and kitchen_name='' and category='' and selection_label='' and note='' and sent_quantity=0 and unit_price_cents>0));
alter table app_private.sale_items alter column product_id drop not null;
alter table app_private.sale_items add column line_kind text not null default 'product';
alter table app_private.sale_items add constraint sale_line_origin check(
 (line_kind='product' and product_id is not null)
 or (line_kind='amount' and product_id is null and category='' and selection_label='' and unit_price_cents>0));

create function app_private.ops_amount_name(value jsonb) returns text language sql immutable set search_path='' as $$
 select coalesce(nullif(app_private.ops_text(value,0,100),''),'Importe libre');
$$;
create function app_private.ops_amount_vat(profile jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare treatment text:=coalesce(profile->>'defaultVatTreatment','vat_16');
begin
 if treatment not in ('vat_16','vat_0','exempt','border_8','unconfigured') then raise exception 'VALIDATION_ERROR'; end if;
 return jsonb_build_object('taxTreatment',treatment,'taxBps',case treatment when 'vat_16' then 1600 when 'border_8' then 800 else 0 end);
end $$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_validate_before_amount(jsonb)'::regprocedure) into definition;
 needle:=$old$   if c='save_order' then
    perform app_private.ops_exact(i$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_validate_before_amount'; end if;
 definition:=replace(definition,needle,$new$   if c='save_order' then
    if i->>'kind'='amount' then
     perform app_private.ops_exact(i,array['lineId','kind','name','quantity','unitPriceCents','note']);
     perform app_private.ops_amount_name(i->'name'); perform app_private.ops_int(i->'unitPriceCents',1,99999999);
     if i->'note' is distinct from '""'::jsonb then raise exception 'VALIDATION_ERROR'; end if;
    else
    perform app_private.ops_exact(i$new$);
 needle:=$old$   else perform app_private.ops_exact(i,array['lineId','quantity']); end if;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_validate_before_amount'; end if;
 definition:=replace(definition,needle,$new$    end if;
   else perform app_private.ops_exact(i,array['lineId','quantity']); end if;$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_slice(app_private.order_lines,integer)'::regprocedure) into definition;
 needle:=$old$'taxBps',l.tax_bps,'taxTreatment',l.tax_treatment)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_slice'; end if;
 definition:=replace(definition,needle,$new$'taxBps',l.tax_bps,'taxTreatment',l.tax_treatment)||case when l.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_amount_line(app_private.order_lines,bigint)'::regprocedure) into definition;
 needle:=$old$'allocatedGrossCents',p_take+d)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_amount_line'; end if;
 definition:=replace(definition,needle,$new$'allocatedGrossCents',p_take+d)||case when l.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_quote_totals_valid(jsonb,bigint,bigint,bigint)'::regprocedure) into definition;
 needle:=$old$  perform app_private.ops_uuid(i->'productId');$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_quote_totals_valid'; end if;
 definition:=replace(definition,needle,$new$  if i->>'kind'='amount' then
   if i->'productId' is distinct from 'null'::jsonb then return false; end if;
  else perform app_private.ops_uuid(i->'productId'); end if;$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_assert_attempt_integrity(uuid,uuid)'::regprocedure) into definition;
 needle:=$old$ end item from app_private.sale_items i$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_assert_attempt_integrity'; end if;
 definition:=replace(definition,needle,$new$ end||case when i.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end item from app_private.sale_items i$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.pos_command_before_point(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$   if l.id is not null then
    if l.product_id<>$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$   if line->>'kind'='amount' then
    if l.id is not null and l.line_kind<>'amount' then raise exception 'ORDER_CHANGED'; end if;
    if l.id is not null then
     update app_private.order_lines set name=app_private.ops_amount_name(line->'name'),quantity=qty,unit_price_cents=(line->>'unitPriceCents')::integer,
      gross_cents=qty::bigint*(line->>'unitPriceCents')::integer,discount_cents=0,total_cents=qty::bigint*(line->>'unitPriceCents')::integer,
      tax_cents=app_private.included_vat_cents(qty::bigint*(line->>'unitPriceCents')::integer,l.tax_bps)
      where business_id=p_business_id and order_id=o.id and id=l.id;
    else
     pricing:=app_private.ops_amount_vat(business.profile);
     insert into app_private.order_lines(business_id,order_id,id,line_kind,product_id,product_version,name,kitchen_name,category,selection_label,note,quantity,unit_price_cents,gross_cents,total_cents,tax_cents,tax_bps,tax_treatment)
      values(p_business_id,o.id,line_id,'amount',null,1,app_private.ops_amount_name(line->'name'),'','','','',qty,(line->>'unitPriceCents')::integer,
       qty::bigint*(line->>'unitPriceCents')::integer,qty::bigint*(line->>'unitPriceCents')::integer,
       app_private.included_vat_cents(qty::bigint*(line->>'unitPriceCents')::integer,(pricing->>'taxBps')::integer),(pricing->>'taxBps')::integer,pricing->>'taxTreatment');
    end if;
   else
   if l.id is not null then
    if l.line_kind<>'product' or l.product_id<>$new$);
 needle:=$old$   end if;
  end loop;
  delete from app_private.order_lines$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$   end if;
   end if;
  end loop;
  delete from app_private.order_lines$new$);
 needle:=$old$and ol.sent_quantity>ol.paid_quantity;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$and ol.sent_quantity>ol.paid_quantity and ol.line_kind='product';$new$);
 needle:=$old$and ol.quantity>ol.sent_quantity;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$and ol.quantity>ol.sent_quantity and ol.line_kind='product';$new$);
 needle:=$old$and ol.paid_quantity>ol.sent_quantity;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$and ol.paid_quantity>ol.sent_quantity and ol.line_kind='product';$new$);
 needle:=$old$set sent_quantity=quantity where business_id=p_business_id and order_id=o.id;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$set sent_quantity=quantity where business_id=p_business_id and order_id=o.id and line_kind='product';$new$);
 needle:=$old$set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=p_business_id and order_id=o.id;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=p_business_id and order_id=o.id and line_kind='product';$new$);
 needle:=$old$discount_cents,allocated_gross_cents)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$discount_cents,allocated_gross_cents,line_kind)$new$);
 needle:=$old$(x->>'allocatedGrossCents')::bigint from jsonb_array_elements$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$(x->>'allocatedGrossCents')::bigint,case when x->>'kind'='amount' then 'amount' else 'product' end from jsonb_array_elements$new$);
 needle:=$old$ end order by si.line_id)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: pos_command_before_point'; end if;
 definition:=replace(definition,needle,$new$ end||case when si.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end order by si.line_id)$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure) into definition;
 needle:=$old$discount_cents,allocated_gross_cents)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: point_materialize'; end if;
 definition:=replace(definition,needle,$new$discount_cents,allocated_gross_cents,line_kind)$new$);
 needle:=$old$(x->>'allocatedGrossCents')::bigint from jsonb_array_elements$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: point_materialize'; end if;
 definition:=replace(definition,needle,$new$(x->>'allocatedGrossCents')::bigint,case when x->>'kind'='amount' then 'amount' else 'product' end from jsonb_array_elements$new$);
 needle:=$old$and ol.paid_quantity>ol.sent_quantity;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: point_materialize'; end if;
 definition:=replace(definition,needle,$new$and ol.paid_quantity>ol.sent_quantity and ol.line_kind='product';$new$);
 needle:=$old$set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=a.business_id and order_id=o.id;$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: point_materialize'; end if;
 definition:=replace(definition,needle,$new$set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=a.business_id and order_id=o.id and line_kind='product';$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.legacy_pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$coalesce(i->'selection','null'::jsonb)::text) into v_items$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: legacy_pos_command'; end if;
 definition:=replace(definition,needle,$new$coalesce(i->'selection','null'::jsonb)::text,case when i->>'kind'='amount' then i::text else '' end) into v_items$new$);
 needle:=$old$or (select count(distinct (i->>'productId',coalesce(i->'selection','null'::jsonb))) from jsonb_array_elements(v_items) i)<>jsonb_array_length(v_items)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: legacy_pos_command'; end if;
 definition:=replace(definition,needle,$new$or (select count(distinct (i->>'productId',coalesce(i->'selection','null'::jsonb))) from jsonb_array_elements(v_items) i where i->>'kind' is distinct from 'amount')<>(select count(*) from jsonb_array_elements(v_items) i where i->>'kind' is distinct from 'amount')$new$);
 needle:=$old$    for v_item in select * from jsonb_array_elements(v_items) loop
      if jsonb_typeof$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: legacy_pos_command'; end if;
 definition:=replace(definition,needle,$new$    for v_item in select * from jsonb_array_elements(v_items) loop
      if v_item->>'kind'='amount' then
       perform app_private.ops_exact(v_item,array['kind','name','quantity','unitPriceCents']);
       perform app_private.ops_amount_name(v_item->'name');
       v_quantity:=app_private.ops_int(v_item->'quantity',1,999)::integer;
       v_price:=app_private.ops_int(v_item->'unitPriceCents',1,99999999)::integer;
       v_total:=v_total+v_price::bigint*v_quantity; v_count:=v_count+v_quantity;
       continue;
      end if;
      if v_item ? 'kind' then raise exception 'VALIDATION_ERROR'; end if;
      if jsonb_typeof$new$);
 needle:=$old$    v_result:=app_private.sale_json(v_sale);$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: legacy_pos_command'; end if;
 definition:=replace(definition,needle,$new$    v_pricing:=app_private.ops_amount_vat(v_business.profile);
    insert into app_private.sale_items(business_id,sale_id,line_kind,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps)
     select p_business_id,v_sale.id,'amount',null,app_private.ops_amount_name(i->'name'),'',(i->>'quantity')::integer,(i->>'unitPriceCents')::integer,
      (i->>'quantity')::bigint*(i->>'unitPriceCents')::integer,'',
      app_private.included_vat_cents((i->>'quantity')::bigint*(i->>'unitPriceCents')::integer,(v_pricing->>'taxBps')::integer),v_pricing->>'taxTreatment',(v_pricing->>'taxBps')::integer
     from jsonb_array_elements(v_items) i where i->>'kind'='amount';
    v_result:=app_private.sale_json(v_sale);$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_report_window_before_point(uuid,timestamptz,timestamptz)'::regprocedure) into definition;
 needle:=$old$'productId',product_id,'name',name,'quantity',quantity$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_report_window_before_point'; end if;
 definition:=replace(definition,needle,$new$'productId',product_id,'name',name,'kind',case when product_id is null then 'amount' else 'product' end,'quantity',quantity$new$);
 needle:=$old$i.product_id=keys.product_id and i.name=keys.name$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_report_window_before_point'; end if;
 definition:=replace(definition,needle,$new$i.product_id is not distinct from keys.product_id and (keys.product_id is null or i.name=keys.name)$new$);
 needle:=$old$ri.product_id=keys.product_id and ri.name=keys.name$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_report_window_before_point'; end if;
 definition:=replace(definition,needle,$new$ri.product_id is not distinct from keys.product_id and (keys.product_id is null or ri.name=keys.name)$new$);
 needle:=$old$select product_id,name from i union select product_id,name from ri$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_report_window_before_point'; end if;
 definition:=replace(definition,needle,$new$select product_id,case when line_kind='amount' then 'Importe libre' else name end name from i union select product_id,case when line_kind='amount' then 'Importe libre' else name end name from ri$new$);
 execute definition;
end $migration$;

do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.ops_employee_report_window_base(uuid,uuid,timestamptz,timestamptz)'::regprocedure) into definition;
 needle:=$old$'productId',product_id,'name',name,'quantity',quantity$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_employee_report_window_base'; end if;
 definition:=replace(definition,needle,$new$'productId',product_id,'name',name,'kind',case when product_id is null then 'amount' else 'product' end,'quantity',quantity$new$);
 needle:=$old$i.product_id=keys.product_id and i.name=keys.name$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_employee_report_window_base'; end if;
 definition:=replace(definition,needle,$new$i.product_id is not distinct from keys.product_id and (keys.product_id is null or i.name=keys.name)$new$);
 needle:=$old$ri.product_id=keys.product_id and ri.name=keys.name$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_employee_report_window_base'; end if;
 definition:=replace(definition,needle,$new$ri.product_id is not distinct from keys.product_id and (keys.product_id is null or ri.name=keys.name)$new$);
 needle:=$old$select product_id,name from i union select product_id,name from ri$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount dependency: ops_employee_report_window_base'; end if;
 definition:=replace(definition,needle,$new$select product_id,case when line_kind='amount' then 'Importe libre' else name end name from i union select product_id,case when line_kind='amount' then 'Importe libre' else name end name from ri$new$);
 execute definition;
end $migration$;

alter function app_private.ops_line_json(app_private.order_lines) rename to ops_line_json_before_free_amount;
create function app_private.ops_line_json(l app_private.order_lines) returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_line_json_before_free_amount(l)||case when l.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end;
$$;

-- Receipt kind comes from the immutable row, never from the current catalog.
do $migration$
declare definition text; needle text;
begin
 select pg_get_functiondef('app_private.sale_json(app_private.sales,boolean)'::regprocedure) into definition;
 needle:=$old$ end order by i.name,i.line_id)$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected free-amount sale projection'; end if;
 execute replace(definition,needle,$new$ end||case when i.line_kind='amount' then jsonb_build_object('kind','amount') else '{}'::jsonb end order by i.name,i.line_id)$new$);
end $migration$;

revoke all on function app_private.ops_amount_name(jsonb),app_private.ops_amount_vat(jsonb),app_private.ops_line_json_before_free_amount(app_private.order_lines),app_private.ops_line_json(app_private.order_lines) from public,anon,authenticated;
