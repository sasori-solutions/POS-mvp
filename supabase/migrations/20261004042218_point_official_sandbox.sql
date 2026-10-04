-- Official provider sandbox is permanently confined to an explicitly enrolled,
-- empty business. It never enables the local HTTP simulator on a hosted backend.
create table app_private.point_sandbox_businesses (
 business_id uuid primary key references app_private.businesses(id) on delete cascade,
 enrolled_by uuid references app_private.employees(id) on delete set null,
 enrolled_at timestamptz not null default clock_timestamp()
);
alter table app_private.point_sandbox_businesses enable row level security;
revoke all on app_private.point_sandbox_businesses from public,anon,authenticated;

create function app_private.point_sandbox_connection_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if new.environment='live' and exists(select 1 from app_private.point_sandbox_businesses where business_id=new.business_id) then raise exception 'POINT_STATE_INVALID'; end if;
 return new;
end $$;
create trigger point_sandbox_connection_guard before insert or update on app_private.point_connections for each row execute function app_private.point_sandbox_connection_guard();
revoke all on function app_private.point_sandbox_connection_guard() from public,anon,authenticated;

alter function app_private.point_settings_json(uuid,uuid) rename to point_settings_json_before_official_sandbox;
create function app_private.point_settings_json(p_business uuid,p_employee uuid) returns jsonb language sql stable set search_path='' as $$
 select app_private.point_settings_json_before_official_sandbox(p_business,p_employee)||jsonb_build_object('sandbox',jsonb_build_object('available',false,
 'official',exists(select 1 from app_private.point_sandbox_businesses sb join app_private.point_connections c on c.business_id=sb.business_id where sb.business_id=p_business and c.status='connected' and c.environment='sandbox'),
 'testBusiness',exists(select 1 from app_private.point_sandbox_businesses where business_id=p_business)))
$$;
revoke all on function app_private.point_settings_json(uuid,uuid) from public,anon,authenticated;

alter function app_private.point_command(uuid,uuid,jsonb) rename to point_command_before_official_sandbox;
create function app_private.point_command(p_business uuid,p_employee uuid,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare e app_private.employees%rowtype; c app_private.point_checkouts%rowtype; a app_private.point_attempts%rowtype; con app_private.point_connections%rowtype; cmd text:=p->>'command';
begin
 if cmd not in ('connect_sandbox','simulate') then
  if cmd='oauth_start' and exists(select 1 from app_private.point_sandbox_businesses where business_id=p_business) then raise exception 'POINT_STATE_INVALID'; end if;
  return app_private.point_command_before_official_sandbox(p_business,p_employee,p);
 end if;
 -- Existing entrypoints validate live Auth/operator/device sessions before this function.
 perform app_private.point_command_before_official_sandbox(p_business,p_employee,jsonb_build_object('command','settings'));
 select * into e from app_private.employees where business_id=p_business and id=p_employee and active and deleted_at is null;
 if not found or e.role<>'owner' or e.user_id is null or coalesce(current_setting('app.point_session_kind',true),'')<>'personal' then raise exception 'PERMISSION_DENIED'; end if;
 if cmd='connect_sandbox' then
  perform app_private.ops_exact(p,array['command','operationId']); perform app_private.ops_uuid(p->'operationId');
  if not exists(select 1 from app_private.point_sandbox_businesses where business_id=p_business) and
   (exists(select 1 from app_private.sales where business_id=p_business) or exists(select 1 from app_private.point_attempts where business_id=p_business) or exists(select 1 from app_private.point_connections where business_id=p_business and environment='live')) then raise exception 'POINT_STATE_INVALID'; end if;
  return jsonb_build_object('data',jsonb_build_object('backendDirective',jsonb_build_object('kind',cmd,'businessId',p_business,'employeeId',p_employee)));
 end if;
 perform app_private.ops_exact(p,array['command','checkoutId','status']);
 if p->>'status' not in ('processed','failed','canceled','expired','action_required') then raise exception 'VALIDATION_ERROR'; end if;
 select * into c from app_private.point_checkouts where business_id=p_business and id=app_private.ops_uuid(p->'checkoutId') for update;
 if not found then raise exception 'POINT_CHECKOUT_NOT_FOUND'; end if;
 select * into a from app_private.point_attempts where business_id=p_business and id=c.active_attempt_id;
 select * into con from app_private.point_connections where business_id=p_business and id=a.connection_id;
 if not exists(select 1 from app_private.point_sandbox_businesses where business_id=p_business) or con.environment is distinct from 'sandbox' or con.status is distinct from 'connected' or a.environment is distinct from 'sandbox'
  or a.terminal_id is distinct from 'NEWLAND_N950__SBX0000001' or a.remote_order_id is null or a.sale_state='materialized' or a.state not in ('pending','sent_to_terminal','processing','unknown_review') then raise exception 'POINT_STATE_INVALID'; end if;
 return jsonb_build_object('data',jsonb_build_object('backendDirective',jsonb_build_object('kind',cmd,'businessId',p_business,'connectionId',con.id,'remoteOrderId',a.remote_order_id,'employeeId',p_employee)));
end $$;
revoke all on function app_private.point_command(uuid,uuid,jsonb) from public,anon,authenticated;

alter function public.point_service(text,jsonb) rename to point_service_before_official_sandbox;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare con jsonb; auth_result jsonb; b uuid:=(p_payload->>'businessId')::uuid;
begin
 if p_action in ('official_sandbox_connect','official_sandbox_authorize') then
  -- Re-authorize after provider I/O: logout/revocation must not finish enrollment or simulation.
  auth_result:=public.point_execute((p_payload->>'userId')::uuid,(p_payload->>'authSessionId')::uuid,b,p_payload->>'operatorToken',
   case when p_action='official_sandbox_connect' then jsonb_build_object('command','connect_sandbox','operationId',p_payload->>'operationId')
   else jsonb_build_object('command','simulate','checkoutId',p_payload->>'checkoutId','status',p_payload->>'status') end);
  if auth_result ? 'error' then return auth_result; end if;
  if p_action='official_sandbox_authorize' then return auth_result; end if;
  -- Briefly block sale inserts while enrolling so the empty-business check cannot race a cash sale.
  lock table app_private.sales in share row exclusive mode;
  perform 1 from app_private.businesses where id=b for update;
  if not exists(select 1 from app_private.point_sandbox_businesses where business_id=b) and
   (exists(select 1 from app_private.sales where business_id=b) or exists(select 1 from app_private.point_attempts where business_id=b) or exists(select 1 from app_private.point_connections where business_id=b and environment='live')) then raise exception 'POINT_STATE_INVALID'; end if;
  insert into app_private.point_sandbox_businesses(business_id,enrolled_by) values(b,(auth_result#>>'{data,backendDirective,employeeId}')::uuid) on conflict do nothing;
  con:=public.point_service_before_official_sandbox('connection_save',p_payload||jsonb_build_object('environment','sandbox'));
  perform public.point_service_before_official_sandbox('terminal_save',jsonb_build_object('connectionId',con->>'id','terminalId','NEWLAND_N950__SBX0000001','serial','SBX0000001','storeId','sandbox','posId','sandbox','branchName','Pruebas','registerName','Terminal virtual','mode','PDV','verified',true,'physicallyConfirmed',true));
  return jsonb_build_object('connected',true);
 end if;
 return public.point_service_before_official_sandbox(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_official_sandbox(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_official_sandbox(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;
