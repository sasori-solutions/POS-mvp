-- OAuth can finish after a remote token exchange. Reauthorize the original
-- account/operator in the same transaction that persists its connection.
alter function public.point_service(text,jsonb) rename to point_service_before_oauth_completion;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare st app_private.point_oauth_states%rowtype; response jsonb;
begin
 if p_action='oauth_connection_save' then
  if p_payload->>'stateHash' is null or p_payload->>'stateHash' !~ '^[0-9a-f]{64}$' then raise exception 'POINT_OAUTH_INVALID'; end if;
  select * into st from app_private.point_oauth_states where state_hash=decode(p_payload->>'stateHash','hex') for update;
  if not found or st.consumed_at is null or st.pkce_ciphertext is null or st.expires_at<=clock_timestamp()
   or st.business_id is distinct from (p_payload->>'businessId')::uuid
   or st.user_id is distinct from (p_payload->>'userId')::uuid
   or st.auth_session_id is distinct from (p_payload->>'authSessionId')::uuid
   or st.redirect_uri is distinct from p_payload->>'redirectUri'
   or st.environment is distinct from p_payload->>'environment' then raise exception 'POINT_OAUTH_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('point-connection:'||st.business_id::text,0));
  -- Recheck after the mutex wait. Share locks serialize the final write with
  -- Auth logout, operator lock and employee/membership revocation.
  perform 1 from auth.sessions s where s.id=st.auth_session_id and s.user_id=st.user_id for share;
  perform 1 from app_private.employees e where e.business_id=st.business_id and e.user_id=st.user_id for share;
  perform 1 from app_private.business_memberships m where m.business_id=st.business_id and m.user_id=st.user_id for share;
  perform 1 from app_private.operator_sessions o where o.business_id=st.business_id and o.user_id=st.user_id
   and o.auth_session_id=st.auth_session_id and o.token_hash=extensions.digest(p_payload->>'operatorToken','sha256') for share;
  perform app_private.assert_owner_operator(st.user_id,st.auth_session_id,st.business_id,p_payload->>'operatorToken');
  -- A slower older callback must not replace a more recent completed connection.
  if exists(select 1 from app_private.point_oauth_states newer where newer.business_id=st.business_id
   and newer.state_hash<>st.state_hash and newer.created_at>=st.created_at
   and newer.consumed_at is not null and newer.pkce_ciphertext is null) then
   raise exception 'POINT_OAUTH_INVALID';
  end if;
  response:=public.point_service_before_oauth_completion('connection_save',p_payload);
  -- Clearing the verifier marks successful completion and prevents a second save.
  update app_private.point_oauth_states set pkce_ciphertext=null where state_hash=st.state_hash;
  return response;
 end if;
 return public.point_service_before_oauth_completion(p_action,p_payload);
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_oauth_completion(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_oauth_completion(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;

-- Orders GET accepts orders created less than three calendar months ago. Bound
-- periodic auditing of already confirmed sales to that API window. An unresolved
-- attempt keeps reconciliation indefinitely and never expires locally.
do $$
declare definition text;
 needle text := $old$where pa.state in ('pending','sent_to_terminal','processing','unknown_review','partially_refunded','approved_verified') and (pa.observed_at is null or pa.observed_at<clock_timestamp()-interval '5 minutes')$old$;
begin
 definition:=pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure);
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then
  raise exception 'Point audit source changed; review the migration before applying';
 end if;
 definition:=replace(definition,needle,$new$where (pa.state in ('pending','sent_to_terminal','processing','unknown_review')
  and (pa.observed_at is null or pa.observed_at<clock_timestamp()-interval '5 minutes'))
  or (pa.state in ('partially_refunded','approved_verified') and pa.created_at>clock_timestamp()-interval '3 months'
   and coalesce(pa.last_reconciled_at,pa.observed_at,pa.created_at)<clock_timestamp()-interval '5 minutes')$new$);
 execute definition;
end $$;
