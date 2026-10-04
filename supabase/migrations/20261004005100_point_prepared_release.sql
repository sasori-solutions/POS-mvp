-- A local reservation can be released before any provider operation exists.
-- Preserve normal actor/grant/revision/UUID validation in the original command.
create or replace function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare reservation app_private.checkout_attempts%rowtype; cmd text:=p_payload->>'command';
begin
 if cmd in ('start_checkout','mark_checkout_uncertain','resolve_checkout','update_checkout','record_checkout') then
  select * into reservation from app_private.checkout_attempts where business_id=p_business_id and id=(p_payload->>'attemptId')::uuid;
  if reservation.payment_method='card_integrated' then
   if cmd in ('resolve_checkout','update_checkout') and exists(select 1 from app_private.pos_operations where business_id=p_business_id and operation_id=(p_payload->>'operationId')::uuid) then
    return app_private.pos_command_before_point(p_business_id,p_employee_id,p_payload);
   end if;
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
   select * into reservation from app_private.checkout_attempts where business_id=p_business_id and id=reservation.id for update;
   if cmd='resolve_checkout' and p_payload->>'resolution'='abort' and reservation.status='prepared'
    and not exists(select 1 from app_private.point_checkouts c join app_private.point_attempts a on a.business_id=c.business_id and a.checkout_id=c.id
     where c.business_id=p_business_id and c.checkout_attempt_id=reservation.id) then
    return app_private.pos_command_before_point(p_business_id,p_employee_id,p_payload);
   end if;
   if cmd='update_checkout' and reservation.status='prepared'
    and not exists(select 1 from app_private.point_checkouts where business_id=p_business_id and checkout_attempt_id=reservation.id) then
    return app_private.pos_command_before_point(p_business_id,p_employee_id,p_payload);
   end if;
   raise exception 'POINT_RESULT_UNCERTAIN';
  end if;
 end if;
 if cmd='complete_sale' and p_payload->>'paymentMethod'='card_integrated' then raise exception 'POINT_STATE_INVALID'; end if;
 if cmd='prepare_reversal' and exists(select 1 from app_private.sales where business_id=p_business_id and id=(p_payload->>'saleId')::uuid and payment_method='card_integrated') then raise exception 'POINT_STATE_INVALID'; end if;
 return app_private.pos_command_before_point(p_business_id,p_employee_id,p_payload);
end $$;
revoke all on function app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;

-- Retrying local cancellation after a lost response keeps the accepted status.
do $patch$ declare d text; begin
 select pg_get_functiondef('app_private.point_command(uuid,uuid,jsonb)'::regprocedure) into d;
 d:=replace(d,$old$where business_id=p_business and id=q.id;
  elsif a.state$old$,$new$where business_id=p_business and id=q.id and status='prepared';
  elsif a.state$new$);
 execute d;
end $patch$;
