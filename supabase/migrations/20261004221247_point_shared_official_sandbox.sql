-- The server-owned virtual receiver is shared by dedicated test businesses.
-- OAuth receivers (including OAuth sandbox) retain the one-business boundary.
alter table app_private.point_connections add column official_sandbox boolean not null default false;
update app_private.point_connections c set official_sandbox=true
 where c.environment='sandbox' and exists(select 1 from app_private.point_sandbox_businesses sb where sb.business_id=c.business_id);
alter table app_private.point_connections add constraint point_official_sandbox_environment check(not official_sandbox or environment='sandbox');
alter table app_private.point_connections drop constraint point_connections_receiver_id_environment_key;
create unique index point_oauth_receiver_unique on app_private.point_connections(receiver_id,environment) where not official_sandbox;
create unique index point_official_receiver_per_business on app_private.point_connections(business_id,receiver_id,environment) where official_sandbox;

create function app_private.point_official_connection_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.official_sandbox is distinct from old.official_sandbox then raise exception 'POINT_STATE_INVALID'; end if;
 if new.official_sandbox and (new.environment<>'sandbox' or not exists(select 1 from app_private.point_sandbox_businesses where business_id=new.business_id)) then raise exception 'POINT_STATE_INVALID'; end if;
 return new;
end $$;
create trigger point_official_connection_guard before insert or update on app_private.point_connections for each row execute function app_private.point_official_connection_guard();
revoke all on function app_private.point_official_connection_guard() from public,anon,authenticated;

alter function public.point_service(text,jsonb) rename to point_service_before_shared_sandbox;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare con app_private.point_connections%rowtype; auth_result jsonb; b uuid:=(p_payload->>'businessId')::uuid;
begin
 if p_action='connection_save' then
  -- Serialize the ordinary and official paths for this receiver. A virtual
  -- connection can never be overwritten with an OAuth credential.
  perform pg_advisory_xact_lock(hashtextextended('point-receiver:'||(p_payload->>'environment')||':'||(p_payload->>'receiverId'),0));
  if exists(select 1 from app_private.point_connections where receiver_id=p_payload->>'receiverId' and environment=p_payload->>'environment' and official_sandbox) then raise exception 'POINT_FACT_MISMATCH'; end if;
 elsif p_action='official_sandbox_connect' then
  -- Preserve the live Auth/operator recheck after provider I/O, before writing.
  auth_result:=public.point_execute((p_payload->>'userId')::uuid,(p_payload->>'authSessionId')::uuid,b,p_payload->>'operatorToken',
   jsonb_build_object('command','connect_sandbox','operationId',p_payload->>'operationId'));
  if auth_result ? 'error' then return auth_result; end if;
  lock table app_private.sales in share row exclusive mode;
  perform 1 from app_private.businesses where id=b for update;
  perform pg_advisory_xact_lock(hashtextextended('point-receiver:sandbox:'||(p_payload->>'receiverId'),0));
  if not exists(select 1 from app_private.point_sandbox_businesses where business_id=b) and
   (exists(select 1 from app_private.sales where business_id=b) or exists(select 1 from app_private.point_attempts where business_id=b) or exists(select 1 from app_private.point_connections where business_id=b and environment='live')) then raise exception 'POINT_STATE_INVALID'; end if;
  if exists(select 1 from app_private.point_connections where receiver_id=p_payload->>'receiverId' and environment='sandbox' and not official_sandbox) then raise exception 'POINT_FACT_MISMATCH'; end if;
  insert into app_private.point_sandbox_businesses(business_id,enrolled_by) values(b,(auth_result#>>'{data,backendDirective,employeeId}')::uuid) on conflict do nothing;
  select * into con from app_private.point_connections where business_id=b and receiver_id=p_payload->>'receiverId' and environment='sandbox' and official_sandbox for update;
  if not found then
   update app_private.point_connections set status='reconnect_required' where business_id=b and status='connected';
   insert into app_private.point_connections(business_id,receiver_id,environment,status,tokens_ciphertext,expires_at,verified_at,official_sandbox)
    values(b,p_payload->>'receiverId','sandbox','connected',p_payload->>'tokensCiphertext',(p_payload->>'expiresAt')::timestamptz,clock_timestamp(),true) returning * into con;
  else
   update app_private.point_connections set status='reconnect_required' where business_id=b and id<>con.id and status='connected';
   update app_private.point_connections set status='connected',tokens_ciphertext=p_payload->>'tokensCiphertext',expires_at=(p_payload->>'expiresAt')::timestamptz,
    verified_at=clock_timestamp(),token_version=token_version+1,refresh_lease_token=null,refresh_lease_until=null where id=con.id returning * into con;
  end if;
  perform public.point_service_before_shared_sandbox('terminal_save',jsonb_build_object('connectionId',con.id,'terminalId','NEWLAND_N950__SBX0000001','serial','SBX0000001',
   'storeId','sandbox','posId','sandbox','branchName','Pruebas','registerName','Terminal virtual','mode','PDV','verified',true,'physicallyConfirmed',true));
  return jsonb_build_object('connected',true);
 end if;
 return public.point_service_before_shared_sandbox(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_shared_sandbox(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_shared_sandbox(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;
