-- Business preferences and private, bounded JPEG images. Legacy profile payloads
-- retain their shape so accepted create_business fingerprints remain stable.
create or replace function app_private.validate_profile(p_profile jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v_key text; v_value text; v_methods jsonb;
begin
  if p_profile is null then
    return '{"branchName":"Sucursal principal","registerName":"Caja 1","address":"","city":"","state":"","contactPhone":"","paymentMethods":["cash"]}'::jsonb;
  end if;
  if jsonb_typeof(p_profile) <> 'object'
    or not p_profile ?& array['branchName','registerName','address','city','state','contactPhone','paymentMethods']
    or exists(select 1 from jsonb_object_keys(p_profile) k where k not in ('branchName','registerName','address','city','state','contactPhone','paymentMethods','accountsEnabled','defaultVatTreatment','logoImageId')) then
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
  if jsonb_array_length(v_methods)<1 or jsonb_array_length(v_methods)>4
    or exists(select 1 from jsonb_array_elements(v_methods) m where jsonb_typeof(m)<>'string' or m#>>'{}' not in ('cash','card_external','transfer','card_integrated'))
    or (select count(distinct m) from jsonb_array_elements(v_methods) m) <> jsonb_array_length(v_methods) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  if p_profile ? 'accountsEnabled' and jsonb_typeof(p_profile->'accountsEnabled') <> 'boolean' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_profile ? 'defaultVatTreatment' and (jsonb_typeof(p_profile->'defaultVatTreatment') <> 'string' or p_profile->>'defaultVatTreatment' not in ('vat_16','vat_0','exempt','border_8','unconfigured')) then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_profile ? 'logoImageId' and jsonb_typeof(p_profile->'logoImageId') <> 'null'
    and (jsonb_typeof(p_profile->'logoImageId') <> 'string' or p_profile->>'logoImageId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  return p_profile;
end $$;

create table app_private.profile_images (
  id uuid primary key,
  subject text not null check(subject in ('business','account')),
  business_id uuid references app_private.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parts integer not null check(parts between 1 and 60),
  data text check(char_length(data) <= 245760),
  created_at timestamptz not null default clock_timestamp(),
  check((subject='business') = (business_id is not null))
);
create index profile_images_owner_idx on app_private.profile_images(user_id,subject);
create table app_private.profile_image_parts (
  image_id uuid not null references app_private.profile_images(id) on delete cascade,
  part integer not null check(part between 0 and 59),
  data text not null check(char_length(data) between 4 and 4096),
  primary key(image_id,part)
);
create table app_private.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  image_id uuid references app_private.profile_images(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp()
);
create table app_private.profile_image_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  business_id uuid not null references app_private.businesses(id) on delete cascade,
  payload_fingerprint bytea not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,operation_id)
);
alter table app_private.profile_images enable row level security;
alter table app_private.profile_image_parts enable row level security;
alter table app_private.account_profiles enable row level security;
alter table app_private.profile_image_operations enable row level security;
revoke all on app_private.profile_images,app_private.profile_image_parts,app_private.account_profiles,app_private.profile_image_operations from public,anon,authenticated;

create function app_private.assert_business_logo()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.profile->>'logoImageId' is not null then
    if new.profile->>'logoImageId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or not exists(select 1 from app_private.profile_images i where i.id=(new.profile->>'logoImageId')::uuid and i.subject='business' and i.business_id=new.id and i.data is not null) then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
  end if;
  return new;
end $$;
create trigger businesses_validate_logo before insert or update of profile on app_private.businesses for each row execute function app_private.assert_business_logo();

-- Only operational preferences and the authorized image bytes are added to the
-- employee projection. Address/contact remain owner-only.
alter function app_private.employee_context(uuid,boolean) rename to employee_context_before_business_preferences;
create function app_private.employee_context(p_employee_id uuid,p_allow_profile boolean)
returns jsonb language plpgsql set search_path='' as $$
declare v_context jsonb; v_profile jsonb; v_user_id uuid; v_logo text; v_avatar text;
begin
  v_context:=app_private.employee_context_before_business_preferences(p_employee_id,p_allow_profile);
  select b.profile,e.user_id into v_profile,v_user_id from app_private.employees e join app_private.businesses b on b.id=e.business_id where e.id=p_employee_id;
  v_context:=jsonb_set(v_context,'{profile}',(v_context->'profile')||jsonb_build_object(
    'accountsEnabled',coalesce(v_profile->'accountsEnabled','true'::jsonb),
    'defaultVatTreatment',coalesce(v_profile->'defaultVatTreatment','"vat_16"'::jsonb),
    'paymentMethods',coalesce(v_profile->'paymentMethods','[]'::jsonb),
    'logoImageId',v_profile->'logoImageId'));
  select 'data:image/jpeg;base64,'||i.data into v_logo from app_private.profile_images i
    where i.subject='business' and i.business_id=(v_context->>'id')::uuid and i.id::text=v_profile->>'logoImageId' and i.data is not null;
  select 'data:image/jpeg;base64,'||i.data into v_avatar from app_private.account_profiles p join app_private.profile_images i on i.id=p.image_id
    where p.user_id=v_user_id and i.subject='account' and i.user_id=v_user_id and i.data is not null;
  return v_context||jsonb_build_object('logoUrl',v_logo,'accountAvatarUrl',v_avatar);
end $$;

create function app_private.profile_image_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_business_id uuid:=(p_payload->>'businessId')::uuid; v_subject text:=p_payload->>'subject';
  v_operation_id uuid; v_fingerprint bytea; v_existing app_private.profile_image_operations%rowtype;
  v_image_id uuid; v_image app_private.profile_images%rowtype; v_part integer; v_parts integer; v_chunk text; v_image_data text; v_bytes bytea; v_complete boolean:=false; v_result jsonb;
begin
  perform app_private.assert_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  -- Serialize personal image writes with live employee/membership revocation
  -- and PIN-session locking, in employee -> membership -> operator order.
  perform 1 from app_private.employees where business_id=v_business_id and user_id=p_user_id and active and deleted_at is null for share;
  perform 1 from app_private.business_memberships where business_id=v_business_id and user_id=p_user_id and active for share;
  perform 1 from app_private.operator_sessions where business_id=v_business_id and user_id=p_user_id and auth_session_id=p_auth_session_id
    and token_hash=extensions.digest(p_payload->>'operatorToken','sha256') for share;
  perform app_private.assert_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  if v_subject='business' then perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  elsif v_subject is distinct from 'account' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_action not in ('upload_profile_image','remove_profile_image') or p_action is null or p_payload->>'action' is distinct from p_action
    or jsonb_typeof(p_payload->'operationId') is distinct from 'string' or p_payload->>'operationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('action','businessId','operatorToken','subject','imageId','operationId','part','parts','data'))
    or not p_payload ?& array['action','businessId','operatorToken','subject','operationId'] then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  if p_action='remove_profile_image' and (p_payload ? 'imageId' or p_payload ? 'part' or p_payload ? 'parts' or p_payload ? 'data') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_operation_id:=(p_payload->>'operationId')::uuid;
  v_fingerprint:=extensions.digest((p_payload-'operatorToken')::text,'sha256');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('profile-operation:'||p_user_id::text||':'||v_operation_id::text,0));
  perform app_private.assert_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
  select * into v_existing from app_private.profile_image_operations where user_id=p_user_id and operation_id=v_operation_id;
  if found then
    if v_existing.business_id<>v_business_id or v_existing.payload_fingerprint<>v_fingerprint then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    v_result:=v_existing.result;
    -- The immutable receipt replays, while business grants/profile reflect the
    -- current authorized session. A late retry never restores an older image.
    if v_result->>'complete'='true' or v_result->>'removed'='true' then v_result:=v_result||jsonb_build_object('business',app_private.business_context(p_user_id,v_business_id)); end if;
    return jsonb_build_object('data',v_result);
  end if;
  if p_action='remove_profile_image' then
    if v_subject='business' then
      update app_private.businesses set profile=profile||jsonb_build_object('logoImageId',null) where id=v_business_id;
    else
      insert into app_private.account_profiles(user_id,image_id) values(p_user_id,null)
        on conflict(user_id) do update set image_id=null,updated_at=clock_timestamp();
    end if;
    v_result:=jsonb_build_object('removed',true,'business',app_private.business_context(p_user_id,v_business_id));
  else
    if not p_payload ?& array['imageId','part','parts','data'] or jsonb_typeof(p_payload->'imageId') is distinct from 'string'
      or p_payload->>'imageId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(p_payload->'part') is distinct from 'number' or jsonb_typeof(p_payload->'parts') is distinct from 'number'
      or p_payload->>'part' !~ '^(0|[1-9][0-9]?)$' or p_payload->>'parts' !~ '^[1-9][0-9]?$'
      or jsonb_typeof(p_payload->'data') is distinct from 'string' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_image_id:=(p_payload->>'imageId')::uuid; v_part:=(p_payload->>'part')::integer; v_parts:=(p_payload->>'parts')::integer; v_chunk:=p_payload->>'data';
    if v_parts not between 1 and 60 or v_part<0 or v_part>=v_parts or char_length(v_chunk) not between 4 and 4096
      or char_length(v_chunk)%4<>0 or v_chunk !~ '^[A-Za-z0-9+/]+={0,2}$'
      or (v_part<v_parts-1 and (char_length(v_chunk)<>4096 or strpos(v_chunk,'=')>0)) then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('profile-image:'||v_image_id::text,0));
    perform app_private.assert_operator(p_user_id,p_auth_session_id,v_business_id,p_payload->>'operatorToken');
    insert into app_private.profile_images(id,subject,business_id,user_id,parts)
      values(v_image_id,v_subject,case when v_subject='business' then v_business_id else null end,p_user_id,v_parts) on conflict do nothing;
    select * into v_image from app_private.profile_images where id=v_image_id for update;
    if v_image.subject<>v_subject or v_image.user_id<>p_user_id or v_image.parts<>v_parts
      or v_subject='business' and v_image.business_id<>v_business_id then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if v_image.data is not null then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    insert into app_private.profile_image_parts(image_id,part,data) values(v_image_id,v_part,v_chunk) on conflict do nothing;
    if exists(select 1 from app_private.profile_image_parts where image_id=v_image_id and part=v_part and data<>v_chunk) then raise exception 'OPERATION_CONFLICT' using errcode='P0001'; end if;
    if (select count(*) from app_private.profile_image_parts where image_id=v_image_id)=v_parts then
      select string_agg(data,'' order by part) into v_image_data from app_private.profile_image_parts where image_id=v_image_id;
      v_bytes:=decode(v_image_data,'base64');
      if char_length(v_image_data)>245760 or octet_length(v_bytes)>184320 or octet_length(v_bytes)<6
        or substring(v_bytes from 1 for 3)<>decode('ffd8ff','hex') or substring(v_bytes from octet_length(v_bytes)-1 for 2)<>decode('ffd9','hex') then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
      update app_private.profile_images set data=v_image_data where id=v_image_id;
      delete from app_private.profile_image_parts where image_id=v_image_id;
      if v_subject='business' then
        update app_private.businesses set profile=profile||jsonb_build_object('logoImageId',v_image_id) where id=v_business_id;
      else
        insert into app_private.account_profiles(user_id,image_id) values(p_user_id,v_image_id)
          on conflict(user_id) do update set image_id=excluded.image_id,updated_at=clock_timestamp();
      end if;
      v_complete:=true;
    end if;
    v_result:=jsonb_build_object('imageId',v_image_id,'complete',v_complete);
    if v_complete then v_result:=v_result||jsonb_build_object('business',app_private.business_context(p_user_id,v_business_id)); end if;
  end if;
  insert into app_private.profile_image_operations(user_id,operation_id,business_id,payload_fingerprint,result) values(p_user_id,v_operation_id,v_business_id,v_fingerprint,v_result-'business');
  return jsonb_build_object('data',v_result);
end $$;

alter function public.account_manage(uuid,uuid,text,jsonb) rename to account_manage_before_business_preferences;
alter function public.account_manage_before_business_preferences(uuid,uuid,text,jsonb) set schema app_private;
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_saved jsonb; v_profile jsonb; v_key text;
begin
  if p_action in ('upload_profile_image','remove_profile_image') then return app_private.profile_image_manage(p_user_id,p_auth_session_id,p_action,p_payload); end if;
  if p_action='update_business' then
    perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken');
    select profile into v_saved from app_private.businesses where id=(p_payload->>'businessId')::uuid for update;
    v_profile:=p_payload->'profile';
    foreach v_key in array array['accountsEnabled','defaultVatTreatment','logoImageId'] loop
      if not v_profile ? v_key and v_saved ? v_key then v_profile:=v_profile||jsonb_build_object(v_key,v_saved->v_key); end if;
    end loop;
    p_payload:=jsonb_set(p_payload,'{profile}',v_profile);
  end if;
  return app_private.account_manage_before_business_preferences(p_user_id,p_auth_session_id,p_action,p_payload);
end $$;

-- Direct checkout still needs its internal Mostrador order for exact persistent
-- reservations. Disabling named accounts never strands an existing account.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_business_preferences;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_accounts_enabled boolean; v_exists boolean;
begin
  if p_payload->>'command'='save_order' then
    perform app_private.ops_validate(p_payload-array['action','businessId','operatorToken','deviceToken']);
    select coalesce((profile->>'accountsEnabled')::boolean,true) into v_accounts_enabled from app_private.businesses where id=p_business_id for share;
    select exists(select 1 from app_private.operational_orders where business_id=p_business_id and id=(p_payload->>'orderId')::uuid)
      or exists(select 1 from app_private.pos_operations where business_id=p_business_id and operation_id=(p_payload->>'operationId')::uuid) into v_exists;
    if not v_accounts_enabled and not v_exists and (p_payload->>'name' is distinct from 'Mostrador' or p_payload->>'tableId' is not null) then
      raise exception 'PERMISSION_DENIED' using errcode='P0001';
    end if;
  end if;
  return app_private.pos_command_before_business_preferences(p_business_id,p_employee_id,p_payload);
end $$;

revoke all on function app_private.validate_profile(jsonb),app_private.assert_business_logo(),app_private.employee_context_before_business_preferences(uuid,boolean),app_private.employee_context(uuid,boolean),app_private.profile_image_manage(uuid,uuid,text,jsonb),app_private.account_manage_before_business_preferences(uuid,uuid,text,jsonb),app_private.pos_command_before_business_preferences(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb),public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
