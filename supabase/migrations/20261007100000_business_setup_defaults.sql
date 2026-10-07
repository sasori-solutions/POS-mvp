-- Receiving details are private operational instructions, never bank credentials.
-- Optional keys preserve legacy create fingerprints and older-client updates.
alter function app_private.validate_profile(jsonb) rename to validate_profile_before_transfer_account;
create function app_private.validate_profile(p_profile jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare v_result jsonb; v_account jsonb; v_key text; v_value text; v_sum integer:=0; v_index integer;
begin
  if p_profile is not null and jsonb_typeof(p_profile) is distinct from 'object' then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  v_result:=app_private.validate_profile_before_transfer_account(p_profile-'transferAccount');
  if p_profile is null or not p_profile ? 'transferAccount' then return v_result; end if;
  v_account:=p_profile->'transferAccount';
  if jsonb_typeof(v_account)='null' then return v_result||jsonb_build_object('transferAccount',null); end if;
  if jsonb_typeof(v_account) is distinct from 'object' or not v_account ?& array['beneficiary','bank','clabe']
    or exists(select 1 from jsonb_object_keys(v_account) k where k not in ('beneficiary','bank','clabe')) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  foreach v_key in array array['beneficiary','bank'] loop
    v_value:=v_account->>v_key;
    if jsonb_typeof(v_account->v_key) is distinct from 'string' or v_value ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' or char_length(v_value)>100 then
      raise exception 'VALIDATION_ERROR' using errcode='P0001';
    end if;
    v_value:=btrim(regexp_replace(v_value,'[[:space:]]+',' ','g'));
    if char_length(v_value)<1 then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
    v_account:=jsonb_set(v_account,array[v_key],to_jsonb(v_value));
  end loop;
  if jsonb_typeof(v_account->'clabe') is distinct from 'string' or v_account->>'clabe' !~ '^[0-9]{18}$' then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  for v_index in 1..17 loop
    v_sum:=v_sum+((substring(v_account->>'clabe' from v_index for 1)::integer * (array[3,7,1])[(v_index-1)%3+1])%10);
  end loop;
  if (10-v_sum%10)%10<>substring(v_account->>'clabe' from 18 for 1)::integer then raise exception 'VALIDATION_ERROR' using errcode='P0001'; end if;
  return v_result||jsonb_build_object('transferAccount',v_account);
end $$;

alter function app_private.employee_context(uuid,boolean) rename to employee_context_before_transfer_account;
create function app_private.employee_context(p_employee_id uuid,p_allow_profile boolean)
returns jsonb language plpgsql set search_path='' as $$
declare v_result jsonb; v_account jsonb; v_allowed boolean;
begin
  v_result:=app_private.employee_context_before_transfer_account(p_employee_id,p_allow_profile);
  select b.profile->'transferAccount',e.role='owner' or 'sales.create'=any(e.permissions)
    into v_account,v_allowed from app_private.employees e join app_private.businesses b on b.id=e.business_id
    where e.id=p_employee_id and e.active and e.deleted_at is null;
  if v_allowed then v_result:=jsonb_set(v_result,'{profile}',(v_result->'profile')||jsonb_build_object('transferAccount',v_account));
  else v_result:=jsonb_set(v_result,'{profile}',(v_result->'profile')-'transferAccount'); end if;
  return v_result;
end $$;

alter function public.account_manage(uuid,uuid,text,jsonb) rename to account_manage_before_transfer_account;
alter function public.account_manage_before_transfer_account(uuid,uuid,text,jsonb) set schema app_private;
create function public.account_manage(p_user_id uuid,p_auth_session_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_saved jsonb;
begin
  if p_action='update_business' then
    perform app_private.assert_owner_operator(p_user_id,p_auth_session_id,(p_payload->>'businessId')::uuid,p_payload->>'operatorToken');
    select profile into v_saved from app_private.businesses where id=(p_payload->>'businessId')::uuid for update;
    if not (p_payload->'profile') ? 'transferAccount' and v_saved ? 'transferAccount' then
      p_payload:=jsonb_set(p_payload,'{profile}',(p_payload->'profile')||jsonb_build_object('transferAccount',v_saved->'transferAccount'));
    end if;
  end if;
  return app_private.account_manage_before_transfer_account(p_user_id,p_auth_session_id,p_action,p_payload);
end $$;

revoke all on function app_private.validate_profile_before_transfer_account(jsonb),app_private.validate_profile(jsonb),app_private.employee_context_before_transfer_account(uuid,boolean),app_private.employee_context(uuid,boolean),app_private.account_manage_before_transfer_account(uuid,uuid,text,jsonb),public.account_manage(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function app_private.account_manage_before_transfer_account(uuid,uuid,text,jsonb) from service_role;
grant execute on function public.account_manage(uuid,uuid,text,jsonb) to service_role;
