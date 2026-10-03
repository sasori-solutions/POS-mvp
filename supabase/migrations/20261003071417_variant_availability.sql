-- Availability grant changes only the manual flag, never prices or quantities.
do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.legacy_pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$update app_private.products set details=jsonb_set(details,'{soldOut}',p_payload->'soldOut'),version=version+1,updated_at=clock_timestamp()
        where business_id=p_business_id and id=v_product.id returning * into v_product;$old$;
 replacement:=$new$if p_payload ? 'variationId' then
        if jsonb_typeof(p_payload->'variationId') is distinct from 'string' or not exists(
          select 1 from jsonb_array_elements(v_product.details->'variations') v where v->>'id'=p_payload->>'variationId') then raise exception 'VALIDATION_ERROR'; end if;
        update app_private.products set details=jsonb_set(details,'{variations}',(select jsonb_agg(
          case when v->>'id'=p_payload->>'variationId' then jsonb_set(v,'{soldOut}',p_payload->'soldOut') else v end order by ordinal)
          from jsonb_array_elements(details->'variations') with ordinality t(v,ordinal))),version=version+1,updated_at=clock_timestamp()
          where business_id=p_business_id and id=v_product.id returning * into v_product;
      else
        update app_private.products set details=jsonb_set(details,'{soldOut}',p_payload->'soldOut'),version=version+1,updated_at=clock_timestamp()
          where business_id=p_business_id and id=v_product.id returning * into v_product;
      end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected availability dispatch'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
