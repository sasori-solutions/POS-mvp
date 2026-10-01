-- Agente de Larios, 2026-10-01. Progressive setup, staff membership and restricted shared registers.
alter table app_private.businesses add column profile jsonb not null default
  '{"branchName":"Sucursal principal","registerName":"Caja 1","address":"","city":"","state":"","contactPhone":"","paymentMethods":["cash"]}'::jsonb;
alter table app_private.business_memberships drop constraint business_memberships_role_check;
alter table app_private.business_memberships add constraint business_memberships_role_check check (role in ('owner','manager','cashier','kitchen'));
alter table app_private.account_audit_events drop constraint account_audit_events_event_check;
alter table app_private.account_audit_events add constraint account_audit_events_event_check check (event in (
  'business_created','pin_unlock_succeeded','pin_unlock_failed','pin_lockout','operator_locked','operator_sessions_revoked',
  'business_updated','employee_created','employee_updated','invitation_created','invitation_revoked','invitation_accepted',
  'pairing_created','device_paired','device_revoked','pin_reset'
));

create table app_private.employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 100),
  role text not null check (role in ('owner','manager','cashier','kitchen')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id,id), unique (business_id,user_id)
);
-- Personal identities use the original credential row, so all PIN entry points share its lockout counter.
create table app_private.shared_employee_credentials (
  business_id uuid not null,
  employee_id uuid not null,
  pin_hash text not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_until timestamptz,
  primary key (business_id,employee_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
insert into app_private.employees(business_id,user_id,name,role,active)
  select business_id,user_id,'Dueño',role,active from app_private.business_memberships;

create table app_private.employee_create_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  business_id uuid not null,
  payload_fingerprint bytea not null,
  employee_id uuid not null,
  primary key (user_id,operation_id),
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
create table app_private.business_invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  payload_fingerprint bytea not null,
  name text not null,
  role text not null check (role in ('manager','cashier','kitchen')),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  accepted_by uuid references auth.users(id) on delete cascade,
  accepted_operation_id uuid,
  accepted_fingerprint bytea,
  accepted_employee_id uuid,
  accepted_at timestamptz,
  unique(created_by,operation_id),
  foreign key (business_id,accepted_employee_id) references app_private.employees(business_id,id) on delete cascade
);
create table app_private.devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 100),
  register_name text not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz,
  unique (business_id,id)
);
create table app_private.device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  paired_device_id uuid,
  paired_operation_id uuid,
  paired_name text,
  unique(created_by,operation_id),
  foreign key (business_id,paired_device_id) references app_private.devices(business_id,id) on delete cascade
);
create table app_private.device_operator_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  device_id uuid not null,
  employee_id uuid not null,
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '8 hours'),
  revoked_at timestamptz,
  foreign key (business_id,device_id) references app_private.devices(business_id,id) on delete cascade,
  foreign key (business_id,employee_id) references app_private.employees(business_id,id) on delete cascade
);
create index device_operator_sessions_device_idx on app_private.device_operator_sessions(device_id) where revoked_at is null;

alter table app_private.employees enable row level security;
alter table app_private.shared_employee_credentials enable row level security;
alter table app_private.employee_create_operations enable row level security;
alter table app_private.business_invitations enable row level security;
alter table app_private.devices enable row level security;
alter table app_private.device_pairing_codes enable row level security;
alter table app_private.device_operator_sessions enable row level security;
revoke all on all tables in schema app_private from public,anon,authenticated;
revoke all on all sequences in schema app_private from public,anon,authenticated;

create function app_private.validate_profile(p_profile jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_key text; v_value text; v_methods jsonb;
begin
  if p_profile is null then
    return '{"branchName":"Sucursal principal","registerName":"Caja 1","address":"","city":"","state":"","contactPhone":"","paymentMethods":["cash"]}'::jsonb;
  end if;
  if jsonb_typeof(p_profile) <> 'object' or (select count(*) from jsonb_object_keys(p_profile)) <> 7
    or not p_profile ?& array['branchName','registerName','address','city','state','contactPhone','paymentMethods'] then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  foreach v_key in array array['branchName','registerName','address','city','state','contactPhone'] loop
    v_value := p_profile->>v_key;
    if jsonb_typeof(p_profile->v_key) <> 'string' or v_value ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      or char_length(v_value) > (case when v_key='address' then 300 when v_key='contactPhone' then 30 else 100 end) then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    p_profile := jsonb_set(p_profile,array[v_key],to_jsonb(btrim(regexp_replace(v_value,'[[:space:]]+',' ','g'))));
  end loop;
  if p_profile->>'branchName' = '' or p_profile->>'registerName' = '' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_profile->>'contactPhone' <> '' and p_profile->>'contactPhone' !~ '^[+0-9() -]{5,30}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_methods := p_profile->'paymentMethods';
  if jsonb_typeof(v_methods) <> 'array' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if jsonb_array_length(v_methods)<1 or jsonb_array_length(v_methods)>3 or exists(select 1 from jsonb_array_elements(v_methods) m where jsonb_typeof(m)<>'string' or m#>>'{}' not in ('cash','card_external','transfer'))
    or (select count(distinct m) from jsonb_array_elements(v_methods) m) <> jsonb_array_length(v_methods) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  return p_profile;
end;
$$;
create function app_private.assert_member(p_user_id uuid,p_business_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from app_private.business_memberships m join app_private.employees e
    on e.business_id=m.business_id and e.user_id=m.user_id
    where m.business_id=p_business_id and m.user_id=p_user_id and m.active and e.active and m.role=e.role) then
    raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001';
  end if;
end;
$$;
create function app_private.employee_summary(p_employee app_private.employees)
returns jsonb language sql set search_path = '' as $$
  select jsonb_build_object('id',p_employee.id,'name',p_employee.name,'role',p_employee.role,'active',p_employee.active);
$$;
create function app_private.employee_context(p_employee_id uuid,p_allow_profile boolean)
returns jsonb language plpgsql set search_path = '' as $$
declare v_context jsonb;
begin
  select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,
    'timezone',b.timezone,'currency',b.currency,'createdAt',b.created_at,'role',e.role,
    'employee',jsonb_build_object('id',e.id,'name',e.name,'role',e.role),
    'profile',case when p_allow_profile and e.role='owner' then b.profile else
      '{"branchName":"","registerName":"","address":"","city":"","state":"","contactPhone":"","paymentMethods":[]}'::jsonb end
  ) into v_context from app_private.employees e join app_private.businesses b on b.id=e.business_id where e.id=p_employee_id and e.active;
  if v_context is null then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  return v_context;
end;
$$;
create or replace function app_private.business_context(p_user_id uuid,p_business_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.assert_member(p_user_id,p_business_id);
  select id into v_id from app_private.employees where user_id=p_user_id and business_id=p_business_id and active;
  return app_private.employee_context(v_id,true);
end;
$$;
-- Keep the original credential and locking semantics for Google owners and Google employees.
create or replace function app_private.verify_pin(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_pin text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_credential app_private.operator_credentials%rowtype; v_attempts integer; v_locked_until timestamptz;
begin
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  perform app_private.assert_member(p_user_id,p_business_id);
  select * into v_credential from app_private.operator_credentials where business_id=p_business_id and user_id=p_user_id for update;
  if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
  if v_credential.locked_until>clock_timestamp() then
    return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_credential.locked_until-clock_timestamp()))::integer)));
  end if;
  if extensions.crypt(p_pin,v_credential.pin_hash)<>v_credential.pin_hash then
    v_attempts:=case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.operator_credentials set failed_attempts=v_attempts,locked_until=v_locked_until where business_id=p_business_id and user_id=p_user_id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event)
      values(p_business_id,p_user_id,p_auth_session_id,case when v_attempts>=5 then 'pin_lockout' else 'pin_unlock_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'PIN_LOCKED' else 'PIN_INVALID' end,'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  update app_private.operator_credentials set failed_attempts=0,locked_until=null where business_id=p_business_id and user_id=p_user_id;
  return null;
end;
$$;
create function app_private.assert_operator(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns timestamptz language plpgsql set search_path = '' as $$
declare v_session app_private.operator_sessions%rowtype;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  perform app_private.assert_member(p_user_id,p_business_id);
  if p_operator_token is null or p_operator_token !~ '^[0-9a-f]{64}$' then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
  select * into v_session from app_private.operator_sessions where token_hash=extensions.digest(p_operator_token,'sha256')
    and business_id=p_business_id and user_id=p_user_id and auth_session_id=p_auth_session_id;
  if not found or v_session.revoked_at is not null then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
  if v_session.expires_at<=clock_timestamp() then raise exception 'SESSION_EXPIRED' using errcode='P0001'; end if;
  return v_session.expires_at;
end;
$$;
create function app_private.assert_owner_operator(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns void language plpgsql set search_path = '' as $$
begin
  perform app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  if not exists(select 1 from app_private.business_memberships where business_id=p_business_id and user_id=p_user_id and active and role='owner') then
    raise exception 'PERMISSION_DENIED' using errcode='P0001';
  end if;
end;
$$;
create or replace function public.account_status(p_user_id uuid,p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_businesses jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type) order by b.created_at,b.id),'[]'::jsonb)
    into v_businesses from app_private.businesses b join app_private.business_memberships m on m.business_id=b.id
    join app_private.employees e on e.business_id=m.business_id and e.user_id=m.user_id
    where m.user_id=p_user_id and m.active and e.active;
  return jsonb_build_object('data',jsonb_build_object('businesses',v_businesses));
end;
$$;
create or replace function public.account_context(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_expires timestamptz;
begin
  v_expires:=app_private.assert_operator(p_user_id,p_auth_session_id,p_business_id,p_operator_token);
  return jsonb_build_object('data',jsonb_build_object('business',app_private.business_context(p_user_id,p_business_id),'expiresAt',v_expires));
end;
$$;
create or replace function public.account_lock(p_user_id uuid,p_auth_session_id uuid,p_business_id uuid,p_operator_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id); perform app_private.assert_member(p_user_id,p_business_id);
  if p_operator_token is null or p_operator_token !~ '^[0-9a-f]{64}$' then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
  update app_private.operator_sessions set revoked_at=clock_timestamp() where token_hash=extensions.digest(p_operator_token,'sha256') and business_id=p_business_id
    and user_id=p_user_id and auth_session_id=p_auth_session_id and revoked_at is null;
  if found then insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(p_business_id,p_user_id,p_auth_session_id,'operator_locked'); end if;
  return jsonb_build_object('data',jsonb_build_object('locked',true));
end;
$$;

create function public.account_create_business(p_user_id uuid,p_auth_session_id uuid,p_name text,p_business_type text,p_timezone text,p_operation_id uuid,p_pin text,p_profile jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text:=btrim(regexp_replace(p_name,'[[:space:]]+',' ','g')); v_profile jsonb; v_fingerprint bytea;
  v_operation app_private.business_create_operations%rowtype; v_business_id uuid; v_pin_result jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if p_name is null or p_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' or char_length(v_name) not between 2 and 100
    or p_business_type is null or p_business_type not in ('cafe','restaurant','other') or p_timezone is null or char_length(p_timezone)>100
    or p_timezone !~ '^[A-Za-z_]+/[A-Za-z_+-]+(/[A-Za-z_+-]+)?$' or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone)
    or p_operation_id is null or p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_profile:=app_private.validate_profile(p_profile);
  -- Preserve the historic fingerprint for old clients' payloads.
  v_fingerprint:=extensions.digest((jsonb_build_object('name',v_name,'businessType',p_business_type,'timezone',p_timezone)
    || case when p_profile is null then '{}'::jsonb else jsonb_build_object('profile',v_profile) end)::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':'||p_operation_id::text,0));
  select * into v_operation from app_private.business_create_operations where user_id=p_user_id and operation_id=p_operation_id;
  if found then
    if v_operation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    v_pin_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_operation.business_id,p_pin);
    if v_pin_result is not null then
      if v_pin_result#>>'{error,code}'='PIN_INVALID' then return jsonb_build_object('error',jsonb_build_object('code','OPERATION_CONFLICT')); end if;
      return v_pin_result;
    end if;
    return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_operation.business_id);
  end if;
  insert into app_private.businesses(name,business_type,timezone,profile) values(v_name,p_business_type,p_timezone,v_profile) returning id into v_business_id;
  insert into app_private.business_memberships(business_id,user_id) values(v_business_id,p_user_id);
  insert into app_private.employees(business_id,user_id,name,role) values(v_business_id,p_user_id,'Dueño','owner');
  insert into app_private.operator_credentials(business_id,user_id,pin_hash) values(v_business_id,p_user_id,extensions.crypt(p_pin,extensions.gen_salt('bf',12)));
  insert into app_private.business_create_operations(user_id,operation_id,payload_fingerprint,business_id) values(p_user_id,p_operation_id,v_fingerprint,v_business_id);
  insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'business_created');
  return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_business_id);
end;
$$;
create or replace function public.account_create_business(p_user_id uuid,p_auth_session_id uuid,p_name text,p_business_type text,p_timezone text,p_operation_id uuid,p_pin text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.account_create_business(p_user_id,p_auth_session_id,p_name,p_business_type,p_timezone,p_operation_id,p_pin,null);
$$;
create unique index business_invitations_accept_operation_idx on app_private.business_invitations(accepted_by,accepted_operation_id) where accepted_by is not null;
create unique index device_pairing_codes_pair_operation_idx on app_private.device_pairing_codes(paired_operation_id) where paired_operation_id is not null;

-- One authenticated owner entry point; every action rechecks the live operator and server role.
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_business_id uuid; v_operation_id uuid; v_name text; v_role text; v_pin text; v_fingerprint bytea;
  v_employee app_private.employees%rowtype; v_operation app_private.employee_create_operations%rowtype;
  v_invitation app_private.business_invitations%rowtype; v_pairing app_private.device_pairing_codes%rowtype;
  v_code text; v_expires timestamptz; v_profile jsonb; v_pin_result jsonb; v_employees jsonb; v_invitations jsonb; v_devices jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  if p_action='accept_invitation' then
    v_pin:=p_payload->>'pin'; v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_operation_id:=(p_payload->>'operationId')::uuid;
    if v_operation_id is null or v_pin is null or v_pin !~ '^[0-9]{6}$' or v_name is null or char_length(v_name) not between 2 and 100
      or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' or p_payload->>'invitationCode' is null or p_payload->>'invitationCode' !~ '^[0-9a-f]{64}$' then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':accept:'||v_operation_id::text,0));
    select * into v_invitation from app_private.business_invitations where token_hash=extensions.digest(p_payload->>'invitationCode','sha256') for update;
    if not found or v_invitation.revoked_at is not null then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
    v_fingerprint:=extensions.digest(jsonb_build_object('name',v_name)::text,'sha256');
    if v_invitation.accepted_by is not null then
      if v_invitation.accepted_by<>p_user_id or v_invitation.accepted_operation_id<>v_operation_id then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
      if v_invitation.accepted_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      v_pin_result:=app_private.verify_pin(p_user_id,p_auth_session_id,v_invitation.business_id,v_pin);
      if v_pin_result is not null then
        if v_pin_result#>>'{error,code}'='PIN_INVALID' then return jsonb_build_object('error',jsonb_build_object('code','OPERATION_CONFLICT')); end if;
        return v_pin_result;
      end if;
      return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_invitation.business_id);
    end if;
    if v_invitation.expires_at<=clock_timestamp() then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
    if exists(select 1 from app_private.business_invitations where accepted_by=p_user_id and accepted_operation_id=v_operation_id) then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if exists(select 1 from app_private.business_memberships where business_id=v_invitation.business_id and user_id=p_user_id) then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    insert into app_private.business_memberships(business_id,user_id,role) values(v_invitation.business_id,p_user_id,v_invitation.role);
    insert into app_private.employees(business_id,user_id,name,role) values(v_invitation.business_id,p_user_id,v_name,v_invitation.role) returning * into v_employee;
    insert into app_private.operator_credentials(business_id,user_id,pin_hash) values(v_invitation.business_id,p_user_id,extensions.crypt(v_pin,extensions.gen_salt('bf',12)));
    update app_private.business_invitations set accepted_by=p_user_id,accepted_operation_id=v_operation_id,accepted_fingerprint=v_fingerprint,
      accepted_employee_id=v_employee.id,accepted_at=clock_timestamp() where id=v_invitation.id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_invitation.business_id,p_user_id,p_auth_session_id,'invitation_accepted');
    return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_invitation.business_id);
  end if;
  v_business_id:=(p_payload->>'businessId')::uuid;
  if p_action='reset_pin' then
    perform app_private.assert_owner(p_user_id,v_business_id); perform app_private.assert_member(p_user_id,v_business_id);
    if not exists(select 1 from auth.sessions where id=p_auth_session_id and user_id=p_user_id and created_at>=clock_timestamp()-interval '5 minutes') then
      raise exception 'REAUTH_REQUIRED' using errcode='P0001';
    end if;
    v_pin:=p_payload->>'pin'; if v_pin is null or v_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    -- Match shared unlock's employee -> credential -> session lock order.
    perform 1 from app_private.employees where business_id=v_business_id and user_id=p_user_id for update;
    update app_private.operator_credentials set pin_hash=extensions.crypt(v_pin,extensions.gen_salt('bf',12)),failed_attempts=0,locked_until=null where business_id=v_business_id and user_id=p_user_id;
    update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and user_id=p_user_id and revoked_at is null;
    update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and employee_id in
      (select id from app_private.employees where business_id=v_business_id and user_id=p_user_id) and revoked_at is null;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'pin_reset');
    return app_private.issue_operator_session(p_user_id,p_auth_session_id,v_business_id);
  end if;
  perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if p_action='team' then
    select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e where e.business_id=v_business_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'role',i.role,'expiresAt',i.expires_at,
      'active',i.revoked_at is null and i.accepted_by is null and i.expires_at>clock_timestamp()) order by i.expires_at desc),'[]'::jsonb)
      into v_invitations from app_private.business_invitations i where i.business_id=v_business_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'registerName',d.register_name,
      'active',d.revoked_at is null and d.expires_at>clock_timestamp()) order by d.created_at,d.id),'[]'::jsonb)
      into v_devices from app_private.devices d where d.business_id=v_business_id;
    return jsonb_build_object('data',jsonb_build_object('employees',v_employees,'invitations',v_invitations,'devices',v_devices));
  elsif p_action='update_business' then
    v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g'));
    if v_name is null or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' or char_length(v_name) not between 2 and 100
      or p_payload->>'businessType' is null or p_payload->>'businessType' not in ('cafe','restaurant','other')
      or p_payload->>'timezone' is null or char_length(p_payload->>'timezone')>100 or p_payload->>'timezone' !~ '^[A-Za-z_]+/[A-Za-z_+-]+(/[A-Za-z_+-]+)?$'
      or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_payload->>'timezone') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_profile:=app_private.validate_profile(p_payload->'profile');
    update app_private.businesses set name=v_name,business_type=p_payload->>'businessType',timezone=p_payload->>'timezone',profile=v_profile where id=v_business_id;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'business_updated');
    return jsonb_build_object('data',app_private.business_context(p_user_id,v_business_id));
  elsif p_action in ('create_employee','update_employee','create_invitation') then
    v_name:=btrim(regexp_replace(p_payload->>'name','[[:space:]]+',' ','g')); v_role:=p_payload->>'role'; v_pin:=p_payload->>'pin';
    if v_name is null or char_length(v_name) not between 2 and 100 or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
      or v_role is null or v_role not in ('manager','cashier','kitchen') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    if p_action='update_employee' then
      if jsonb_typeof(p_payload->'active')<>'boolean' or (v_pin is not null and v_pin !~ '^[0-9]{6}$') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      select * into v_employee from app_private.employees where id=(p_payload->>'employeeId')::uuid and business_id=v_business_id for update;
      if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
      if v_employee.role='owner' then raise exception 'PERMISSION_DENIED' using errcode='P0001'; end if;
      update app_private.employees set name=v_name,role=v_role,active=(p_payload->>'active')::boolean where id=v_employee.id returning * into v_employee;
      if v_employee.user_id is not null then
        update app_private.business_memberships set role=v_role,active=v_employee.active where business_id=v_business_id and user_id=v_employee.user_id;
        if v_pin is not null then update app_private.operator_credentials set pin_hash=extensions.crypt(v_pin,extensions.gen_salt('bf',12)),failed_attempts=0,locked_until=null where business_id=v_business_id and user_id=v_employee.user_id; end if;
        update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and user_id=v_employee.user_id and revoked_at is null;
      elsif v_pin is not null then
        update app_private.shared_employee_credentials set pin_hash=extensions.crypt(v_pin,extensions.gen_salt('bf',12)),failed_attempts=0,locked_until=null where business_id=v_business_id and employee_id=v_employee.id;
      end if;
      update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and employee_id=v_employee.id and revoked_at is null;
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_updated');
      return jsonb_build_object('data',app_private.employee_summary(v_employee));
    end if;
    v_operation_id:=(p_payload->>'operationId')::uuid;
    if v_operation_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_fingerprint:=extensions.digest(jsonb_build_object('businessId',v_business_id,'name',v_name,'role',v_role)::text,'sha256');
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':'||p_action||':'||v_operation_id::text,0));
    if p_action='create_employee' then
      if v_pin is null or v_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      select * into v_operation from app_private.employee_create_operations where user_id=p_user_id and operation_id=v_operation_id;
      if found then
        if v_operation.payload_fingerprint<>v_fingerprint or not exists(select 1 from app_private.shared_employee_credentials where employee_id=v_operation.employee_id and pin_hash=extensions.crypt(v_pin,pin_hash)) then
          raise exception 'OPERATION_CONFLICT' using errcode='P0001';
        end if;
        select * into v_employee from app_private.employees where id=v_operation.employee_id;
        return jsonb_build_object('data',app_private.employee_summary(v_employee));
      end if;
      insert into app_private.employees(business_id,name,role) values(v_business_id,v_name,v_role) returning * into v_employee;
      insert into app_private.shared_employee_credentials(business_id,employee_id,pin_hash) values(v_business_id,v_employee.id,extensions.crypt(v_pin,extensions.gen_salt('bf',12)));
      insert into app_private.employee_create_operations(user_id,operation_id,business_id,payload_fingerprint,employee_id) values(p_user_id,v_operation_id,v_business_id,v_fingerprint,v_employee.id);
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'employee_created');
      return jsonb_build_object('data',app_private.employee_summary(v_employee));
    end if;
    select * into v_invitation from app_private.business_invitations where created_by=p_user_id and operation_id=v_operation_id for update;
    if found then
      if v_invitation.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      if v_invitation.accepted_by is not null or v_invitation.revoked_at is not null or v_invitation.expires_at<=clock_timestamp() then raise exception 'INVITATION_INVALID' using errcode='P0001'; end if;
      -- Only hashes persist. A retry rotates the unconsumed secret on the same invitation.
      v_code:=encode(extensions.gen_random_bytes(32),'hex');
      update app_private.business_invitations set token_hash=extensions.digest(v_code,'sha256') where id=v_invitation.id;
    else
      v_code:=encode(extensions.gen_random_bytes(32),'hex');
      insert into app_private.business_invitations(business_id,created_by,operation_id,payload_fingerprint,name,role,token_hash,expires_at)
        values(v_business_id,p_user_id,v_operation_id,v_fingerprint,v_name,v_role,extensions.digest(v_code,'sha256'),clock_timestamp()+interval '48 hours') returning * into v_invitation;
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'invitation_created');
    end if;
    return jsonb_build_object('data',jsonb_build_object('invitationCode',v_code,'invitationId',v_invitation.id,'expiresAt',v_invitation.expires_at));
  elsif p_action='revoke_invitation' then
    update app_private.business_invitations set revoked_at=clock_timestamp() where business_id=v_business_id and id=(p_payload->>'invitationId')::uuid;
    if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'invitation_revoked');
    return jsonb_build_object('data',jsonb_build_object('revoked',true));
  elsif p_action='create_pairing_code' then
    v_operation_id:=(p_payload->>'operationId')::uuid; if v_operation_id is null then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text||':pair:'||v_operation_id::text,0));
    select * into v_pairing from app_private.device_pairing_codes where created_by=p_user_id and operation_id=v_operation_id for update;
    if found then
      if v_pairing.business_id<>v_business_id then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      if v_pairing.used_at is not null or v_pairing.expires_at<=clock_timestamp() then raise exception 'PAIRING_INVALID' using errcode='P0001'; end if;
      v_code:=encode(extensions.gen_random_bytes(32),'hex');
      update app_private.device_pairing_codes set token_hash=extensions.digest(v_code,'sha256') where id=v_pairing.id;
    else
      v_code:=encode(extensions.gen_random_bytes(32),'hex');
      insert into app_private.device_pairing_codes(business_id,created_by,operation_id,token_hash,expires_at)
        values(v_business_id,p_user_id,v_operation_id,extensions.digest(v_code,'sha256'),clock_timestamp()+interval '10 minutes') returning * into v_pairing;
      insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'pairing_created');
    end if;
    return jsonb_build_object('data',jsonb_build_object('pairingCode',v_code,'expiresAt',v_pairing.expires_at));
  elsif p_action='revoke_device' then
    update app_private.devices set revoked_at=clock_timestamp() where business_id=v_business_id and id=(p_payload->>'deviceId')::uuid;
    if not found then raise exception 'BUSINESS_ACCESS_DENIED' using errcode='P0001'; end if;
    update app_private.device_operator_sessions set revoked_at=clock_timestamp() where business_id=v_business_id and device_id=(p_payload->>'deviceId')::uuid and revoked_at is null;
    insert into app_private.account_audit_events(business_id,user_id,auth_session_id,event) values(v_business_id,p_user_id,p_auth_session_id,'device_revoked');
    return jsonb_build_object('data',jsonb_build_object('revoked',true));
  end if;
  raise exception 'VALIDATION_ERROR' using errcode='P0001';
end;
$$;
create function app_private.verify_employee_pin(p_employee app_private.employees,p_pin text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_credential app_private.shared_employee_credentials%rowtype; v_attempts integer; v_locked_until timestamptz;
begin
  if p_employee.user_id is not null then return app_private.verify_pin(p_employee.user_id,null,p_employee.business_id,p_pin); end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  select * into v_credential from app_private.shared_employee_credentials where business_id=p_employee.business_id and employee_id=p_employee.id for update;
  if not found then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
  if v_credential.locked_until>clock_timestamp() then return jsonb_build_object('error',jsonb_build_object('code','PIN_LOCKED','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_credential.locked_until-clock_timestamp()))::integer))); end if;
  if extensions.crypt(p_pin,v_credential.pin_hash)<>v_credential.pin_hash then
    v_attempts:=case when v_credential.locked_until is not null then 1 else v_credential.failed_attempts+1 end;
    if v_attempts>=5 then v_locked_until:=clock_timestamp()+interval '15 minutes'; end if;
    update app_private.shared_employee_credentials set failed_attempts=v_attempts,locked_until=v_locked_until where business_id=p_employee.business_id and employee_id=p_employee.id;
    insert into app_private.account_audit_events(business_id,event) values(p_employee.business_id,case when v_attempts>=5 then 'pin_lockout' else 'pin_unlock_failed' end);
    return jsonb_build_object('error',jsonb_build_object('code',case when v_attempts>=5 then 'PIN_LOCKED' else 'PIN_INVALID' end,'retryAfterSeconds',case when v_attempts>=5 then 900 else null end));
  end if;
  update app_private.shared_employee_credentials set failed_attempts=0,locked_until=null where business_id=p_employee.business_id and employee_id=p_employee.id;
  return null;
end;
$$;

-- No Google identity is attached to this entry point. Only a hashed, revocable device credential
-- authorizes its small projection; owner-management RPCs still require personal Google + owner PIN.
create function public.account_device(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pairing app_private.device_pairing_codes%rowtype; v_device app_private.devices%rowtype;
  v_employee app_private.employees%rowtype; v_session app_private.device_operator_sessions%rowtype;
  v_token text; v_expires timestamptz; v_operation_id uuid; v_name text; v_business jsonb; v_employees jsonb; v_pin_result jsonb;
begin
  if p_action='device_pair' then
    v_operation_id:=(p_payload->>'operationId')::uuid; v_name:=btrim(regexp_replace(p_payload->>'deviceName','[[:space:]]+',' ','g'));
    if v_operation_id is null or v_name is null or char_length(v_name) not between 2 and 100
      or v_name ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' or p_payload->>'pairingCode' is null or p_payload->>'pairingCode' !~ '^[0-9a-f]{64}$' then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('device_pair:'||v_operation_id::text,0));
    select * into v_pairing from app_private.device_pairing_codes where token_hash=extensions.digest(p_payload->>'pairingCode','sha256') for update;
    if not found then raise exception 'PAIRING_INVALID' using errcode='P0001'; end if;
    if v_pairing.used_at is not null then
      if v_pairing.paired_operation_id<>v_operation_id then raise exception 'PAIRING_INVALID' using errcode='P0001'; end if;
      if v_pairing.paired_name<>v_name then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      select * into v_device from app_private.devices where id=v_pairing.paired_device_id for update;
      if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
      v_token:=encode(extensions.gen_random_bytes(32),'hex');
      update app_private.devices set token_hash=extensions.digest(v_token,'sha256') where id=v_device.id;
      update app_private.device_operator_sessions set revoked_at=clock_timestamp() where device_id=v_device.id and revoked_at is null;
    else
      if v_pairing.expires_at<=clock_timestamp() then raise exception 'PAIRING_INVALID' using errcode='P0001'; end if;
      if exists(select 1 from app_private.device_pairing_codes where paired_operation_id=v_operation_id) then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
      v_token:=encode(extensions.gen_random_bytes(32),'hex');
      insert into app_private.devices(business_id,name,register_name,token_hash)
        select v_pairing.business_id,v_name,coalesce(nullif(b.profile->>'registerName',''),'Caja 1'),extensions.digest(v_token,'sha256')
        from app_private.businesses b where b.id=v_pairing.business_id returning * into v_device;
      update app_private.device_pairing_codes set used_at=clock_timestamp(),paired_device_id=v_device.id,paired_operation_id=v_operation_id,paired_name=v_name where id=v_pairing.id;
      insert into app_private.account_audit_events(business_id,event) values(v_device.business_id,'device_paired');
    end if;
    select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type) into v_business from app_private.businesses b where b.id=v_device.business_id;
    return jsonb_build_object('data',jsonb_build_object('deviceId',v_device.id,'deviceToken',v_token,'business',v_business,'registerName',v_device.register_name));
  end if;
  if p_payload->>'deviceToken' is null or p_payload->>'deviceToken' !~ '^[0-9a-f]{64}$' then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  -- Lock makes pairing replay/revocation/operator replacement serialize against all device requests.
  select * into v_device from app_private.devices where token_hash=extensions.digest(p_payload->>'deviceToken','sha256') for update;
  if not found or v_device.revoked_at is not null or v_device.expires_at<=clock_timestamp() then raise exception 'DEVICE_REVOKED' using errcode='P0001'; end if;
  if p_action='device_forget' then
    update app_private.devices set revoked_at=clock_timestamp() where id=v_device.id;
    update app_private.device_operator_sessions set revoked_at=clock_timestamp() where device_id=v_device.id and revoked_at is null;
    insert into app_private.account_audit_events(business_id,event) values(v_device.business_id,'device_revoked');
    return jsonb_build_object('data',jsonb_build_object('revoked',true));
  elsif p_action='device_status' then
    select jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type) into v_business from app_private.businesses b where b.id=v_device.business_id;
    select coalesce(jsonb_agg(app_private.employee_summary(e) order by e.created_at,e.id),'[]'::jsonb) into v_employees from app_private.employees e
      where e.business_id=v_device.business_id and e.active and (e.user_id is null or exists(select 1 from app_private.business_memberships m where m.business_id=e.business_id and m.user_id=e.user_id and m.active));
    return jsonb_build_object('data',jsonb_build_object('business',v_business,'employees',v_employees,'registerName',v_device.register_name));
  elsif p_action='device_unlock' then
    select * into v_employee from app_private.employees where id=(p_payload->>'employeeId')::uuid and business_id=v_device.business_id for update;
    if not found or not v_employee.active then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
    -- A PIN attempt on the shared register leaves the previous employee locked, even on failure.
    update app_private.device_operator_sessions set revoked_at=clock_timestamp() where device_id=v_device.id and revoked_at is null;
    v_pin_result:=app_private.verify_employee_pin(v_employee,p_payload->>'pin');
    if v_pin_result is not null then return v_pin_result; end if;
    v_token:=encode(extensions.gen_random_bytes(32),'hex'); v_expires:=clock_timestamp()+interval '8 hours';
    insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash,expires_at)
      values(v_device.business_id,v_device.id,v_employee.id,extensions.digest(v_token,'sha256'),v_expires);
    insert into app_private.account_audit_events(business_id,user_id,event) values(v_device.business_id,v_employee.user_id,'pin_unlock_succeeded');
    return jsonb_build_object('data',jsonb_build_object('business',app_private.employee_context(v_employee.id,false),'operatorToken',v_token,'expiresAt',v_expires));
  elsif p_action in ('device_context','device_lock') then
    if p_payload->>'operatorToken' is null or p_payload->>'operatorToken' !~ '^[0-9a-f]{64}$' then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
    select * into v_session from app_private.device_operator_sessions where token_hash=extensions.digest(p_payload->>'operatorToken','sha256') and device_id=v_device.id and business_id=v_device.business_id;
    if p_action='device_lock' then
      if found and v_session.revoked_at is null then
        update app_private.device_operator_sessions set revoked_at=clock_timestamp() where id=v_session.id;
        insert into app_private.account_audit_events(business_id,event) values(v_device.business_id,'operator_locked');
      end if;
      return jsonb_build_object('data',jsonb_build_object('locked',true));
    end if;
    if not found or v_session.revoked_at is not null then raise exception 'SESSION_INVALID' using errcode='P0001'; end if;
    if v_session.expires_at<=clock_timestamp() then raise exception 'SESSION_EXPIRED' using errcode='P0001'; end if;
    select * into v_employee from app_private.employees where id=v_session.employee_id and business_id=v_device.business_id and active;
    if not found then raise exception 'EMPLOYEE_INACTIVE' using errcode='P0001'; end if;
    if v_employee.user_id is not null then perform app_private.assert_member(v_employee.user_id,v_device.business_id); end if;
    return jsonb_build_object('data',jsonb_build_object('business',app_private.employee_context(v_employee.id,false),'expiresAt',v_session.expires_at));
  end if;
  raise exception 'VALIDATION_ERROR' using errcode='P0001';
end;
$$;

revoke all on all functions in schema app_private from public,anon,authenticated;
revoke all on function public.account_create_business(uuid,uuid,text,text,text,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.account_device(text,jsonb) from public,anon,authenticated;
grant execute on function public.account_create_business(uuid,uuid,text,text,text,uuid,text,jsonb) to service_role;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.account_device(text,jsonb) to service_role;
