-- Agente de Larios, 2026-10-02. Deletion permanently removes the employee from
-- this business. A later invitation is a new person, PIN and device enrollment.
-- Financial history remains immutable. Remove actor links while reserving every
-- accepted operation ID, so a fresh employee cannot replay an earlier charge.
alter table app_private.pos_operations alter column actor_id drop not null;
update app_private.pos_operations o set actor_id=null where actor_id is not null
  and not exists(select 1 from app_private.employees e where e.business_id=o.business_id and e.id=o.actor_id);
alter table app_private.pos_operations add constraint pos_operations_actor_fk
  foreign key (business_id,actor_id) references app_private.employees(business_id,id) on delete set null (actor_id);

create table app_private.employee_operation_tombstones (
  operation_key bytea primary key check (octet_length(operation_key)=32),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  action text not null check (action in ('create_employee','create_invitation','delete_employee')),
  target_hash bytea check (target_hash is null or octet_length(target_hash)=32)
);
alter table app_private.employee_operation_tombstones enable row level security;
revoke all on app_private.employee_operation_tombstones from public,anon,authenticated;

-- Keep only opaque operation identities, not the deleted employee or credentials.
insert into app_private.employee_operation_tombstones(operation_key,business_id,action,target_hash)
  select extensions.digest(user_id::text||':delete_employee:'||operation_id::text,'sha256'),business_id,'delete_employee',extensions.digest(employee_id::text,'sha256')
  from app_private.employee_lifecycle_operations where action='delete_employee' on conflict do nothing;

create function app_private.unlink_employee_before_delete()
returns trigger language plpgsql set search_path='' as $$
begin
  -- The business itself may already be disappearing through its own cascade.
  if exists(select 1 from app_private.businesses where id=old.business_id) then
    insert into app_private.employee_operation_tombstones(operation_key,business_id,action)
      select extensions.digest(o.user_id::text||':create_employee:'||o.operation_id::text,'sha256'),o.business_id,'create_employee'
      from app_private.employee_create_operations o where o.business_id=old.business_id and o.employee_id=old.id on conflict do nothing;
    insert into app_private.employee_operation_tombstones(operation_key,business_id,action)
      select extensions.digest(i.created_by::text||':create_invitation:'||i.operation_id::text,'sha256'),i.business_id,'create_invitation'
      from app_private.business_invitations i where i.business_id=old.business_id and i.employee_id=old.id on conflict do nothing;
  end if;
  if old.user_id is not null then
    -- Employee -> credential -> dependent sessions is the same lock order used
    -- by PIN entry, reset and acceptance. Other businesses and Auth stay intact.
    perform 1 from app_private.operator_credentials where business_id=old.business_id and user_id=old.user_id for update;
    update app_private.account_audit_events set user_id=null,auth_session_id=null where business_id=old.business_id and user_id=old.user_id;
    update app_private.pin_security_audit_events set user_id=null,auth_session_id=null where business_id=old.business_id and user_id=old.user_id;
    delete from app_private.business_memberships where business_id=old.business_id and user_id=old.user_id;
  end if;
  -- Employee FKs cascade invitations, setup codes, shared credentials, register
  -- sessions, personal bindings and notifications. Keep global nonce tombstones:
  -- removing them would permit a signed request to be replayed after reinviting.
  return old;
end;
$$;
create trigger employees_permanent_unlink before delete on app_private.employees
  for each row execute function app_private.unlink_employee_before_delete();

create or replace function app_private.change_employee_lifecycle(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business uuid:=(p_payload->>'businessId')::uuid; v_employee_id uuid:=(p_payload->>'employeeId')::uuid;
  v_operation uuid:=(p_payload->>'operationId')::uuid; v_key bytea; v_prior app_private.employee_operation_tombstones%rowtype;
  v_employee app_private.employees%rowtype;
begin
  if p_action is distinct from 'delete_employee' or v_business is null or v_employee_id is null or v_operation is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  -- Create/retry/invite/delete all take this lock before owner and target rows.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business::text||':employee_mutation',0));
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business,p_payload->>'operatorToken');
  v_key:=extensions.digest(p_user_id::text||':delete_employee:'||v_operation::text,'sha256');
  select * into v_prior from app_private.employee_operation_tombstones where operation_key=v_key;
  if found then
    if v_prior.business_id<>v_business or v_prior.action<>'delete_employee' or v_prior.target_hash is distinct from extensions.digest(v_employee_id::text,'sha256') then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('data',jsonb_build_object('id',v_employee_id,'deleted',true));
  end if;
  select * into v_employee from app_private.employees where business_id=v_business and id=v_employee_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  delete from app_private.employees where id=v_employee.id;
  insert into app_private.employee_operation_tombstones(operation_key,business_id,action,target_hash)
    values(v_key,v_business,'delete_employee',extensions.digest(v_employee_id::text,'sha256'));
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business,p_user_id,p_auth_session_id,'employee_deleted');
  return jsonb_build_object('data',jsonb_build_object('id',v_employee_id,'deleted',true));
end;
$$;

alter function app_private.create_employee_access(uuid,uuid,jsonb) rename to create_employee_access_before_permanent_unlink;
create function app_private.create_employee_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_prior app_private.employee_operation_tombstones%rowtype; v_business uuid:=(p_payload->>'businessId')::uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business::text||':employee_mutation',0));
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business,p_payload->>'operatorToken');
  select * into v_prior from app_private.employee_operation_tombstones where operation_key=extensions.digest(p_user_id::text||':create_employee:'||(p_payload->>'operationId')::uuid::text,'sha256');
  if found then
    if v_prior.business_id<>v_business then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001';
  end if;
  return app_private.create_employee_access_before_permanent_unlink(p_user_id,p_auth_session_id,p_payload);
end;
$$;
alter function app_private.create_invitation_access(uuid,uuid,jsonb) rename to create_invitation_access_before_permanent_unlink;
create function app_private.create_invitation_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_prior app_private.employee_operation_tombstones%rowtype; v_business uuid:=(p_payload->>'businessId')::uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business::text||':employee_mutation',0));
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business,p_payload->>'operatorToken');
  select * into v_prior from app_private.employee_operation_tombstones where operation_key=extensions.digest(p_user_id::text||':create_invitation:'||(p_payload->>'operationId')::uuid::text,'sha256');
  if found then
    if v_prior.business_id<>v_business then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001';
  end if;
  return app_private.create_invitation_access_before_permanent_unlink(p_user_id,p_auth_session_id,p_payload);
end;
$$;

create or replace function app_private.employee_invitation_details(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_invitation app_private.business_invitations%rowtype; v_employee app_private.employees%rowtype; v_business jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if p_payload->>'invitationCode' is null or p_payload->>'invitationCode' !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_invitation from app_private.business_invitations where token_hash=extensions.digest(p_payload->>'invitationCode','sha256');
  if not found or v_invitation.employee_id is null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_invitation.business_id and id=v_invitation.employee_id for update;
  if not found or not v_employee.active or v_employee.deleted_at is not null or v_employee.role='owner' then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  select * into v_invitation from app_private.business_invitations where id=v_invitation.id for update;
  if v_invitation.token_hash<>extensions.digest(p_payload->>'invitationCode','sha256') or v_invitation.revoked_at is not null or v_invitation.accepted_at is not null
    or v_invitation.expires_at<=clock_timestamp() or v_employee.user_id is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  if exists(select 1 from app_private.business_memberships where business_id=v_employee.business_id and user_id=p_user_id) then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,'timezone',b.timezone,'currency',b.currency)
    into v_business from app_private.businesses b where b.id=v_invitation.business_id;
  return jsonb_build_object('data',jsonb_build_object('business',v_business,'employee',app_private.employee_summary(v_employee),'expiresAt',v_invitation.expires_at));
end;
$$;

create or replace function app_private.accept_employee_invitation(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_operation_id uuid:=(p_payload->>'operationId')::uuid; v_pin text:=p_payload->>'pin';
  v_name text:=case when p_payload ? 'name' then btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')) else null end;
  v_invitation app_private.business_invitations%rowtype; v_employee app_private.employees%rowtype;
  v_fingerprint bytea; v_pin_result jsonb; v_shared app_private.shared_employee_credentials%rowtype;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if v_operation_id is null or v_pin is null or v_pin !~ '^[0-9]{6}$'
    or (p_payload ? 'name' and (v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'))
    or p_payload->>'invitationCode' is null or p_payload->>'invitationCode' !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':accept:'||v_operation_id::text,0));
  -- First locate without locking, then use the same employee -> invitation order as issuance/editing.
  select * into v_invitation from app_private.business_invitations where token_hash=extensions.digest(p_payload->>'invitationCode','sha256');
  if not found or v_invitation.employee_id is null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  -- A Google identity can bind to only one person in this business, even across different target rows.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':employee_membership:'||v_invitation.business_id::text,0));
  select * into v_employee from app_private.employees where id=v_invitation.employee_id and business_id=v_invitation.business_id for update;
  if not found then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  select * into v_invitation from app_private.business_invitations where id=v_invitation.id for update;
  if v_invitation.token_hash<>extensions.digest(p_payload->>'invitationCode','sha256') or v_invitation.revoked_at is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  if v_employee.deleted_at is not null or not v_employee.active then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  -- The ignored legacy name remains part of retry identity, independent of later owner edits.
  v_fingerprint:=extensions.digest(jsonb_build_object('name',v_name)::text,'sha256');
  if v_invitation.accepted_by is not null then
    if v_invitation.accepted_by<>p_user_id or v_invitation.accepted_operation_id<>v_operation_id
      or v_employee.user_id is distinct from p_user_id then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
    if v_invitation.accepted_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    v_pin_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_employee.business_id,v_pin);
    if v_pin_result is not null then
      if v_pin_result#>>'{error,code}'='PIN_INVALID' then return jsonb_build_object('error',jsonb_build_object('code','OPERATION_CONFLICT')); end if;
      return v_pin_result;
    end if;
    return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_employee.business_id);
  end if;
  if v_invitation.expires_at<=clock_timestamp() or v_employee.user_id is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  if exists(select 1 from app_private.business_invitations where accepted_by=p_user_id and accepted_operation_id=v_operation_id) then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
  if exists(select 1 from app_private.business_memberships where business_id=v_employee.business_id and user_id=p_user_id) then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  select * into v_shared from app_private.shared_employee_credentials where business_id=v_employee.business_id and employee_id=v_employee.id for update;
  if v_shared.employee_id is not null then
    -- Verify the existing employee-selected PIN before linking. Failures commit the shared counter without consuming the invitation.
    v_pin_result:=app_private.verify_employee_pin(v_employee,v_pin);
    if v_pin_result is not null then return v_pin_result; end if;
  end if;
  insert into app_private.business_memberships(business_id,user_id,role) values(v_employee.business_id,p_user_id,v_employee.role);
  update app_private.employees set user_id=p_user_id where id=v_employee.id;
  insert into app_private.operator_credentials(business_id,user_id,pin_hash,failed_attempts,locked_until)
    values(v_employee.business_id,p_user_id,coalesce(v_shared.pin_hash,extensions.crypt(v_pin,extensions.gen_salt('bf',12))),coalesce(v_shared.failed_attempts,0),v_shared.locked_until);
  delete from app_private.shared_employee_credentials where business_id=v_employee.business_id and employee_id=v_employee.id;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_employee.business_id and employee_id=v_employee.id and revoked_at is null;
  update app_private.business_invitations set accepted_by=p_user_id,accepted_operation_id=v_operation_id,accepted_fingerprint=v_fingerprint,
    accepted_employee_id=v_employee.id,accepted_at=clock_timestamp() where id=v_invitation.id;
  update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='employee_linked' where business_id=v_employee.business_id and employee_id=v_employee.id
    and id<>v_invitation.id and accepted_by is null and revoked_at is null and expires_at>clock_timestamp();
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_employee.business_id,p_user_id,p_auth_session_id,'invitation_accepted');
  -- The exact existing credential moved to Google; this is the same PIN, never a second PIN choice.
  return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_employee.business_id);
end;
$$;

create or replace function app_private.employee_team(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employees jsonb; v_invitations jsonb; v_devices jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e where e.business_id=v_business_id and e.deleted_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'employeeId',i.employee_id,'name',coalesce(e.name,i.name),'role',coalesce(e.role,i.role),'expiresAt',i.expires_at,
    'status',app_private.invitation_status(i,e),'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at,'revokeReason',i.revoke_reason,
    'active',app_private.invitation_status(i,e)='pending') order by coalesce(i.created_at,i.expires_at-interval '48 hours') desc,i.id),'[]'::jsonb)
    into v_invitations from app_private.business_invitations i left join app_private.employees e on e.business_id=i.business_id and e.id=i.employee_id where i.business_id=v_business_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,'active',d.revoked_at is null and d.expires_at>clock_timestamp()) order by d.created_at,d.id),'[]'::jsonb)
    into v_devices from app_private.devices d where d.business_id=v_business_id;
  return jsonb_build_object('data',jsonb_build_object('employees',v_employees,'invitations',v_invitations,'devices',v_devices));
end;
$$;

-- Rejoin/restoration is retired, including direct service-side legacy dispatch.
drop function app_private.can_rejoin_employee(app_private.employees,app_private.employees,app_private.business_invitations);
drop function app_private.verify_archived_employee_pin(app_private.employees,uuid,text);
drop function app_private.change_employee_lifecycle_before_rejoin(uuid,uuid,text,jsonb);
drop table app_private.employee_lifecycle_operations;

-- Previously removed employees must follow the same permanent deletion policy.
-- Merged empty placeholders cascade with their parent or are independently purged.
do $$ begin
  if exists(select 1 from app_private.employees where deleted_at is not null and role='owner') then raise exception 'Cannot permanently unlink a business owner'; end if;
end $$;
delete from app_private.employees where deleted_at is not null and role<>'owner';
alter table app_private.employees drop column merged_into_employee_id;
alter table app_private.employees add constraint employees_no_soft_delete_check check (deleted_at is null);
-- An erased actor never authorizes a stored financial-operation replay.
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
    if v_operation.actor_id is distinct from v_actor.id or v_operation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
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

revoke all on all functions in schema app_private from public,anon,authenticated;
