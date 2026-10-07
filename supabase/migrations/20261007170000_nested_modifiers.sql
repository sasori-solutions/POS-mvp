-- Conditional groups remain product-local even when their definitions are shared.
create function app_private.validate_modifier_hierarchy(groups jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare g jsonb; current_group jsonb; parent_group jsonb; seen uuid[]; depth integer;
begin
 if jsonb_typeof(groups) is distinct from 'array' or jsonb_array_length(groups)>6 then raise exception 'VALIDATION_ERROR'; end if;
 for g in select * from jsonb_array_elements(groups) loop
  current_group:=g; seen:=array[app_private.ops_uuid(g->'id')]; depth:=1;
  while current_group ? 'parentOptionId' loop
   perform app_private.ops_uuid(current_group->'parentOptionId');
   select s into parent_group from jsonb_array_elements(groups) s where exists(select 1 from jsonb_array_elements(s->'options') o where o->>'id'=current_group->>'parentOptionId');
   if not found or app_private.ops_uuid(parent_group->'id')=any(seen) then raise exception 'VALIDATION_ERROR'; end if;
   depth:=depth+1; if depth>3 then raise exception 'VALIDATION_ERROR'; end if;
   seen:=array_append(seen,app_private.ops_uuid(parent_group->'id')); current_group:=parent_group;
  end loop;
 end loop;
end; $$;

alter function app_private.validate_product_details(uuid,jsonb) rename to validate_product_details_before_nested_modifiers;
create function app_private.validate_product_details(p_business uuid,d jsonb) returns void
language plpgsql set search_path='' as $$
begin
 perform app_private.validate_modifier_hierarchy(d->'modifierSets');
 perform app_private.validate_product_details_before_nested_modifiers(p_business,jsonb_set(d,'{modifierSets}',
  coalesce((select jsonb_agg(g-'parentOptionId' order by position) from jsonb_array_elements(d->'modifierSets') with ordinality groups(g,position)),'[]')));
end; $$;

create function app_private.modifier_option_available(groups jsonb,option_id text,depth integer default 1)
returns boolean language plpgsql immutable set search_path='' as $$
declare option jsonb; child_group jsonb; child jsonb; capacity integer;
begin
 if depth>3 then return false; end if;
 select o into option from jsonb_array_elements(groups) g cross join lateral jsonb_array_elements(g->'options') o where o->>'id'=option_id;
 if not found or coalesce((option->>'soldOut')::boolean,false) then return false; end if;
 for child_group in select * from jsonb_array_elements(groups) g where g->>'parentOptionId'=option_id loop
  capacity:=0;
  for child in select * from jsonb_array_elements(child_group->'options') loop
   if app_private.modifier_option_available(groups,child->>'id',depth+1) then capacity:=capacity+coalesce((child->>'maxQuantity')::integer,1); end if;
  end loop;
  if least(capacity,24)<(child_group->>'min')::integer then return false; end if;
 end loop;
 return true;
end; $$;

create or replace function app_private.propagate_modifier_group(g app_private.modifier_groups) returns jsonb
language plpgsql set search_path='' as $$
declare item app_private.products%rowtype; next_details jsonb; result jsonb:='[]';
begin
 for item in select prod.* from app_private.products prod join app_private.product_modifier_groups link
  on link.business_id=prod.business_id and link.product_id=prod.id
  where link.business_id=g.business_id and link.group_id=g.id and prod.deleted_at is null order by prod.id for update of prod loop
  next_details:=jsonb_set(item.details,'{modifierSets}',(select jsonb_agg(case when x->>'libraryId'=g.id::text then g.details||jsonb_build_object('libraryId',g.id)||case when x ? 'parentOptionId' then jsonb_build_object('parentOptionId',x->'parentOptionId') else '{}'::jsonb end else x end order by position)
   from jsonb_array_elements(item.details->'modifierSets') with ordinality sets(x,position)));
  perform app_private.validate_product_details(g.business_id,next_details);
  update app_private.products set details=next_details,version=version+1,updated_at=clock_timestamp() where business_id=item.business_id and id=item.id returning * into item;
  result:=result||jsonb_build_array(app_private.product_json(item));
 end loop;
 return result;
end; $$;

create or replace function app_private.product_selection(p app_private.products,s jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare price bigint:=p.price_cents; label text:=''; v jsonb; g jsonb; o jsonb;
 quantity integer; selected_count integer; capacity integer; count_ids integer:=0; identity jsonb;
begin
 if s is not null then
  perform app_private.ops_exact(s,array['variationId','modifierIds','variablePriceCents']);
  if jsonb_typeof(s->'modifierIds') is distinct from 'array' or jsonb_array_length(s->'modifierIds')>24 then raise exception 'VALIDATION_ERROR'; end if;
  for identity in select * from jsonb_array_elements(s->'modifierIds') loop perform app_private.ops_uuid(identity); end loop;
 end if;
 if coalesce((p.details->>'soldOut')::boolean,false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
 if coalesce(jsonb_array_length(p.details->'variations'),0)>0 then
  select x into v from jsonb_array_elements(p.details->'variations') x where x->>'id'=s->>'variationId';
  if v is null then raise exception 'VALIDATION_ERROR'; end if;
  if (v->>'soldOut')::boolean then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  price:=(v->>'priceCents')::integer; label:=v->>'name';
 elsif s->>'variationId' is not null then raise exception 'VALIDATION_ERROR'; end if;
 if coalesce((p.details->>'variablePrice')::boolean,false) then
  price:=app_private.ops_int(s->'variablePriceCents',0,99999999);
 elsif s->>'variablePriceCents' is not null then raise exception 'VALIDATION_ERROR'; end if;
 for g in select * from jsonb_array_elements(coalesce(p.details->'modifierSets','[]'::jsonb)) loop
  if g ? 'parentOptionId' and not coalesce(s->'modifierIds' ? (g->>'parentOptionId'),false) then continue; end if;
  selected_count:=0; capacity:=0;
  for o in select * from jsonb_array_elements(g->'options') loop
   if app_private.modifier_option_available(p.details->'modifierSets',o->>'id') then capacity:=capacity+coalesce((o->>'maxQuantity')::integer,1); end if;
   select count(*)::integer into quantity from jsonb_array_elements_text(coalesce(s->'modifierIds','[]')) x where x=o->>'id';
   if quantity>0 then
    if not app_private.modifier_option_available(p.details->'modifierSets',o->>'id') then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    if quantity>coalesce((o->>'maxQuantity')::integer,1) then raise exception 'VALIDATION_ERROR'; end if;
    price:=price+(o->>'priceCents')::bigint*quantity;
    label:=concat_ws(', ',nullif(label,''),case when quantity>1 then quantity::text||' × ' else '' end|| (o->>'name'));
    selected_count:=selected_count+quantity; count_ids:=count_ids+quantity;
   end if;
  end loop;
  if capacity<(g->>'min')::integer then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  if selected_count<(g->>'min')::integer or selected_count>(g->>'max')::integer then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if count_ids<>coalesce(jsonb_array_length(s->'modifierIds'),0) or price not between 0 and 99999999 then raise exception 'VALIDATION_ERROR'; end if;
 return jsonb_build_object('price',price,'label',label);
end; $$;


revoke all on function app_private.validate_modifier_hierarchy(jsonb),app_private.validate_product_details(uuid,jsonb),app_private.validate_product_details_before_nested_modifiers(uuid,jsonb),
 app_private.modifier_option_available(jsonb,text,integer),app_private.propagate_modifier_group(app_private.modifier_groups),app_private.product_selection(app_private.products,jsonb) from public,anon,authenticated;
