-- Checkout finalizes the account when an attempt is prepared, without a separate
-- UI step. Confirmed payments enqueue only paid quantities not already sent.
-- All effects stay inside the existing authorized, idempotent business transaction.
do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$elsif c='prepare_checkout' then
   if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;$old$;
 replacement:=$new$elsif c='prepare_checkout' then
   if o.status<>'open' or o.phase not in ('service','checkout') then raise exception 'ORDER_LOCKED'; end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected checkout phase guard'; end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$update app_private.operational_orders set revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_attempt_json(a);$old$;
 replacement:=$new$update app_private.operational_orders set phase='checkout',revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_attempt_json(a);$new$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected checkout preparation update'; end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$update app_private.operational_orders set frozen=true,status=case when exists(select 1 from app_private.order_lines where business_id=p_business_id and order_id=o.id and quantity>paid_quantity) then 'open' else 'paid' end,$old$;
 replacement:=$new$-- Previous manual sends remain valid; repeated or split payments never
    -- enqueue them again. The immutable batch uses accepted kitchen snapshots.
    select jsonb_agg(jsonb_build_object('lineId',ol.id,'name',ol.kitchen_name,'selectionLabel',ol.selection_label,'note',ol.note,'quantity',ol.paid_quantity-ol.sent_quantity) order by ol.id) into lines
     from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and ol.paid_quantity>ol.sent_quantity;
    if lines is not null then
     insert into app_private.kitchen_batches(business_id,order_id,order_name,table_name,kind,items,actor_id,actor_name)
      values(p_business_id,o.id,o.name,(select name from app_private.dining_tables where business_id=p_business_id and id=o.table_id),'items',lines,a.actor_id,a.operator_name);
     update app_private.order_lines set sent_quantity=greatest(sent_quantity,paid_quantity) where business_id=p_business_id and order_id=o.id;
    end if;
    update app_private.operational_orders set frozen=true,status=case when exists(select 1 from app_private.order_lines where business_id=p_business_id and order_id=o.id and quantity>paid_quantity) then 'open' else 'paid' end,$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected payment completion update'; end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$if a.kind='payment' and p->>'resolution'='abort' then
    update app_private.operational_orders set revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=a.order_id returning * into o;$old$;
 replacement:=$new$if a.kind='payment' and p->>'resolution'='abort' then
    update app_private.operational_orders set phase=case when not frozen and status='open' then 'service' else phase end,
     revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=a.order_id returning * into o;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected aborted payment update'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
