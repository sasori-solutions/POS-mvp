-- Agente de Larios, 2026-10-01. A Google session alone cannot reset or enroll an owner PIN.
-- Raw recovery codes exist only in a successful response; salted PIN snapshots only authorize exact retries.
create table app_private.owner_pin_recovery_credentials (
  business_id uuid not null,
  user_id uuid not null,
  code_hash bytea not null check (octet_length(code_hash)=32),
  generation uuid not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (business_id,user_id),
  foreign key (business_id,user_id) references app_private.business_memberships(business_id,user_id) on delete cascade
);
create table app_private.pin_security_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  business_id uuid not null,
  action text not null check (action in ('create_recovery_code','reset_pin','change_pin')),
  payload_fingerprint bytea not null,
  prior_pin_hash text,
  result_pin_hash text not null,
  consumed_code_hash bytea,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id,operation_id),
  foreign key (business_id,user_id) references app_private.business_memberships(business_id,user_id) on delete cascade
);
create table app_private.pin_security_audit_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  auth_session_id uuid,
  event text not null check (event in ('recovery_code_created','recovery_failed','recovery_lockout','pin_recovered','pin_changed')),
  occurred_at timestamptz not null default clock_timestamp()
);
alter table app_private.owner_pin_recovery_credentials enable row level security;
alter table app_private.pin_security_operations enable row level security;
alter table app_private.pin_security_audit_events enable row level security;
revoke all on app_private.owner_pin_recovery_credentials,app_private.pin_security_operations,app_private.pin_security_audit_events from public,anon,authenticated;
revoke all on sequence app_private.pin_security_audit_events_id_seq from public,anon,authenticated;

-- All entry points now share employee -> credential -> session ordering. In particular, a creation
-- replay or personal unlock cannot verify an old PIN and then issue a token after a concurrent reset.
create or replace function app_private.verify_pin(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_pin text)
returns jsonb language plpgsql set search_path='' as $$
declare v_credential app_private.operator_credentials%rowtype; v_attempts integer; v_locked_until timestamptz;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  perform 1 from app_private.employees where business_id=p_business_id and user_id=p_user_id for update;
  perform app_private.assert_member(p_user_id,p_business_id);
  select * into v_credential from app_private.operator_credentials where business_id=p_business_id and user_id=p_user_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_credential.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_credential.locked_until-clock_timestamp()))::integer)));
  end if;
  if extensions.crypt(p_pin,v_credential.pin_hash)<>v_credential.pin_hash then
    v_attempts:=case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.operator_credentials set failed_attempts=v_attempts,locked_until=v_locked_until where business_id=p_business_id and user_id=p_user_id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(p_business_id,p_user_id,p_auth_session_id,case when v_attempts>=5 then 'pin_lockout' else 'pin_unlock_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'PIN_LOCKED' else 'PIN_INVALID' end,'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  update app_private.operator_credentials set failed_attempts=0,locked_until=null where business_id=p_business_id and user_id=p_user_id;
  return null;
end;
$$;

create function app_private.revoke_person_operator_sessions(p_user_id uuid,p_business_id uuid,p_employee_id uuid)
returns void language plpgsql set search_path='' as $$
begin
  update app_private.operator_sessions set revoked_at=clock_timestamp()
    where business_id=p_business_id and user_id=p_user_id and revoked_at is null;
  update app_private.device_operator_sessions set revoked_at=clock_timestamp()
    where business_id=p_business_id and employee_id=p_employee_id and revoked_at is null;
end;
$$;

-- A retry of a committed PIN change is authorized by both its prior salted PIN and its still-current
-- result PIN. This uses the same bounded counter as normal PIN entry; a stale operation is never an unlock.
create function app_private.verify_pin_change_retry(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_prior_pin text,p_result_pin text,p_operation app_private.pin_security_operations)
returns jsonb language plpgsql set search_path='' as $$
declare v_credential app_private.operator_credentials%rowtype; v_attempts integer; v_locked_until timestamptz;
begin
  select * into v_credential from app_private.operator_credentials where business_id=p_business_id and user_id=p_user_id for update;
  if not found or v_credential.pin_hash<>p_operation.result_pin_hash then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
  if v_credential.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_credential.locked_until-clock_timestamp()))::integer)));
  end if;
  if extensions.crypt(p_prior_pin,p_operation.prior_pin_hash)<>p_operation.prior_pin_hash
    or extensions.crypt(p_result_pin,v_credential.pin_hash)<>v_credential.pin_hash then
    v_attempts:=case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.operator_credentials set failed_attempts=v_attempts,locked_until=v_locked_until where business_id=p_business_id and user_id=p_user_id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(p_business_id,p_user_id,p_auth_session_id,case when v_attempts>=5 then 'pin_lockout' else 'pin_unlock_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'PIN_LOCKED' else 'OPERATION_CONFLICT' end,'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  update app_private.operator_credentials set failed_attempts=0,locked_until=null where business_id=p_business_id and user_id=p_user_id;
  return null;
end;
$$;

create function app_private.create_owner_recovery_code(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_pin text:=p_payload->>'currentPin'; v_code text; v_result jsonb; v_fingerprint bytea;
  v_operation app_private.pin_security_operations%rowtype; v_credential app_private.operator_credentials%rowtype;
  v_recovery app_private.owner_pin_recovery_credentials%rowtype;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if v_business_id is null or v_operation_id is null or v_pin is null or v_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  perform 1 from app_private.employees where business_id=v_business_id and user_id=p_user_id for update;
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  v_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_business_id,v_pin);
  if v_result is not null then return v_result; end if;
  select * into v_credential from app_private.operator_credentials where business_id=v_business_id and user_id=p_user_id;
  v_fingerprint:=extensions.digest(jsonb_build_object('businessId',v_business_id,'action','create_recovery_code')::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':pin_security:'||v_operation_id::text,0));
  select * into v_operation from app_private.pin_security_operations where user_id=p_user_id and operation_id=v_operation_id;
  select * into v_recovery from app_private.owner_pin_recovery_credentials where business_id=v_business_id and user_id=p_user_id for update;
  if v_operation.operation_id is not null then
    if v_operation.action<>'create_recovery_code' or v_operation.payload_fingerprint<>v_fingerprint
      or v_operation.result_pin_hash<>v_credential.pin_hash or v_recovery.generation is distinct from v_operation_id then
      raise exception 'OPERATION_CONFLICT' using errcode='P0001';
    end if;
  else
    insert into app_private.pin_security_operations(user_id,operation_id,business_id,action,payload_fingerprint,result_pin_hash)
      values(p_user_id,v_operation_id,v_business_id,'create_recovery_code',v_fingerprint,v_credential.pin_hash);
    insert into app_private.pin_security_audit_events(business_id,user_id,auth_session_id,event)
      values(v_business_id,p_user_id,p_auth_session_id,'recovery_code_created');
  end if;
  v_code:=encode(extensions.gen_random_bytes(32),'hex');
  insert into app_private.owner_pin_recovery_credentials(business_id,user_id,code_hash,generation)
    values(v_business_id,p_user_id,extensions.digest(v_code,'sha256'),v_operation_id)
    on conflict(business_id,user_id) do update set code_hash=excluded.code_hash,generation=excluded.generation,
      failed_attempts=0,locked_until=null,updated_at=clock_timestamp();
  return jsonb_build_object('data',jsonb_build_object('recoveryCode',v_code));
end;
$$;

create function app_private.recover_owner_pin(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_pin text:=p_payload->>'pin'; v_code text:=p_payload->>'recoveryCode'; v_new_code text; v_fingerprint bytea; v_pin_hash text;
  v_employee app_private.employees%rowtype; v_credential app_private.operator_credentials%rowtype;
  v_recovery app_private.owner_pin_recovery_credentials%rowtype; v_operation app_private.pin_security_operations%rowtype;
  v_attempts integer; v_locked_until timestamptz; v_session jsonb; v_retry boolean:=false;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if v_business_id is null or v_operation_id is null or v_pin is null or v_pin !~ '^[0-9]{6}$'
    or v_code is null or v_code !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_business_id and user_id=p_user_id for update;
  perform app_private.assert_owner(p_user_id,v_business_id);
  perform app_private.assert_member(p_user_id,v_business_id);
  if not exists(select 1 from auth.sessions where id=p_auth_session_id and user_id=p_user_id and created_at>=clock_timestamp()-interval '5 minutes') then
    raise exception 'REAUTH_REQUIRED' using errcode='P0001';
  end if;
  select * into v_credential from app_private.operator_credentials where business_id=v_business_id and user_id=p_user_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  select * into v_recovery from app_private.owner_pin_recovery_credentials where business_id=v_business_id and user_id=p_user_id for update;
  if not found then raise exception 'RECOVERY_UNAVAILABLE' using errcode='P0001'; end if;
  if v_recovery.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','RECOVERY_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_recovery.locked_until-clock_timestamp()))::integer)));
  end if;
  v_fingerprint:=extensions.digest(jsonb_build_object('businessId',v_business_id,'action','reset_pin')::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':pin_security:'||v_operation_id::text,0));
  select * into v_operation from app_private.pin_security_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.action<>'reset_pin' or v_operation.payload_fingerprint<>v_fingerprint
      or v_operation.result_pin_hash<>v_credential.pin_hash or v_recovery.generation is distinct from v_operation_id then
      raise exception 'OPERATION_CONFLICT' using errcode='P0001';
    end if;
    v_retry:=true;
  end if;
  if (v_retry and (v_operation.consumed_code_hash<>extensions.digest(v_code,'sha256')
      or extensions.crypt(v_pin,v_operation.result_pin_hash)<>v_operation.result_pin_hash))
    or (not v_retry and v_recovery.code_hash<>extensions.digest(v_code,'sha256')) then
    v_attempts:=case when v_recovery.locked_until is not null then 1 else v_recovery.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.owner_pin_recovery_credentials set failed_attempts=v_attempts,locked_until=v_locked_until
      where business_id=v_business_id and user_id=p_user_id;
    insert into app_private.pin_security_audit_events(business_id,user_id,auth_session_id,event)
      values(v_business_id,p_user_id,p_auth_session_id,case when v_attempts>=5 then 'recovery_lockout' else 'recovery_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'RECOVERY_LOCKED' else 'RECOVERY_INVALID' end,
      'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  if not v_retry then
    v_pin_hash:=extensions.crypt(v_pin,extensions.gen_salt('bf',12));
    update app_private.operator_credentials set pin_hash=v_pin_hash,failed_attempts=0,locked_until=null
      where business_id=v_business_id and user_id=p_user_id;
    insert into app_private.pin_security_operations(user_id,operation_id,business_id,action,payload_fingerprint,result_pin_hash,consumed_code_hash)
      values(p_user_id,v_operation_id,v_business_id,'reset_pin',v_fingerprint,v_pin_hash,v_recovery.code_hash);
    insert into app_private.pin_security_audit_events(business_id,user_id,auth_session_id,event)
      values(v_business_id,p_user_id,p_auth_session_id,'pin_recovered');
  else
    -- Exact lost-response retries may complete during PIN cooldown: the independent recovery code
    -- is verified above and resets that counter, just as the original recovery transaction did.
    update app_private.operator_credentials set failed_attempts=0,locked_until=null where business_id=v_business_id and user_id=p_user_id;
  end if;
  v_new_code:=encode(extensions.gen_random_bytes(32),'hex');
  update app_private.owner_pin_recovery_credentials set code_hash=extensions.digest(v_new_code,'sha256'),generation=v_operation_id,
    failed_attempts=0,locked_until=null,updated_at=clock_timestamp() where business_id=v_business_id and user_id=p_user_id;
  perform app_private.revoke_person_operator_sessions(p_user_id,v_business_id,v_employee.id);
  v_session:=app_private.issue_operator_session(p_user_id,p_auth_session_id,v_business_id);
  return jsonb_build_object('data',(v_session->'data')||jsonb_build_object('recoveryCode',v_new_code));
end;
$$;

create function app_private.change_person_pin(p_user_id uuid,p_auth_session_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_current_pin text:=p_payload->>'currentPin'; v_pin text:=p_payload->>'pin'; v_fingerprint bytea; v_result jsonb; v_pin_hash text;
  v_employee app_private.employees%rowtype; v_credential app_private.operator_credentials%rowtype;
  v_operation app_private.pin_security_operations%rowtype;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if v_business_id is null or v_operation_id is null or v_current_pin is null or v_current_pin !~ '^[0-9]{6}$'
    or v_pin is null or v_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_employee from app_private.employees where business_id=v_business_id and user_id=p_user_id for update;
  perform app_private.assert_member(p_user_id,v_business_id);
  v_fingerprint:=extensions.digest(jsonb_build_object('businessId',v_business_id,'action','change_pin')::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':pin_security:'||v_operation_id::text,0));
  select * into v_operation from app_private.pin_security_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_operation.action<>'change_pin' or v_operation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    v_result:=app_private.verify_pin_change_retry(p_user_id,p_auth_session_id,v_business_id,v_current_pin,v_pin,v_operation);
    if v_result is not null then return v_result; end if;
  else
    perform app_private.assert_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
    v_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_business_id,v_current_pin);
    if v_result is not null then return v_result; end if;
    select * into v_credential from app_private.operator_credentials where business_id=v_business_id and user_id=p_user_id;
    v_pin_hash:=extensions.crypt(v_pin,extensions.gen_salt('bf',12));
    update app_private.operator_credentials set pin_hash=v_pin_hash,failed_attempts=0,locked_until=null where business_id=v_business_id and user_id=p_user_id;
    insert into app_private.pin_security_operations(user_id,operation_id,business_id,action,payload_fingerprint,prior_pin_hash,result_pin_hash)
      values(p_user_id,v_operation_id,v_business_id,'change_pin',v_fingerprint,v_credential.pin_hash,v_pin_hash);
    insert into app_private.pin_security_audit_events(business_id,user_id,auth_session_id,event)
      values(v_business_id,p_user_id,p_auth_session_id,'pin_changed');
  end if;
  perform app_private.revoke_person_operator_sessions(p_user_id,v_business_id,v_employee.id);
  return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_business_id);
end;
$$;

create or replace function public.account_status(p_user_id uuid,p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_businesses jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,
      'canRecoverPin',m.role='owner' and e.role='owner',
      'recoveryReady',m.role='owner' and e.role='owner' and exists(select 1 from app_private.owner_pin_recovery_credentials r where r.business_id=b.id and r.user_id=p_user_id))
      order by b.created_at,b.id),'[]'::jsonb) into v_businesses
    from app_private.businesses b join app_private.business_memberships m on m.business_id=b.id
    join app_private.employees e on e.business_id=m.business_id and e.user_id=m.user_id
    where m.user_id=p_user_id and m.active and e.active and e.deleted_at is null and m.role=e.role;
  return jsonb_build_object('data',jsonb_build_object('businesses',v_businesses));
end;
$$;

alter function public.account_manage(uuid,uuid,text,jsonb) set schema app_private;
alter function app_private.account_manage(uuid,uuid,text,jsonb) rename to account_manage_employee_pin_v5;
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  case p_action
    when 'create_recovery_code' then return app_private.create_owner_recovery_code(p_user_id,p_auth_session_id,p_payload);
    when 'reset_pin' then return app_private.recover_owner_pin(p_user_id,p_auth_session_id,p_payload);
    when 'change_pin' then return app_private.change_person_pin(p_user_id,p_auth_session_id,p_payload);
    else return app_private.account_manage_employee_pin_v5(p_user_id,p_auth_session_id,p_action,p_payload);
  end case;
end;
$$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function public.account_status(uuid,uuid),public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_status(uuid,uuid),public.account_manage(uuid,uuid,text,jsonb) to service_role;
