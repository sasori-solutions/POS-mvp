-- Agente de Larios, 2026-10-02. A fresh owner invitation can restore a removed
-- Google employee without creating a second identity or resetting their security.
alter table app_private.employees add column merged_into_employee_id uuid;
alter table app_private.employees add constraint employees_merged_target_fk
  foreign key (business_id,merged_into_employee_id) references app_private.employees(business_id,id) on delete cascade;
alter table app_private.employees add constraint employees_merged_inactive_check
  check (merged_into_employee_id is null or (merged_into_employee_id<>id and user_id is null and deleted_at is not null and not active));

-- Only an empty invitation placeholder may be retired. Never merge an existing
-- PIN-only person or reuse a link issued before the owner removed this account.
create function app_private.can_rejoin_employee(p_target app_private.employees,p_archived app_private.employees,p_invitation app_private.business_invitations)
returns boolean language sql set search_path='' as $$
  select coalesce(p_archived.id is not null and p_archived.user_id is not null and p_archived.role<>'owner'
    and p_archived.deleted_at is not null and not p_archived.active
    and p_target.business_id=p_archived.business_id and p_target.id<>p_archived.id
    and p_target.user_id is null and p_target.role<>'owner' and p_target.active and p_target.deleted_at is null and p_target.merged_into_employee_id is null
    and p_invitation.business_id=p_target.business_id and p_invitation.employee_id=p_target.id
    and p_invitation.created_at>p_archived.deleted_at
    and exists(select 1 from app_private.business_memberships m where m.business_id=p_archived.business_id and m.user_id=p_archived.user_id and not m.active and m.role=p_archived.role)
    and exists(select 1 from app_private.operator_credentials c where c.business_id=p_archived.business_id and c.user_id=p_archived.user_id)
    and not exists(select 1 from app_private.shared_employee_credentials c where c.business_id=p_target.business_id and c.employee_id=p_target.id)
    and not exists(select 1 from app_private.employee_pin_setup_codes s where s.business_id=p_target.business_id and s.employee_id=p_target.id)
    and not exists(select 1 from app_private.device_operator_sessions s where s.business_id=p_target.business_id and s.employee_id=p_target.id)
    and not exists(select 1 from app_private.employee_personal_devices d where d.business_id=p_target.business_id and d.employee_id=p_target.id)
    and not exists(select 1 from app_private.employee_lifecycle_operations o where o.business_id=p_target.business_id and o.employee_id=p_target.id)
    and not exists(select 1 from app_private.business_invitations i where i.business_id=p_target.business_id and i.employee_id=p_target.id and i.accepted_at is not null),false);
$$;

-- The caller holds the archived employee row and has checked a fresh invitation.
-- Verification happens before any restoration: expected PIN failures commit only
-- the existing bounded counter. Success clears failures like a normal PIN entry.
create function app_private.verify_archived_employee_pin(p_employee app_private.employees,p_auth_session_id uuid,p_pin text)
returns jsonb language plpgsql set search_path='' as $$
declare v_credential app_private.operator_credentials%rowtype; v_attempts integer; v_locked_until timestamptz;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_employee.user_id is null or p_employee.deleted_at is null or p_employee.active or p_employee.role='owner' then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  select * into v_credential from app_private.operator_credentials where business_id=p_employee.business_id and user_id=p_employee.user_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_credential.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_credential.locked_until-clock_timestamp()))::integer)));
  end if;
  if extensions.crypt(p_pin,v_credential.pin_hash)<>v_credential.pin_hash then
    v_attempts:=case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.operator_credentials set failed_attempts=v_attempts,locked_until=v_locked_until where business_id=p_employee.business_id and user_id=p_employee.user_id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(p_employee.business_id,p_employee.user_id,p_auth_session_id,case when v_attempts>=5 then 'pin_lockout' else 'pin_unlock_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'PIN_LOCKED' else 'PIN_INVALID' end,'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  update app_private.operator_credentials set failed_attempts=0,locked_until=null where business_id=p_employee.business_id and user_id=p_employee.user_id;
  return null;
end;
$$;


create or replace function app_private.employee_invitation_details(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_invitation app_private.business_invitations%rowtype; v_employee app_private.employees%rowtype; v_business jsonb; v_archived app_private.employees%rowtype; v_returning boolean:=false;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if p_payload->>'invitationCode' is null or p_payload->>'invitationCode' !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_invitation from app_private.business_invitations where token_hash=extensions.digest(p_payload->>'invitationCode','sha256');
  if not found or v_invitation.employee_id is null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_invitation.business_id and id=v_invitation.employee_id for update;
  if not found or not v_employee.active or v_employee.deleted_at is not null or v_employee.role='owner' then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  select * into v_archived from app_private.employees where business_id=v_employee.business_id and user_id=p_user_id and deleted_at is not null and not active and role<>'owner' for update;
  select * into v_invitation from app_private.business_invitations where id=v_invitation.id for update;
  if v_invitation.token_hash<>extensions.digest(p_payload->>'invitationCode','sha256') or v_invitation.revoked_at is not null or v_invitation.accepted_at is not null
    or v_invitation.expires_at<=clock_timestamp() or v_employee.user_id is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
  if exists(select 1 from app_private.business_memberships where business_id=v_employee.business_id and user_id=p_user_id) then
    if not app_private.can_rejoin_employee(v_employee,v_archived,v_invitation) then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    v_returning:=true;
  end if;
  select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,'timezone',b.timezone,'currency',b.currency)
    into v_business from app_private.businesses b where b.id=v_invitation.business_id;
  return jsonb_build_object('data',jsonb_build_object('business',v_business,'employee',app_private.employee_summary(v_employee)||case when v_returning then jsonb_build_object('pinReady',true) else '{}'::jsonb end,'expiresAt',v_invitation.expires_at,'returningEmployee',v_returning));
end;
$$;

create or replace function app_private.accept_employee_invitation(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_operation_id uuid:=(p_payload->>'operationId')::uuid; v_pin text:=p_payload->>'pin';
  v_name text:=case when p_payload ? 'name' then btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')) else null end;
  v_invitation app_private.business_invitations%rowtype; v_employee app_private.employees%rowtype;
  v_fingerprint bytea; v_pin_result jsonb; v_shared app_private.shared_employee_credentials%rowtype;
  v_archived app_private.employees%rowtype; v_returning boolean:=false; v_placeholder uuid;
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
  -- Targets are unlinked placeholders; the linked archived row is locked second, before credentials/invitations.
  select * into v_archived from app_private.employees where business_id=v_employee.business_id and user_id=p_user_id and deleted_at is not null and not active and role<>'owner' for update;
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
  if exists(select 1 from app_private.business_memberships where business_id=v_employee.business_id and user_id=p_user_id) then
    if not app_private.can_rejoin_employee(v_employee,v_archived,v_invitation) then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    v_pin_result:=app_private.verify_archived_employee_pin(v_archived,p_auth_session_id,v_pin);
    if v_pin_result is not null then return v_pin_result; end if;
    v_returning:=true;
  end if;
  if v_returning then
    v_placeholder:=v_employee.id;
    -- Keep the historical person ID, credential and personal device. The fresh
    -- owner invitation supplies the new display name and role, never a new PIN.
    update app_private.employees set name=v_employee.name,role=v_employee.role,active=true,deleted_at=null where id=v_archived.id returning * into v_archived;
    update app_private.business_memberships set role=v_archived.role,active=true where business_id=v_archived.business_id and user_id=p_user_id;
    update app_private.employees set active=false,deleted_at=clock_timestamp(),merged_into_employee_id=v_archived.id where id=v_placeholder;
    update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='employee_linked'
      where business_id=v_employee.business_id and employee_id=v_placeholder and id<>v_invitation.id and accepted_at is null and revoked_at is null;
    update app_private.business_invitations set employee_id=v_archived.id where id=v_invitation.id returning * into v_invitation;
    perform app_private.revoke_person_operator_sessions(p_user_id,v_archived.business_id,v_archived.id);
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_archived.business_id,p_user_id,p_auth_session_id,'employee_restored');
    v_employee:=v_archived;
  else
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
  end if;
  update app_private.business_invitations set accepted_by=p_user_id,accepted_operation_id=v_operation_id,accepted_fingerprint=v_fingerprint,
    accepted_employee_id=v_employee.id,accepted_at=clock_timestamp() where id=v_invitation.id;
  update app_private.business_invitations set revoked_at=clock_timestamp(),revoke_reason='employee_linked' where business_id=v_employee.business_id and employee_id=v_employee.id
    and id<>v_invitation.id and accepted_by is null and revoked_at is null and expires_at>clock_timestamp();
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_employee.business_id,p_user_id,p_auth_session_id,'invitation_accepted');
  -- Both linking and returning preserve the personal PIN and enforce its browser binding.
  return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_employee.business_id);
end;
$$;

alter function app_private.change_employee_lifecycle(uuid,uuid,text,jsonb) rename to change_employee_lifecycle_before_rejoin;
create function app_private.change_employee_lifecycle(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_employee app_private.employees%rowtype;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken');
  select * into v_employee from app_private.employees where business_id=(p_payload->>'businessId')::uuid and id=(p_payload->>'employeeId')::uuid for update;
  if v_employee.merged_into_employee_id is not null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  return app_private.change_employee_lifecycle_before_rejoin(p_user_id,p_auth_session_id,p_action,p_payload);
end;
$$;

create or replace function app_private.employee_team(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_employees jsonb; v_deleted jsonb; v_invitations jsonb; v_devices jsonb;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e where e.business_id=v_business_id and e.deleted_at is null;
  select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.deleted_at desc,e.id),'[]'::jsonb) into v_deleted from app_private.employees e where e.business_id=v_business_id and e.deleted_at is not null and e.merged_into_employee_id is null;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'employeeId',i.employee_id,'name',coalesce(e.name,i.name),'role',coalesce(e.role,i.role),'expiresAt',i.expires_at,
    'status',app_private.invitation_status(i,e),'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at,'revokeReason',i.revoke_reason,
    'active',app_private.invitation_status(i,e)='pending') order by coalesce(i.created_at,i.expires_at-interval '48 hours') desc,i.id),'[]'::jsonb)
    into v_invitations from app_private.business_invitations i left join app_private.employees e on e.business_id=i.business_id and e.id=i.employee_id where i.business_id=v_business_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,'active',d.revoked_at is null and d.expires_at>clock_timestamp()) order by d.created_at,d.id),'[]'::jsonb)
    into v_devices from app_private.devices d where d.business_id=v_business_id;
  return jsonb_build_object('data',jsonb_build_object('employees',v_employees,'deletedEmployees',v_deleted,'invitations',v_invitations,'devices',v_devices));
end;
$$;

revoke all on all functions in schema app_private from public,anon,authenticated;
