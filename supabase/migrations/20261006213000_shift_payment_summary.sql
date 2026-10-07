-- Receipts are attributed through their accepted checkout, not calendar dates.
-- Provider refunds lack a shift_id; preserve that limitation rather than invent
-- a refund shift or change immutable financial history.
create index checkout_shift_receipts_idx on app_private.checkout_attempts(business_id,shift_id,sale_id)
 where kind='payment' and status='completed' and sale_id is not null;
create index sale_reversals_shift_method_idx on app_private.sale_reversals(business_id,shift_id,payment_method);

create function app_private.ops_shift_payment_summary(p_business uuid,p_shift uuid)
returns jsonb language sql stable set search_path='' as $$
 with methods(payment_method,position) as (
  values ('cash',1),('card_external',2),('card_integrated',3),('transfer',4)
 ), collected as (
  select sale.payment_method,sum(sale.total_cents) amount
  from app_private.sales sale
  where sale.business_id=p_business and exists (
   select 1 from app_private.checkout_attempts attempt
   where attempt.business_id=p_business and attempt.shift_id=p_shift
    and attempt.kind='payment' and attempt.status='completed' and attempt.sale_id=sale.id
  ) group by sale.payment_method
 ), refunded as (
  select reversal.payment_method,sum(reversal.amount_cents) amount
  from app_private.sale_reversals reversal
  where reversal.business_id=p_business and reversal.shift_id=p_shift
  group by reversal.payment_method
 ), totals as (
  select methods.payment_method,methods.position,coalesce(collected.amount,0) collected_cents,
   coalesce(refunded.amount,0) refunded_cents
  from methods left join collected using(payment_method) left join refunded using(payment_method)
 ) select jsonb_build_object(
  'collectedCents',sum(collected_cents),'refundedCents',sum(refunded_cents),
  'netCents',sum(collected_cents)-sum(refunded_cents),'pointRefundsNotAttributed',true,
  'payments',jsonb_agg(jsonb_build_object('paymentMethod',payment_method,
   'collectedCents',collected_cents,'refundedCents',refunded_cents,
   'netCents',collected_cents-refunded_cents) order by position)
 ) from totals;
$$;

-- Keep the existing projection and add an optional summary outside blind count.
-- Accepted mutations store this JSON once. Replays still return their original
-- stored response, including responses accepted before this migration.
create or replace function app_private.ops_shift_json(s app_private.cash_shifts)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'revision',s.revision,'status',s.status,'openedAt',s.opened_at,'closedAt',s.closed_at,'openedBy',s.opener_name,'closedBy',s.closer_name,
 'openingCents',s.opening_cents,'countedCents',s.counted_cents,'expectedCents',s.expected_cents,'differenceCents',s.difference_cents,
 'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'kind',m.kind,'amountCents',m.amount_cents,'reason',m.reason,'actorName',m.actor_name,'createdAt',m.created_at) order by m.created_at,m.id) from app_private.cash_movements m where m.business_id=s.business_id and m.shift_id=s.id),'[]'::jsonb))
 ||case when s.status='closing' then '{}'::jsonb else jsonb_build_object('paymentSummary',app_private.ops_shift_payment_summary(s.business_id,s.id)) end;
$$;

-- Delegate all validation, authorization and replay to the existing dispatcher.
-- Its operations badge masks cash fields for sales/reversal-only operators;
-- apply the same boundary to the newly added field after that live check.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_shift_summary;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 result:=app_private.pos_command_before_shift_summary(p_business_id,p_employee_id,p_payload);
 if p_payload->>'command'='operations'
  and not app_private.has_permission(p_business_id,p_employee_id,'cash.read')
  and jsonb_typeof(result#>'{data,shift}')='object' then
  result:=jsonb_set(result,'{data,shift}',(result#>'{data,shift}')-'paymentSummary');
 end if;
 return result;
end; $$;

revoke all on function app_private.ops_shift_payment_summary(uuid,uuid),app_private.ops_shift_json(app_private.cash_shifts),app_private.pos_command_before_shift_summary(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.pos_command_before_shift_summary(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) to service_role;
