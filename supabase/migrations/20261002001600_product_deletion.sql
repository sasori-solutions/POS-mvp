-- Retire products from the catalog permanently while retaining financial references.
-- Existing rows and receipts are untouched; the old client remains compatible.
alter table app_private.products add column deleted_at timestamptz;
alter table app_private.products add constraint products_deleted_inactive check (deleted_at is null or not active);

create or replace function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_actor app_private.employees%rowtype;
  v_business app_private.businesses%rowtype;
  v_product app_private.products%rowtype;
  v_sale app_private.sales%rowtype;
  v_operation app_private.pos_operations%rowtype;
  v_command text:=p_payload->>'command';
  v_operation_id uuid;
  v_fingerprint bytea;
  v_result jsonb;
  v_products jsonb;
  v_rows jsonb;
  v_next jsonb:='null'::jsonb;
  v_items jsonb;
  v_item jsonb;
  v_product_id uuid;
  v_name text;
  v_category text;
  v_price integer;
  v_version integer;
  v_quantity integer;
  v_total bigint:=0;
  v_count integer:=0;
  v_pricing jsonb;
  v_image_id uuid;
  v_image app_private.product_images%rowtype;
  v_image_data text;
begin
  select * into v_actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active for share;
  if not found then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_actor.role not in ('owner','manager','cashier') then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if v_actor.user_id is not null then perform app_private.assert_member(v_actor.user_id,p_business_id); end if;
  select * into v_business from app_private.businesses where id=p_business_id;

  if v_command='catalog' then
    select coalesce(jsonb_agg(app_private.product_json(p) order by p.name,p.id),'[]'::jsonb) into v_products
      from app_private.products p where p.business_id=p_business_id and p.deleted_at is null and (p.active or v_actor.role in ('owner','manager'));
    return jsonb_build_object('data',jsonb_build_object('products',v_products,'paymentMethods',v_business.profile->'paymentMethods'));
  elsif v_command='sales' then
    select coalesce(jsonb_agg(app_private.sale_json(s,false) order by s.created_at desc,s.id desc),'[]'::jsonb) into v_rows
    from (select * from app_private.sales where business_id=p_business_id
      and (v_actor.role in ('owner','manager') or employee_id=v_actor.id)
      and (p_payload->'cursor'='null'::jsonb or (created_at,id)<((p_payload#>>'{cursor,createdAt}')::timestamptz,(p_payload#>>'{cursor,id}')::uuid))
      order by created_at desc,id desc limit 31) s;
    if jsonb_array_length(v_rows)>30 then
      v_rows:=v_rows-30;
      v_next:=jsonb_build_object('createdAt',v_rows#>>'{29,createdAt}','id',v_rows#>>'{29,id}');
    end if;
    return jsonb_build_object('data',jsonb_build_object('sales',v_rows,'nextCursor',v_next));
  elsif v_command='sale' then
    select * into v_sale from app_private.sales where business_id=p_business_id and id=(p_payload->>'saleId')::uuid
      and (v_actor.role in ('owner','manager') or employee_id=v_actor.id);
    if not found then raise exception 'SALE_NOT_FOUND' using errcode='P0001'; end if;
    return jsonb_build_object('data',app_private.sale_json(v_sale));
  end if;

  if v_command not in ('save_product','set_product_active','delete_product','set_product_sold_out','upload_product_image','complete_sale') or v_command is null then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  if v_command in ('save_product','set_product_active','delete_product','upload_product_image') and v_actor.role not in ('owner','manager') then
    raise exception 'PERMISSION_DENIED' using errcode='P0001';
  end if;
  v_operation_id:=(p_payload->>'operationId')::uuid;
  if v_operation_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  -- Identity and transient credentials never form part of an operation or its stored outcome.
  if v_command='complete_sale' then
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    select jsonb_agg(i order by i->>'productId', coalesce(i->'selection','null'::jsonb)::text) into v_items from jsonb_array_elements(p_payload->'items') i;
    v_fingerprint:=extensions.digest((jsonb_build_object('command',v_command,'items',v_items,
      'totalCents',p_payload->'totalCents','paymentMethod',p_payload->'paymentMethod'))::text,'sha256');
  else
    v_fingerprint:=extensions.digest((p_payload-array['action','businessId','operatorToken','deviceToken','operationId'])::text,'sha256');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||v_operation_id::text,0));
  select * into v_operation from app_private.pos_operations where business_id=p_business_id and operation_id=v_operation_id;
  if found then
    if v_operation.actor_id is distinct from v_actor.id or v_operation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    -- Replays return the accepted result even after price, availability or payment configuration changes.
    return jsonb_build_object('data',v_operation.result);
  end if;

  if v_command='upload_product_image' then

    v_image_id:=(p_payload->>'imageId')::uuid;
    if v_image_id is null or jsonb_typeof(p_payload->'part') is distinct from 'number' or jsonb_typeof(p_payload->'parts') is distinct from 'number'
      or p_payload->>'part' !~ '^[0-9]+$' or p_payload->>'parts' !~ '^[0-9]+$'
      or (p_payload->>'parts')::numeric not between 1 and 60 or (p_payload->>'part')::numeric not between 0 and (p_payload->>'parts')::numeric-1
      or p_payload->>'data' is null or p_payload->>'data' !~ '^[A-Za-z0-9+/=]+$' or char_length(p_payload->>'data') not between 1 and 4096 then raise exception 'VALIDATION_ERROR'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('image:'||p_business_id::text||':'||v_image_id::text,0));
    insert into app_private.product_images(business_id,id,actor_id,parts) values(p_business_id,v_image_id,v_actor.id,(p_payload->>'parts')::integer) on conflict do nothing;
    select * into v_image from app_private.product_images where business_id=p_business_id and id=v_image_id for update;
    if v_image.actor_id<>v_actor.id or v_image.parts<>(p_payload->>'parts')::integer then raise exception 'OPERATION_CONFLICT'; end if;
    if v_image.data is null then
      insert into app_private.product_image_parts(business_id,image_id,part,data) values(p_business_id,v_image_id,(p_payload->>'part')::integer,p_payload->>'data') on conflict do nothing;
      if exists(select 1 from app_private.product_image_parts where business_id=p_business_id and image_id=v_image_id and part=(p_payload->>'part')::integer and data<>p_payload->>'data') then raise exception 'OPERATION_CONFLICT'; end if;
      if (select count(*) from app_private.product_image_parts where business_id=p_business_id and image_id=v_image_id)=v_image.parts then
        select string_agg(data,'' order by part) into v_image_data from app_private.product_image_parts where business_id=p_business_id and image_id=v_image_id;
        if char_length(v_image_data)>245760 or char_length(v_image_data)%4<>0 or substring(decode(v_image_data,'base64') from 1 for 3)<>decode('ffd8ff','hex')
          then raise exception 'VALIDATION_ERROR'; end if;
        update app_private.product_images set data=v_image_data where business_id=p_business_id and id=v_image_id;
        delete from app_private.product_image_parts where business_id=p_business_id and image_id=v_image_id;
      end if;
    end if;
    v_result:=jsonb_build_object('imageId',v_image_id,'complete',exists(select 1 from app_private.product_images where business_id=p_business_id and id=v_image_id and data is not null));
  elsif v_command in ('save_product','set_product_active','delete_product','set_product_sold_out') then
    v_product_id:=(p_payload->>'productId')::uuid;
    if v_product_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    select * into v_product from app_private.products where business_id=p_business_id and id=v_product_id for update;
    if v_product.deleted_at is not null then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
    if v_command='delete_product' then
      v_version:=(p_payload->>'expectedVersion')::integer;
      if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
      update app_private.products set active=false,deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
        where business_id=p_business_id and id=v_product.id returning * into v_product;
    elsif v_command='save_product' then
      v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g'));
      v_category:=btrim(regexp_replace(p_payload->>'category','[[:space:]]+',' ','g'));
      if v_name is null or char_length(v_name) not between 1 and 100 or v_category is null or char_length(v_category)>60
        or v_name ~ '[\x01-\x1f\x7f]' or v_category ~ '[\x01-\x1f\x7f]'
        or jsonb_typeof(p_payload->'priceCents') is distinct from 'number' or p_payload->>'priceCents' !~ '^[0-9]+$'
        or (p_payload->>'priceCents')::numeric not between 0 and 99999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      v_price:=(p_payload->>'priceCents')::integer;
      if p_payload ? 'details' then perform app_private.validate_product_details(p_business_id,p_payload->'details'); end if;
      if p_payload->'expectedVersion'='null'::jsonb then
        if v_product.id is not null or exists(select 1 from app_private.products where id=v_product_id) then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
        insert into app_private.products(id,business_id,name,category,price_cents,details) values(v_product_id,p_business_id,v_name,v_category,v_price,coalesce(p_payload->'details','{}'::jsonb)) returning * into v_product;
      else
        v_version:=(p_payload->>'expectedVersion')::integer;
        if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
        update app_private.products set name=v_name,category=v_category,price_cents=v_price,details=coalesce(p_payload->'details',details),version=version+1,updated_at=clock_timestamp()
          where id=v_product.id and business_id=p_business_id returning * into v_product;
      end if;
    elsif v_command='set_product_sold_out' then
      v_version:=(p_payload->>'expectedVersion')::integer;
      if jsonb_typeof(p_payload->'soldOut') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
      if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED'; end if;
      update app_private.products set details=jsonb_set(details,'{soldOut}',p_payload->'soldOut'),version=version+1,updated_at=clock_timestamp()
        where business_id=p_business_id and id=v_product.id returning * into v_product;
    else
      v_version:=(p_payload->>'expectedVersion')::integer;
      if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
      update app_private.products set active=(p_payload->>'active')::boolean,version=version+1,updated_at=clock_timestamp()
        where id=v_product.id and business_id=p_business_id returning * into v_product;
    end if;
    v_result:=case when v_command='delete_product' then jsonb_build_object('id',v_product.id,'deleted',true) else app_private.product_json(v_product) end;
  else
    if v_items is null or jsonb_array_length(v_items) not between 1 and 40
      or (select count(distinct (i->>'productId',coalesce(i->'selection','null'::jsonb))) from jsonb_array_elements(v_items) i)<>jsonb_array_length(v_items)
      or p_payload->>'paymentMethod' is null or p_payload->>'paymentMethod' not in ('cash','card_external','transfer')
      or jsonb_typeof(p_payload->'totalCents') is distinct from 'number' or p_payload->>'totalCents' !~ '^[0-9]+$'
      or (p_payload->>'totalCents')::numeric not between 0 and 9999999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    if not (v_business.profile->'paymentMethods' ? (p_payload->>'paymentMethod')) then raise exception 'PAYMENT_METHOD_DISABLED' using errcode='P0001'; end if;
    -- Lock in a stable order against simultaneous edits/deactivation. SQL computes the authoritative total.
    perform 1 from app_private.products p where p.business_id=p_business_id
      and p.id in (select (i->>'productId')::uuid from jsonb_array_elements(v_items) i) order by p.id for update;
    for v_item in select * from jsonb_array_elements(v_items) loop
      if jsonb_typeof(v_item->'quantity') is distinct from 'number' or v_item->>'quantity' !~ '^[0-9]+$'
        or (v_item->>'quantity')::numeric not between 1 and 999
        or jsonb_typeof(v_item->'unitPriceCents') is distinct from 'number' or v_item->>'unitPriceCents' !~ '^[0-9]+$'
        or (v_item->>'unitPriceCents')::numeric not between 0 and 99999999
        or jsonb_typeof(v_item->'version') is distinct from 'number' or v_item->>'version' !~ '^[0-9]+$'
        or (v_item->>'version')::numeric not between 1 and 2147483647 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      select * into v_product from app_private.products where business_id=p_business_id and id=(v_item->>'productId')::uuid;
      if not found or v_product.deleted_at is not null or not v_product.active or coalesce((v_product.details->>'soldOut')::boolean,false) then raise exception 'PRODUCT_UNAVAILABLE' using errcode='P0001'; end if;
      v_pricing:=app_private.product_selection(v_product,v_item->'selection');
      if (v_pricing->>'price')::integer<>(v_item->>'unitPriceCents')::integer or v_product.version<>(v_item->>'version')::integer then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
      v_quantity:=(v_item->>'quantity')::integer;
      if coalesce((v_product.details->>'trackStock')::boolean,false) and (v_product.details->>'stock')::integer < (select sum((i->>'quantity')::integer) from jsonb_array_elements(v_items) i where i->>'productId'=v_product.id::text) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
      v_total:=v_total+(v_pricing->>'price')::bigint*v_quantity; v_count:=v_count+v_quantity;
    end loop;
    if v_total<>(p_payload->>'totalCents')::bigint or v_total>9999999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    insert into app_private.sales(business_id,employee_id,operator_name,operation_id,total_cents,item_count,payment_method,timezone)
      values(p_business_id,v_actor.id,v_actor.name,v_operation_id,v_total,v_count,p_payload->>'paymentMethod',v_business.timezone) returning * into v_sale;
    insert into app_private.sale_items(business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps)
      select p_business_id,v_sale.id,p.id,p.name,p.category,(i->>'quantity')::integer,(pricing->>'price')::integer,
        (pricing->>'price')::bigint*(i->>'quantity')::integer,pricing->>'label',
        app_private.included_vat_cents((pricing->>'price')::bigint*(i->>'quantity')::integer,coalesce((p.details->>'taxBps')::integer,0)),
        app_private.product_tax_treatment(p.details),coalesce((p.details->>'taxBps')::integer,0)
      from jsonb_array_elements(v_items) i join app_private.products p on p.id=(i->>'productId')::uuid and p.business_id=p_business_id
      cross join lateral app_private.product_selection(p,i->'selection') pricing;
    update app_private.products p set version=p.version+1,details=jsonb_set(p.details,'{stock}',to_jsonb((p.details->>'stock')::integer-q.quantity)),updated_at=clock_timestamp()
      from (select (i->>'productId')::uuid id,sum((i->>'quantity')::integer)::integer quantity from jsonb_array_elements(v_items) i group by 1) q
      where p.business_id=p_business_id and p.id=q.id and coalesce((p.details->>'trackStock')::boolean,false);
    v_result:=app_private.sale_json(v_sale);
  end if;
  insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result)
    values(p_business_id,v_operation_id,v_actor.id,v_fingerprint,v_result);
  return jsonb_build_object('data',v_result);
end;
$$;


revoke all on function app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
