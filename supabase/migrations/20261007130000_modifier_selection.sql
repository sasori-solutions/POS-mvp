-- Whole extras use the bounded historical identity array: each occurrence is
-- one unit. Legacy options still allow exactly one unit unless configured.
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
  selected_count:=0; capacity:=0;
  for o in select * from jsonb_array_elements(g->'options') loop
   if not coalesce((o->>'soldOut')::boolean,false) then capacity:=capacity+coalesce((o->>'maxQuantity')::integer,1); end if;
   select count(*)::integer into quantity from jsonb_array_elements_text(coalesce(s->'modifierIds','[]')) x where x=o->>'id';
   if quantity>0 then
    if coalesce((o->>'soldOut')::boolean,false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
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

-- The free-amount migration delegates to ops_validate_before_amount. Remove
-- only its obsolete uniqueness check; UUID/shape/quantity validation stays.
-- Guarding one exact occurrence makes a changed predecessor fail closed.
do $$
declare definition text:=pg_get_functiondef('app_private.ops_validate_before_amount(jsonb)'::regprocedure);
 needle text:='      or (select count(distinct m) from jsonb_array_elements(i#>''{selection,modifierIds}'') m)<>jsonb_array_length(i#>''{selection,modifierIds}'')';
begin
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'MODIFIER_VALIDATOR_PREDECESSOR_CHANGED'; end if;
 execute replace(definition,needle,'');
end; $$;
revoke all on function app_private.product_selection(app_private.products,jsonb),app_private.ops_validate_before_amount(jsonb) from public,anon,authenticated;
