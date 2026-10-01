-- Agente de Larios. Private tenant data; the account Edge Function is the sole browser entry point.
create schema if not exists app_private;
create extension if not exists pgcrypto with schema extensions;
revoke all on schema app_private from public, anon, authenticated;

create table app_private.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  business_type text not null check (business_type in ('cafe', 'restaurant', 'other')),
  timezone text not null,
  currency text not null default 'MXN' check (currency = 'MXN'),
  created_at timestamptz not null default now()
);

create table app_private.business_memberships (
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role = 'owner'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_memberships_user_idx on app_private.business_memberships(user_id) where active;

create table app_private.operator_credentials (
  business_id uuid not null,
  user_id uuid not null,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id),
  foreign key (business_id, user_id) references app_private.business_memberships(business_id, user_id) on delete cascade
);

create table app_private.operator_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  user_id uuid not null,
  auth_session_id uuid not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '8 hours'),
  revoked_at timestamptz,
  foreign key (business_id, user_id) references app_private.business_memberships(business_id, user_id) on delete cascade
);
create index operator_sessions_actor_idx on app_private.operator_sessions(user_id, auth_session_id, business_id) where revoked_at is null;

create table app_private.business_create_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload_fingerprint bytea not null,
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

create table app_private.account_audit_events (
  id bigint generated always as identity primary key,
  business_id uuid references app_private.businesses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  auth_session_id uuid,
  event text not null check (event in (
    'business_created', 'pin_unlock_succeeded', 'pin_unlock_failed',
    'pin_lockout', 'operator_locked', 'operator_sessions_revoked'
  )),
  occurred_at timestamptz not null default now()
);
create index account_audit_events_business_idx on app_private.account_audit_events(business_id, occurred_at);

alter table app_private.businesses enable row level security;
alter table app_private.business_memberships enable row level security;
alter table app_private.operator_credentials enable row level security;
alter table app_private.operator_sessions enable row level security;
alter table app_private.business_create_operations enable row level security;
alter table app_private.account_audit_events enable row level security;
revoke all on all tables in schema app_private from public, anon, authenticated;
revoke all on all sequences in schema app_private from public, anon, authenticated;

create function app_private.assert_live_auth(p_user_id uuid, p_auth_session_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_user_id is null or p_auth_session_id is null or not exists (
    select 1 from auth.sessions s where s.id = p_auth_session_id and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
  ) then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
end;
$$;

create function app_private.assert_owner(p_user_id uuid, p_business_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from app_private.business_memberships m
    where m.business_id = p_business_id and m.user_id = p_user_id and m.active and m.role = 'owner'
  ) then
    raise exception 'BUSINESS_ACCESS_DENIED' using errcode = 'P0001';
  end if;
end;
$$;

create function app_private.business_context(p_user_id uuid, p_business_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare v_business jsonb;
begin
  perform app_private.assert_owner(p_user_id, p_business_id);
  select jsonb_build_object(
    'id', b.id, 'name', b.name, 'businessType', b.business_type,
    'timezone', b.timezone, 'currency', b.currency,
    'role', 'owner', 'createdAt', b.created_at
  ) into v_business from app_private.businesses b where b.id = p_business_id;
  return v_business;
end;
$$;

-- Returns expected failures instead of raising: raising would roll back the failure counter.
-- The row lock serializes simultaneous PIN attempts, including creation replays.
create function app_private.verify_pin(p_user_id uuid, p_auth_session_id uuid, p_business_id uuid, p_pin text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_credential app_private.operator_credentials%rowtype;
  v_attempts integer;
  v_locked_until timestamptz;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    raise exception 'VALIDATION_ERROR' using errcode = 'P0001';
  end if;
  perform app_private.assert_owner(p_user_id, p_business_id);
  select * into v_credential from app_private.operator_credentials
    where business_id = p_business_id and user_id = p_user_id for update;
  if not found then
    raise exception 'BUSINESS_ACCESS_DENIED' using errcode = 'P0001';
  end if;
  if v_credential.locked_until > clock_timestamp() then
    return jsonb_build_object('error', jsonb_build_object(
      'code', 'PIN_LOCKED', 'message', 'Too many PIN attempts. Try again later.',
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from v_credential.locked_until - clock_timestamp()))::integer)
    ));
  end if;
  if extensions.crypt(p_pin, v_credential.pin_hash) <> v_credential.pin_hash then
    v_attempts := case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts + 1 end;
    if v_attempts >= 5 then
      v_locked_until := clock_timestamp() + interval '15 minutes';
    end if;
    update app_private.operator_credentials set failed_attempts = v_attempts, locked_until = v_locked_until
      where business_id = p_business_id and user_id = p_user_id;
    insert into app_private.account_audit_events(business_id, user_id, auth_session_id, event)
      values(p_business_id, p_user_id, p_auth_session_id, case when v_attempts >= 5 then 'pin_lockout' else 'pin_unlock_failed' end);
    if v_attempts >= 5 then
      return jsonb_build_object('error', jsonb_build_object('code', 'PIN_LOCKED',
        'message', 'Too many PIN attempts. Try again later.', 'retryAfterSeconds', 900));
    end if;
    return jsonb_build_object('error', jsonb_build_object('code', 'PIN_INVALID', 'message', 'The PIN is incorrect.'));
  end if;
  update app_private.operator_credentials set failed_attempts = 0, locked_until = null
    where business_id = p_business_id and user_id = p_user_id;
  return null;
end;
$$;

create function app_private.issue_operator_session(p_user_id uuid, p_auth_session_id uuid, p_business_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires_at timestamptz := clock_timestamp() + interval '8 hours';
begin
  -- A retry gets a usable fresh token; an earlier lost response cannot retain another active session.
  update app_private.operator_sessions set revoked_at = clock_timestamp()
    where user_id = p_user_id and auth_session_id = p_auth_session_id and business_id = p_business_id and revoked_at is null;
  insert into app_private.operator_sessions(business_id, user_id, auth_session_id, token_hash, expires_at)
    values(p_business_id, p_user_id, p_auth_session_id, extensions.digest(v_token, 'sha256'), v_expires_at);
  insert into app_private.account_audit_events(business_id, user_id, auth_session_id, event)
    values(p_business_id, p_user_id, p_auth_session_id, 'pin_unlock_succeeded');
  return jsonb_build_object('data', jsonb_build_object(
    'business', app_private.business_context(p_user_id, p_business_id),
    'operatorToken', v_token, 'expiresAt', v_expires_at
  ));
end;
$$;

create function public.account_status(p_user_id uuid, p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_businesses jsonb;
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'businessType', b.business_type)
    order by b.created_at, b.id), '[]'::jsonb) into v_businesses
    from app_private.businesses b join app_private.business_memberships m on m.business_id = b.id
    where m.user_id = p_user_id and m.active and m.role = 'owner';
  return jsonb_build_object('data', jsonb_build_object('businesses', v_businesses));
end;
$$;

create function public.account_create_business(
  p_user_id uuid, p_auth_session_id uuid, p_name text,
  p_business_type text, p_timezone text, p_operation_id uuid, p_pin text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(regexp_replace(p_name, '[[:space:]]+', ' ', 'g'));
  v_fingerprint bytea;
  v_operation app_private.business_create_operations%rowtype;
  v_business_id uuid;
  v_pin_result jsonb;
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  if p_name is null or p_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    or char_length(v_name) not between 2 and 100
    or p_business_type is null or p_business_type not in ('cafe', 'restaurant', 'other')
    or p_timezone is null or char_length(p_timezone) > 100
    or p_timezone !~ '^[A-Za-z_]+/[A-Za-z_+-]+(/[A-Za-z_+-]+)?$'
    or not exists(select 1 from pg_catalog.pg_timezone_names where name = p_timezone)
    or p_operation_id is null or p_pin is null or p_pin !~ '^[0-9]{6}$'
  then
    raise exception 'VALIDATION_ERROR' using errcode = 'P0001';
  end if;
  -- No deterministic digest of a six-digit secret is stored. The existing salted bcrypt verifies PIN equality on replay.
  v_fingerprint := extensions.digest(jsonb_build_object('name', v_name,
    'businessType', p_business_type, 'timezone', p_timezone)::text, 'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || p_operation_id::text, 0));
  select * into v_operation from app_private.business_create_operations
    where user_id = p_user_id and operation_id = p_operation_id;
  if found then
    if v_operation.payload_fingerprint <> v_fingerprint then
      raise exception 'OPERATION_CONFLICT' using errcode = 'P0001';
    end if;
    v_pin_result := app_private.verify_pin(p_user_id, p_auth_session_id, v_operation.business_id, p_pin);
    if v_pin_result is not null then
      if v_pin_result #>> '{error,code}' = 'PIN_INVALID' then
        return jsonb_build_object('error', jsonb_build_object('code', 'OPERATION_CONFLICT',
          'message', 'The operation was already used with different details.'));
      end if;
      return v_pin_result;
    end if;
    return app_private.issue_operator_session(p_user_id, p_auth_session_id, v_operation.business_id);
  end if;
  insert into app_private.businesses(name, business_type, timezone)
    values(v_name, p_business_type, p_timezone) returning id into v_business_id;
  insert into app_private.business_memberships(business_id, user_id) values(v_business_id, p_user_id);
  insert into app_private.operator_credentials(business_id, user_id, pin_hash)
    values(v_business_id, p_user_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)));
  insert into app_private.business_create_operations(user_id, operation_id, payload_fingerprint, business_id)
    values(p_user_id, p_operation_id, v_fingerprint, v_business_id);
  insert into app_private.account_audit_events(business_id, user_id, auth_session_id, event)
    values(v_business_id, p_user_id, p_auth_session_id, 'business_created');
  return app_private.issue_operator_session(p_user_id, p_auth_session_id, v_business_id);
end;
$$;

create function public.account_unlock(p_user_id uuid, p_auth_session_id uuid, p_business_id uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pin_result jsonb;
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  v_pin_result := app_private.verify_pin(p_user_id, p_auth_session_id, p_business_id, p_pin);
  if v_pin_result is not null then return v_pin_result; end if;
  return app_private.issue_operator_session(p_user_id, p_auth_session_id, p_business_id);
end;
$$;

create function public.account_context(p_user_id uuid, p_auth_session_id uuid, p_business_id uuid, p_operator_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session app_private.operator_sessions%rowtype;
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  perform app_private.assert_owner(p_user_id, p_business_id);
  if p_operator_token is null or p_operator_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SESSION_INVALID' using errcode = 'P0001';
  end if;
  select * into v_session from app_private.operator_sessions where token_hash = extensions.digest(p_operator_token, 'sha256')
    and business_id = p_business_id and user_id = p_user_id and auth_session_id = p_auth_session_id;
  if not found or v_session.revoked_at is not null then
    raise exception 'SESSION_INVALID' using errcode = 'P0001';
  end if;
  if v_session.expires_at <= clock_timestamp() then
    raise exception 'SESSION_EXPIRED' using errcode = 'P0001';
  end if;
  return jsonb_build_object('data', jsonb_build_object(
    'business', app_private.business_context(p_user_id, p_business_id), 'expiresAt', v_session.expires_at
  ));
end;
$$;

create function public.account_lock(p_user_id uuid, p_auth_session_id uuid, p_business_id uuid, p_operator_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  perform app_private.assert_owner(p_user_id, p_business_id);
  if p_operator_token is null or p_operator_token !~ '^[0-9a-f]{64}$' then
    raise exception 'SESSION_INVALID' using errcode = 'P0001';
  end if;
  update app_private.operator_sessions set revoked_at = clock_timestamp()
    where token_hash = extensions.digest(p_operator_token, 'sha256') and business_id = p_business_id
    and user_id = p_user_id and auth_session_id = p_auth_session_id and revoked_at is null;
  if found then
    insert into app_private.account_audit_events(business_id, user_id, auth_session_id, event)
      values(p_business_id, p_user_id, p_auth_session_id, 'operator_locked');
  end if;
  return jsonb_build_object('data', jsonb_build_object('locked', true));
end;
$$;

create function public.account_revoke_sessions(p_user_id uuid, p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_live_auth(p_user_id, p_auth_session_id);
  update app_private.operator_sessions set revoked_at = clock_timestamp()
    where user_id = p_user_id and auth_session_id = p_auth_session_id and revoked_at is null;
  insert into app_private.account_audit_events(user_id, auth_session_id, event)
    values(p_user_id, p_auth_session_id, 'operator_sessions_revoked');
  return jsonb_build_object('data', jsonb_build_object('revoked', true));
end;
$$;

-- Postgres functions normally grant EXECUTE to PUBLIC. Revoke explicitly before the transaction commits.
revoke all on all functions in schema app_private from public, anon, authenticated;
revoke all on function public.account_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.account_create_business(uuid, uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.account_unlock(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.account_context(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.account_lock(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.account_revoke_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_status(uuid, uuid) to service_role;
grant execute on function public.account_create_business(uuid, uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.account_unlock(uuid, uuid, uuid, text) to service_role;
grant execute on function public.account_context(uuid, uuid, uuid, text) to service_role;
grant execute on function public.account_lock(uuid, uuid, uuid, text) to service_role;
grant execute on function public.account_revoke_sessions(uuid, uuid) to service_role;
