-- One manual payment command: sale, cash totals and comanda commit together.
-- Reuse the authorized checkout transitions within this single transaction.
-- Their intermediate states cannot escape or survive a failed registration.
do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into definition;
 needle:=$old$when 'prepare_checkout' then array['operationId','orderId','expectedRevision','items','paymentMethod']$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected checkout validation'; end if;
 definition:=replace(definition,needle,needle||$new$
 when 'record_payment' then array['operationId','orderId','expectedRevision','items','paymentMethod','confirmed']$new$);
 definition:=replace(definition,$old$or c='prepare_checkout' and$old$,$new$or c in ('prepare_checkout','record_payment') and$new$);
 definition:=replace(definition,$old$or c='confirm_waiver' and$old$,$new$or c in ('confirm_waiver','record_payment') and$new$);
 needle:=$old$if c='save_order' or c='prepare_checkout' then$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected checkout item validation'; end if;
 execute replace(definition,needle,$new$if c in ('save_order','prepare_checkout','record_payment') then$new$);

 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,$old$when 'prepare_checkout' then 'sales.create'$old$,$new$when 'record_payment' then 'sales.create' when 'prepare_checkout' then 'sales.create'$new$);
 definition:=replace(definition,$old$if c='prepare_checkout' and not$old$,$new$if c in ('prepare_checkout','record_payment') and not$new$);
 definition:=replace(definition,$old$if c in ('save_order','prepare_checkout') then$old$,$new$if c in ('save_order','prepare_checkout','record_payment') then$new$);
 needle:=$old$if c='activate_operations' then
  insert into app_private.operational_settings$old$;
 replacement:=$new$if c='record_payment' then
  -- Parent UUID/fingerprint and current authorization were checked before replay.
  -- Child operation IDs are transaction-local; rollback removes every child.
  result:=app_private.pos_command(p_business_id,p_employee_id,
   (p-'confirmed')||jsonb_build_object('command','prepare_checkout','operationId',pg_catalog.gen_random_uuid()))->'data';
  result:=app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
   'command','start_checkout','operationId',pg_catalog.gen_random_uuid(),
   'attemptId',result->'id','expectedRevision',result->'revision'))->'data';
  result:=app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
   'command','resolve_checkout','operationId',pg_catalog.gen_random_uuid(),
   'attemptId',result->'id','expectedRevision',result->'revision',
   'resolution','complete','confirmed',true,'reason','Pago registrado'))->'data';
  select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id;
  -- No separate table-release/account-close step for a fully paid order.
  if o.status='paid' then
   perform app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
    'command','close_order','operationId',pg_catalog.gen_random_uuid(),
    'orderId',o.id,'expectedRevision',o.revision));
   select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id;
  end if;
  result:=jsonb_build_object('order',app_private.ops_order_json(o),'attempt',result);
 elsif c='activate_operations' then
  insert into app_private.operational_settings$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational dispatch'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
