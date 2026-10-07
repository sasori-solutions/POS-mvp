-- Restore compatible catalog options without changing accepted financial snapshots.
-- A product must remain selectable within the existing 24-modifier sale bound.
-- The exact optional IVA contract and previous private function grants stay intact.
create or replace function app_private.validate_product_details(p_business uuid,d jsonb)
returns void language plpgsql set search_path='' as $$
declare expected_rate integer; k text; v jsonb; s jsonb; o jsonb; ids text[]:='{}'; attribute_names text[]:='{}';
 attribute_name text; attribute_value text;
 -- Match String.trim() for non-control Unicode whitespace at the HTTP boundary.
 trim_chars text:=U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
 if jsonb_typeof(d) is distinct from 'object' or (select count(*) from jsonb_object_keys(d))<>(22
   +case when d ? 'taxTreatment' then 1 else 0 end
   +case when d ? 'skipCustomization' then 1 else 0 end
   +case when d ? 'customAttributes' then 1 else 0 end)
 or not d ?& array['description','imageId','tileColor','tileLabel','itemType','customerName','kitchenName','sku','barcode','soldOut','favorite','variablePrice','trackStock','stock','lowStockAlert','costCents','taxBps','calories','dietary','allergens','variations','modifierSets'] then raise exception 'VALIDATION_ERROR'; end if;
 if d ? 'taxTreatment' then
   if jsonb_typeof(d->'taxTreatment') is distinct from 'string' or d->>'taxTreatment' not in ('vat_16','vat_0','exempt','border_8','unconfigured') then raise exception 'VALIDATION_ERROR'; end if;
   expected_rate:=case d->>'taxTreatment' when 'vat_16' then 1600 when 'border_8' then 800 else 0 end;
   if d->'taxBps' is distinct from to_jsonb(expected_rate) then raise exception 'VALIDATION_ERROR'; end if;
 end if;
 for k in select unnest(array['description','tileColor','tileLabel','itemType','customerName','kitchenName','sku','barcode','dietary','allergens']) loop
   if jsonb_typeof(d->k) is distinct from 'string' or d->>k ~ '[\x01-\x1f\x7f]' then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if char_length(d->>'description')>1000 or char_length(d->>'tileLabel')>8 or d->>'tileColor' !~ '^#[0-9A-Fa-f]{6}$'
 or d->>'itemType' not in ('prepared','physical','service','digital','event','other') or char_length(d->>'customerName')>100 or char_length(d->>'kitchenName')>100
 or char_length(d->>'sku')>60 or char_length(d->>'barcode')>32 or char_length(d->>'dietary')>200 or char_length(d->>'allergens')>200 then raise exception 'VALIDATION_ERROR'; end if;
 for k in select unnest(array['soldOut','favorite','variablePrice','trackStock']) loop
   if jsonb_typeof(d->k) is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if d ? 'skipCustomization' and jsonb_typeof(d->'skipCustomization') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
 if d ? 'customAttributes' then
   if jsonb_typeof(d->'customAttributes') is distinct from 'array' or jsonb_array_length(d->'customAttributes')>8 then raise exception 'VALIDATION_ERROR'; end if;
   for s in select * from jsonb_array_elements(d->'customAttributes') loop
     if jsonb_typeof(s) is distinct from 'object' or not s ?& array['name','value']
       or (select count(*) from jsonb_object_keys(s))<>2
       or jsonb_typeof(s->'name') is distinct from 'string' or jsonb_typeof(s->'value') is distinct from 'string'
       or s->>'name' ~ '[\x01-\x1f\x7f]' or s->>'value' ~ '[\x01-\x1f\x7f]' then raise exception 'VALIDATION_ERROR'; end if;
     attribute_name:=btrim(s->>'name',trim_chars); attribute_value:=btrim(s->>'value',trim_chars);
     if char_length(attribute_name) not between 1 and 40 or char_length(s->>'name')>40
       or char_length(attribute_value) not between 1 and 120 or char_length(s->>'value')>120 then raise exception 'VALIDATION_ERROR'; end if;
     attribute_names:=array_append(attribute_names,lower(normalize(attribute_name,NFC)));
   end loop;
   if cardinality(attribute_names)<>(select count(distinct name) from unnest(attribute_names) name) then raise exception 'VALIDATION_ERROR'; end if;
 end if;
 for k in select unnest(array['stock','lowStockAlert','taxBps','costCents','calories']) loop
   if k in ('costCents','calories') and d->k='null'::jsonb then continue; end if;
   if jsonb_typeof(d->k) is distinct from 'number' or d->>k !~ '^[0-9]+$' or (d->>k)::numeric > (case k when 'taxBps' then 10000 when 'costCents' then 99999999 when 'calories' then 100000 else 999999 end) then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if d->'imageId'<>'null'::jsonb and not exists(select 1 from app_private.product_images where business_id=p_business and id=(d->>'imageId')::uuid and data is not null) then raise exception 'VALIDATION_ERROR'; end if;
 if jsonb_typeof(d->'variations') is distinct from 'array' or jsonb_array_length(d->'variations')>20 or jsonb_typeof(d->'modifierSets') is distinct from 'array' or jsonb_array_length(d->'modifierSets')>6
 or (d->>'variablePrice')::boolean and jsonb_array_length(d->'variations')>0 then raise exception 'VALIDATION_ERROR'; end if;
 for v in select * from jsonb_array_elements(d->'variations') loop
   if jsonb_typeof(v) is distinct from 'object' or not v ?& array['id','name','priceCents','sku','barcode','soldOut'] or (select count(*) from jsonb_object_keys(v))<>6
   or jsonb_typeof(v->'name') is distinct from 'string' or char_length(btrim(v->>'name')) not between 1 and 60 or v->>'name' ~ '[\x01-\x1f\x7f]'
   or jsonb_typeof(v->'sku') is distinct from 'string' or char_length(v->>'sku')>60 or v->>'sku' ~ '[\x01-\x1f\x7f]'
   or jsonb_typeof(v->'barcode') is distinct from 'string' or char_length(v->>'barcode')>32 or v->>'barcode' ~ '[\x01-\x1f\x7f]'
   or jsonb_typeof(v->'soldOut') is distinct from 'boolean' or jsonb_typeof(v->'priceCents') is distinct from 'number' or v->>'priceCents' !~ '^[0-9]+$' or (v->>'priceCents')::numeric>99999999 then raise exception 'VALIDATION_ERROR'; end if;
   perform (v->>'id')::uuid; if v->>'id' is null then raise exception 'VALIDATION_ERROR'; end if; ids:=array_append(ids,v->>'id');
 end loop;
 for s in select * from jsonb_array_elements(d->'modifierSets') loop
   if jsonb_typeof(s) is distinct from 'object' or not s ?& array['id','name','min','max','options'] or (select count(*) from jsonb_object_keys(s))<>5
   or jsonb_typeof(s->'name') is distinct from 'string' or char_length(btrim(s->>'name')) not between 1 and 60 or s->>'name' ~ '[\x01-\x1f\x7f]'
   or jsonb_typeof(s->'options') is distinct from 'array' or jsonb_array_length(s->'options') not between 1 and 12
   or jsonb_typeof(s->'min') is distinct from 'number' or jsonb_typeof(s->'max') is distinct from 'number' or s->>'min' !~ '^[0-9]+$' or s->>'max' !~ '^[0-9]+$'
   or (s->>'min')::numeric>(s->>'max')::numeric or (s->>'max')::numeric not between 1 and jsonb_array_length(s->'options') then raise exception 'VALIDATION_ERROR'; end if;
   perform (s->>'id')::uuid; if s->>'id' is null then raise exception 'VALIDATION_ERROR'; end if; ids:=array_append(ids,s->>'id');
   for o in select * from jsonb_array_elements(s->'options') loop
     if jsonb_typeof(o) is distinct from 'object' or not o ?& array['id','name','priceCents'] or (select count(*) from jsonb_object_keys(o))<>3
     or jsonb_typeof(o->'name') is distinct from 'string' or char_length(btrim(o->>'name')) not between 1 and 60 or o->>'name' ~ '[\x01-\x1f\x7f]'
     or jsonb_typeof(o->'priceCents') is distinct from 'number' or o->>'priceCents' !~ '^[0-9]+$' or (o->>'priceCents')::numeric>99999999 then raise exception 'VALIDATION_ERROR'; end if;
     perform (o->>'id')::uuid; if o->>'id' is null then raise exception 'VALIDATION_ERROR'; end if; ids:=array_append(ids,o->>'id');
   end loop;
 end loop;
 if (select coalesce(sum((group_details->>'min')::integer),0)
     from jsonb_array_elements(d->'modifierSets') group_details)>24 then
   raise exception 'VALIDATION_ERROR';
 end if;
 if cardinality(ids)<>(select count(distinct i) from unnest(ids) i) then raise exception 'VALIDATION_ERROR'; end if;
end;
$$;

revoke all on function app_private.validate_product_details(uuid,jsonb) from public,anon,authenticated;

-- Public order/receipt labels are captured from the same-tenant catalog only when
-- a line is created. Kitchen labels remain independent, and updates preserve the
-- accepted snapshot. Amount-only lines have no product and retain their own name.
create function app_private.catalog_customer_name_snapshot() returns trigger
language plpgsql set search_path='' as $$
declare customer_name text;
begin
 if new.product_id is null then return new; end if;
 select nullif(btrim(p.details->>'customerName'),'') into customer_name
 from app_private.products p
 where p.business_id=new.business_id and p.id=new.product_id;
 if customer_name is not null then new.name:=customer_name; end if;
 return new;
end;
$$;
create trigger catalog_customer_name_snapshot before insert on app_private.order_lines
 for each row execute function app_private.catalog_customer_name_snapshot();
revoke all on function app_private.catalog_customer_name_snapshot() from public,anon,authenticated;
