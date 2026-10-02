-- Agente de Larios, 2026-10-01. Email confirms only a scoped PIN reset, never a login.
create table app_private.pin_email_recoveries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null,
  user_id uuid not null,
  employee_id uuid not null references app_private.employees(id) on delete cascade,
  email text not null,
  token_hash bytea not null unique check (octet_length(token_hash)=32),
  prior_pin_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
  delivered_at timestamptz,
  revoked_at timestamptz,
  consumed_at timestamptz,
  operation_id uuid,
  result_pin_hash text,
  foreign key (business_id,user_id) references app_private.business_memberships(business_id,user_id) on delete cascade
);
create index pin_email_recovery_rate on app_private.pin_email_recoveries(user_id,created_at desc);
alter table app_private.pin_email_recoveries enable row level security;
revoke all on app_private.pin_email_recoveries from public,anon,authenticated;

create function app_private.invalidate_employee_email_recovery() returns trigger language plpgsql set search_path='' as $$
begin
  if old.active is distinct from new.active or old.deleted_at is distinct from new.deleted_at
    or old.user_id is distinct from new.user_id or old.role is distinct from new.role then
    update app_private.pin_email_recoveries set revoked_at=clock_timestamp()
      where employee_id=old.id and revoked_at is null;
  end if;
  return new;
end;
$$;
create trigger employee_email_recovery_invalidated after update on app_private.employees
  for each row execute function app_private.invalidate_employee_email_recovery();

create function app_private.prepare_pin_email(p_user_id uuid,p_business_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_employee app_private.employees%rowtype; v_email text; v_pin_hash text; v_token text; v_id uuid;
  v_latest timestamptz; v_oldest timestamptz; v_count integer; v_retry integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':pin_email',0));
  select * into v_employee from app_private.employees where business_id=p_business_id and user_id=p_user_id for update;
  perform app_private.assert_member(p_user_id,p_business_id);
  select email into v_email from auth.users where id=p_user_id and email_confirmed_at is not null;
  select pin_hash into v_pin_hash from app_private.operator_credentials where business_id=p_business_id and user_id=p_user_id for update;
  if v_email is null or v_email='' or v_pin_hash is null then raise exception 'RECOVERY_UNAVAILABLE' using errcode='P0001'; end if;
  select max(created_at),min(created_at),count(*) into v_latest,v_oldest,v_count
    from app_private.pin_email_recoveries where user_id=p_user_id and created_at>clock_timestamp()-interval '1 hour';
  if v_latest>clock_timestamp()-interval '1 minute' or v_count>=5 then
    v_retry:=greatest(1,ceil(extract(epoch from (case when v_count>=5 then v_oldest+interval '1 hour' else v_latest+interval '1 minute' end)-clock_timestamp()))::integer);
    return jsonb_build_object('error',jsonb_build_object('code','RECOVERY_LOCKED','retryAfterSeconds',v_retry));
  end if;
  -- Replaced links remain invalid even if delivery fails or an employee is later restored.
  update app_private.pin_email_recoveries set revoked_at=clock_timestamp()
    where user_id=p_user_id and business_id=p_business_id and revoked_at is null;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into app_private.pin_email_recoveries(business_id,user_id,employee_id,email,token_hash,prior_pin_hash)
    values(p_business_id,p_user_id,v_employee.id,v_email,extensions.digest(v_token,'sha256'),v_pin_hash) returning id into v_id;
  -- This service-role-only response is consumed by the mail adapter, never forwarded to a browser.
  return jsonb_build_object('data',jsonb_build_object('id',v_id,'email',v_email,'token',v_token));
end;
$$;

create or replace function public.account_request_pin_email(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  return app_private.prepare_pin_email(p_user_id,p_business_id);
end;
$$;
create function public.account_device_request_pin_email(p_device_token text,p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device app_private.devices%rowtype; v_user_id uuid;
begin
  select * into v_device from app_private.devices where token_hash=extensions.digest(p_device_token,'sha256');
  if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  select user_id into v_user_id from app_private.employees where id=p_employee_id and business_id=v_device.business_id and active and deleted_at is null;
  if not found then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_user_id is null then raise exception 'RECOVERY_UNAVAILABLE' using errcode='P0001'; end if;
  return app_private.prepare_pin_email(v_user_id,v_device.business_id);
end;
$$;

create function public.account_pin_email_delivery(p_id uuid,p_delivered boolean)
returns void language sql security definer set search_path='' as $$
  update app_private.pin_email_recoveries set delivered_at=case when p_delivered then clock_timestamp() end,
    revoked_at=case when not p_delivered then clock_timestamp() else revoked_at end where id=p_id;
$$;

create function public.account_confirm_pin_email(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_token text:=p_payload->>'recoveryToken'; v_pin text:=p_payload->>'pin'; v_operation_id uuid:=(p_payload->>'operationId')::uuid;
  v_link app_private.pin_email_recoveries%rowtype; v_current_hash text; v_employee app_private.employees%rowtype;
begin
  if p_action not in ('pin_email_details','confirm_pin_email') or v_token is null or v_token !~ '^[0-9a-f]{64}$'
    or (p_action='confirm_pin_email' and (v_pin is null or v_pin !~ '^[0-9]{6}$' or v_operation_id is null)) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  select * into v_link from app_private.pin_email_recoveries where token_hash=extensions.digest(v_token,'sha256');
  if not found then raise exception 'RECOVERY_INVALID' using errcode='P0001'; end if;
  -- Use the same employee -> credential -> recovery lock order as all personal PIN changes.
  select * into v_employee from app_private.employees where id=v_link.employee_id for update;
  select pin_hash into v_current_hash from app_private.operator_credentials where business_id=v_link.business_id and user_id=v_link.user_id for update;
  select * into v_link from app_private.pin_email_recoveries where id=v_link.id for update;
  if v_link.revoked_at is not null or v_link.delivered_at is null or v_link.expires_at<=clock_timestamp()
    or not v_employee.active or v_employee.deleted_at is not null or v_employee.user_id is distinct from v_link.user_id
    or not exists(select 1 from app_private.business_memberships where business_id=v_link.business_id and user_id=v_link.user_id and active and role=v_employee.role)
    or not exists(select 1 from auth.users where id=v_link.user_id and email=v_link.email and email_confirmed_at is not null and (banned_until is null or banned_until<=clock_timestamp()) and deleted_at is null)
    or v_current_hash is null then raise exception 'RECOVERY_INVALID' using errcode='P0001'; end if;
  if v_link.consumed_at is not null then
    -- A lost-response retry reports completion only; it never reopens sessions or resets lockout.
    if p_action='confirm_pin_email' and v_link.operation_id=v_operation_id and v_link.result_pin_hash=v_current_hash then
      return jsonb_build_object('data',jsonb_build_object('updated',true));
    end if;
    raise exception 'RECOVERY_INVALID' using errcode='P0001';
  end if;
  if v_link.prior_pin_hash<>v_current_hash then raise exception 'RECOVERY_INVALID' using errcode='P0001'; end if;
  if p_action='pin_email_details' then
    return jsonb_build_object('data',jsonb_build_object('businessName',(select name from app_private.businesses where id=v_link.business_id),'expiresAt',v_link.expires_at));
  end if;
  v_current_hash:=extensions.crypt(v_pin,extensions.gen_salt('bf',12));
  update app_private.operator_credentials set pin_hash=v_current_hash,failed_attempts=0,locked_until=null
    where business_id=v_link.business_id and user_id=v_link.user_id;
  update app_private.pin_email_recoveries set consumed_at=clock_timestamp(),operation_id=v_operation_id,result_pin_hash=v_current_hash where id=v_link.id;
  update app_private.pin_email_recoveries set revoked_at=clock_timestamp()
    where user_id=v_link.user_id and business_id=v_link.business_id and id<>v_link.id and revoked_at is null;
  perform app_private.revoke_person_operator_sessions(v_link.user_id,v_link.business_id,v_link.employee_id);
  insert into app_private.pin_security_audit_events(business_id,user_id,event) values(v_link.business_id,v_link.user_id,'pin_recovered');
  return jsonb_build_object('data',jsonb_build_object('updated',true));
end;
$$;

-- Retired code entry points cannot be used by an older PWA or a direct API caller.
create or replace function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  case p_action
    when 'create_recovery_code','reset_pin' then raise exception 'RECOVERY_UNAVAILABLE' using errcode='P0001';
    when 'change_pin' then return app_private.change_person_pin(p_user_id,p_auth_session_id,p_payload);
    else return app_private.account_manage_employee_pin_v5(p_user_id,p_auth_session_id,p_action,p_payload);
  end case;
end;
$$;
create or replace function public.account_status(p_user_id uuid,p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_businesses jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,
    'canRecoverPin',true,'recoveryReady',true) order by b.created_at,b.id),'[]'::jsonb) into v_businesses
    from app_private.businesses b join app_private.business_memberships m on m.business_id=b.id
    join app_private.employees e on e.business_id=m.business_id and e.user_id=m.user_id
    where m.user_id=p_user_id and m.active and e.active and e.deleted_at is null and m.role=e.role;
  return jsonb_build_object('data',jsonb_build_object('businesses',v_businesses));
end;
$$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function public.account_device_request_pin_email(text,uuid),public.account_request_pin_email(uuid,uuid,uuid),public.account_pin_email_delivery(uuid,boolean),public.account_confirm_pin_email(text,jsonb) from public,anon,authenticated;
grant execute on function public.account_device_request_pin_email(text,uuid),public.account_request_pin_email(uuid,uuid,uuid),public.account_pin_email_delivery(uuid,boolean),public.account_confirm_pin_email(text,jsonb) to service_role;
