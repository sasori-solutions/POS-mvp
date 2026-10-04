-- Append-only financial adjustments, accepted replay responses and order events.
-- There is no session variable or caller-controlled bypass. Employee removal may
-- only clear its vanished foreign key; complete tenant deletion keeps its cascade.

create function app_private.ops_adjustment_items_valid(p_items jsonb,p_amount bigint)
returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; discount numeric:=0; tax numeric:=0;
begin
 if jsonb_typeof(p_items) is distinct from 'array' then return false; end if;
 for item in select value from jsonb_array_elements(p_items) loop
  discount:=discount+app_private.ops_int(item->'discountCents',0,9999999999);
  tax:=tax+app_private.ops_int(item->'taxCents',0,9999999999);
 end loop;
 if discount>9999999999 or tax>9999999999 then return false; end if;
 return app_private.ops_quote_totals_valid(p_items,p_amount,discount::bigint,tax::bigint);
exception when others then return false;
end; $$;
alter table app_private.order_cancellations add constraint order_cancellations_exact_snapshot
 check(app_private.ops_adjustment_items_valid(items,amount_cents));
alter table app_private.balance_waivers add constraint balance_waivers_exact_snapshot
 check(app_private.ops_adjustment_items_valid(items,amount_cents));
alter table app_private.balance_waivers add constraint balance_waivers_resolution_state
 check(revision>0 and order_revision>0 and (
  (status='prepared' and resolved_at is null and resolver_name is null and resolver_id is null)
  or (status='completed' and resolved_at is not null and resolver_name is not null and resolved_at>=created_at)));

-- Check the complete remaining prefix before an adjustment affects the balance.
-- Prepared waivers may remain as historical proposals after the order changes;
-- completing one must compare its unchanged snapshot and revision again.
create function app_private.ops_assert_adjustment_remaining(p_business uuid,p_order uuid,p_amount bigint,p_items jsonb,p_revision integer default null)
returns void language plpgsql set search_path='' as $$
declare o app_private.operational_orders%rowtype; expected_items jsonb; expected_amount numeric;
begin
 select * into o from app_private.operational_orders where business_id=p_business and id=p_order;
 if o.id is null or o.status<>'open' or (p_revision is not null and o.revision<>p_revision)
  or app_private.ops_pending(p_business,p_order) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 select jsonb_agg(app_private.ops_slice(l,l.quantity-l.paid_quantity) order by l.id),
  coalesce(sum((app_private.ops_slice(l,l.quantity-l.paid_quantity)->>'totalCents')::numeric),0)
 into expected_items,expected_amount from app_private.order_lines l
 where l.business_id=p_business and l.order_id=p_order and l.quantity>l.paid_quantity;
 if expected_items is null or expected_items is distinct from p_items or expected_amount<>p_amount
  or not app_private.ops_adjustment_items_valid(p_items,p_amount) then raise exception 'FINANCIAL_INTEGRITY'; end if;
end; $$;

create function app_private.ops_guard_adjustment_history() returns trigger
language plpgsql set search_path='' as $$
declare old_row jsonb; new_row jsonb; cleanup_keys text[]; key text; actor uuid;
begin
 if tg_op='DELETE' then
  if exists(select 1 from app_private.businesses where id=old.business_id) then raise exception 'FINANCIAL_INTEGRITY'; end if;
  return old;
 end if;
 if tg_op='INSERT' then
  if tg_table_name='order_cancellations' then
   perform app_private.ops_assert_adjustment_remaining(new.business_id,new.order_id,new.amount_cents,new.items);
  elsif tg_table_name='balance_waivers' then
   if new.status<>'prepared' or new.revision<>1 then raise exception 'FINANCIAL_INTEGRITY'; end if;
   perform app_private.ops_assert_adjustment_remaining(new.business_id,new.order_id,new.amount_cents,new.items,new.order_revision);
  end if;
  return new;
 end if;
 old_row:=to_jsonb(old); new_row:=to_jsonb(new);
 cleanup_keys:=case when tg_table_name='balance_waivers' then array['actor_id','resolver_id'] else array['actor_id'] end;
 foreach key in array cleanup_keys loop
  if old_row->key is not distinct from new_row->key then continue; end if;
  -- Resolver assignment belongs exclusively to the prepared→completed transition.
  if tg_table_name='balance_waivers' and key='resolver_id' and old_row->>'status'='prepared' and new_row->>'status'='completed' then continue; end if;
  actor:=nullif(old_row->>key,'')::uuid;
  if actor is null or new_row->key is distinct from 'null'::jsonb
   or exists(select 1 from app_private.employees e where e.business_id=old.business_id and e.id=actor) then raise exception 'FINANCIAL_INTEGRITY'; end if;
 end loop;
 if tg_table_name='balance_waivers' and old_row->>'status'='prepared' and new_row->>'status'='completed' then
  if old_row-array['status','revision','resolver_id','resolver_name','resolved_at','actor_id']
   is distinct from new_row-array['status','revision','resolver_id','resolver_name','resolved_at','actor_id']
   or new.revision<>old.revision+1 or new.resolver_id is null or new.resolver_name is null or new.resolved_at is null then raise exception 'FINANCIAL_INTEGRITY'; end if;
  perform app_private.ops_assert_adjustment_remaining(new.business_id,new.order_id,new.amount_cents,new.items,new.order_revision);
 elsif old_row-cleanup_keys is distinct from new_row-cleanup_keys then raise exception 'FINANCIAL_INTEGRITY'; end if;
 return new;
end; $$;
do $$ declare table_name text; begin
 foreach table_name in array array['order_cancellations','balance_waivers','pos_operations','order_events'] loop
  execute format('create trigger financial_adjustment_history before insert or update or delete on app_private.%I for each row execute function app_private.ops_guard_adjustment_history()',table_name);
 end loop;
end $$;

-- Deferred reconciliation includes adjustments in the final committed order.
create function app_private.ops_check_adjustment_order() returns trigger
language plpgsql set search_path='' as $$
declare business uuid; order_id uuid;
begin
 business:=case when tg_op='DELETE' then old.business_id else new.business_id end;
 order_id:=case when tg_op='DELETE' then old.order_id else new.order_id end;
 if exists(select 1 from app_private.businesses where id=business) then
  perform app_private.ops_assert_order_integrity(business,order_id);
 end if;
 return null;
end; $$;
create constraint trigger financial_adjustment_order_consistent after insert or update or delete on app_private.order_cancellations
 deferrable initially deferred for each row execute function app_private.ops_check_adjustment_order();
create constraint trigger financial_adjustment_order_consistent after insert or update or delete on app_private.balance_waivers
 deferrable initially deferred for each row execute function app_private.ops_check_adjustment_order();

create function app_private.ops_financial_adjustment_check() returns jsonb
language plpgsql set search_path='' as $$
declare invalid_cancellations bigint; invalid_waivers bigint;
begin
 select count(*) into invalid_cancellations from app_private.order_cancellations
  where not app_private.ops_adjustment_items_valid(items,amount_cents);
 select count(*) into invalid_waivers from app_private.balance_waivers
  where not app_private.ops_adjustment_items_valid(items,amount_cents) or revision<=0 or order_revision<=0
  or (status='prepared' and (resolved_at is not null or resolver_name is not null or resolver_id is not null))
  or (status='completed' and (resolved_at is null or resolver_name is null or resolved_at<created_at));
 return jsonb_build_object('invalidCancellations',invalid_cancellations,'invalidWaivers',invalid_waivers);
end; $$;
do $$ declare checks jsonb; begin
 checks:=app_private.ops_financial_adjustment_check();
 if exists(select 1 from jsonb_each_text(checks) where value::bigint<>0) then raise exception 'FINANCIAL_INTEGRITY'; end if;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app_private' and p.proname in ('ops_adjustment_items_valid','ops_assert_adjustment_remaining','ops_guard_adjustment_history','ops_check_adjustment_order','ops_financial_adjustment_check') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end $$;
