-- Agente de Larios, 2026-10-01. Employees choose their own PIN; owners only authorize setup/reset.
create table app_private.employee_pin_setup_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  employee_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  purpose text not null check (purpose in ('initial','reset')),
  token_hash bytea not null unique,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_operation_id uuid,
  consumed_user_id uuid references auth.users(id) on delete cascade,
  consumed_auth_session_id uuid,
  consumed_device_id uuid,
  consumed_pin_hash text,
  unique (created_by,operation_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade,
  foreign key (business_id,consumed_device_id) references app_private.devices(business_id,id) on delete cascade,
  check ((consumed_at is null and consumed_operation_id is null and consumed_pin_hash is null and consumed_user_id is null and consumed_auth_session_id is null and consumed_device_id is null)
    or (consumed_at is not null and consumed_operation_id is not null and consumed_pin_hash is not null
      and ((consumed_device_id is not null and consumed_user_id is null and consumed_auth_session_id is null)
        or (consumed_device_id is null and consumed_user_id is not null and consumed_auth_session_id is not null))))
);
alter table app_private.employee_pin_setup_codes enable row level security;
revoke all on app_private.employee_pin_setup_codes from public,anon,authenticated;
create index employee_pin_setup_employee_idx on app_private.employee_pin_setup_codes(business_id,employee_id);

alter table app_private.account_audit_events drop constraint account_audit_events_event_check;
alter table app_private.account_audit_events add constraint account_audit_events_event_check check (event in (
  'business_created','pin_unlock_succeeded','pin_unlock_failed','pin_lockout','operator_locked','operator_sessions_revoked',
  'business_updated','employee_created','employee_updated','employee_deleted','employee_restored','invitation_created','invitation_revoked','invitation_accepted',
  'pairing_created','device_paired','device_revoked','pin_reset','employee_pin_setup_created','employee_pin_set'
));

-- Returning an employee or linking Google never revives an earlier setup authorization.
create function app_private.invalidate_employee_pin_setup()
returns trigger language plpgsql set search_path='' as $$
begin
  if (old.active and not new.active) or (old.deleted_at is null and new.deleted_at is not null)
    or (old.user_id is null and new.user_id is not null) then
    update app_private.employee_pin_setup_codes set revoked_at=clock_timestamp()
      where business_id=new.business_id and employee_id=new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
create trigger employees_invalidate_pin_setup after update of active,deleted_at,user_id on app_private.employees
  for each row execute function app_private.invalidate_employee_pin_setup();

create function app_private.issue_employee_pin_setup(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_employee_id uuid,p_operation_id uuid,p_purpose text)
returns jsonb language plpgsql set search_path='' as $$
declare v_employee app_private.employees%rowtype; v_setup app_private.employee_pin_setup_codes%rowtype; v_code text;
begin
  if p_operation_id is null or p_purpose not in ('initial','reset') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=p_business_id and id=p_employee_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if not v_employee.active or v_employee.deleted_at is not null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':employee_pin_setup:'||p_operation_id::text,0));
  select * into v_setup from app_private.employee_pin_setup_codes where created_by=p_user_id and operation_id=p_operation_id for update;
  if found then
    if v_setup.business_id<>p_business_id or v_setup.employee_id<>p_employee_id or v_setup.purpose<>p_purpose then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if v_setup.consumed_at is not null or v_setup.revoked_at is not null or v_setup.expires_at<=clock_timestamp() then raise exception 'PIN_SETUP_INVALID' using errcode='P0001'; end if;
  end if;
  v_code:=encode(extensions.gen_random_bytes(32),'hex');
  if v_setup.id is not null then
    update app_private.employee_pin_setup_codes set token_hash=extensions.digest(v_code,'sha256') where id=v_setup.id;
  else
    -- A newer authorization also makes already-consumed retries unavailable; ordinary PIN entry still works.
    update app_private.employee_pin_setup_codes set revoked_at=clock_timestamp()
      where business_id=p_business_id and employee_id=p_employee_id and revoked_at is null;
    insert into app_private.employee_pin_setup_codes(business_id,employee_id,created_by,operation_id,purpose,token_hash,expires_at)
      values(p_business_id,p_employee_id,p_user_id,p_operation_id,p_purpose,extensions.digest(v_code,'sha256'),clock_timestamp()+interval '15 minutes') returning * into v_setup;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(p_business_id,p_user_id,p_auth_session_id,'employee_pin_setup_created');
  end if;
  return jsonb_build_object('setupCode',v_code,'setupId',v_setup.id,'expiresAt',v_setup.expires_at);
end;
$$;

-- Device -> employee -> authorization -> credential is also the register-unlock lock order.
-- Personal requests must already belong to this exact Google-linked person; a code never links identities.
create function app_private.lock_employee_pin_setup(p_user_id uuid,p_auth_session_id uuid,p_device_id uuid,p_code text,p_allow_consumed boolean)
returns app_private.employee_pin_setup_codes language plpgsql set search_path='' as $$
declare v_setup app_private.employee_pin_setup_codes%rowtype; v_employee app_private.employees%rowtype; v_device app_private.devices%rowtype;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_device_id is null then
    perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  else
    if p_user_id is not null or p_auth_session_id is not null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    select * into v_device from app_private.devices where id=p_device_id for update;
    if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  end if;
  select * into v_setup from app_private.employee_pin_setup_codes where token_hash=extensions.digest(p_code,'sha256');
  if not found or (p_device_id is not null and v_setup.business_id<>v_device.business_id) then raise exception 'PIN_SETUP_INVALID' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_setup.business_id and id=v_setup.employee_id for update;
  if not found or not v_employee.active or v_employee.deleted_at is not null or v_employee.role='owner' then raise exception 'PIN_SETUP_INVALID' using errcode='P0001'; end if;
  select * into v_setup from app_private.employee_pin_setup_codes where id=v_setup.id for update;
  if v_setup.token_hash<>extensions.digest(p_code,'sha256') or v_setup.revoked_at is not null or v_setup.expires_at<=clock_timestamp()
    or (not p_allow_consumed and v_setup.consumed_at is not null) then raise exception 'PIN_SETUP_INVALID' using errcode='P0001'; end if;
  if p_device_id is null then
    if v_employee.user_id is distinct from p_user_id then raise exception 'PIN_SETUP_ACCOUNT_MISMATCH' using errcode='P0001'; end if;
    perform app_private.assert_member(p_user_id,v_setup.business_id);
  elsif v_employee.user_id is not null then
    perform app_private.assert_member(v_employee.user_id,v_setup.business_id);
  end if;
  return v_setup;
end;
$$;

create function app_private.employee_pin_setup_details(p_user_id uuid,p_auth_session_id uuid,p_device_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_setup app_private.employee_pin_setup_codes%rowtype; v_employee app_private.employees%rowtype; v_business jsonb;
begin
  v_setup:=app_private.lock_employee_pin_setup(p_user_id,p_auth_session_id,p_device_id,p_payload->>'setupCode',false);
  select * into v_employee from app_private.employees where business_id=v_setup.business_id and id=v_setup.employee_id;
  select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,'timezone',b.timezone,'currency',b.currency)
    into v_business from app_private.businesses b where b.id=v_setup.business_id;
  return jsonb_build_object('data',jsonb_build_object('business',v_business,'employee',app_private.employee_summary(v_employee),'expiresAt',v_setup.expires_at));
end;
$$;

create function app_private.consume_employee_pin_setup(p_user_id uuid,p_auth_session_id uuid,p_device_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_setup app_private.employee_pin_setup_codes%rowtype; v_employee app_private.employees%rowtype;
  v_operation_id uuid:=(p_payload->>'operationId')::uuid; v_pin text:=p_payload->>'pin'; v_hash text;
  v_result jsonb; v_token text; v_expires timestamptz;
begin
  if v_operation_id is null or v_pin is null or v_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_setup:=app_private.lock_employee_pin_setup(p_user_id,p_auth_session_id,p_device_id,p_payload->>'setupCode',true);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(coalesce(p_user_id::text,p_device_id::text)||':consume_employee_pin_setup:'||v_operation_id::text,0));
  if exists(select 1 from app_private.employee_pin_setup_codes where id<>v_setup.id and consumed_operation_id=v_operation_id
    and ((p_device_id is null and consumed_user_id=p_user_id) or (p_device_id is not null and consumed_device_id=p_device_id))) then
    raise exception 'OPERATION_CONFLICT' using errcode='P0001';
  end if;
  select * into v_employee from app_private.employees where business_id=v_setup.business_id and id=v_setup.employee_id;
  if v_employee.user_id is null then
    select pin_hash into v_hash from app_private.shared_employee_credentials where business_id=v_setup.business_id and employee_id=v_setup.employee_id for update;
  else
    select pin_hash into v_hash from app_private.operator_credentials where business_id=v_setup.business_id and user_id=v_employee.user_id for update;
  end if;
  if v_setup.consumed_at is not null then
    -- A lost response may issue a replacement session only for its original caller and unchanged current credential.
    -- It never writes the PIN or clears a subsequent lockout/reset/deletion.
    if v_setup.consumed_operation_id<>v_operation_id or v_setup.consumed_user_id is distinct from p_user_id
      or v_setup.consumed_auth_session_id is distinct from p_auth_session_id or v_setup.consumed_device_id is distinct from p_device_id
      or v_hash is distinct from v_setup.consumed_pin_hash then raise exception 'PIN_SETUP_INVALID' using errcode='P0001'; end if;
    v_result:=app_private.verify_employee_pin(v_employee,v_pin);
    if v_result is not null then return v_result; end if;
  else
    v_hash:=extensions.crypt(v_pin,extensions.gen_salt('bf',12));
    if v_employee.user_id is null then
      insert into app_private.shared_employee_credentials(business_id,employee_id,pin_hash)
        values(v_setup.business_id,v_setup.employee_id,v_hash) on conflict(business_id,employee_id)
        do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null;
    else
      insert into app_private.operator_credentials(business_id,user_id,pin_hash)
        values(v_setup.business_id,v_employee.user_id,v_hash) on conflict(business_id,user_id)
        do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null;
    end if;
    update app_private.employee_pin_setup_codes set consumed_at=clock_timestamp(),consumed_operation_id=v_operation_id,
      consumed_user_id=p_user_id,consumed_auth_session_id=p_auth_session_id,consumed_device_id=p_device_id,consumed_pin_hash=v_hash where id=v_setup.id;
    if v_employee.user_id is not null then
      update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_setup.business_id and user_id=v_employee.user_id and revoked_at is null;
    end if;
    update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_setup.business_id and employee_id=v_setup.employee_id and revoked_at is null;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(v_setup.business_id,p_user_id,p_auth_session_id,'employee_pin_set');
  end if;
  if p_device_id is null then return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_setup.business_id); end if;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where device_id=p_device_id and revoked_at is null;
  v_token:=encode(extensions.gen_random_bytes(32),'hex'); v_expires:=clock_timestamp()+interval '8 hours';
  insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash,expires_at)
    values(v_setup.business_id,p_device_id,v_setup.employee_id,extensions.digest(v_token,'sha256'),v_expires);
  insert into app_private.account_audit_events(business_id,user_id,event) values(v_setup.business_id,v_employee.user_id,'pin_unlock_succeeded');
  return jsonb_build_object('data',jsonb_build_object('business',app_private.employee_context(v_setup.employee_id,false),'operatorToken',v_token,'expiresAt',v_expires));
end;
$$;

create function app_private.employee_invitation_details(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
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

create or replace function app_private.create_employee_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_name text:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role text:=p_payload->>'role'; v_pin text:=p_payload->>'pin';
  v_google boolean:=coalesce((p_payload->>'inviteWithGoogle')::boolean,false); v_fingerprint bytea;
  v_operation app_private.employee_create_operations%rowtype; v_employee app_private.employees%rowtype; v_invitation jsonb; v_setup jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_operation_id is null or v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    or v_role is null or v_role not in ('manager','cashier','kitchen') or v_pin is not null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  -- New operations explicitly belong to the employee-selected PIN policy. Legacy owner-PIN operations cannot mutate through a retry.
  v_fingerprint:=extensions.digest((jsonb_build_object('businessId',v_business_id,'name',v_name,'role',v_role,'pinPolicy','employee')
    || case when v_google then jsonb_build_object('inviteWithGoogle',true) else '{}'::jsonb end)::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':create_employee:'||v_operation_id::text,0));
  select * into v_operation from app_private.employee_create_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.payload_fingerprint<>v_fingerprint or v_operation.invite_google<>v_google then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    select * into v_employee from app_private.employees where business_id=v_business_id and id=v_operation.employee_id for update;
  else
    insert into app_private.employees(business_id,name,role) values(v_business_id,v_name,v_role) returning * into v_employee;
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


create or replace function app_private.update_employee_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employee app_private.employees%rowtype;
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
  update app_private.employees set name=v_name,role=v_role,active=(p_payload->>'active')::boolean where id=v_employee.id returning * into v_employee;
  if v_employee.user_id is not null then
    update app_private.business_memberships set role=v_role,active=v_employee.active where business_id=v_business_id and user_id=v_employee.user_id;
    update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and user_id=v_employee.user_id and revoked_at is null;
  end if;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null;
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_updated');
  return jsonb_build_object('data',app_private.employee_summary(v_employee));
end;
$$;

-- Preserve the previously deployed non-PIN actions under their existing authorization checks.
alter function public.account_manage(uuid,uuid,text,jsonb) set schema app_private;
alter function app_private.account_manage(uuid,uuid,text,jsonb) rename to account_manage_employee_lifecycle_v4;
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_business_id uuid;
begin
  case p_action
    when 'create_pin_setup' then
      v_business_id:=(p_payload->>'businessId')::uuid;
      perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
      return jsonb_build_object('data',app_private.issue_employee_pin_setup(p_user_id,p_auth_session_id,v_business_id,
        (p_payload->>'employeeId')::uuid,(p_payload->>'operationId')::uuid,'reset'));
    when 'employee_pin_setup_details' then return app_private.employee_pin_setup_details(p_user_id,p_auth_session_id,null,p_payload);
    when 'set_employee_pin' then return app_private.consume_employee_pin_setup(p_user_id,p_auth_session_id,null,p_payload);
    when 'invitation_details' then return app_private.employee_invitation_details(p_user_id,p_auth_session_id,p_payload);
    else return app_private.account_manage_employee_lifecycle_v4(p_user_id,p_auth_session_id,p_action,p_payload);
  end case;
end;
$$;

alter function public.account_device(text,jsonb) set schema app_private;
alter function app_private.account_device(text,jsonb) rename to account_device_unified_v3;
create function public.account_device(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device app_private.devices%rowtype;
begin
  if p_action not in ('device_pin_setup_details','device_set_employee_pin') then
    return app_private.account_device_unified_v3(p_action,p_payload);
  end if;
  if p_payload->>'deviceToken' is null or p_payload->>'deviceToken' !~ '^[0-9a-f]{64}$' then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  select * into v_device from app_private.devices where token_hash=extensions.digest(p_payload->>'deviceToken','sha256') for update;
  if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  if p_action='device_pin_setup_details' then return app_private.employee_pin_setup_details(null,null,v_device.id,p_payload); end if;
  return app_private.consume_employee_pin_setup(null,null,v_device.id,p_payload);
end;
$$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function app_private.account_manage_employee_lifecycle_v4(uuid,uuid,text,jsonb) from service_role;
revoke all on function app_private.account_device_unified_v3(text,jsonb) from service_role;
revoke all on function public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.account_device(text,jsonb) from public,anon,authenticated;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.account_device(text,jsonb) to service_role;
