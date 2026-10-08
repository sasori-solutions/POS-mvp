-- Bounded catalogue batches have one immutable receipt and commit atomically.
-- Row writes use the current dispatcher, preserving shared-library validation.
create function app_private.catalog_batch_row_uuid(p_operation uuid,p_row uuid,p_kind text)
returns uuid language sql immutable set search_path='' as $$
  with value as (select encode(extensions.digest(p_operation::text||':'||p_row::text||':'||p_kind,'sha256'),'hex') h)
  select (substring(h from 1 for 8)||'-'||substring(h from 9 for 4)||'-5'||substring(h from 14 for 3)||'-8'||substring(h from 18 for 3)||'-'||substring(h from 21 for 12))::uuid from value;
$$;

alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_catalog_bulk;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
<<catalog_batch>>
declare p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken']; c text:=p_payload->>'command';
  actor app_private.employees%rowtype; operation app_private.pos_operations%rowtype; product app_private.products%rowtype;
  operation_id uuid; fingerprint bytea; rows jsonb; row jsonb; patch jsonb; result jsonb:='[]'; saved jsonb; command jsonb; details jsonb;
  product_id uuid; expected_version integer; active boolean; tax text;
begin
  if c is null or c not in ('import_products','bulk_edit_products') then return app_private.pos_command_before_catalog_bulk(p_business_id,p_employee_id,p_payload); end if;
  select e.* into actor from app_private.employees e where e.business_id=p_business_id and e.id=p_employee_id and e.active and e.deleted_at is null for share;
  if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
  if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
  if not app_private.has_permission(p_business_id,actor.id,'catalog.manage') then raise exception 'PERMISSION_DENIED'; end if;
  if octet_length(p::text)>8192 then raise exception 'PAYLOAD_TOO_LARGE'; end if;
  if c='import_products' then perform app_private.ops_exact(p,array['command','operationId','items']); rows:=p->'items';
  else
    perform app_private.ops_exact(p,array['command','operationId','products','patch']); rows:=p->'products'; patch:=p->'patch';
    if jsonb_typeof(patch) is distinct from 'object' or (select count(*) from jsonb_object_keys(patch)) not between 1 and 4
      or exists(select 1 from jsonb_object_keys(patch) k where k not in ('category','active','priceCents','vatTreatment')) then raise exception 'VALIDATION_ERROR'; end if;
    if patch ? 'category' and (jsonb_typeof(patch->'category') is distinct from 'string' or char_length(patch->>'category')>60 or patch->>'category' ~ '[\x01-\x1f\x7f]') then raise exception 'VALIDATION_ERROR'; end if;
    if patch ? 'active' and jsonb_typeof(patch->'active') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
    if patch ? 'priceCents' then perform app_private.ops_int(patch->'priceCents',0,99999999); end if;
    if patch ? 'vatTreatment' and (jsonb_typeof(patch->'vatTreatment') is distinct from 'string' or patch->>'vatTreatment' not in ('vat_16','vat_0','exempt','border_8','unconfigured')) then raise exception 'VALIDATION_ERROR'; end if;
  end if;
  if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and 20
    or (select count(distinct lower(value->>'productId')) from jsonb_array_elements(rows))<>jsonb_array_length(rows) then raise exception 'VALIDATION_ERROR'; end if;
  operation_id:=app_private.ops_uuid(p->'operationId'); fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:'||p_business_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
  select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=catalog_batch.operation_id;
  if found then
    if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
    return jsonb_build_object('data',operation.result);
  end if;
  -- Fixed ordering is shared with ordinary product updates and library edits.
  for row in select value from jsonb_array_elements(rows) order by value->>'productId' loop
    product_id:=app_private.ops_uuid(row->'productId');
    if c='import_products' then
      perform app_private.ops_exact(row,array['productId','expectedVersion','name','category','priceCents','active']||case when row ? 'details' then array['details'] else array[]::text[] end);
      if jsonb_typeof(row->'active') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
      if row->'expectedVersion'<>'null'::jsonb then perform app_private.ops_int(row->'expectedVersion',1,2147483647); end if;
      command:=(row-'active')||jsonb_build_object('command','save_product','operationId',app_private.catalog_batch_row_uuid(operation_id,product_id,'save'));
      saved:=app_private.pos_command(p_business_id,p_employee_id,command)->'data'; active:=(row->>'active')::boolean;
    else
      perform app_private.ops_exact(row,array['productId','expectedVersion']); expected_version:=app_private.ops_int(row->'expectedVersion',1,2147483647);
      select * into product from app_private.products where business_id=p_business_id and id=product_id and deleted_at is null for update;
      if not found or product.version<>expected_version then raise exception 'PRODUCT_CHANGED'; end if;
      command:=jsonb_build_object('command','save_product','operationId',app_private.catalog_batch_row_uuid(operation_id,product_id,'save'),
        'productId',product_id,'expectedVersion',product.version,'name',product.name,'category',coalesce(patch->'category',to_jsonb(product.category)),
        'priceCents',coalesce(patch->'priceCents',to_jsonb(product.price_cents)));
      if patch ? 'vatTreatment' then
        -- Legacy sparse details become complete without discarding old options.
        details:='{"description":"","imageId":null,"tileColor":"#E8EEF8","tileLabel":"","itemType":"prepared","customerName":"","kitchenName":"","sku":"","barcode":"","soldOut":false,"favorite":false,"variablePrice":false,"trackStock":false,"stock":0,"lowStockAlert":5,"costCents":null,"taxBps":0,"calories":null,"dietary":"","allergens":"","variations":[],"modifierSets":[]}'::jsonb||product.details;
        tax:=patch->>'vatTreatment'; details:=details||jsonb_build_object('taxTreatment',tax,'taxBps',case tax when 'vat_16' then 1600 when 'border_8' then 800 else 0 end);
        command:=command||jsonb_build_object('details',details);
      end if;
      saved:=app_private.pos_command(p_business_id,p_employee_id,command)->'data'; active:=coalesce((patch->>'active')::boolean,product.active);
    end if;
    if (saved->>'active')::boolean is distinct from active then
      saved:=app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object('command','set_product_active',
        'operationId',app_private.catalog_batch_row_uuid(operation_id,product_id,'active'),'productId',product_id,'expectedVersion',saved->'version','active',active))->'data';
    end if;
    if saved is null or saved->>'id' is distinct from product_id::text then raise exception 'SERVER_ERROR'; end if;
    result:=result||jsonb_build_array(saved);
  end loop;
  result:=jsonb_build_object('products',result);
  insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,operation_id,actor.id,fingerprint,result);
  return jsonb_build_object('data',result);
end $$;

revoke all on function app_private.catalog_batch_row_uuid(uuid,uuid,text),app_private.pos_command_before_catalog_bulk(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
