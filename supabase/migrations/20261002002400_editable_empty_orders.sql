-- An existing service account can be emptied and refilled before collection.
-- New accounts and checkout still require items; sent/paid lines retain their guards.
do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into definition;
 needle:=$old$jsonb_array_length(p->'items') not between 1 and 40$old$;
 replacement:=$new$jsonb_array_length(p->'items') not between
   (case when c='save_order' and p->'expectedRevision'<>'null'::jsonb then 0 else 1 end) and 40$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational item validation'; end if;
 execute replace(definition,needle,replacement);

 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 -- jsonb_agg returns SQL NULL for an empty array. Keep canonical payloads and
 -- operation fingerprints intact so an empty edit remains safely retryable.
 needle:=$old$select jsonb_agg(i order by i->>'lineId') into lines from jsonb_array_elements(p->'items') i;$old$;
 replacement:=$new$select coalesce(jsonb_agg(i order by i->>'lineId'),'[]'::jsonb) into lines from jsonb_array_elements(p->'items') i;$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>2 then
  raise exception 'Unexpected operational item normalization';
 end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$delete from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and not exists(select 1 from jsonb_array_elements(p->'items') i where i->>'lineId'=ol.id::text);
  perform app_private.ops_price_order(p_business_id,o.id);$old$;
 replacement:=$new$delete from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and not exists(select 1 from jsonb_array_elements(p->'items') i where i->>'lineId'=ol.id::text);
  if jsonb_array_length(p->'items')=0 then
   update app_private.operational_orders set discount=null where business_id=p_business_id and id=o.id returning * into o;
  end if;
  perform app_private.ops_price_order(p_business_id,o.id);$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational item replacement'; end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$if c='begin_order_checkout' then
    if o.phase<>'service' then raise exception 'ORDER_LOCKED'; end if;$old$;
 replacement:=needle||$new$
    if not exists(select 1 from app_private.order_lines where business_id=p_business_id and order_id=o.id) then raise exception 'VALIDATION_ERROR'; end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational checkout guard'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
