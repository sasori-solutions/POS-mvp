-- Accept the integrated method already supported by the Point contract.
-- Existing profiles, grants, owner authorization and terminal activation stay intact.
create or replace function app_private.validate_profile(p_profile jsonb)
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
  if jsonb_array_length(v_methods)<1 or jsonb_array_length(v_methods)>4 or exists(select 1 from jsonb_array_elements(v_methods) m where jsonb_typeof(m)<>'string' or m#>>'{}' not in ('cash','card_external','transfer','card_integrated'))
    or (select count(distinct m) from jsonb_array_elements(v_methods) m) <> jsonb_array_length(v_methods) then
    raise exception 'VALIDATION_ERROR' using errcode='P0001';
  end if;
  return p_profile;
end;
$$;
