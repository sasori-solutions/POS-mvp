-- Availability is manual. Preserve historical inventory metadata without using it
-- to authorize lines or changing it when an old/new client saves a product.
create function app_private.manual_availability_details(p_details jsonb,p_previous jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select case when p_details is null then coalesce(p_previous,'{}'::jsonb) else
   p_details || jsonb_build_object(
     'trackStock',coalesce(p_previous->'trackStock','false'::jsonb),
     'stock',coalesce(p_previous->'stock','0'::jsonb),
     'lowStockAlert',coalesce(p_previous->'lowStockAlert','5'::jsonb)) end;
$$;
revoke all on function app_private.manual_availability_details(jsonb,jsonb) from public,anon,authenticated;

create or replace function app_private.product_json(p_product app_private.products)
returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('id',p_product.id,'name',p_product.name,'category',p_product.category,'priceCents',p_product.price_cents,'active',p_product.active,'version',p_product.version,
   'details',p_product.details || '{"trackStock":false}'::jsonb,
   'image',(select 'data:image/jpeg;base64,'||data from app_private.product_images where business_id=p_product.business_id and id=(p_product.details->>'imageId')::uuid));
$$;
revoke all on function app_private.product_json(app_private.products) from public,anon,authenticated;

-- Patch the preceding dispatcher instead of replacing its permission checks,
-- tenant restrictions, replay ordering or other already-applied contracts.
do $migration$
declare
 definition text;
 quantity_gate text := $needle$      if coalesce((v_product.details->>'trackStock')::boolean,false) and (v_product.details->>'stock')::integer < (select sum((i->>'quantity')::integer) from jsonb_array_elements(v_items) i where i->>'productId'=v_product.id::text) then raise exception 'PRODUCT_UNAVAILABLE'; end if;$needle$;
 quantity_debit text := $needle$    update app_private.products p set version=p.version+1,details=jsonb_set(p.details,'{stock}',to_jsonb((p.details->>'stock')::integer-q.quantity)),updated_at=clock_timestamp()
      from (select (i->>'productId')::uuid id,sum((i->>'quantity')::integer)::integer quantity from jsonb_array_elements(v_items) i group by 1) q
      where p.business_id=p_business_id and p.id=q.id and coalesce((p.details->>'trackStock')::boolean,false);$needle$;
 insert_details text := $needle$coalesce(p_payload->'details','{}'::jsonb)$needle$;
 update_details text := $needle$details=coalesce(p_payload->'details',details)$needle$;
begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 if position(quantity_gate in definition)=0 or position(quantity_debit in definition)=0
   or position(insert_details in definition)=0 or position(update_details in definition)=0 then
   raise exception 'Unexpected POS function revision for manual availability';
 end if;
 definition:=replace(definition,quantity_gate,'');
 definition:=replace(definition,quantity_debit,'');
 definition:=replace(definition,insert_details,$replacement$app_private.manual_availability_details(p_payload->'details',null)$replacement$);
 definition:=replace(definition,update_details,$replacement$details=app_private.manual_availability_details(p_payload->'details',details)$replacement$);
 execute definition;
end;
$migration$;
revoke all on function app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
