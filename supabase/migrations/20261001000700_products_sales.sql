-- Online catalog and sales. Money is integer MXN cents; finalized sales are append-only.
create table app_private.products (
  id uuid primary key,
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  category text not null default '' check (char_length(category) <= 60),
  price_cents integer not null check (price_cents between 0 and 99999999),
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (business_id,id)
);
create index products_catalog_idx on app_private.products(business_id,name,id);

create table app_private.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  employee_id uuid,
  operator_name text not null,
  operation_id uuid not null,
  total_cents bigint not null check (total_cents between 0 and 9999999999),
  item_count integer not null check (item_count between 1 and 39960),
  payment_method text not null check (payment_method in ('cash','card_external','transfer')),
  timezone text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (business_id,id), unique (business_id,operation_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete set null (employee_id)
);
create index sales_history_idx on app_private.sales(business_id,created_at desc,id desc);
create index sales_employee_history_idx on app_private.sales(business_id,employee_id,created_at desc,id desc);

create table app_private.sale_items (
  business_id uuid not null,
  sale_id uuid not null,
  product_id uuid not null,
  name text not null,
  category text not null,
  quantity integer not null check (quantity between 1 and 999),
  unit_price_cents integer not null check (unit_price_cents between 0 and 99999999),
  total_cents bigint not null check (total_cents = quantity::bigint * unit_price_cents),
  primary key (sale_id,product_id),
  foreign key (business_id,sale_id) references app_private.sales(business_id,id) on delete cascade,
  foreign key (business_id,product_id) references app_private.products(business_id,id)
);

create table app_private.pos_operations (
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  operation_id uuid not null,
  actor_id uuid not null,
  payload_fingerprint bytea not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (business_id,operation_id)
);

alter table app_private.products enable row level security;
alter table app_private.sales enable row level security;
alter table app_private.sale_items enable row level security;
alter table app_private.pos_operations enable row level security;
revoke all on app_private.products,app_private.sales,app_private.sale_items,app_private.pos_operations from public,anon,authenticated;

create function app_private.product_json(p_product app_private.products)
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object('id',p_product.id,'name',p_product.name,'category',p_product.category,
    'priceCents',p_product.price_cents,'active',p_product.active,'version',p_product.version);
$$;

create function app_private.sale_json(p_sale app_private.sales,p_detail boolean default true)
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object('id',p_sale.id,'createdAt',p_sale.created_at,'timezone',p_sale.timezone,
    'totalCents',p_sale.total_cents,'paymentMethod',p_sale.payment_method,'itemCount',p_sale.item_count,
    'operatorName',p_sale.operator_name) || case when p_detail then jsonb_build_object('items',(
      select jsonb_agg(jsonb_build_object('productId',i.product_id,'name',i.name,'category',i.category,
        'quantity',i.quantity,'unitPriceCents',i.unit_price_cents,'totalCents',i.total_cents) order by i.name,i.product_id)
      from app_private.sale_items i where i.business_id=p_sale.business_id and i.sale_id=p_sale.id
    )) else '{}'::jsonb end;
$$;

-- Called only through the two credential-checked entry points below.
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
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
begin
  select * into v_actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active for share;
  if not found then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_actor.role not in ('owner','manager','cashier') then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if v_actor.user_id is not null then perform app_private.assert_member(v_actor.user_id,p_business_id); end if;
  select * into v_business from app_private.businesses where id=p_business_id;

  if v_command='catalog' then
    select coalesce(jsonb_agg(app_private.product_json(p) order by p.name,p.id),'[]'::jsonb) into v_products
      from app_private.products p where p.business_id=p_business_id and (p.active or v_actor.role in ('owner','manager'));
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

  if v_command not in ('save_product','set_product_active','complete_sale') or v_command is null then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  if v_command in ('save_product','set_product_active') and v_actor.role not in ('owner','manager') then
    raise exception 'PERMISSION_DENIED' using errcode='P0001';
  end if;
  v_operation_id:=(p_payload->>'operationId')::uuid;
  if v_operation_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  -- Identity and transient credentials never form part of an operation or its stored outcome.
  if v_command='complete_sale' then
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    select jsonb_agg(i order by i->>'productId') into v_items from jsonb_array_elements(p_payload->'items') i;
    v_fingerprint:=extensions.digest((jsonb_build_object('command',v_command,'items',v_items,
      'totalCents',p_payload->'totalCents','paymentMethod',p_payload->'paymentMethod'))::text,'sha256');
  else
    v_fingerprint:=extensions.digest((p_payload-array['action','businessId','operatorToken','deviceToken','operationId'])::text,'sha256');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||v_operation_id::text,0));
  select * into v_operation from app_private.pos_operations where business_id=p_business_id and operation_id=v_operation_id;
  if found then
    if v_operation.actor_id<>v_actor.id or v_operation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    -- Replays return the accepted result even after price, availability or payment configuration changes.
    return jsonb_build_object('data',v_operation.result);
  end if;

  if v_command in ('save_product','set_product_active') then
    v_product_id:=(p_payload->>'productId')::uuid;
    if v_product_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    select * into v_product from app_private.products where business_id=p_business_id and id=v_product_id for update;
    if v_command='save_product' then
      v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g'));
      v_category:=btrim(regexp_replace(p_payload->>'category','[[:space:]]+',' ','g'));
      if v_name is null or char_length(v_name) not between 1 and 100 or v_category is null or char_length(v_category)>60
        or v_name ~ '[\x01-\x1f\x7f]' or v_category ~ '[\x01-\x1f\x7f]'
        or jsonb_typeof(p_payload->'priceCents') is distinct from 'number' or p_payload->>'priceCents' !~ '^[0-9]+$'
        or (p_payload->>'priceCents')::numeric not between 0 and 99999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      v_price:=(p_payload->>'priceCents')::integer;
      if p_payload->'expectedVersion'='null'::jsonb then
        if v_product.id is not null or exists(select 1 from app_private.products where id=v_product_id) then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
        insert into app_private.products(id,business_id,name,category,price_cents) values(v_product_id,p_business_id,v_name,v_category,v_price) returning * into v_product;
      else
        v_version:=(p_payload->>'expectedVersion')::integer;
        if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
        update app_private.products set name=v_name,category=v_category,price_cents=v_price,version=version+1,updated_at=clock_timestamp()
          where id=v_product.id and business_id=p_business_id returning * into v_product;
      end if;
    else
      v_version:=(p_payload->>'expectedVersion')::integer;
      if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      if v_product.id is null or v_version is null or v_product.version<>v_version then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
      update app_private.products set active=(p_payload->>'active')::boolean,version=version+1,updated_at=clock_timestamp()
        where id=v_product.id and business_id=p_business_id returning * into v_product;
    end if;
    v_result:=app_private.product_json(v_product);
  else
    if v_items is null or jsonb_array_length(v_items) not between 1 and 40
      or (select count(distinct i->>'productId') from jsonb_array_elements(v_items) i)<>jsonb_array_length(v_items)
      or p_payload->>'paymentMethod' is null or p_payload->>'paymentMethod' not in ('cash','card_external','transfer')
      or jsonb_typeof(p_payload->'totalCents') is distinct from 'number' or p_payload->>'totalCents' !~ '^[0-9]+$'
      or (p_payload->>'totalCents')::numeric not between 0 and 9999999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    if not (v_business.profile->'paymentMethods' ? (p_payload->>'paymentMethod')) then raise exception 'PAYMENT_METHOD_DISABLED' using errcode='P0001'; end if;
    -- Lock in a stable order against simultaneous edits/deactivation. SQL computes the authoritative total.
    perform 1 from app_private.products p where p.business_id=p_business_id
      and p.id in (select (i->>'productId')::uuid from jsonb_array_elements(v_items) i) order by p.id for share;
    for v_item in select * from jsonb_array_elements(v_items) loop
      if jsonb_typeof(v_item->'quantity') is distinct from 'number' or v_item->>'quantity' !~ '^[0-9]+$'
        or (v_item->>'quantity')::numeric not between 1 and 999
        or jsonb_typeof(v_item->'unitPriceCents') is distinct from 'number' or v_item->>'unitPriceCents' !~ '^[0-9]+$'
        or (v_item->>'unitPriceCents')::numeric not between 0 and 99999999
        or jsonb_typeof(v_item->'version') is distinct from 'number' or v_item->>'version' !~ '^[0-9]+$'
        or (v_item->>'version')::numeric not between 1 and 2147483647 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      select * into v_product from app_private.products where business_id=p_business_id and id=(v_item->>'productId')::uuid;
      if not found or not v_product.active then raise exception 'PRODUCT_UNAVAILABLE' using errcode='P0001'; end if;
      if v_product.price_cents<>(v_item->>'unitPriceCents')::integer or v_product.version<>(v_item->>'version')::integer then raise exception 'PRODUCT_CHANGED' using errcode='P0001'; end if;
      v_quantity:=(v_item->>'quantity')::integer;
      v_total:=v_total+v_product.price_cents::bigint*v_quantity; v_count:=v_count+v_quantity;
    end loop;
    if v_total<>(p_payload->>'totalCents')::bigint or v_total>9999999999 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    insert into app_private.sales(business_id,employee_id,operator_name,operation_id,total_cents,item_count,payment_method,timezone)
      values(p_business_id,v_actor.id,v_actor.name,v_operation_id,v_total,v_count,p_payload->>'paymentMethod',v_business.timezone) returning * into v_sale;
    insert into app_private.sale_items(business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents)
      select p_business_id,v_sale.id,p.id,p.name,p.category,(i->>'quantity')::integer,p.price_cents,p.price_cents::bigint*(i->>'quantity')::integer
      from jsonb_array_elements(v_items) i join app_private.products p on p.id=(i->>'productId')::uuid and p.business_id=p_business_id;
    v_result:=app_private.sale_json(v_sale);
  end if;
  insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result)
    values(p_business_id,v_operation_id,v_actor.id,v_fingerprint,v_result);
  return jsonb_build_object('data',v_result);
end;
$$;

create function public.pos_execute(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_employee_id uuid;
begin
  perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  perform 1 from app_private.operator_sessions where business_id=p_business_id and user_id=p_user_id and auth_session_id=p_auth_session_id
    and token_hash=extensions.digest(p_operator_token,'sha256') for share;
  perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  select id into v_employee_id from app_private.employees where business_id=p_business_id and user_id=p_user_id and active;
  return app_private.pos_command(p_business_id,v_employee_id,p_payload);
end;
$$;

create function public.pos_device(p_device_token text,p_operator_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_context jsonb;
begin
  -- Reuses the existing device lock, expiry, revocation and employee membership checks.
  v_context:=public.account_device('device_context',jsonb_build_object('deviceToken',p_device_token,'operatorToken',p_operator_token));
  return app_private.pos_command((v_context#>>'{data,business,id}')::uuid,(v_context#>>'{data,business,employee,id}')::uuid,p_payload);
end;
$$;

revoke all on function app_private.product_json(app_private.products) from public,anon,authenticated;
revoke all on function app_private.sale_json(app_private.sales,boolean) from public,anon,authenticated;
revoke all on function app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.pos_execute(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.pos_device(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pos_execute(uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.pos_device(text,text,jsonb) to service_role;
