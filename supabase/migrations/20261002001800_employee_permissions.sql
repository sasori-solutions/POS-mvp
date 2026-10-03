-- Explicit employee grants replace operational role presets. The owner identity stays protected.
-- Existing operational access is migrated once; new rows receive no role-derived rights.
create function app_private.permission_keys()
returns text[] language sql immutable set search_path='' as $$ select array['catalog.read','catalog.manage','catalog.availability','sales.create','sales.read_own','sales.read_all','sales.discount','sales.reverse','orders.read','orders.manage','orders.cancel','kitchen.read','kitchen.operate','cash.read','cash.open','cash.move','cash.close','reports.read','tables.manage']::text[]; $$;

-- Editing a permission implies its read prerequisite in every entry point.
create function app_private.employee_permissions_valid(p_permissions text[])
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_permissions <@ app_private.permission_keys() and array_position(p_permissions,null) is null
    and cardinality(p_permissions)=(select count(distinct value) from unnest(p_permissions) value)
    and not exists(select 1 from (values
      ('catalog.manage','catalog.read'),('catalog.availability','catalog.read'),('sales.create','catalog.read'),
      ('sales.discount','sales.create'),('sales.reverse','sales.read_all'),
      ('orders.manage','orders.read'),('orders.cancel','orders.read'),('kitchen.operate','kitchen.read'),
      ('cash.open','cash.read'),('cash.move','cash.read'),('cash.close','cash.read')
    ) dependencies(permission,prerequisite) where permission=any(p_permissions) and not prerequisite=any(p_permissions)),false);
$$;

alter table app_private.employees add column permissions text[] not null default '{}'::text[];
alter table app_private.employees add constraint employee_permissions_known check (
  app_private.employee_permissions_valid(permissions));
update app_private.employees set permissions=case role
  when 'manager' then array['catalog.read','catalog.manage','catalog.availability','sales.create','sales.read_own','sales.read_all']::text[]
  when 'cashier' then array['catalog.read','catalog.availability','sales.create','sales.read_own']::text[]
  else '{}'::text[] end;

create function app_private.validate_employee_permissions(p_permissions jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare v_values text[];
begin
  if jsonb_typeof(p_permissions) is distinct from 'array' or jsonb_array_length(p_permissions)>cardinality(app_private.permission_keys())
    or exists(select 1 from jsonb_array_elements(p_permissions) v where jsonb_typeof(v) is distinct from 'string') then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  select coalesce(array_agg(value order by value),'{}'::text[]) into v_values from jsonb_array_elements_text(p_permissions);
  if not app_private.employee_permissions_valid(v_values) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  return v_values;
end;
$$;

create function app_private.has_permission(p_business_id uuid,p_employee_id uuid,p_permission text)
returns boolean language sql stable set search_path='' as $$
  select coalesce(p_permission=any(app_private.permission_keys()) and exists(
    select 1 from app_private.employees e where e.business_id=p_business_id and e.id=p_employee_id and e.active and e.deleted_at is null
      and (e.role='owner' or p_permission=any(e.permissions))
      and (e.user_id is null or exists(select 1 from app_private.business_memberships m
        where m.business_id=e.business_id and m.user_id=e.user_id and m.active and m.role=e.role))),false);
$$;

create function app_private.revoke_changed_employee_permissions()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.permissions is distinct from old.permissions then
    perform app_private.revoke_person_operator_sessions(new.user_id,new.business_id,new.id);
  end if;
  return new;
end;
$$;
create trigger employee_permissions_revoke_sessions after update of permissions on app_private.employees
  for each row execute function app_private.revoke_changed_employee_permissions();

create or replace function app_private.employee_summary(p_employee app_private.employees)
returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('id',p_employee.id,'name',p_employee.name,'role',p_employee.role,'active',p_employee.active,
    'permissions',case when p_employee.role='owner' then app_private.permission_keys() else p_employee.permissions end,
    'deletedAt',p_employee.deleted_at,'googleLinked',p_employee.user_id is not null,
    'pinReady',case when p_employee.user_id is not null then exists(select 1 from app_private.operator_credentials c where c.business_id=p_employee.business_id and c.user_id=p_employee.user_id)
      else exists(select 1 from app_private.shared_employee_credentials c where c.business_id=p_employee.business_id and c.employee_id=p_employee.id) end);
$$;

create or replace function app_private.employee_context(p_employee_id uuid,p_allow_profile boolean)
returns jsonb language plpgsql set search_path='' as $$
declare v_context jsonb;
begin
  select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,
    'timezone',b.timezone,'currency',b.currency,'createdAt',b.created_at,'role',e.role,
    'permissions',case when e.role='owner' then app_private.permission_keys() else e.permissions end,
    'employee',jsonb_build_object('id',e.id,'name',e.name,'role',e.role,'permissions',case when e.role='owner' then app_private.permission_keys() else e.permissions end),
    'profile',case when p_allow_profile and e.role='owner' then b.profile else
      '{"branchName":"","registerName":"","address":"","city":"","state":"","contactPhone":"","paymentMethods":[]}'::jsonb end)
    into v_context from app_private.employees e join app_private.businesses b on b.id=e.business_id
    where e.id=p_employee_id and e.active and e.deleted_at is null;
  if v_context is null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  return v_context;
end;
$$;

-- Employee edits take the employee lock before revoking operator rows. Match that
-- order here, then reauthorize after both locks; revocation cannot deadlock with a sale.
create or replace function public.pos_execute(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_employee_id uuid;
begin
  perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  select id into v_employee_id from app_private.employees where business_id=p_business_id and user_id=p_user_id and active for share;
  perform 1 from app_private.operator_sessions where business_id=p_business_id and user_id=p_user_id and auth_session_id=p_auth_session_id
    and token_hash=extensions.digest(p_operator_token,'sha256') for share;
  perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  perform set_config('app.pos_session_kind','personal',true);
  return app_private.pos_command(p_business_id,v_employee_id,p_payload);
end;
$$;
revoke all on function public.pos_execute(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.pos_execute(uuid,uuid,uuid,text,jsonb) to service_role;

create or replace function app_private.create_employee_access_before_permanent_unlink(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_name text:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role text:=p_payload->>'role'; v_pin text:=p_payload->>'pin';
  v_google boolean:=coalesce((p_payload->>'inviteWithGoogle')::boolean,false); v_fingerprint bytea;
  v_permissions text[]; v_operation app_private.employee_create_operations%rowtype; v_employee app_private.employees%rowtype; v_invitation jsonb; v_setup jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_operation_id is null or v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    or v_role is null or v_role not in ('manager','cashier','kitchen') or v_pin is not null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_permissions:=case when p_payload ? 'permissions' then app_private.validate_employee_permissions(p_payload->'permissions') else '{}'::text[] end;
  -- New operations explicitly belong to the employee-selected PIN policy. Legacy owner-PIN operations cannot mutate through a retry.
  v_fingerprint:=extensions.digest((jsonb_build_object('businessId',v_business_id,'name',v_name,'role',v_role,'pinPolicy','employee')
    || case when p_payload ? 'permissions' then jsonb_build_object('permissions',v_permissions) else '{}'::jsonb end
    || case when v_google then jsonb_build_object('inviteWithGoogle',true) else '{}'::jsonb end)::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':create_employee:'||v_operation_id::text,0));
  select * into v_operation from app_private.employee_create_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.payload_fingerprint<>v_fingerprint or v_operation.invite_google<>v_google then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    select * into v_employee from app_private.employees where business_id=v_business_id and id=v_operation.employee_id for update;
  else
    insert into app_private.employees(business_id,name,role,permissions) values(v_business_id,v_name,'cashier',v_permissions) returning * into v_employee;
    insert into app_private.employee_create_operations(user_id,operation_id,business_id,payload_fingerprint,employee_id,initial_pin_hash,invite_google)
      values(p_user_id,v_operation_id,v_business_id,v_fingerprint,v_employee.id,null,v_google);
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_created');
  end if;
  if v_employee.deleted_at is not null or not v_employee.active then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_google and v_employee.user_id is null then
    v_invitation:=app_private.issue_employee_invitation(p_user_id,p_auth_session_id,v_business_id,v_employee.id,v_operation_id,
      extensions.digest(jsonb_build_object('businessId',v_business_id,'employeeId',v_employee.id)::text,'sha256'));
  end if;
  if not v_google and v_employee.user_id is null and not exists(select 1 from app_private.shared_employee_credentials where business_id=v_business_id and employee_id=v_employee.id) then
    v_setup:=app_private.issue_employee_pin_setup(p_user_id,p_auth_session_id,v_business_id,v_employee.id,v_operation_id,'initial');
  end if;
  return jsonb_build_object('data',app_private.employee_summary(v_employee)||case when v_invitation is not null then jsonb_build_object('invitation',v_invitation)
    when v_setup is not null then jsonb_build_object('pinSetup',v_setup) else '{}'::jsonb end);
end;
$$;


create or replace function app_private.update_employee_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_permissions text[]; v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employee app_private.employees%rowtype;
  v_name text:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role text:=p_payload->>'role'; v_pin text:=p_payload->>'pin';
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    or v_role is null or v_role not in ('manager','cashier','kitchen') or jsonb_typeof(p_payload->'active') is distinct from 'boolean'
    or v_pin is not null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_business_id and id=(p_payload->>'employeeId')::uuid for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if v_employee.deleted_at is not null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  v_permissions:=case when p_payload ? 'permissions' then app_private.validate_employee_permissions(p_payload->'permissions') else v_employee.permissions end;
  update app_private.employees set name=v_name,role=v_role,permissions=v_permissions,active=(p_payload->>'active')::boolean where id=v_employee.id returning * into v_employee;
  if v_employee.user_id is not null then
    update app_private.business_memberships set role=v_role,active=v_employee.active where business_id=v_business_id and user_id=v_employee.user_id;
    update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and user_id=v_employee.user_id and revoked_at is null;
  end if;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null;
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_updated');
  return jsonb_build_object('data',app_private.employee_summary(v_employee));
end;
$$;

create or replace function app_private.create_invitation_access_before_permanent_unlink(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_permissions text[]; v_employee_id uuid; v_name text; v_role text; v_fingerprint bytea; v_invitation app_private.business_invitations%rowtype;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_operation_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_payload ? 'employeeId' then
    if p_payload ? 'permissions' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_employee_id:=(p_payload->>'employeeId')::uuid;
    if v_employee_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_fingerprint:=extensions.digest(jsonb_build_object('businessId',v_business_id,'employeeId',v_employee_id)::text,'sha256');
  else
    v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role:=p_payload->>'role';
    if v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      or v_role is null or v_role not in ('manager','cashier','kitchen') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_permissions:=case when p_payload ? 'permissions' then app_private.validate_employee_permissions(p_payload->'permissions') else '{}'::text[] end;
    v_fingerprint:=extensions.digest((jsonb_build_object('businessId',v_business_id,'name',v_name,'role',v_role)
      || case when p_payload ? 'permissions' then jsonb_build_object('permissions',v_permissions) else '{}'::jsonb end)::text,'sha256');
    -- Serialize legacy creation per business. Existing operation retries precede the ambiguous-name guard.
    perform 1 from app_private.businesses where id=v_business_id for no key update;
    select * into v_invitation from app_private.business_invitations where created_by=p_user_id and operation_id=v_operation_id;
    if found then
      if v_invitation.business_id<>v_business_id or v_invitation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      if v_invitation.employee_id is null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
      v_employee_id:=v_invitation.employee_id;
    else
      if exists(select 1 from app_private.employees where business_id=v_business_id and lower(btrim(regexp_replace(name,'[[:space:]]+',' ','g')))=lower(v_name)) then
        raise exception 'OPERATION_CONFLICT' using errcode='P0001';
      end if;
      insert into app_private.employees(business_id,name,role,permissions) values(v_business_id,v_name,'cashier',v_permissions) returning id into v_employee_id;
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_created');
    end if;
  end if;
  return jsonb_build_object('data',app_private.issue_employee_invitation(p_user_id,p_auth_session_id,v_business_id,v_employee_id,v_operation_id,v_fingerprint));
end;
$$;

create or replace function app_private.employee_team(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employees jsonb; v_invitations jsonb; v_devices jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e where e.business_id=v_business_id and e.deleted_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'employeeId',i.employee_id,'name',coalesce(e.name,i.name),'role',coalesce(e.role,i.role),'permissions',coalesce(e.permissions,'{}'::text[]),'expiresAt',i.expires_at,
    'status',app_private.invitation_status(i,e),'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at,'revokeReason',i.revoke_reason,
    'active',app_private.invitation_status(i,e)='pending') order by coalesce(i.created_at,i.expires_at-interval '48 hours') desc,i.id),'[]'::jsonb)
    into v_invitations from app_private.business_invitations i left join app_private.employees e on e.business_id=i.business_id and e.id=i.employee_id where i.business_id=v_business_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,'active',d.revoked_at is null and d.expires_at>clock_timestamp()) order by d.created_at,d.id),'[]'::jsonb)
    into v_devices from app_private.devices d where d.business_id=v_business_id;
  return jsonb_build_object('data',jsonb_build_object('employees',v_employees,'invitations',v_invitations,'devices',v_devices));
end;
$$;

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
  if v_actor.user_id is not null then perform app_private.assert_member(v_actor.user_id,p_business_id); end if;
  select * into v_business from app_private.businesses where id=p_business_id;
  if v_command is null or v_command not in ('catalog','sales','sale','save_product','set_product_active','delete_product','set_product_sold_out','upload_product_image','complete_sale') then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  -- Current grants are checked before reading data or replaying any accepted mutation.
  if not (case
    when v_command='catalog' then app_private.has_permission(p_business_id,v_actor.id,'catalog.read')
    when v_command in ('sales','sale') then app_private.has_permission(p_business_id,v_actor.id,'sales.read_own') or app_private.has_permission(p_business_id,v_actor.id,'sales.read_all')
    when v_command in ('save_product','set_product_active','delete_product','upload_product_image') then app_private.has_permission(p_business_id,v_actor.id,'catalog.manage')
    when v_command='set_product_sold_out' then app_private.has_permission(p_business_id,v_actor.id,'catalog.availability')
    when v_command='complete_sale' then app_private.has_permission(p_business_id,v_actor.id,'sales.create')
    else false end) then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;

  if v_command='catalog' then
    select coalesce(jsonb_agg(app_private.product_json(p) order by p.name,p.id),'[]'::jsonb) into v_products
      from app_private.products p where p.business_id=p_business_id and p.deleted_at is null and (p.active or app_private.has_permission(p_business_id,v_actor.id,'catalog.manage'));
    return jsonb_build_object('data',jsonb_build_object('products',v_products,'paymentMethods',v_business.profile->'paymentMethods'));
  elsif v_command='sales' then
    select coalesce(jsonb_agg(app_private.sale_json(s,false) order by s.created_at desc,s.id desc),'[]'::jsonb) into v_rows
    from (select * from app_private.sales where business_id=p_business_id
      and (app_private.has_permission(p_business_id,v_actor.id,'sales.read_all') or employee_id=v_actor.id)
      and (p_payload->'cursor'='null'::jsonb or (created_at,id)<((p_payload#>>'{cursor,createdAt}')::timestamptz,(p_payload#>>'{cursor,id}')::uuid))
      order by created_at desc,id desc limit 31) s;
    if jsonb_array_length(v_rows)>30 then
      v_rows:=v_rows-30;
      v_next:=jsonb_build_object('createdAt',v_rows#>>'{29,createdAt}','id',v_rows#>>'{29,id}');
    end if;
    return jsonb_build_object('data',jsonb_build_object('sales',v_rows,'nextCursor',v_next));
  elsif v_command='sale' then
    select * into v_sale from app_private.sales where business_id=p_business_id and id=(p_payload->>'saleId')::uuid
      and (app_private.has_permission(p_business_id,v_actor.id,'sales.read_all') or employee_id=v_actor.id);
    if not found then raise exception 'SALE_NOT_FOUND' using errcode='P0001'; end if;
    return jsonb_build_object('data',app_private.sale_json(v_sale));
  end if;

  if v_command not in ('save_product','set_product_active','delete_product','set_product_sold_out','upload_product_image','complete_sale') or v_command is null then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
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

revoke all on all functions in schema app_private from public,anon,authenticated;
