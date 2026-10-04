-- Presence is based on recently authenticated operator activity, not session expiry alone.
alter table app_private.operator_sessions add column last_seen_at timestamptz;
alter table app_private.device_operator_sessions add column last_seen_at timestamptz;

create index operator_sessions_presence_idx on app_private.operator_sessions(business_id,last_seen_at)
  where revoked_at is null;
create index device_operator_sessions_presence_idx on app_private.device_operator_sessions(business_id,last_seen_at)
  where revoked_at is null;

create or replace function public.account_context(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_expires timestamptz; v_business jsonb; v_connected jsonb;
begin
  v_expires:=app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  update app_private.operator_sessions set last_seen_at=clock_timestamp()
    where token_hash=extensions.digest(p_operator_token,'sha256') and business_id=p_business_id
      and user_id=p_user_id and auth_session_id=p_auth_session_id and revoked_at is null
      and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds');

  v_business:=app_private.business_context(p_user_id,p_business_id);
  if v_business->>'role'='owner' then
    select coalesce(jsonb_agg(jsonb_build_object('id',online.id,'name',online.name,'lastSeenAt',online.last_seen_at)
      order by online.name,online.id),'[]'::jsonb)
      into v_connected
      from (
        select e.id,e.name,max(activity.last_seen_at) as last_seen_at
        from app_private.employees e
        join lateral (
          select s.last_seen_at from app_private.operator_sessions s
            where s.business_id=e.business_id and s.user_id=e.user_id and s.revoked_at is null
              and s.expires_at>clock_timestamp() and s.last_seen_at>=clock_timestamp()-interval '90 seconds'
          union all
          select s.last_seen_at from app_private.device_operator_sessions s
            where s.business_id=e.business_id and s.employee_id=e.id and s.revoked_at is null
              and s.expires_at>clock_timestamp() and s.last_seen_at>=clock_timestamp()-interval '90 seconds'
        ) activity on true
        where e.business_id=p_business_id and e.active and e.role<>'owner'
        group by e.id,e.name
      ) online;
    v_business:=v_business||jsonb_build_object('connectedEmployees',v_connected);
  end if;
  return jsonb_build_object('data',jsonb_build_object('business',v_business,'expiresAt',v_expires));
end;
$$;

-- The existing device-context path retains all pairing, link, expiry and revocation checks.
create or replace function public.account_device(p_action text,p_payload jsonb)
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
  elsif p_action='device_context' and v_result ? 'data' then
    update app_private.device_operator_sessions set last_seen_at=clock_timestamp()
      where token_hash=extensions.digest(p_payload->>'operatorToken','sha256') and revoked_at is null
        and expires_at>clock_timestamp() and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds');
  end if;
  return v_result;
end;
$$;

revoke all on function public.account_context(uuid,uuid,uuid,text),public.account_device(text,jsonb) from public,anon,authenticated;
grant execute on function public.account_context(uuid,uuid,uuid,text),public.account_device(text,jsonb) to service_role;
