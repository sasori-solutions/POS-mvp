-- Dispositivos previously listed only PIN-paired registers. Personal browser
-- bindings and owner browsers now have an owner-only persisted projection.
alter table app_private.employee_personal_devices add column id uuid not null default gen_random_uuid();
alter table app_private.employee_personal_devices add constraint employee_personal_devices_id_key unique(id);
alter table app_private.employee_personal_devices add column revoked_at timestamptz;
alter table app_private.employee_personal_devices add column last_seen_at timestamptz;

create table app_private.owner_browser_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  employee_id uuid not null,
  key_hash bytea not null check(octet_length(key_hash)=32),
  name text not null check(char_length(name) between 2 and 100),
  created_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  unique(business_id,employee_id,key_hash),
  foreign key(business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
alter table app_private.owner_browser_devices enable row level security;
revoke all on app_private.owner_browser_devices from public,anon,authenticated;

insert into app_private.owner_browser_devices(business_id,employee_id,key_hash,name,created_at,last_seen_at)
  select s.business_id,e.id,s.employee_device_key_hash,'Navegador del dueño',min(s.created_at),max(s.last_seen_at)
  from app_private.operator_sessions s join app_private.employees e on e.business_id=s.business_id and e.user_id=s.user_id
  where e.role='owner' and e.active and e.deleted_at is null and s.employee_device_key_hash is not null
  group by s.business_id,e.id,s.employee_device_key_hash;
update app_private.employee_personal_devices d set last_seen_at=(select max(s.last_seen_at)
  from app_private.operator_sessions s join app_private.employees e on e.business_id=s.business_id and e.user_id=s.user_id
  where s.business_id=d.business_id and e.id=d.employee_id and s.employee_device_key_hash=d.key_hash);

-- A replacement has a fresh public ID. A delayed revoke of the old ID cannot
-- remove a subsequently approved replacement. Approval is the only restoration.
create function app_private.refresh_employee_device_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.key_hash is distinct from old.key_hash or new.linked_at is distinct from old.linked_at then
    new.id:=gen_random_uuid(); new.revoked_at:=null; new.last_seen_at:=null;
  end if;
  return new;
end $$;
create trigger employee_device_identity before update on app_private.employee_personal_devices
  for each row execute function app_private.refresh_employee_device_identity();

alter function app_private.check_employee_device(uuid,uuid,boolean) rename to check_employee_device_before_visibility;
create function app_private.check_employee_device(p_user_id uuid,p_business_id uuid,p_allow_enroll boolean)
returns jsonb language plpgsql set search_path='' as $$
declare v_employee app_private.employees%rowtype; v_owner_device app_private.owner_browser_devices%rowtype;
  v_device app_private.employee_personal_devices%rowtype; v_key text:=nullif(current_setting('app.employee_device_key',true),'');
  v_name text:=nullif(current_setting('app.employee_device_name',true),''); v_result jsonb;
begin
  select * into v_employee from app_private.employees where business_id=p_business_id and user_id=p_user_id for update;
  if not found or not v_employee.active or v_employee.deleted_at is not null then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_employee.role='owner' then
    -- Keep the existing storage-unavailable owner access contract. A key, when
    -- present, is verified by Edge and remains revocable across Auth sessions.
    if v_key is null then return null; end if;
    if v_key !~ '^[0-9a-f]{64}$' then raise exception 'DEVICE_PROOF_INVALID' using errcode='P0001'; end if;
    select * into v_owner_device from app_private.owner_browser_devices
      where business_id=p_business_id and employee_id=v_employee.id and key_hash=decode(v_key,'hex') for update;
    if found and v_owner_device.revoked_at is not null then return jsonb_build_object('error',jsonb_build_object('code','DEVICE_REVOKED')); end if;
    if v_name is null or v_name='Navegador del empleado' then v_name:='Navegador del dueño'; end if;
    insert into app_private.owner_browser_devices(business_id,employee_id,key_hash,name,last_seen_at)
      values(p_business_id,v_employee.id,decode(v_key,'hex'),v_name,clock_timestamp())
      on conflict(business_id,employee_id,key_hash) do update set last_seen_at=excluded.last_seen_at
        where app_private.owner_browser_devices.last_seen_at is null or app_private.owner_browser_devices.last_seen_at<clock_timestamp()-interval '30 seconds';
    return null;
  end if;
  select * into v_device from app_private.employee_personal_devices where business_id=p_business_id and employee_id=v_employee.id for update;
  if found and v_device.revoked_at is not null then
    if p_allow_enroll and v_key ~ '^[0-9a-f]{64}$'
      and (select count(*) from app_private.owner_notifications where business_id=p_business_id and employee_id=v_employee.id
        and kind='employee_device_requested' and created_at>clock_timestamp()-interval '10 minutes')<5
      and not exists(select 1 from app_private.owner_notifications where business_id=p_business_id and employee_id=v_employee.id
        and kind='employee_device_requested' and created_at>=v_device.revoked_at
        and device_key_hash=decode(v_key,'hex') and (status='pending' or created_at>clock_timestamp()-interval '10 minutes')) then
      insert into app_private.owner_notifications(business_id,employee_id,kind,device_key_hash,device_name,status)
        values(p_business_id,v_employee.id,'employee_device_requested',decode(v_key,'hex'),coalesce(v_name,'Navegador del empleado'),'pending') on conflict do nothing;
    end if;
    return jsonb_build_object('error',jsonb_build_object('code','DEVICE_APPROVAL_REQUIRED'));
  end if;
  v_result:=app_private.check_employee_device_before_visibility(p_user_id,p_business_id,p_allow_enroll);
  if v_result is null then update app_private.employee_personal_devices set last_seen_at=clock_timestamp()
    where business_id=p_business_id and employee_id=v_employee.id and revoked_at is null
      and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds'); end if;
  return v_result;
end $$;

alter function app_private.assert_operator(uuid,uuid,uuid,text) rename to assert_operator_before_owner_device_binding;
create function app_private.assert_operator(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns timestamptz language plpgsql set search_path='' as $$
declare v_expires timestamptz; v_key text:=nullif(current_setting('app.employee_device_key',true),''); v_session_key bytea;
begin
  v_expires:=app_private.assert_operator_before_owner_device_binding(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  select employee_device_key_hash into v_session_key from app_private.operator_sessions where business_id=p_business_id
    and user_id=p_user_id and auth_session_id=p_auth_session_id and token_hash=extensions.digest(p_operator_token,'sha256');
  if v_session_key is not null and (v_key is null or decode(v_key,'hex')<>v_session_key) then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
  return v_expires;
end $$;

alter function public.account_manage(uuid,uuid,text,jsonb) rename to account_manage_before_device_visibility;
alter function public.account_manage_before_device_visibility(uuid,uuid,text,jsonb) set schema app_private;
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_business uuid:=(p_payload->>'businessId')::uuid; v_id uuid; v_result jsonb; v_devices jsonb;
  v_owner app_private.owner_browser_devices%rowtype; v_employee_device app_private.employee_personal_devices%rowtype;
  v_key text:=nullif(current_setting('app.employee_device_key',true),'');
begin
  if p_action not in ('team','revoke_device') then return app_private.account_manage_before_device_visibility(p_user_id,p_auth_session_id,p_action,p_payload); end if;
  if p_action='revoke_device' then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('device-admin:'||v_business::text,0)); end if;
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business,p_payload->>'operatorToken');
  if p_action='team' then
    v_result:=app_private.account_manage_before_device_visibility(p_user_id,p_auth_session_id,p_action,p_payload);
    select coalesce(jsonb_agg(entry order by active desc,last_seen desc nulls last,id),'[]'::jsonb) into v_devices from (
      select d.id,d.revoked_at is null and d.expires_at>clock_timestamp() active,
        (select max(s.last_seen_at) from app_private.device_operator_sessions s where s.business_id=d.business_id and s.device_id=d.id) last_seen,
        jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,'active',d.revoked_at is null and d.expires_at>clock_timestamp(),
          'kind','register','current',false,'lastSeenAt',(select max(s.last_seen_at) from app_private.device_operator_sessions s where s.business_id=d.business_id and s.device_id=d.id)) entry
        from app_private.devices d where d.business_id=v_business
      union all
      select d.id,d.revoked_at is null and e.active,d.last_seen_at,
        jsonb_build_object('id',d.id,'name',d.name,'registerName','','active',d.revoked_at is null and e.active,
          'kind','owner_browser','employeeName',e.name,'current',coalesce(e.user_id=p_user_id and encode(d.key_hash,'hex')=v_key,false),'lastSeenAt',d.last_seen_at)
        from app_private.owner_browser_devices d join app_private.employees e on e.business_id=d.business_id and e.id=d.employee_id
        where d.business_id=v_business and e.deleted_at is null
      union all
      select d.id,d.revoked_at is null and e.active,d.last_seen_at,
        jsonb_build_object('id',d.id,'name',d.name,'registerName','','active',d.revoked_at is null and e.active,
          'kind','employee_browser','employeeName',e.name,'current',false,'lastSeenAt',d.last_seen_at)
        from app_private.employee_personal_devices d join app_private.employees e on e.business_id=d.business_id and e.id=d.employee_id
        where d.business_id=v_business and e.deleted_at is null
    ) listed;
    return jsonb_set(v_result,'{data,devices}',v_devices);
  end if;
  v_id:=(p_payload->>'deviceId')::uuid;
  select * into v_owner from app_private.owner_browser_devices where business_id=v_business and id=v_id;
  if found then
    perform 1 from app_private.employees where business_id=v_business and id=v_owner.employee_id for update;
    select * into v_owner from app_private.owner_browser_devices where business_id=v_business and id=v_id for update;
    if v_owner.revoked_at is null then
      update app_private.owner_browser_devices set revoked_at=clock_timestamp() where id=v_id;
      update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business
        and user_id=(select user_id from app_private.employees where business_id=v_business and id=v_owner.employee_id)
        and employee_device_key_hash=v_owner.key_hash and revoked_at is null;
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business,p_user_id,p_auth_session_id,'device_revoked');
    end if;
    return jsonb_build_object('data',jsonb_build_object('revoked',true));
  end if;
  select * into v_employee_device from app_private.employee_personal_devices where business_id=v_business and id=v_id;
  if found then
    perform 1 from app_private.employees where business_id=v_business and id=v_employee_device.employee_id for update;
    select * into v_employee_device from app_private.employee_personal_devices where business_id=v_business and id=v_id for update;
    if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    if v_employee_device.revoked_at is null then
      update app_private.employee_personal_devices set revoked_at=clock_timestamp() where business_id=v_business and id=v_id;
      update app_private.owner_notifications set status='rejected',reviewed_at=clock_timestamp(),read_at=coalesce(read_at,clock_timestamp())
        where business_id=v_business and employee_id=v_employee_device.employee_id and status='pending';
      perform app_private.revoke_person_operator_sessions((select user_id from app_private.employees where business_id=v_business and id=v_employee_device.employee_id),v_business,v_employee_device.employee_id);
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business,p_user_id,p_auth_session_id,'device_revoked');
    end if;
    return jsonb_build_object('data',jsonb_build_object('revoked',true));
  end if;
  return app_private.account_manage_before_device_visibility(p_user_id,p_auth_session_id,p_action,p_payload);
end $$;

revoke all on function app_private.refresh_employee_device_identity(),app_private.check_employee_device_before_visibility(uuid,uuid,boolean),app_private.check_employee_device(uuid,uuid,boolean),app_private.assert_operator_before_owner_device_binding(uuid,uuid,uuid,text),app_private.assert_operator(uuid,uuid,uuid,text),app_private.account_manage_before_device_visibility(uuid,uuid,text,jsonb),public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function app_private.account_manage_before_device_visibility(uuid,uuid,text,jsonb) from service_role;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
