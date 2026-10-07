-- Fixed preparation, explicit selling price; never inferred cost or inventory.
alter table app_private.products add column combo_snapshot jsonb;
alter table app_private.order_lines add column combo_snapshot jsonb;
alter table app_private.sale_items add column combo_snapshot jsonb;

create function app_private.validate_combo_input(parts jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare part jsonb; chosen jsonb; modifier jsonb;
begin
 if jsonb_typeof(parts) is distinct from 'array' or jsonb_array_length(parts)>8 then raise exception 'VALIDATION_ERROR'; end if;
 for part in select * from jsonb_array_elements(parts) loop
  perform app_private.ops_exact(part,array['productId','version','quantity']||case when part ? 'selection' then array['selection'] else '{}'::text[] end);
  perform app_private.ops_uuid(part->'productId'); perform app_private.ops_int(part->'version',1,2147483647); perform app_private.ops_int(part->'quantity',1,24);
  if part ? 'selection' then
   chosen:=part->'selection'; perform app_private.ops_exact(chosen,array['variationId','modifierIds','variablePriceCents']);
   if chosen->'variationId'<>'null'::jsonb then perform app_private.ops_uuid(chosen->'variationId'); end if;
   if chosen->'variablePriceCents'<>'null'::jsonb then perform app_private.ops_int(chosen->'variablePriceCents',0,99999999); end if;
   if jsonb_typeof(chosen->'modifierIds') is distinct from 'array' or jsonb_array_length(chosen->'modifierIds')>24 then raise exception 'VALIDATION_ERROR'; end if;
   for modifier in select * from jsonb_array_elements(chosen->'modifierIds') loop perform app_private.ops_uuid(modifier); end loop;
  end if;
 end loop;
 if (select count(distinct (entry.value->'productId',coalesce(entry.value->'selection','null'::jsonb))) from jsonb_array_elements(parts) entry(value))<>jsonb_array_length(parts) then raise exception 'VALIDATION_ERROR'; end if;
end; $$;

alter function app_private.validate_product_details(uuid,jsonb) rename to validate_product_details_before_combos;
create function app_private.validate_product_details(p_business uuid,d jsonb) returns void language plpgsql set search_path='' as $$
begin
 if d ? 'comboComponents' then
  perform app_private.validate_combo_input(d->'comboComponents');
  if jsonb_array_length(d->'comboComponents')>0 and ((d->>'variablePrice')::boolean or jsonb_array_length(d->'variations')>0) then raise exception 'VALIDATION_ERROR'; end if;
 end if;
 perform app_private.validate_product_details_before_combos(p_business,d-'comboComponents');
end; $$;

alter function app_private.product_selection(app_private.products,jsonb) rename to product_selection_before_combos;
create function app_private.combo_availability_reason(p_business uuid,parts jsonb) returns text language plpgsql stable set search_path='' as $$
declare part jsonb; item app_private.products%rowtype;
begin
 for part in select * from jsonb_array_elements(coalesce(parts,'[]')) loop
  select * into item from app_private.products where business_id=p_business and id=(part->>'productId')::uuid;
  if not found then return 'Combo no disponible: falta un componente.'; end if;
  if item.deleted_at is not null or not item.active or jsonb_array_length(coalesce(item.details->'comboComponents','[]'))>0 then return 'Combo no disponible: '||item.name||'.'; end if;
  begin perform app_private.product_selection_before_combos(item,part->'selection');
  exception when others then return 'Combo no disponible: '||item.name||'.'; end;
 end loop;
 return null;
end; $$;
create function app_private.product_selection(p app_private.products,s jsonb) returns jsonb language plpgsql set search_path='' as $$
begin
 if app_private.combo_availability_reason(p.business_id,p.details->'comboComponents') is not null then raise exception 'PRODUCT_UNAVAILABLE'; end if;
 return app_private.product_selection_before_combos(p,s);
end; $$;

create function app_private.capture_combo_product_snapshot() returns trigger language plpgsql set search_path='' as $$
declare part jsonb; item app_private.products%rowtype; pricing jsonb; snapshot jsonb:='[]'; parts jsonb:=coalesce(new.details->'comboComponents','[]');
begin
 perform app_private.validate_combo_input(parts);
 if exists(select 1 from jsonb_array_elements(parts) p where p->>'productId'=new.id::text) then raise exception 'VALIDATION_ERROR'; end if;
 -- An unrelated catalog edit retains the original preparation configuration.
 if tg_op='UPDATE' and parts is not distinct from coalesce(old.details->'comboComponents','[]') then new.combo_snapshot:=old.combo_snapshot; return new; end if;
 if jsonb_array_length(parts)=0 then new.combo_snapshot:=null; return new; end if;
 perform 1 from app_private.products p where p.business_id=new.business_id and p.id in (select (x->>'productId')::uuid from jsonb_array_elements(parts) x) order by p.id for share;
 for part in select * from jsonb_array_elements(parts) loop
  select * into item from app_private.products where business_id=new.business_id and id=(part->>'productId')::uuid;
  if not found or item.version<>(part->>'version')::integer then raise exception 'PRODUCT_CHANGED'; end if;
  if item.deleted_at is not null or not item.active or jsonb_array_length(coalesce(item.details->'comboComponents','[]'))>0 then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  pricing:=app_private.product_selection_before_combos(item,part->'selection');
  snapshot:=snapshot||jsonb_build_array(jsonb_build_object('productId',item.id,'version',item.version,'quantity',(part->>'quantity')::integer,
   'name',coalesce(nullif(item.details->>'customerName',''),item.name),'kitchenName',coalesce(nullif(item.details->>'kitchenName',''),item.name),'selectionLabel',pricing->>'label'));
 end loop;
 new.combo_snapshot:=snapshot; return new;
end; $$;
create trigger capture_combo_product_snapshot before insert or update of details on app_private.products for each row execute function app_private.capture_combo_product_snapshot();

alter function app_private.product_json(app_private.products) rename to product_json_before_combos;
create function app_private.product_json(p_product app_private.products) returns jsonb language sql set search_path='' as $$
 select app_private.product_json_before_combos(p_product)||case when p_product.combo_snapshot is null then '{}'::jsonb else jsonb_build_object('comboComponents',p_product.combo_snapshot,
 'comboUnavailableReason',app_private.combo_availability_reason(p_product.business_id,p_product.details->'comboComponents')) end;
$$;
create function app_private.capture_combo_order_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if new.product_id is not null then select p.combo_snapshot into new.combo_snapshot from app_private.products p where p.business_id=new.business_id and p.id=new.product_id; end if;
 return new;
end; $$;
create trigger capture_combo_order_snapshot before insert on app_private.order_lines for each row execute function app_private.capture_combo_order_snapshot();
alter function app_private.ops_line_json(app_private.order_lines) rename to ops_line_json_before_combos;
create function app_private.ops_line_json(l app_private.order_lines) returns jsonb language sql immutable set search_path='' as $$
 select app_private.ops_line_json_before_combos(l)||case when l.combo_snapshot is null then '{}'::jsonb else jsonb_build_object('comboComponents',l.combo_snapshot) end;
$$;
alter function app_private.ops_slice(app_private.order_lines,integer) rename to ops_slice_before_combos;
create function app_private.ops_slice(l app_private.order_lines,n integer) returns jsonb language sql immutable set search_path='' as $$
 select app_private.ops_slice_before_combos(l,n)||case when l.combo_snapshot is null then '{}'::jsonb else jsonb_build_object('comboComponents',l.combo_snapshot) end;
$$;
alter function app_private.ops_amount_line(app_private.order_lines,bigint) rename to ops_amount_line_before_combos;
create function app_private.ops_amount_line(l app_private.order_lines,p_take bigint) returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_amount_line_before_combos(l,p_take)||case when l.combo_snapshot is null then '{}'::jsonb else jsonb_build_object('comboComponents',l.combo_snapshot) end;
$$;
create function app_private.capture_combo_kitchen_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 new.items:=(select jsonb_agg(x||case when l.combo_snapshot is null then '{}'::jsonb else jsonb_build_object('comboComponents',l.combo_snapshot) end order by position)
  from jsonb_array_elements(new.items) with ordinality entries(x,position) left join app_private.order_lines l
  on l.business_id=new.business_id and l.order_id=new.order_id and l.id=(x->>'lineId')::uuid);
 return new;
end; $$;
create trigger capture_combo_kitchen_snapshot before insert on app_private.kitchen_batches for each row execute function app_private.capture_combo_kitchen_snapshot();

-- Copy accepted quote metadata with receipt amounts; retain existing money,
-- actor checks, state transitions and idempotence. Guard exact predecessors.
do $$
declare signature text; definition text; needle text; replacement text;
begin
 foreach signature in array array['app_private.pos_command_before_point(uuid,uuid,jsonb)','app_private.point_materialize(app_private.point_attempts)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  needle:='allocated_gross_cents,line_kind)'; replacement:='allocated_gross_cents,line_kind,combo_snapshot)';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'COMBO_RECEIPT_PREDECESSOR_CHANGED'; end if;
  definition:=replace(definition,needle,replacement);
  needle:='else ''product'' end from jsonb_array_elements'; replacement:='else ''product'' end,x->''comboComponents'' from jsonb_array_elements';
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'COMBO_RECEIPT_PREDECESSOR_CHANGED'; end if;
  execute replace(definition,needle,replacement);
 end loop;
 definition:=pg_get_functiondef('app_private.ops_assert_attempt_integrity(uuid,uuid)'::regprocedure);
 needle:='''taxBps'',i.tax_bps,''taxTreatment'',i.tax_treatment)';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'COMBO_INTEGRITY_PREDECESSOR_CHANGED'; end if;
 execute replace(definition,needle,needle||'||case when i.combo_snapshot is null then ''{}''::jsonb else jsonb_build_object(''comboComponents'',i.combo_snapshot) end');
 definition:=pg_get_functiondef('app_private.sale_json(app_private.sales,boolean)'::regprocedure);
 needle:='''taxBps'',i.tax_bps)';
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'COMBO_SALE_JSON_PREDECESSOR_CHANGED'; end if;
 execute replace(definition,needle,needle||'||case when i.combo_snapshot is null then ''{}''::jsonb else jsonb_build_object(''comboComponents'',i.combo_snapshot) end');
end; $$;
-- Direct legacy sales have no operational quote and hold their catalog locks.
create function app_private.capture_combo_legacy_receipt_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if new.combo_snapshot is null and new.product_id is not null and not exists(select 1 from app_private.sales s join app_private.checkout_attempts a on a.business_id=s.business_id and a.id=s.operation_id where s.business_id=new.business_id and s.id=new.sale_id) then
  select p.combo_snapshot into new.combo_snapshot from app_private.products p where p.business_id=new.business_id and p.id=new.product_id;
 end if;
 return new;
end; $$;
create trigger capture_combo_legacy_receipt_snapshot before insert on app_private.sale_items for each row execute function app_private.capture_combo_legacy_receipt_snapshot();
revoke all on function app_private.validate_combo_input(jsonb),app_private.validate_product_details(uuid,jsonb),app_private.validate_product_details_before_combos(uuid,jsonb),
 app_private.combo_availability_reason(uuid,jsonb),app_private.product_selection(app_private.products,jsonb),app_private.product_selection_before_combos(app_private.products,jsonb),
 app_private.capture_combo_product_snapshot(),app_private.product_json(app_private.products),app_private.product_json_before_combos(app_private.products),app_private.capture_combo_order_snapshot(),
 app_private.ops_line_json(app_private.order_lines),app_private.ops_line_json_before_combos(app_private.order_lines),app_private.ops_slice(app_private.order_lines,integer),app_private.ops_slice_before_combos(app_private.order_lines,integer),
 app_private.ops_amount_line(app_private.order_lines,bigint),app_private.ops_amount_line_before_combos(app_private.order_lines,bigint),app_private.capture_combo_kitchen_snapshot(),app_private.capture_combo_legacy_receipt_snapshot() from public,anon,authenticated;
