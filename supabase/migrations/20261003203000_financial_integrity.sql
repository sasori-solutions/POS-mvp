-- Financial integrity is enforced at the private database boundary as well as
-- by the authorized command state machine. No historical values are repaired.
-- These guards protect against programming mistakes by privileged writers;
-- database administrators can still intentionally alter database definitions.

create function app_private.ops_quote_totals_valid(p_items jsonb,p_total bigint,p_discount bigint,p_tax bigint)
returns boolean language plpgsql immutable set search_path='' as $$
declare i jsonb; quantity bigint; price bigint; discount bigint; total bigint; tax bigint;
 sum_total numeric:=0; sum_discount numeric:=0; sum_tax numeric:=0; ids uuid[]:='{}'; line_id uuid;
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 40 then return false; end if;
 for i in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(i) is distinct from 'object' then return false; end if;
  line_id:=app_private.ops_uuid(i->'lineId');
  perform app_private.ops_uuid(i->'productId');
  if line_id=any(ids) then return false; end if;
  ids:=array_append(ids,line_id);
  quantity:=app_private.ops_int(i->'quantity',1,999);
  price:=app_private.ops_int(i->'unitPriceCents',0,99999999);
  discount:=app_private.ops_int(i->'discountCents',0,9999999999);
  total:=app_private.ops_int(i->'totalCents',0,9999999999);
  tax:=app_private.ops_int(i->'taxCents',0,9999999999);
  if total<>quantity*price-discount or discount>quantity*price or tax>total then return false; end if;
  sum_total:=sum_total+total; sum_discount:=sum_discount+discount; sum_tax:=sum_tax+tax;
 end loop;
 return sum_total=p_total and sum_discount=p_discount and sum_tax=p_tax;
exception when others then return false;
end; $$;
alter table app_private.checkout_attempts add constraint checkout_attempts_exact_snapshot
 check(app_private.ops_quote_totals_valid(items,total_cents,discount_cents,tax_cents));
-- Whole order lines carry a known accepted rate. Receipt slices retain prefix
-- allocations and legacy receipts may lack a rate, so this check is NOT applied
-- to sale_items or recomputed from today's catalog.
alter table app_private.order_lines add constraint order_lines_exact_included_tax
 check(tax_cents=app_private.included_vat_cents(total_cents,tax_bps));

create function app_private.ops_assert_payment_quote(a app_private.checkout_attempts) returns void
language plpgsql set search_path='' as $$
declare o app_private.operational_orders%rowtype; l app_private.order_lines%rowtype; item jsonb; quantity integer;
begin
 if a.kind<>'payment' then return; end if;
 select * into o from app_private.operational_orders where business_id=a.business_id and id=a.order_id;
 if o.id is null or o.status<>'open' then raise exception 'FINANCIAL_INTEGRITY'; end if;
 if not app_private.ops_quote_totals_valid(a.items,a.total_cents,a.discount_cents,a.tax_cents) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 for item in select value from jsonb_array_elements(a.items) loop
  select * into l from app_private.order_lines where business_id=a.business_id and order_id=a.order_id and id=(item->>'lineId')::uuid;
  quantity:=(item->>'quantity')::integer;
  if l.id is null or quantity>l.quantity-l.paid_quantity or app_private.ops_slice(l,quantity) is distinct from item then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end loop;
end; $$;

-- The shared completion branch is used by current record_checkout and by
-- compatible clients recovering started/uncertain attempts. Re-read and compare
-- the quote before inserting a receipt or advancing any paid quantity.
do $patch$ declare definition text; needle text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;
    insert into app_private.sales$old$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Unexpected financial completion revision'; end if;
 execute replace(definition,needle,$new$if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;
    perform app_private.ops_assert_payment_quote(a);
    insert into app_private.sales$new$);
end $patch$;

-- A settled record cannot be rewritten or deleted on its own. Referential
-- employee erasure may only null the actor foreign keys; business deletion
-- retains the existing complete-tenant cascade. No session/config bypass exists.
create function app_private.ops_guard_financial_history() returns trigger
language plpgsql set search_path='' as $$
declare old_row jsonb:=to_jsonb(old); new_row jsonb; cleanup_keys text[]; key text;
begin
 if tg_op='DELETE' then
  if exists(select 1 from app_private.businesses where id=old.business_id) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return old;
 end if;
 new_row:=to_jsonb(new);
 cleanup_keys:=case tg_table_name
  when 'sales' then array['employee_id']
  when 'sale_reversals' then array['actor_id','resolver_id']
  when 'cash_movements' then array['actor_id']
  when 'checkout_attempts' then array['actor_id','resolver_id']
  when 'cash_shifts' then array['opened_by','closed_by']
  else '{}'::text[] end;
 foreach key in array cleanup_keys loop
  if key='resolver_id' and tg_table_name='checkout_attempts' and old_row->>'status' not in ('completed','aborted') then continue; end if;
  if key='closed_by' and tg_table_name='cash_shifts' and old_row->>'status'<>'closed' then continue; end if;
  if new_row->key is distinct from old_row->key and new_row->key is distinct from 'null'::jsonb then raise exception 'FINANCIAL_INTEGRITY'; end if;
  if new_row->key is distinct from old_row->key and exists(select 1 from app_private.employees where business_id=old.business_id and id=(old_row->>key)::uuid) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end loop;
 if tg_table_name='checkout_attempts' and old_row->>'status' not in ('completed','aborted') then
  if old_row-array['revision','status','payment_method','total_cents','discount_cents','tax_cents','items','sale_id','resolver_id','resolver_name','resolution_reason','resolved_at','actor_id']
   is distinct from new_row-array['revision','status','payment_method','total_cents','discount_cents','tax_cents','items','sale_id','resolver_id','resolver_name','resolution_reason','resolved_at','actor_id'] then raise exception 'FINANCIAL_INTEGRITY'; end if;
  if old_row->>'status'<>'prepared' and old_row-array['revision','status','sale_id','resolver_id','resolver_name','resolution_reason','resolved_at','actor_id']
   is distinct from new_row-array['revision','status','sale_id','resolver_id','resolver_name','resolution_reason','resolved_at','actor_id'] then raise exception 'FINANCIAL_INTEGRITY'; end if;
  if old_row->>'status'='prepared' and new_row->>'status'='prepared' then perform app_private.ops_assert_payment_quote(new); end if;
 elsif tg_table_name='cash_shifts' and old_row->>'status'<>'closed' then
  if old_row-array['revision','status','closed_at','closed_by','closer_name','counted_cents','expected_cents','difference_cents','opened_by']
   is distinct from new_row-array['revision','status','closed_at','closed_by','closer_name','counted_cents','expected_cents','difference_cents','opened_by'] then raise exception 'FINANCIAL_INTEGRITY'; end if;
 else
  if old_row-cleanup_keys is distinct from new_row-cleanup_keys then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end if;
 return new;
end; $$;

do $$ declare table_name text; begin
 foreach table_name in array array['sales','sale_items','checkout_attempts','sale_reversals','cash_movements','cash_shifts'] loop
  execute format('create trigger financial_history_immutable before update or delete on app_private.%I for each row execute function app_private.ops_guard_financial_history()',table_name);
 end loop;
end $$;

-- Paid lines keep the accepted price/discount/IVA snapshots. Only quantities
-- advanced by the financial/preparation transaction can change after freezing.
create function app_private.ops_guard_frozen_order() returns trigger
language plpgsql set search_path='' as $$
declare frozen boolean;
begin
 if tg_table_name='operational_orders' then
  if old.frozen and (new.frozen is distinct from true or new.discount is distinct from old.discount) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return new;
 end if;
 if tg_op='INSERT' then
  select o.frozen into frozen from app_private.operational_orders o where o.business_id=new.business_id and o.id=new.order_id;
  if frozen then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return new;
 end if;
 select o.frozen into frozen from app_private.operational_orders o where o.business_id=old.business_id and o.id=old.order_id;
 if tg_op='DELETE' then
  if frozen then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return old;
 end if;
 if frozen and to_jsonb(old)-array['paid_quantity','sent_quantity'] is distinct from to_jsonb(new)-array['paid_quantity','sent_quantity'] then raise exception 'FINANCIAL_INTEGRITY'; end if;
 return new;
end; $$;
create trigger financial_order_frozen before update on app_private.operational_orders
 for each row execute function app_private.ops_guard_frozen_order();
create trigger financial_order_frozen before insert or update or delete on app_private.order_lines
 for each row execute function app_private.ops_guard_frozen_order();

create function app_private.ops_guard_new_collection() returns trigger
language plpgsql set search_path='' as $$
declare shift_status text;
begin
 select status into shift_status from app_private.cash_shifts where business_id=new.business_id and id=new.shift_id;
 if shift_status is distinct from 'open' then raise exception 'FINANCIAL_INTEGRITY'; end if;
 if tg_table_name='checkout_attempts' then perform app_private.ops_assert_payment_quote(new); end if;
 return new;
end; $$;
create trigger financial_collection_open_shift before insert on app_private.checkout_attempts
 for each row execute function app_private.ops_guard_new_collection();
create trigger financial_collection_open_shift before insert on app_private.cash_movements
 for each row execute function app_private.ops_guard_new_collection();

-- Parent/children are inserted in one transaction. Deferred checks inspect the
-- final committed graph, including zero-value receipts and legacy null IVA.
create function app_private.ops_assert_sale_integrity(p_business uuid,p_sale uuid) returns void
language plpgsql set search_path='' as $$
declare sale app_private.sales%rowtype; total numeric; quantity bigint; count_lines integer;
begin
 select * into sale from app_private.sales where business_id=p_business and id=p_sale;
 if sale.id is null then return; end if;
 select coalesce(sum(total_cents),0),coalesce(sum(i.quantity),0),count(*) into total,quantity,count_lines
  from app_private.sale_items i where business_id=p_business and sale_id=p_sale;
 if count_lines not between 1 and 40 or total<>sale.total_cents or quantity<>sale.item_count then raise exception 'FINANCIAL_INTEGRITY'; end if;
end; $$;
create function app_private.ops_assert_attempt_integrity(p_business uuid,p_attempt uuid) returns void
language plpgsql set search_path='' as $$
declare a app_private.checkout_attempts%rowtype; sale app_private.sales%rowtype; reversal app_private.sale_reversals%rowtype; discount numeric; tax numeric; receipt_items jsonb; quote_items jsonb;
begin
 select * into a from app_private.checkout_attempts where business_id=p_business and id=p_attempt;
 if a.id is null or a.status<>'completed' then return; end if;
 if a.kind='payment' then
  select * into sale from app_private.sales where business_id=p_business and id=a.sale_id;
  if sale.id is null or sale.operation_id<>a.id or sale.total_cents<>a.total_cents or sale.payment_method<>a.payment_method or sale.operator_name<>a.operator_name then raise exception 'FINANCIAL_INTEGRITY'; end if;
  select coalesce(sum(discount_cents),0),coalesce(sum(tax_cents),0) into discount,tax from app_private.sale_items where business_id=p_business and sale_id=a.sale_id;
  if discount<>a.discount_cents or tax<>a.tax_cents or sale.item_count<>(select sum((i->>'quantity')::integer) from jsonb_array_elements(a.items) i) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  select jsonb_agg(item order by item::text) into receipt_items from (select jsonb_build_object(
   'productId',i.product_id,'name',i.name,'category',i.category,'selectionLabel',i.selection_label,'quantity',i.quantity,
   'unitPriceCents',i.unit_price_cents,'discountCents',i.discount_cents,'totalCents',i.total_cents,'taxCents',i.tax_cents,
   'taxBps',i.tax_bps,'taxTreatment',i.tax_treatment) item from app_private.sale_items i where i.business_id=p_business and i.sale_id=a.sale_id) snapshots;
  select jsonb_agg(item order by item::text) into quote_items from (select value-'lineId' item from jsonb_array_elements(a.items)) snapshots;
  if receipt_items is distinct from quote_items then raise exception 'FINANCIAL_INTEGRITY'; end if;
 else
  select * into reversal from app_private.sale_reversals where business_id=p_business and attempt_id=a.id;
  if reversal.id is null or reversal.sale_id<>a.original_sale_id or reversal.shift_id<>a.shift_id or reversal.amount_cents<>a.total_cents or reversal.tax_cents<>a.tax_cents or reversal.payment_method<>a.payment_method then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end if;
end; $$;
create function app_private.ops_assert_order_integrity(p_business uuid,p_order uuid) returns void
language plpgsql set search_path='' as $$
declare o app_private.operational_orders%rowtype; l app_private.order_lines%rowtype; quantity bigint; paid numeric; discount numeric; tax numeric;
 total numeric; collected numeric; waived numeric; cancelled numeric; balance numeric; expected_discount numeric; expected_paid numeric; expected_tax numeric;
begin
 select * into o from app_private.operational_orders where business_id=p_business and id=p_order;
 if o.id is null then return; end if;
 for l in select * from app_private.order_lines where business_id=p_business and order_id=p_order loop
  select coalesce(sum((i->>'quantity')::integer),0),coalesce(sum((i->>'totalCents')::bigint),0),coalesce(sum((i->>'discountCents')::bigint),0),coalesce(sum((i->>'taxCents')::bigint),0)
   into quantity,paid,discount,tax from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i
   where a.business_id=p_business and a.order_id=p_order and a.kind='payment' and a.status='completed' and i->>'lineId'=l.id::text;
  expected_discount:=floor(l.discount_cents::numeric*l.paid_quantity/l.quantity);
  expected_paid:=l.unit_price_cents::numeric*l.paid_quantity-expected_discount;
  expected_tax:=case when l.total_cents=0 then 0 else floor(l.tax_cents::numeric*expected_paid/l.total_cents) end;
  if quantity<>l.paid_quantity or paid<>expected_paid or discount<>expected_discount or tax<>expected_tax then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end loop;
 if exists(select 1 from app_private.checkout_attempts a cross join lateral jsonb_array_elements(a.items) i
  where a.business_id=p_business and a.order_id=p_order and a.kind='payment' and a.status='completed'
   and not exists(select 1 from app_private.order_lines line_row where line_row.business_id=p_business and line_row.order_id=p_order and line_row.id::text=i->>'lineId')) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 select coalesce(sum(total_cents),0) into total from app_private.order_lines where business_id=p_business and order_id=p_order;
 select coalesce(sum(total_cents),0) into collected from app_private.checkout_attempts where business_id=p_business and order_id=p_order and kind='payment' and status='completed';
 select coalesce(sum(amount_cents),0) into waived from app_private.balance_waivers where business_id=p_business and order_id=p_order and status='completed';
 select coalesce(sum(amount_cents),0) into cancelled from app_private.order_cancellations where business_id=p_business and order_id=p_order;
 balance:=total-collected-waived-cancelled;
 if balance<0 or o.status in ('paid','waived','cancelled','closed') and balance<>0
  or o.status='paid' and exists(select 1 from app_private.order_lines line_row where line_row.business_id=p_business and line_row.order_id=p_order and line_row.paid_quantity<>line_row.quantity)
  or not o.frozen and exists(select 1 from app_private.checkout_attempts where business_id=p_business and order_id=p_order and kind='payment' and status='completed') then raise exception 'FINANCIAL_INTEGRITY'; end if;
end; $$;
create function app_private.ops_assert_reversal_integrity(p_business uuid,p_reversal uuid) returns void
language plpgsql set search_path='' as $$
declare r app_private.sale_reversals%rowtype; sale app_private.sales%rowtype; a app_private.checkout_attempts%rowtype; tax numeric;
begin
 select * into r from app_private.sale_reversals where business_id=p_business and id=p_reversal;
 if r.id is null then return; end if;
 select * into sale from app_private.sales where business_id=p_business and id=r.sale_id;
 select * into a from app_private.checkout_attempts where business_id=p_business and id=r.attempt_id;
 select coalesce(sum(tax_cents),0) into tax from app_private.sale_items where business_id=p_business and sale_id=r.sale_id;
 if sale.id is null or a.id is null or a.kind<>'reversal' or a.status<>'completed' or a.original_sale_id<>r.sale_id
  or r.amount_cents<>sale.total_cents or r.payment_method<>sale.payment_method or r.tax_cents<>tax then raise exception 'FINANCIAL_INTEGRITY'; end if;
 perform app_private.ops_assert_attempt_integrity(p_business,r.attempt_id);
end; $$;
create function app_private.ops_assert_shift_integrity(p_business uuid,p_shift uuid) returns void
language plpgsql set search_path='' as $$
declare s app_private.cash_shifts%rowtype; expected numeric;
begin
 select * into s from app_private.cash_shifts where business_id=p_business and id=p_shift;
 if s.id is null or s.status<>'closed' then return; end if;
 if app_private.ops_pending(p_business,null,p_shift) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 expected:=s.opening_cents
  +coalesce((select sum(case when kind='in' then amount_cents else -amount_cents end) from app_private.cash_movements where business_id=p_business and shift_id=p_shift),0)
  +coalesce((select sum(total_cents) from app_private.checkout_attempts where business_id=p_business and shift_id=p_shift and kind='payment' and status='completed' and payment_method='cash'),0)
  -coalesce((select sum(amount_cents) from app_private.sale_reversals where business_id=p_business and shift_id=p_shift and payment_method='cash'),0);
 if s.expected_cents<>expected or s.difference_cents<>s.counted_cents-expected then raise exception 'FINANCIAL_INTEGRITY'; end if;
end; $$;

create function app_private.ops_check_financial_graph() returns trigger
language plpgsql set search_path='' as $$
declare row_data jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end; business uuid; id uuid;
begin
 business:=(row_data->>'business_id')::uuid;
 if not exists(select 1 from app_private.businesses business_row where business_row.id=business) then return null; end if;
 if tg_table_name in ('sales','sale_items') then
  id:=case when tg_table_name='sales' then (row_data->>'id')::uuid else (row_data->>'sale_id')::uuid end;
  perform app_private.ops_assert_sale_integrity(business,id);
 elsif tg_table_name='checkout_attempts' then
  perform app_private.ops_assert_attempt_integrity(business,(row_data->>'id')::uuid);
  perform app_private.ops_assert_shift_integrity(business,(row_data->>'shift_id')::uuid);
  if row_data->'order_id'<>'null'::jsonb then perform app_private.ops_assert_order_integrity(business,(row_data->>'order_id')::uuid); end if;
 elsif tg_table_name='sale_reversals' then
  perform app_private.ops_assert_reversal_integrity(business,(row_data->>'id')::uuid);
  perform app_private.ops_assert_shift_integrity(business,(row_data->>'shift_id')::uuid);
 elsif tg_table_name in ('cash_movements','cash_shifts') then
  id:=case when tg_table_name='cash_shifts' then (row_data->>'id')::uuid else (row_data->>'shift_id')::uuid end;
  perform app_private.ops_assert_shift_integrity(business,id);
 elsif tg_table_name in ('operational_orders','order_lines') then
  id:=case when tg_table_name='operational_orders' then (row_data->>'id')::uuid else (row_data->>'order_id')::uuid end;
  perform app_private.ops_assert_order_integrity(business,id);
 end if;
 return null;
end; $$;
do $$ declare table_name text; begin
 foreach table_name in array array['sales','sale_items','checkout_attempts','sale_reversals','cash_movements','cash_shifts','operational_orders','order_lines'] loop
  execute format('create constraint trigger financial_graph_consistent after insert or update or delete on app_private.%I deferrable initially deferred for each row execute function app_private.ops_check_financial_graph()',table_name);
 end loop;
end $$;

-- Reusable read-only diagnostic: it exposes aggregate counts, never receipts,
-- tokens, actors or money. It is private and has no browser execution grants.
create function app_private.ops_financial_ledger_check() returns jsonb
language plpgsql set search_path='' as $$
declare r record; a app_private.checkout_attempts%rowtype; bad_sales bigint:=0; bad_attempts bigint:=0; bad_reversals bigint:=0; bad_shifts bigint:=0; bad_pending bigint:=0; bad_orders bigint:=0; bad_quotes bigint;
begin
 select count(*) into bad_quotes from app_private.checkout_attempts
  where not app_private.ops_quote_totals_valid(items,total_cents,discount_cents,tax_cents);
 for r in select business_id,id from app_private.sales loop
  begin perform app_private.ops_assert_sale_integrity(r.business_id,r.id);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_sales:=bad_sales+1; end;
 end loop;
 for r in select business_id,id from app_private.operational_orders loop
  begin perform app_private.ops_assert_order_integrity(r.business_id,r.id);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_orders:=bad_orders+1; end;
 end loop;
 for r in select business_id,id from app_private.checkout_attempts where status='completed' loop
  begin perform app_private.ops_assert_attempt_integrity(r.business_id,r.id);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_attempts:=bad_attempts+1; end;
 end loop;
 for r in select business_id,id from app_private.sale_reversals loop
  begin perform app_private.ops_assert_reversal_integrity(r.business_id,r.id);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_reversals:=bad_reversals+1; end;
 end loop;
 for r in select business_id,id from app_private.cash_shifts where status='closed' loop
  begin perform app_private.ops_assert_shift_integrity(r.business_id,r.id);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_shifts:=bad_shifts+1; end;
 end loop;
 for a in select attempt.* from app_private.checkout_attempts attempt where kind='payment' and status in ('prepared','collection_started','uncertain') loop
  begin perform app_private.ops_assert_payment_quote(a);
  exception when raise_exception then if sqlerrm<>'FINANCIAL_INTEGRITY' then raise; end if; bad_pending:=bad_pending+1; end;
 end loop;
 return jsonb_build_object('invalidQuotes',bad_quotes,'invalidSales',bad_sales,'invalidCompletedAttempts',bad_attempts,
  'invalidReversals',bad_reversals,'invalidClosedShifts',bad_shifts,'invalidPendingSnapshots',bad_pending,'invalidOrders',bad_orders);
end; $$;
-- Fail the migration if historical accounting is inconsistent. No rewrite,
-- synthetic balancing entry, inferred tax or automatic receipt repair occurs.
do $$ declare checks jsonb; begin
 checks:=app_private.ops_financial_ledger_check();
 if exists(select 1 from jsonb_each_text(checks) where value::bigint<>0) then raise exception 'FINANCIAL_INTEGRITY'; end if;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app_private' and p.proname in ('ops_quote_totals_valid','ops_assert_payment_quote','ops_guard_financial_history','ops_guard_frozen_order','ops_guard_new_collection','ops_assert_sale_integrity','ops_assert_attempt_integrity','ops_assert_order_integrity','ops_assert_reversal_integrity','ops_assert_shift_integrity','ops_check_financial_graph','ops_financial_ledger_check') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end $$;
