-- Reserve before external collection; one final click still records payment,
-- immutable sale, cash effect and comanda atomically.
create function app_private.ops_batch_prepared(b app_private.kitchen_batches) returns boolean
language sql stable set search_path='' as $$
 select b.status in ('preparing','ready','delivered') or exists (
  select 1 from app_private.order_events e where e.business_id=b.business_id and e.order_id=b.order_id
   and e.kind='set_kitchen_status' and e.payload->>'batchId'=b.id::text
   and e.payload->>'status' in ('preparing','ready','delivered'));
$$;
revoke all on function app_private.ops_batch_prepared(app_private.kitchen_batches) from public,anon,authenticated;
-- Recover legacy preparation facts normalized by 0028. The UI still displays
-- these as pending; financial cancellation must retain the original history.
update app_private.kitchen_batches b set status=history.status,revision=b.revision+1
 from (select distinct on (business_id,payload->>'batchId') business_id,payload->>'batchId' batch_id,payload->>'status' status
  from app_private.order_events where kind='set_kitchen_status'
  order by business_id,payload->>'batchId',created_at desc,id desc) history
 where b.business_id=history.business_id and b.id::text=history.batch_id and b.status='queued'
 and history.status in ('preparing','ready');

do $patch$ declare definition text; needle text; replacement text; first_at integer; last_at integer; begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into definition;
 needle:=$old$when 'prepare_checkout' then array['operationId','orderId','expectedRevision','items','paymentMethod']$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected reservation validation'; end if;
 definition:=replace(definition,needle,needle||$new$
 when 'update_checkout' then array['operationId','attemptId','expectedRevision','items','paymentMethod']
 when 'record_checkout' then array['operationId','attemptId','expectedRevision','confirmed']$new$);
 definition:=replace(definition,$old$c in ('prepare_checkout','record_payment') and$old$,$new$c in ('prepare_checkout','record_payment','update_checkout') and$new$);
 definition:=replace(definition,$old$c in ('confirm_waiver','record_payment') and$old$,$new$c in ('confirm_waiver','record_payment','record_checkout') and$new$);
 definition:=replace(definition,$old$c in ('save_order','prepare_checkout','record_payment') then$old$,$new$c in ('save_order','prepare_checkout','record_payment','update_checkout') then$new$);
 execute definition;

 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,$old$c in ('attempt','start_checkout','mark_checkout_uncertain','resolve_checkout') then$old$,$new$c in ('attempt','start_checkout','mark_checkout_uncertain','resolve_checkout','update_checkout','record_checkout') then$new$);
 definition:=replace(definition,$old$if a.kind='reversal' then permitted:=$old$,$new$if c in ('update_checkout','record_checkout') and a.kind<>'payment' then raise exception 'PERMISSION_DENIED'; end if;
  if a.kind='reversal' then permitted:=$new$);
 definition:=replace(definition,$old$c in ('save_order','prepare_checkout','record_payment') then$old$,$new$c in ('save_order','prepare_checkout','record_payment','update_checkout') then$new$);
 definition:=replace(definition,$old$kb.status in ('preparing','ready','delivered')$old$,$new$app_private.ops_batch_prepared(kb)$new$);
 first_at:=position($old$if c='record_payment' then
  -- Parent UUID$old$ in definition);
 last_at:=position($old$elsif c='activate_operations' then$old$ in definition);
 if first_at=0 or last_at<=first_at then raise exception 'Unexpected payment dispatch'; end if;
 replacement:=$new$if c='record_payment' then
  -- Accepted legacy UUIDs replay above. New payments must reserve first.
  raise exception 'ATTEMPT_STATE_INVALID';
 elsif c in ('update_checkout','record_checkout') then
  select * into a from app_private.checkout_attempts where business_id=p_business_id and id=(p->>'attemptId')::uuid for update;
  if a.revision<>(p->>'expectedRevision')::integer then raise exception 'ATTEMPT_CHANGED'; end if;
  if a.status<>'prepared' then raise exception 'ATTEMPT_STATE_INVALID'; end if;
  select * into s from app_private.cash_shifts where business_id=p_business_id and id=a.shift_id for update;
  if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
  select * into o from app_private.operational_orders where business_id=p_business_id and id=a.order_id for update;
  if c='update_checkout' then
   if not (business.profile->'paymentMethods' ? (p->>'paymentMethod')) then raise exception 'PAYMENT_METHOD_DISABLED'; end if;
   slices:='[]'::jsonb; total:=0; tax:=0; discount:=0;
   for line in select * from jsonb_array_elements(p->'items') loop
    select * into l from app_private.order_lines where business_id=p_business_id and order_id=o.id and id=(line->>'lineId')::uuid;
    qty:=(line->>'quantity')::integer;
    if l.id is null or qty>l.quantity-l.paid_quantity then raise exception 'ORDER_CHANGED'; end if;
    pricing:=app_private.ops_slice(l,qty); slices:=slices||jsonb_build_array(pricing);
    total:=total+(pricing->>'totalCents')::bigint; tax:=tax+(pricing->>'taxCents')::bigint; discount:=discount+(pricing->>'discountCents')::bigint;
   end loop;
   update app_private.checkout_attempts set payment_method=p->>'paymentMethod',items=slices,total_cents=total,tax_cents=tax,discount_cents=discount,
    revision=checkout_attempts.revision+1 where business_id=p_business_id and id=a.id returning * into a;
   result:=app_private.ops_attempt_json(a);
  else
   result:=app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
    'command','start_checkout','operationId',pg_catalog.gen_random_uuid(),'attemptId',a.id,'expectedRevision',a.revision))->'data';
   result:=app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
    'command','resolve_checkout','operationId',pg_catalog.gen_random_uuid(),'attemptId',result->'id','expectedRevision',result->'revision',
    'resolution','complete','confirmed',true,'reason','Pago registrado'))->'data';
   select * into o from app_private.operational_orders where business_id=p_business_id and id=a.order_id;
   if o.status='paid' then
    perform app_private.pos_command(p_business_id,p_employee_id,jsonb_build_object(
     'command','close_order','operationId',pg_catalog.gen_random_uuid(),'orderId',o.id,'expectedRevision',o.revision));
    select * into o from app_private.operational_orders where business_id=p_business_id and id=a.order_id;
   end if;
   result:=jsonb_build_object('order',app_private.ops_order_json(o),'attempt',result);
  end if;
 $new$;
 definition:=substring(definition from 1 for first_at-1)||replacement||substring(definition from last_at);
 execute definition;
end $patch$;
