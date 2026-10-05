-- Serialize authorization with Auth logout/session revocation. A financial
-- mutation that already holds this share lock commits before logout completes;
-- a revocation that wins the row lock prevents the mutation from being accepted.
-- Preserve the existing identity, Google/device, tenant and permission checks.
create or replace function app_private.assert_live_auth(p_user_id uuid,p_auth_session_id uuid)
returns void language plpgsql set search_path='' as $$
declare expires_at timestamptz;
begin
  if p_user_id is null or p_auth_session_id is null then
    raise exception 'AUTH_REQUIRED' using errcode='P0001';
  end if;
  select s.not_after into expires_at from auth.sessions s
    where s.id=p_auth_session_id and s.user_id=p_user_id for share;
  -- clock_timestamp is evaluated after a possible lock wait, not at BEGIN.
  if not found or expires_at is not null and expires_at<=clock_timestamp() then
    raise exception 'AUTH_REQUIRED' using errcode='P0001';
  end if;
end $$;
