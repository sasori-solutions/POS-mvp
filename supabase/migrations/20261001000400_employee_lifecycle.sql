-- Agente de Larios, 2026-10-01. Truthful invitation outcomes and recoverable employee removal.
alter table app_private.employees add column deleted_at timestamptz;
alter table app_private.employees add constraint employees_deleted_inactive_check check (deleted_at is null or not active);
alter table app_private.business_invitations add column revoke_reason text
  check (revoke_reason in ('user_cancelled','replaced','employee_deleted','employee_deactivated','employee_linked'));
-- Existing creation timestamps are unknown; only newly issued invitations get a recorded time.
alter table app_private.business_invitations add column created_at timestamptz;
alter table app_private.business_invitations alter column created_at set default clock_timestamp();

-- Lifecycle retries replay the original authorized result, never a later mutation of this person.
create table app_private.employee_lifecycle_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  business_id uuid not null,
  employee_id uuid not null,
  action text not null check (action in ('delete_employee','restore_employee')),
  result jsonb not null,
  primary key (user_id,operation_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
alter table app_private.employee_lifecycle_operations enable row level security;
revoke all on app_private.employee_lifecycle_operations from public,anon,authenticated;

alter table app_private.account_audit_events drop constraint account_audit_events_event_check;
alter table app_private.account_audit_events add constraint account_audit_events_event_check check (event in (
  'business_created','pin_unlock_succeeded','pin_unlock_failed','pin_lockout','operator_locked','operator_sessions_revoked',
  'business_updated','employee_created','employee_updated','employee_deleted','employee_restored','invitation_created','invitation_revoked','invitation_accepted',
  'pairing_created','device_paired','device_revoked','pin_reset'
));

create or replace function app_private.employee_summary(p_employee app_private.employees)
returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('id',p_employee.id,'name',p_employee.name,'role',p_employee.role,'active',p_employee.active,'deletedAt',p_employee.deleted_at,
    'googleLinked',p_employee.user_id is not null,
    'pinReady',case when p_employee.user_id is not null then exists(select 1 from app_private.operator_credentials c where c.business_id=p_employee.business_id and c.user_id=p_employee.user_id)
      else exists(select 1 from app_private.shared_employee_credentials c where c.business_id=p_employee.business_id and c.employee_id=p_employee.id) end);
$$;

create function app_private.invitation_status(p_invitation app_private.business_invitations,p_employee app_private.employees)
returns text language sql set search_path='' as $$
  select case
    when p_invitation.accepted_at is not null then 'accepted'
    when p_invitation.revoked_at is not null then 'revoked'
    when p_invitation.expires_at<=statement_timestamp() then 'expired'
    when p_employee.id is null or p_employee.deleted_at is not null or not p_employee.active or p_employee.user_id is not null then 'unavailable'
    else 'pending' end;
$$;

create or replace function app_private.issue_employee_invitation(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_employee_id uuid,p_operation_id uuid,p_fingerprint bytea)
returns jsonb language plpgsql set search_path='' as $$
declare v_employee app_private.employees%rowtype; v_invitation app_private.business_invitations%rowtype; v_code text;
begin
  -- Every creation/acceptance locks the employee before its invitation, even for a retry.
  select * into v_employee from app_private.employees where business_id=p_business_id and id=p_employee_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if v_employee.deleted_at is not null or not v_employee.active then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':create_invitation:'||p_operation_id::text,0));
  select * into v_invitation from app_private.business_invitations where created_by=p_user_id and operation_id=p_operation_id for update;
  if found then
    if v_invitation.business_id<>p_business_id or v_invitation.employee_id<>p_employee_id or v_invitation.payload_fingerprint<>p_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if v_invitation.accepted_by is not null or v_invitation.revoked_at is not null or v_invitation.expires_at<=clock_timestamp() then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  end if;
  if v_employee.user_id is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  v_code:=encode(extensions.gen_random_bytes(32),'hex');
  if v_invitation.id is not null then
    update app_private.business_invitations set token_hash=extensions.digest(v_code,'sha256') where id=v_invitation.id;
  else
    -- A newly issued link replaces prior pending links for this explicit person.
    update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='replaced'
      where business_id=p_business_id and employee_id=p_employee_id and accepted_at is null and revoked_at is null and expires_at>clock_timestamp();
    insert into app_private.business_invitations(business_id,employee_id,created_by,operation_id,payload_fingerprint,name,role,token_hash,expires_at)
      values(p_business_id,p_employee_id,p_user_id,p_operation_id,p_fingerprint,v_employee.name,v_employee.role,extensions.digest(v_code,'sha256'),clock_timestamp()+interval '48 hours') returning * into v_invitation;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(p_business_id,p_user_id,p_auth_session_id,'invitation_created');
  end if;
  return jsonb_build_object('invitationCode',v_code,'invitationId',v_invitation.id,'expiresAt',v_invitation.expires_at);
end;
$$;

create or replace function app_private.create_employee_access(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_name text:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role text:=p_payload->>'role'; v_pin text:=p_payload->>'pin';
  v_google boolean:=coalesce((p_payload->>'inviteWithGoogle')::boolean,false); v_fingerprint bytea;
  v_operation app_private.employee_create_operations%rowtype; v_employee app_private.employees%rowtype; v_invitation jsonb; v_pin_hash text;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_operation_id is null or v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    or v_role is null or v_role not in ('manager','cashier','kitchen') or (v_google and v_pin is not null)
    or (not v_google and (v_pin is null or v_pin !~ '^[0-9]{6}$')) then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  -- The PIN-only legacy fingerprint remains stable. Google is an explicit additional mode.
  v_fingerprint:=extensions.digest((jsonb_build_object('businessId',v_business_id,'name',v_name,'role',v_role)
    || case when v_google then jsonb_build_object('inviteWithGoogle',true) else '{}'::jsonb end)::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':create_employee:'||v_operation_id::text,0));
  select * into v_operation from app_private.employee_create_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.payload_fingerprint<>v_fingerprint or v_operation.invite_google<>v_google then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if not v_google and v_operation.initial_pin_hash is not null and extensions.crypt(v_pin,v_operation.initial_pin_hash)<>v_operation.initial_pin_hash then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    select * into v_employee from app_private.employees where business_id=v_business_id and id=v_operation.employee_id for update;
  else
    insert into app_private.employees(business_id,name,role) values(v_business_id,v_name,v_role) returning * into v_employee;
    if not v_google then
      v_pin_hash:=extensions.crypt(v_pin,extensions.gen_salt('bf',12));
      insert into app_private.shared_employee_credentials(business_id,employee_id,pin_hash) values(v_business_id,v_employee.id,v_pin_hash);
    end if;
    insert into app_private.employee_create_operations(user_id,operation_id,business_id,payload_fingerprint,employee_id,initial_pin_hash,invite_google)
      values(p_user_id,v_operation_id,v_business_id,v_fingerprint,v_employee.id,v_pin_hash,v_google);
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_created');
  end if;
  if v_employee.deleted_at is not null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_google and v_employee.user_id is null then
    v_invitation:=app_private.issue_employee_invitation(p_user_id,p_auth_session_id,v_business_id,v_employee.id,v_operation_id,
      extensions.digest(jsonb_build_object('businessId',v_business_id,'employeeId',v_employee.id)::text,'sha256'));
  end if;
  return jsonb_build_object('data',app_private.employee_summary(v_employee)||case when v_invitation is not null then jsonb_build_object('invitation',v_invitation) else '{}'::jsonb end);
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
  if v_shared.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_shared.locked_until-clock_timestamp()))::integer)));
  end if;
  insert into app_private.business_memberships(business_id,user_id,role) values(v_employee.business_id,p_user_id,v_employee.role);
  update app_private.employees set user_id=p_user_id where id=v_employee.id;
  insert into app_private.operator_credentials(business_id,user_id,pin_hash,failed_attempts,locked_until)
    values(v_employee.business_id,p_user_id,extensions.crypt(v_pin,extensions.gen_salt('bf',12)),coalesce(v_shared.failed_attempts,0),v_shared.locked_until);
  delete from app_private.shared_employee_credentials where business_id=v_employee.business_id and employee_id=v_employee.id;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_employee.business_id and employee_id=v_employee.id and revoked_at is null;
  update app_private.business_invitations set accepted_by=p_user_id,accepted_operation_id=v_operation_id,accepted_fingerprint=v_fingerprint,
    accepted_employee_id=v_employee.id,accepted_at=clock_timestamp() where id=v_invitation.id;
  update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='employee_linked' where business_id=v_employee.business_id and employee_id=v_employee.id
    and id<>v_invitation.id and accepted_by is null and revoked_at is null and expires_at>clock_timestamp();
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_employee.business_id,p_user_id,p_auth_session_id,'invitation_accepted');
  -- Keep any existing shared-register cooldown when moving its one credential to Google.
  v_pin_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_employee.business_id,v_pin);
  if v_pin_result is not null then return v_pin_result; end if;
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
    or v_role is null or v_role not in ('manager','cashier','kitchen') or jsonb_typeof(p_payload->'active')<>'boolean'
    or (v_pin is not null and v_pin !~ '^[0-9]{6}$') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_business_id and id=(p_payload->>'employeeId')::uuid for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if v_employee.deleted_at is not null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  update app_private.employees set name=v_name,role=v_role,active=(p_payload->>'active')::boolean where id=v_employee.id returning * into v_employee;
  if v_employee.user_id is not null then
    update app_private.business_memberships set role=v_role,active=v_employee.active where business_id=v_business_id and user_id=v_employee.user_id;
    if v_pin is not null then update app_private.operator_credentials set pin_hash=extensions.crypt(v_pin,extensions.gen_salt('bf',12)),failed_attempts=0,locked_until=null where business_id=v_business_id and user_id=v_employee.user_id; end if;
    update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and user_id=v_employee.user_id and revoked_at is null;
  elsif v_pin is not null then
    insert into app_private.shared_employee_credentials(business_id,employee_id,pin_hash) values(v_business_id,v_employee.id,extensions.crypt(v_pin,extensions.gen_salt('bf',12)))
      on conflict(business_id,employee_id) do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null;
  end if;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null;
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_updated');
  return jsonb_build_object('data',app_private.employee_summary(v_employee));
end;
$$;

create function app_private.change_employee_lifecycle(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employee_id uuid:=(p_payload->>'employeeId')::uuid;
  v_operation_id uuid:=(p_payload->>'operationId')::uuid; v_employee app_private.employees%rowtype;
  v_operation app_private.employee_lifecycle_operations%rowtype; v_result jsonb; v_now timestamptz;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_employee_id is null or v_operation_id is null or p_action not in ('delete_employee','restore_employee') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':employee_lifecycle:'||v_operation_id::text,0));
  select * into v_operation from app_private.employee_lifecycle_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.business_id<>v_business_id or v_operation.employee_id<>v_employee_id or v_operation.action<>p_action then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    return jsonb_build_object('data',v_operation.result);
  end if;
  -- Same lock order as invitation issuance/acceptance and employee edits.
  select * into v_employee from app_private.employees where business_id=v_business_id and id=v_employee_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
  if p_action='delete_employee' then
    if v_employee.deleted_at is null then
      if v_employee.user_id is not null then
        -- Serialize personal PIN entry against revoking its sessions, retaining the existing cooldown.
        perform 1 from app_private.operator_credentials where business_id=v_business_id and user_id=v_employee.user_id for update;
      end if;
      v_now:=clock_timestamp();
      update app_private.employees set active=false,deleted_at=v_now where id=v_employee.id returning * into v_employee;
      if v_employee.user_id is not null then
        update app_private.business_memberships set active=false where business_id=v_business_id and user_id=v_employee.user_id;
        update app_private.operator_sessions set revoked_at=v_now where business_id=v_business_id and user_id=v_employee.user_id and revoked_at is null;
      end if;
      update app_private.device_operator_sessions set revoked_at=v_now where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null;
      -- Accepted history remains intact, while its code/retry is permanently unavailable after restoration.
      update app_private.business_invitations set revoked_at=v_now,revoke_reason='employee_deleted'
        where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null
          and (accepted_at is not null or expires_at>v_now);
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_deleted');
    end if;
    v_result:=jsonb_build_object('id',v_employee.id,'deleted',true);
  else
    if v_employee.deleted_at is not null then
      update app_private.employees set active=true,deleted_at=null where id=v_employee.id returning * into v_employee;
      if v_employee.user_id is not null then
        update app_private.business_memberships set active=true where business_id=v_business_id and user_id=v_employee.user_id;
      end if;
      -- Restore never changes credential lockout counters, invitations or revoked operator tokens.
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_restored');
    end if;
    v_result:=app_private.employee_summary(v_employee);
  end if;
  insert into app_private.employee_lifecycle_operations(user_id,operation_id,business_id,employee_id,action,result)
    values(p_user_id,v_operation_id,v_business_id,v_employee.id,p_action,v_result);
  return jsonb_build_object('data',v_result);
end;
$$;

create function app_private.cancel_employee_invitation(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_invitation app_private.business_invitations%rowtype;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select * into v_invitation from app_private.business_invitations where business_id=v_business_id and id=(p_payload->>'invitationId')::uuid;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_invitation.employee_id is not null then
    perform 1 from app_private.employees where business_id=v_business_id and id=v_invitation.employee_id for update;
  end if;
  select * into v_invitation from app_private.business_invitations where id=v_invitation.id for update;
  if v_invitation.accepted_at is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  if v_invitation.revoked_at is null and v_invitation.expires_at>clock_timestamp() then
    update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='user_cancelled' where id=v_invitation.id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'invitation_revoked');
  end if;
  return jsonb_build_object('data',jsonb_build_object('revoked',true));
end;
$$;

create or replace function app_private.employee_team(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employees jsonb; v_deleted jsonb; v_invitations jsonb; v_devices jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e where e.business_id=v_business_id and e.deleted_at is null;
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.deleted_at desc,e.id),'[]'::jsonb) into v_deleted from app_private.employees e where e.business_id=v_business_id and e.deleted_at is not null;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'employeeId',i.employee_id,'name',coalesce(e.name,i.name),'role',coalesce(e.role,i.role),'expiresAt',i.expires_at,
    'status',app_private.invitation_status(i,e),'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at,'revokeReason',i.revoke_reason,
    'active',app_private.invitation_status(i,e)='pending') order by coalesce(i.created_at,i.expires_at-interval '48 hours') desc,i.id),'[]'::jsonb)
    into v_invitations from app_private.business_invitations i left join app_private.employees e on e.business_id=i.business_id and e.id=i.employee_id where i.business_id=v_business_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,'active',d.revoked_at is null and d.expires_at>clock_timestamp()) order by d.created_at,d.id),'[]'::jsonb)
    into v_devices from app_private.devices d where d.business_id=v_business_id;
  return jsonb_build_object('data',jsonb_build_object('employees',v_employees,'deletedEmployees',v_deleted,'invitations',v_invitations,'devices',v_devices));
end;
$$;

create or replace function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  case p_action
    when 'create_employee' then return app_private.create_employee_access(p_user_id,p_auth_session_id,p_payload);
    when 'create_invitation' then return app_private.create_invitation_access(p_user_id,p_auth_session_id,p_payload);
    when 'accept_invitation' then return app_private.accept_employee_invitation(p_user_id,p_auth_session_id,p_payload);
    when 'update_employee' then return app_private.update_employee_access(p_user_id,p_auth_session_id,p_payload);
    when 'delete_employee' then return app_private.change_employee_lifecycle(p_user_id,p_auth_session_id,p_action,p_payload);
    when 'restore_employee' then return app_private.change_employee_lifecycle(p_user_id,p_auth_session_id,p_action,p_payload);
    when 'revoke_invitation' then return app_private.cancel_employee_invitation(p_user_id,p_auth_session_id,p_payload);
    when 'team' then return app_private.employee_team(p_user_id,p_auth_session_id,p_payload);
    else return app_private.account_manage_v2(p_user_id,p_auth_session_id,p_action,p_payload);
  end case;
end;
$$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
