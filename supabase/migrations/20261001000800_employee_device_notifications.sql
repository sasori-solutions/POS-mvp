-- Agente de Larios, 2026-10-01. Personal employee access is tied to a browser signing key.
-- Edge verifies each signature; only service-role RPCs can supply its digest and one-use nonce.
create table app_private.employee_personal_devices (
  business_id uuid not null,
  employee_id uuid not null,
  key_hash bytea not null check (octet_length(key_hash)=32),
  name text not null check (char_length(name) between 2 and 100),
  linked_at timestamptz not null default clock_timestamp(),
  primary key (business_id,employee_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
create table app_private.employee_device_proofs (
  key_hash bytea not null check (octet_length(key_hash)=32),
  nonce uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (key_hash,nonce)
);
create table app_private.owner_notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  employee_id uuid not null,
  kind text not null check (kind in ('employee_device_requested','employee_device_linked')),
  device_key_hash bytea not null check (octet_length(device_key_hash)=32),
  device_name text not null,
  status text not null check (status in ('pending','approved','rejected','info')),
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  reviewed_at timestamptz,
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
create unique index employee_device_pending_key on app_private.owner_notifications(business_id,employee_id,device_key_hash) where status='pending';
create index owner_notifications_feed on app_private.owner_notifications(business_id,created_at desc,id);
alter table app_private.operator_sessions add column employee_device_key_hash bytea;
alter table app_private.employee_personal_devices enable row level security;
alter table app_private.employee_device_proofs enable row level security;
alter table app_private.owner_notifications enable row level security;
revoke all on app_private.employee_personal_devices,app_private.employee_device_proofs,app_private.owner_notifications from public,anon,authenticated;

-- Expected denials return JSON so a valid-PIN attempt's notification commits.
create function app_private.check_employee_device(p_user_id uuid,p_business_id uuid,p_allow_enroll boolean)
returns jsonb language plpgsql set search_path='' as $$
declare v_employee app_private.employees%rowtype; v_device app_private.employee_personal_devices%rowtype;
  v_key text:=nullif(current_setting('app.employee_device_key',true),'');
  v_name text:=coalesce(nullif(current_setting('app.employee_device_name',true),''),'Navegador del empleado');
  v_hash bytea;
begin
  select * into v_employee from app_private.employees where business_id=p_business_id and user_id=p_user_id for update;
  if not found or not v_employee.active or v_employee.deleted_at is not null then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then return null; end if;
  if v_key is null or v_key !~ '^[0-9a-f]{64}$' then return jsonb_build_object('error',jsonb_build_object('code','DEVICE_LINK_REQUIRED')); end if;
  v_hash:=decode(v_key,'hex');
  select * into v_device from app_private.employee_personal_devices where business_id=p_business_id and employee_id=v_employee.id for update;
  if not found then
    if not p_allow_enroll then return jsonb_build_object('error',jsonb_build_object('code','DEVICE_LINK_REQUIRED')); end if;
    insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values(p_business_id,v_employee.id,v_hash,v_name);
    insert into app_private.owner_notifications(business_id,employee_id,kind,device_key_hash,device_name,status)
      values(p_business_id,v_employee.id,'employee_device_linked',v_hash,v_name,'info');
    -- Enrolling an existing account closes all sessions issued before device enforcement.
    perform app_private.revoke_person_operator_sessions(p_user_id,p_business_id,v_employee.id);
    return null;
  end if;
  if v_device.key_hash=v_hash then return null; end if;
  if p_allow_enroll and (select count(*) from app_private.owner_notifications where business_id=p_business_id and employee_id=v_employee.id
      and kind='employee_device_requested' and created_at>clock_timestamp()-interval '10 minutes')<5
    and not exists(select 1 from app_private.owner_notifications where business_id=p_business_id and employee_id=v_employee.id
      and device_key_hash=v_hash and (status='pending' or created_at>clock_timestamp()-interval '10 minutes')) then
    insert into app_private.owner_notifications(business_id,employee_id,kind,device_key_hash,device_name,status)
      values(p_business_id,v_employee.id,'employee_device_requested',v_hash,v_name,'pending') on conflict do nothing;
  end if;
  return jsonb_build_object('error',jsonb_build_object('code','DEVICE_APPROVAL_REQUIRED'));
end;
$$;

alter function app_private.issue_operator_session(uuid,uuid,uuid) rename to issue_operator_session_before_device;
create function app_private.issue_operator_session(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid)
returns jsonb language plpgsql set search_path='' as $$
declare v_result jsonb; v_key text:=nullif(current_setting('app.employee_device_key',true),'');
begin
  v_result:=app_private.check_employee_device(p_user_id,p_business_id,true);
  if v_result is not null then return v_result; end if;
  v_result:=app_private.issue_operator_session_before_device(p_user_id,p_auth_session_id,p_business_id);
  if v_key is not null then
    update app_private.operator_sessions set employee_device_key_hash=decode(v_key,'hex')
      where token_hash=extensions.digest(v_result#>>'{data,operatorToken}','sha256');
  end if;
  return v_result;
end;
$$;

alter function app_private.assert_operator(uuid,uuid,uuid,text) rename to assert_operator_before_device;
create function app_private.assert_operator(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns timestamptz language plpgsql set search_path='' as $$
declare v_expires timestamptz; v_check jsonb; v_key text:=nullif(current_setting('app.employee_device_key',true),'');
begin
  v_expires:=app_private.assert_operator_before_device(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  v_check:=app_private.check_employee_device(p_user_id,p_business_id,false);
  if v_check is not null then raise exception '%',v_check#>>'{error,code}' using errcode='P0001'; end if;
  if exists(select 1 from app_private.employees where business_id=p_business_id and user_id=p_user_id and role<>'owner')
    and not exists(select 1 from app_private.operator_sessions where token_hash=extensions.digest(p_operator_token,'sha256')
      and employee_device_key_hash=decode(v_key,'hex')) then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
  return v_expires;
end;
$$;

create function app_private.employee_notifications(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business uuid:=(p_payload->>'businessId')::uuid; v_notification app_private.owner_notifications%rowtype;
  v_employee app_private.employees%rowtype; v_items jsonb; v_count integer; v_status text;
begin
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business,p_payload->>'operatorToken');
  if p_action='notifications' then
    select count(*)::integer into v_count from app_private.owner_notifications where business_id=v_business and read_at is null;
    select coalesce(jsonb_agg(item order by pending desc,unread desc,created_at desc,id),'[]'::jsonb) into v_items from (
      select n.created_at,n.id,n.status='pending' pending,n.read_at is null unread,jsonb_build_object('id',n.id,'type',n.kind,'employeeId',n.employee_id,'employeeName',e.name,
        'deviceName',n.device_name,'createdAt',n.created_at,'readAt',n.read_at,'status',n.status) item
      from app_private.owner_notifications n join app_private.employees e on e.business_id=n.business_id and e.id=n.employee_id
      where n.business_id=v_business order by (n.status='pending') desc,(n.read_at is null) desc,n.created_at desc,n.id limit 100
    ) entries;
    return jsonb_build_object('data',jsonb_build_object('notifications',v_items,'unreadCount',v_count));
  end if;
  select * into v_notification from app_private.owner_notifications where id=(p_payload->>'notificationId')::uuid and business_id=v_business;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  -- Match the employee -> notification lock order of unlock, deletion and enrollment.
  select * into v_employee from app_private.employees where business_id=v_business and id=v_notification.employee_id for update;
  select * into v_notification from app_private.owner_notifications where id=v_notification.id for update;
  if p_action='mark_notification_read' then
    update app_private.owner_notifications set read_at=coalesce(read_at,clock_timestamp()) where id=v_notification.id;
    return jsonb_build_object('data',jsonb_build_object('read',true));
  end if;
  if p_action<>'review_employee_device' or p_payload->>'decision' not in ('approve','reject') or v_notification.kind<>'employee_device_requested' then
    raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_status:=case when p_payload->>'decision'='approve' then 'approved' else 'rejected' end;
  if v_notification.status<>'pending' then
    if v_notification.status=v_status then return jsonb_build_object('data',jsonb_build_object('reviewed',true)); end if;
    raise exception 'OPERATION_CONFLICT' using errcode='P0001';
  end if;
  if not v_employee.active or v_employee.deleted_at is not null or v_employee.user_id is null or v_employee.role='owner' then
    raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_status='approved' then
    update app_private.employee_personal_devices set key_hash=v_notification.device_key_hash,name=v_notification.device_name,linked_at=clock_timestamp()
      where business_id=v_business and employee_id=v_employee.id;
    if not found then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    perform app_private.revoke_person_operator_sessions(v_employee.user_id,v_business,v_employee.id);
    update app_private.owner_notifications set status='rejected',reviewed_at=clock_timestamp(),read_at=coalesce(read_at,clock_timestamp())
      where business_id=v_business and employee_id=v_employee.id and status='pending' and id<>v_notification.id;
  end if;
  update app_private.owner_notifications set status=v_status,reviewed_at=clock_timestamp(),read_at=coalesce(read_at,clock_timestamp()) where id=v_notification.id;
  return jsonb_build_object('data',jsonb_build_object('reviewed',true));
end;
$$;

create function app_private.close_employee_device_requests() returns trigger language plpgsql set search_path='' as $$
begin
  if not new.active or new.deleted_at is not null or new.user_id is distinct from old.user_id then
    update app_private.owner_notifications set status='rejected',reviewed_at=clock_timestamp() where employee_id=new.id and business_id=new.business_id and status='pending';
  end if;
  return new;
end;
$$;
create trigger employee_device_requests_close after update of active,deleted_at,user_id on app_private.employees
  for each row execute function app_private.close_employee_device_requests();

-- All authenticated HTTP commands enter here; no browser role can invoke it directly.
create function public.account_secure(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb,p_device_key_hash text default null,p_proof_nonce uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_inserted uuid; v_name text:=coalesce(p_payload->>'deviceName','Navegador del empleado'); v_result jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if (p_device_key_hash is null)<>(p_proof_nonce is null) or p_device_key_hash is not null and p_device_key_hash !~ '^[0-9a-f]{64}$'
    or char_length(v_name) not between 2 and 100 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_device_key_hash is not null then
    delete from app_private.employee_device_proofs where created_at<clock_timestamp()-interval '5 minutes';
    insert into app_private.employee_device_proofs(key_hash,nonce,user_id) values(decode(p_device_key_hash,'hex'),p_proof_nonce,p_user_id)
      on conflict do nothing returning nonce into v_inserted;
    if v_inserted is null then return jsonb_build_object('error',jsonb_build_object('code','DEVICE_PROOF_INVALID')); end if;
  end if;
  perform set_config('app.employee_device_key',coalesce(p_device_key_hash,''),true);
  perform set_config('app.employee_device_name',v_name,true);
  if p_action in ('accept_invitation','set_employee_pin') and p_device_key_hash is null then
    return jsonb_build_object('error',jsonb_build_object('code','DEVICE_LINK_REQUIRED'));
  end if;
  -- A recovery/setup authorization does not authorize moving an existing device binding.
  if p_action='set_employee_pin' then
    select app_private.check_employee_device(p_user_id,s.business_id,false) into v_result
      from app_private.employee_pin_setup_codes s where s.token_hash=extensions.digest(p_payload->>'setupCode','sha256')
        and exists(select 1 from app_private.employees e join app_private.employee_personal_devices d on d.business_id=e.business_id and d.employee_id=e.id
          where e.id=s.employee_id and e.user_id=p_user_id);
    if v_result is not null then return v_result; end if;
  end if;
  case p_action
    when 'status' then return public.account_status(p_user_id,p_auth_session_id);
    when 'create_business' then return public.account_create_business(p_user_id,p_auth_session_id,p_payload->>'name',p_payload->>'businessType',p_payload->>'timezone',(p_payload->>'operationId')::uuid,p_payload->>'pin',p_payload->'profile');
    when 'unlock' then return public.account_unlock(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'pin');
    when 'context' then return public.account_context(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken');
    when 'lock' then return public.account_lock(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken');
    when 'revoke_sessions' then return public.account_revoke_sessions(p_user_id,p_auth_session_id);
    when 'request_pin_email' then return public.account_request_pin_email(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid);
    when 'notifications','mark_notification_read','review_employee_device' then return app_private.employee_notifications(p_user_id,p_auth_session_id,p_action,p_payload);
    else return public.account_manage(p_user_id,p_auth_session_id,p_action,p_payload);
  end case;
end;
$$;

-- A shared-register credential must not bypass a personal employee's linked browser.
alter function public.account_device(text,jsonb) rename to account_device_before_personal_binding;
alter function public.account_device_before_personal_binding(text,jsonb) set schema app_private;
create function public.account_device(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_device app_private.devices%rowtype; v_employee app_private.employees%rowtype; v_result jsonb;
begin
  if p_action in ('device_unlock','device_context','device_pin_setup_details','device_set_employee_pin') then
    select * into v_device from app_private.devices where token_hash=extensions.digest(p_payload->>'deviceToken','sha256') for update;
    if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
    if p_action='device_unlock' then
      select * into v_employee from app_private.employees where business_id=v_device.business_id and id=(p_payload->>'employeeId')::uuid for update;
    elsif p_action='device_context' then
      select e.* into v_employee from app_private.employees e join app_private.device_operator_sessions s on s.business_id=e.business_id and s.employee_id=e.id
        where s.device_id=v_device.id and s.token_hash=extensions.digest(p_payload->>'operatorToken','sha256') for update of e;
    else
      select e.* into v_employee from app_private.employees e join app_private.employee_pin_setup_codes s on s.business_id=e.business_id and s.employee_id=e.id
        where s.business_id=v_device.business_id and s.token_hash=extensions.digest(p_payload->>'setupCode','sha256') for update of e;
    end if;
    if v_employee.user_id is not null and v_employee.role<>'owner' then
      return jsonb_build_object('error',jsonb_build_object('code','DEVICE_LINK_REQUIRED'));
    end if;
  end if;
  v_result:=app_private.account_device_before_personal_binding(p_action,p_payload);
  if p_action='device_status' then
    v_result:=jsonb_set(v_result,'{data,employees}',coalesce((select jsonb_agg(e) from jsonb_array_elements(v_result#>'{data,employees}') e
      where e->>'googleLinked'<>'true' or e->>'role'='owner'),'[]'::jsonb));
  end if;
  return v_result;
end;
$$;
revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function app_private.account_device_before_personal_binding(text,jsonb) from service_role;
revoke all on function public.account_secure(uuid,uuid,text,jsonb,text,uuid),public.account_device(text,jsonb) from public,anon,authenticated;
grant execute on function public.account_secure(uuid,uuid,text,jsonb,text,uuid),public.account_device(text,jsonb) to service_role;
