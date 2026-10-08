-- Owner browser sessions are bound by 20261007110000_device_visibility.sql.
-- Point's provider I/O and settings refresh use separate RPC transactions. Carry
-- Edge's already verified hash through service-role-only wrappers, then restore
-- the caller's transaction context on success and failure. Public signatures and
-- all original live actor/state checks remain unchanged; browser JSON rejects the
-- private serverDeviceKeyHash field.
alter function public.point_execute(uuid,uuid,uuid,text,jsonb) rename to point_execute_before_verified_browser;
alter function public.point_execute_before_verified_browser(uuid,uuid,uuid,text,jsonb) set schema app_private;

create function public.point_execute(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_previous text:=current_setting('app.employee_device_key',true); v_result jsonb; v_key text;
begin
  if p_payload ? 'serverDeviceKeyHash' then
    v_key:=p_payload->>'serverDeviceKeyHash';
    if jsonb_typeof(p_payload->'serverDeviceKeyHash') is distinct from 'string' or v_key !~ '^[0-9a-f]{64}$' then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    perform set_config('app.employee_device_key',v_key,true);
  end if;
  begin
    v_result:=app_private.point_execute_before_verified_browser(p_user_id,p_auth_session_id,p_business_id,p_operator_token,p_payload-'serverDeviceKeyHash');
  exception when others then
    perform set_config('app.employee_device_key',coalesce(v_previous,''),true);
    raise;
  end;
  perform set_config('app.employee_device_key',coalesce(v_previous,''),true);
  return v_result;
end $$;

alter function public.point_service(text,jsonb) rename to point_service_before_verified_browser;
alter function public.point_service_before_verified_browser(text,jsonb) set schema app_private;

create function public.point_service(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_previous text:=current_setting('app.employee_device_key',true); v_result jsonb; v_key text;
begin
  if p_payload ? 'serverDeviceKeyHash' then
    v_key:=p_payload->>'serverDeviceKeyHash';
    if jsonb_typeof(p_payload->'serverDeviceKeyHash') is distinct from 'string' or v_key !~ '^[0-9a-f]{64}$' then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    perform set_config('app.employee_device_key',v_key,true);
  end if;
  begin
    v_result:=app_private.point_service_before_verified_browser(p_action,p_payload-'serverDeviceKeyHash');
  exception when others then
    perform set_config('app.employee_device_key',coalesce(v_previous,''),true);
    raise;
  end;
  perform set_config('app.employee_device_key',coalesce(v_previous,''),true);
  return v_result;
end $$;

revoke all on function app_private.point_execute_before_verified_browser(uuid,uuid,uuid,text,jsonb),app_private.point_service_before_verified_browser(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.point_execute(uuid,uuid,uuid,text,jsonb),public.point_service(text,jsonb) from public,anon,authenticated;
grant execute on function public.point_execute(uuid,uuid,uuid,text,jsonb),public.point_service(text,jsonb) to service_role;
