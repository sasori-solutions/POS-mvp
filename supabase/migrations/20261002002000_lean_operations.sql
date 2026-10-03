-- Lean POS operations. Private transactional state; no cloud cutover is automatic.
-- The owner explicitly activates the new checkout; accepted legacy retries still replay.
create table app_private.operational_settings (
 business_id uuid primary key references app_private.businesses(id) on delete cascade,
 enabled boolean not null default false, activated_at timestamptz, activated_by uuid,
 foreign key(business_id,activated_by) references app_private.employees(business_id,id) on delete set null(activated_by)
);
create table app_private.cash_shifts (
 business_id uuid not null references app_private.businesses(id) on delete cascade,
 id uuid not null default gen_random_uuid(), revision integer not null default 1 check(revision>0),
 status text not null default 'open' check(status in ('open','closing','closed')),
 opening_cents bigint not null check(opening_cents between 0 and 9999999999),
 opened_at timestamptz not null default clock_timestamp(), closed_at timestamptz,
 opened_by uuid, opener_name text not null, closed_by uuid, closer_name text,
 counted_cents bigint check(counted_cents between 0 and 9999999999), expected_cents bigint, difference_cents bigint,
 primary key(business_id,id),
 foreign key(business_id,opened_by) references app_private.employees(business_id,id) on delete set null(opened_by),
 foreign key(business_id,closed_by) references app_private.employees(business_id,id) on delete set null(closed_by),
 check((status='closed' and closed_at is not null and counted_cents is not null and expected_cents is not null and difference_cents=counted_cents-expected_cents)
   or (status<>'closed' and closed_at is null and counted_cents is null and expected_cents is null and difference_cents is null))
);
create unique index one_active_cash_shift on app_private.cash_shifts(business_id) where status in ('open','closing');
create table app_private.cash_movements (
 business_id uuid not null, id uuid not null default gen_random_uuid(), shift_id uuid not null,
 kind text not null check(kind in ('in','out')), amount_cents bigint not null check(amount_cents between 1 and 9999999999),
 reason text not null check(char_length(reason) between 1 and 200), actor_id uuid, actor_name text not null,
 created_at timestamptz not null default clock_timestamp(), primary key(business_id,id),
 foreign key(business_id,shift_id) references app_private.cash_shifts(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id)
);
create table app_private.dining_tables (
 business_id uuid not null references app_private.businesses(id) on delete cascade, id uuid not null,
 name text not null check(char_length(name) between 1 and 60), active boolean not null default true,
 revision integer not null default 1 check(revision>0), primary key(business_id,id)
);
create table app_private.operational_orders (
 business_id uuid not null references app_private.businesses(id) on delete cascade, id uuid not null,
 revision integer not null default 1 check(revision>0), name text not null check(char_length(name) between 1 and 100),
 table_id uuid, status text not null default 'open' check(status in ('open','paid','cancelled','waived','closed')),
 phase text not null default 'service' check(phase in ('service','checkout')), frozen boolean not null default false,
 actor_id uuid, operator_name text not null, discount jsonb,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id),
 foreign key(business_id,table_id) references app_private.dining_tables(business_id,id) deferrable initially deferred,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id)
);
-- Paid/waived accounts keep occupying their table until explicitly closed or moved.
create unique index one_occupied_table_account on app_private.operational_orders(business_id,table_id) where table_id is not null and status in ('open','paid','waived','cancelled');
create table app_private.order_lines (
 business_id uuid not null, order_id uuid not null, id uuid not null,
 product_id uuid not null, product_version integer not null check(product_version>0), selection jsonb,
 name text not null, kitchen_name text not null, category text not null, selection_label text not null,
 note text not null check(char_length(note)<=160), quantity integer not null check(quantity between 1 and 999),
 paid_quantity integer not null default 0 check(paid_quantity>=0), sent_quantity integer not null default 0 check(sent_quantity>=0),
 unit_price_cents integer not null check(unit_price_cents between 0 and 99999999),
 gross_cents bigint not null, discount_cents bigint not null default 0, total_cents bigint not null, tax_cents bigint not null,
 tax_bps integer not null check(tax_bps between 0 and 10000), tax_treatment text not null,
 primary key(business_id,order_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,product_id) references app_private.products(business_id,id) deferrable initially deferred,
 check(paid_quantity<=quantity and sent_quantity<=quantity),
 check(gross_cents=quantity::bigint*unit_price_cents and discount_cents between 0 and gross_cents and total_cents=gross_cents-discount_cents and tax_cents between 0 and total_cents)
);
create table app_private.order_events (
 business_id uuid not null, id uuid not null default gen_random_uuid(), order_id uuid not null,
 revision integer not null, kind text not null, actor_id uuid, actor_name text not null, payload jsonb not null,
 created_at timestamptz not null default clock_timestamp(), primary key(business_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id)
);
create table app_private.kitchen_batches (
 business_id uuid not null, id uuid not null default gen_random_uuid(), order_id uuid not null,
 order_name text not null, table_name text, revision integer not null default 1 check(revision>0),
 kind text not null check(kind in ('items','cancellation')), status text not null default 'queued' check(status in ('queued','preparing','ready','delivered')),
 reason text not null default '', items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 40),
 actor_id uuid, actor_name text not null, created_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id)
);
create table app_private.checkout_attempts (
 business_id uuid not null, id uuid not null default gen_random_uuid(), revision integer not null default 1 check(revision>0),
 kind text not null check(kind in ('payment','reversal')), status text not null default 'prepared' check(status in ('prepared','collection_started','completed','aborted','uncertain')),
 order_id uuid, shift_id uuid not null, sale_id uuid, original_sale_id uuid,
 payment_method text not null check(payment_method in ('cash','card_external','transfer')),
 total_cents bigint not null check(total_cents between 0 and 9999999999), discount_cents bigint not null check(discount_cents>=0), tax_cents bigint not null check(tax_cents between 0 and total_cents),
 items jsonb not null check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 40),
 actor_id uuid, actor_identity uuid not null, operator_name text not null, resolver_id uuid, resolver_name text,
 reason text not null default '', resolution_reason text, created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz,
 primary key(business_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,shift_id) references app_private.cash_shifts(business_id,id) deferrable initially deferred,
 foreign key(business_id,sale_id) references app_private.sales(business_id,id) deferrable initially deferred,
 foreign key(business_id,original_sale_id) references app_private.sales(business_id,id) deferrable initially deferred,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id),
 foreign key(business_id,resolver_id) references app_private.employees(business_id,id) on delete set null(resolver_id),
 check((kind='payment' and order_id is not null and original_sale_id is null) or (kind='reversal' and original_sale_id is not null)),
 check((status in ('completed','aborted') and resolved_at is not null) or (status not in ('completed','aborted') and resolved_at is null))
);
create unique index one_pending_order_collection on app_private.checkout_attempts(business_id,order_id) where kind='payment' and status in ('prepared','collection_started','uncertain');
create unique index one_live_sale_reversal on app_private.checkout_attempts(business_id,original_sale_id) where kind='reversal' and status<>'aborted';
create table app_private.sale_reversals (
 business_id uuid not null, id uuid not null default gen_random_uuid(), sale_id uuid not null, attempt_id uuid not null, shift_id uuid not null,
 amount_cents bigint not null check(amount_cents between 0 and 9999999999), tax_cents bigint not null check(tax_cents between 0 and amount_cents),
 payment_method text not null check(payment_method in ('cash','card_external','transfer')), original_operator_name text not null,
 actor_id uuid, actor_identity uuid not null, actor_name text not null, resolver_id uuid, resolver_name text not null, reason text not null,
 timezone text not null, created_at timestamptz not null default clock_timestamp(), primary key(business_id,id), unique(business_id,sale_id),
 foreign key(business_id,sale_id) references app_private.sales(business_id,id) on delete cascade,
 foreign key(business_id,attempt_id) references app_private.checkout_attempts(business_id,id) deferrable initially deferred,
 foreign key(business_id,shift_id) references app_private.cash_shifts(business_id,id) deferrable initially deferred,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id),
 foreign key(business_id,resolver_id) references app_private.employees(business_id,id) on delete set null(resolver_id)
);
create table app_private.balance_waivers (
 business_id uuid not null, id uuid not null default gen_random_uuid(), order_id uuid not null, order_revision integer not null,
 revision integer not null default 1, status text not null default 'prepared' check(status in ('prepared','completed')),
 amount_cents bigint not null check(amount_cents between 0 and 9999999999), reason text not null check(char_length(reason) between 1 and 200),
 actor_id uuid, actor_identity uuid not null, operator_name text not null, resolver_id uuid, resolver_name text,
 timezone text not null, items jsonb not null, created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz,
 primary key(business_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id),
 foreign key(business_id,resolver_id) references app_private.employees(business_id,id) on delete set null(resolver_id)
);
create unique index one_completed_order_waiver on app_private.balance_waivers(business_id,order_id) where status='completed';
create table app_private.order_cancellations (
 business_id uuid not null, id uuid not null default gen_random_uuid(), order_id uuid not null, amount_cents bigint not null check(amount_cents between 0 and 9999999999),
 reason text not null, items jsonb not null, actor_id uuid, actor_name text not null, created_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id), unique(business_id,order_id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id)
);

-- Gross prices stay exact; discounted totals and tax snapshots become first-class receipt fields.
alter table app_private.sale_items add column discount_cents bigint not null default 0 check(discount_cents>=0);
do $$ declare constraint_name text; begin
 select conname into constraint_name from pg_constraint where conrelid='app_private.sale_items'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%total_cents =%quantity%unit_price_cents%';
 if constraint_name is null then raise exception 'Unexpected sale item amount constraint'; end if;
 execute format('alter table app_private.sale_items drop constraint %I',constraint_name);
end $$;
alter table app_private.sale_items add constraint sale_items_total_cents_check check(total_cents=quantity::bigint*unit_price_cents-discount_cents and discount_cents<=quantity::bigint*unit_price_cents);
create or replace function app_private.sale_json(p_sale app_private.sales,p_detail boolean default true)
returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('id',p_sale.id,'createdAt',p_sale.created_at,'timezone',p_sale.timezone,'totalCents',p_sale.total_cents,'paymentMethod',p_sale.payment_method,'itemCount',p_sale.item_count,'operatorName',p_sale.operator_name)
 || case when p_detail then jsonb_build_object('items',(select jsonb_agg(jsonb_build_object('productId',i.product_id,'name',i.name,'category',i.category,'quantity',i.quantity,
 'unitPriceCents',i.unit_price_cents,'totalCents',i.total_cents,'selectionLabel',i.selection_label,'taxCents',i.tax_cents,'taxTreatment',coalesce(i.tax_treatment,'legacy'),'taxBps',i.tax_bps)
 || case when i.discount_cents>0 then jsonb_build_object('discountCents',i.discount_cents) else '{}'::jsonb end order by i.name,i.line_id)
 from app_private.sale_items i where i.business_id=p_sale.business_id and i.sale_id=p_sale.id)) else '{}'::jsonb end;
$$;

do $$ declare t text; begin
 for t in select unnest(array['operational_settings','cash_shifts','cash_movements','dining_tables','operational_orders','order_lines','order_events','kitchen_batches','checkout_attempts','sale_reversals','balance_waivers','order_cancellations']) loop
  execute format('alter table app_private.%I enable row level security',t);
  execute format('revoke all on app_private.%I from public,anon,authenticated',t);
 end loop;
end $$;

create function app_private.ops_exact(p jsonb,keys text[]) returns void language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or not p ?& keys or (select count(*) from jsonb_object_keys(p))<>cardinality(keys) then raise exception 'VALIDATION_ERROR'; end if;
end; $$;
create function app_private.ops_int(p jsonb,min_value bigint,max_value bigint) returns bigint language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'number' or p#>>'{}' !~ '^[0-9]+$' or (p#>>'{}')::numeric not between min_value and max_value then raise exception 'VALIDATION_ERROR'; end if;
 return (p#>>'{}')::bigint;
end; $$;
create function app_private.ops_text(p jsonb,min_length integer,max_length integer) returns text language plpgsql immutable set search_path='' as $$
declare v text;
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' ~ '[\x01-\x1f\x7f]' then raise exception 'VALIDATION_ERROR'; end if;
 v:=btrim(regexp_replace(p#>>'{}','[[:space:]]+',' ','g'));
 if char_length(v) not between min_length and max_length then raise exception 'VALIDATION_ERROR'; end if;
 return v;
end; $$;
create function app_private.ops_uuid(p jsonb) returns uuid language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'VALIDATION_ERROR'; end if;
 return (p#>>'{}')::uuid;
end; $$;
create function app_private.ops_pending(p_business uuid,p_order uuid default null,p_shift uuid default null) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from app_private.checkout_attempts where business_id=p_business and status in ('prepared','collection_started','uncertain') and (p_order is null or order_id=p_order) and (p_shift is null or shift_id=p_shift));
$$;
create function app_private.ops_shift_json(s app_private.cash_shifts) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.id,'revision',s.revision,'status',s.status,'openedAt',s.opened_at,'closedAt',s.closed_at,'openedBy',s.opener_name,'closedBy',s.closer_name,
 'openingCents',s.opening_cents,'countedCents',s.counted_cents,'expectedCents',s.expected_cents,'differenceCents',s.difference_cents,
 'movements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'kind',m.kind,'amountCents',m.amount_cents,'reason',m.reason,'actorName',m.actor_name,'createdAt',m.created_at) order by m.created_at,m.id) from app_private.cash_movements m where m.business_id=s.business_id and m.shift_id=s.id),'[]'::jsonb));
$$;
create function app_private.ops_line_json(l app_private.order_lines) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('lineId',l.id,'productId',l.product_id,'name',l.name,'kitchenName',l.kitchen_name,'category',l.category,'selectionLabel',l.selection_label,'note',l.note,
 'version',l.product_version,'selection',l.selection,
 'quantity',l.quantity,'paidQuantity',l.paid_quantity,'sentQuantity',l.sent_quantity,'unitPriceCents',l.unit_price_cents,'grossCents',l.gross_cents,'discountCents',l.discount_cents,
 'totalCents',l.total_cents,'taxCents',l.tax_cents,'taxBps',l.tax_bps,'taxTreatment',l.tax_treatment);
$$;
create function app_private.ops_order_json(o app_private.operational_orders) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',o.id,'revision',o.revision,'name',o.name,'tableId',o.table_id,'status',o.status,'phase',o.phase,'createdAt',o.created_at,'updatedAt',o.updated_at,
 'operatorName',o.operator_name,'frozen',o.frozen,'discount',o.discount,
 'items',coalesce((select jsonb_agg(app_private.ops_line_json(l) order by l.id) from app_private.order_lines l where l.business_id=o.business_id and l.order_id=o.id),'[]'::jsonb),
 'grossCents',coalesce((select sum(gross_cents) from app_private.order_lines where business_id=o.business_id and order_id=o.id),0),
 'discountCents',coalesce((select sum(discount_cents) from app_private.order_lines where business_id=o.business_id and order_id=o.id),0),
 'totalCents',coalesce((select sum(total_cents) from app_private.order_lines where business_id=o.business_id and order_id=o.id),0),
 'taxCents',coalesce((select sum(tax_cents) from app_private.order_lines where business_id=o.business_id and order_id=o.id),0),
 'paidCents',coalesce((select sum(total_cents) from app_private.checkout_attempts where business_id=o.business_id and order_id=o.id and kind='payment' and status='completed'),0),
 'waivedCents',coalesce((select sum(amount_cents) from app_private.balance_waivers where business_id=o.business_id and order_id=o.id and status='completed'),0),
 'cancelledCents',coalesce((select sum(amount_cents) from app_private.order_cancellations where business_id=o.business_id and order_id=o.id),0),
 'balanceCents',coalesce((select sum(total_cents) from app_private.order_lines where business_id=o.business_id and order_id=o.id),0)
 -coalesce((select sum(total_cents) from app_private.checkout_attempts where business_id=o.business_id and order_id=o.id and kind='payment' and status='completed'),0)
 -coalesce((select sum(amount_cents) from app_private.balance_waivers where business_id=o.business_id and order_id=o.id and status='completed'),0)
 -coalesce((select sum(amount_cents) from app_private.order_cancellations where business_id=o.business_id and order_id=o.id),0));
$$;
create function app_private.ops_table_json(t app_private.dining_tables) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'name',t.name,'active',t.active,'revision',t.revision,'orderId',(select o.id from app_private.operational_orders o where o.business_id=t.business_id and o.table_id=t.id and o.status in ('open','paid','waived','cancelled')));
$$;
create function app_private.ops_batch_json(b app_private.kitchen_batches) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',b.id,'orderId',b.order_id,'orderName',b.order_name,'tableName',b.table_name,'createdAt',b.created_at,'revision',b.revision,'status',b.status,'kind',b.kind,'reason',b.reason,'items',b.items);
$$;
create function app_private.ops_attempt_json(a app_private.checkout_attempts) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',a.id,'revision',a.revision,'kind',a.kind,'status',a.status,'orderId',a.order_id,'shiftId',a.shift_id,'saleId',a.sale_id,'originalSaleId',a.original_sale_id,
 'paymentMethod',a.payment_method,'totalCents',a.total_cents,'taxCents',a.tax_cents,'discountCents',a.discount_cents,'operatorName',a.operator_name,'resolverName',a.resolver_name,'createdAt',a.created_at,'resolvedAt',a.resolved_at,'reason',coalesce(a.resolution_reason,a.reason),'items',a.items);
$$;
create function app_private.ops_waiver_json(w app_private.balance_waivers) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',w.id,'orderId',w.order_id,'revision',w.revision,'status',w.status,'amountCents',w.amount_cents,'reason',w.reason,'operatorName',w.operator_name,'resolvedAt',w.resolved_at);
$$;

-- Largest-remainder allocation of one whole-order discount. Stable UUID order breaks ties.
create function app_private.ops_price_order(p_business uuid,p_order uuid) returns void language plpgsql set search_path='' as $$
declare d jsonb; gross bigint; discount bigint;
begin
 select o.discount into d from app_private.operational_orders o where o.business_id=p_business and o.id=p_order;
 select coalesce(sum(quantity::bigint*unit_price_cents),0) into gross from app_private.order_lines where business_id=p_business and order_id=p_order;
 if gross>9999999999 then raise exception 'VALIDATION_ERROR'; end if;
 discount:=case when d is null then 0 when d->>'kind'='fixed' then (d->>'value')::bigint else round(gross::numeric*(d->>'value')::integer/10000)::bigint end;
 if discount>gross then raise exception 'VALIDATION_ERROR'; end if;
 with shares as (select id,quantity::bigint*unit_price_cents g,
  case when gross=0 then 0 else floor(discount::numeric*(quantity::bigint*unit_price_cents)/gross)::bigint end base,
  case when gross=0 then 0 else mod(discount::numeric*(quantity::bigint*unit_price_cents),gross) end remainder
  from app_private.order_lines where business_id=p_business and order_id=p_order),
 ranked as (select *,row_number() over(order by remainder desc,id) rank,sum(base) over() bases from shares),
 allocated as (select id,g,base+case when rank<=discount-bases then 1 else 0 end amount from ranked)
 update app_private.order_lines l set gross_cents=a.g,discount_cents=a.amount,total_cents=a.g-a.amount,tax_cents=app_private.included_vat_cents(a.g-a.amount,l.tax_bps)
 from allocated a where l.business_id=p_business and l.order_id=p_order and l.id=a.id;
end; $$;

-- Prefix allocation preserves every cent of discount/IVA across quantity splits, including odd cents.
create function app_private.ops_slice(l app_private.order_lines,n integer) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('lineId',l.id,'productId',l.product_id,'name',l.name,'category',l.category,'selectionLabel',l.selection_label,'quantity',n,'unitPriceCents',l.unit_price_cents,
 'discountCents',floor(l.discount_cents::numeric*(l.paid_quantity+n)/l.quantity)::bigint-floor(l.discount_cents::numeric*l.paid_quantity/l.quantity)::bigint,
 'totalCents',l.unit_price_cents::bigint*n-(floor(l.discount_cents::numeric*(l.paid_quantity+n)/l.quantity)::bigint-floor(l.discount_cents::numeric*l.paid_quantity/l.quantity)::bigint),
 'taxCents',case when l.total_cents=0 then 0 else
 floor(l.tax_cents::numeric*(l.unit_price_cents::bigint*(l.paid_quantity+n)-floor(l.discount_cents::numeric*(l.paid_quantity+n)/l.quantity))/l.total_cents)::bigint
 -floor(l.tax_cents::numeric*(l.unit_price_cents::bigint*l.paid_quantity-floor(l.discount_cents::numeric*l.paid_quantity/l.quantity))/l.total_cents)::bigint end,
 'taxBps',l.tax_bps,'taxTreatment',l.tax_treatment);
$$;

-- Preserve the permission/manual-availability implementation from 0018/0019 intact.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to legacy_pos_command;

create function app_private.ops_validate(p jsonb) returns void language plpgsql set search_path='' as $$
#variable_conflict use_column
declare c text:=p->>'command'; fields text[]; i jsonb; d jsonb; k text;
begin
 fields:=case c
 when 'operations' then '{}' when 'orders' then '{}' when 'shifts' then '{}' when 'kitchen' then '{}' when 'tables' then '{}'
 when 'activate_operations' then array['operationId'] when 'open_shift' then array['operationId','openingCents']
 when 'cash_movement' then array['operationId','shiftId','expectedRevision','kind','amountCents','reason']
 when 'begin_shift_close' then array['operationId','shiftId','expectedRevision'] when 'abort_shift_close' then array['operationId','shiftId','expectedRevision']
 when 'close_shift' then array['operationId','shiftId','expectedRevision','countedCents']
 when 'order' then array['orderId']
 when 'save_order' then array['operationId','orderId','expectedRevision','name','tableId','items']
 when 'set_order_discount' then array['operationId','orderId','expectedRevision','discount']
 when 'cancel_order' then array['operationId','orderId','expectedRevision','reason']
 when 'send_order' then array['operationId','orderId','expectedRevision']
 when 'begin_order_checkout' then array['operationId','orderId','expectedRevision']
 when 'resume_order_service' then array['operationId','orderId','expectedRevision']
 when 'close_order' then array['operationId','orderId','expectedRevision']
 when 'move_order' then array['operationId','orderId','expectedRevision','tableId']
 when 'save_table' then array['operationId','tableId','expectedRevision','name','active']
 when 'set_kitchen_status' then array['operationId','batchId','expectedRevision','status']
 when 'prepare_checkout' then array['operationId','orderId','expectedRevision','items','paymentMethod']
 when 'attempt' then array['attemptId']
 when 'start_checkout' then array['operationId','attemptId','expectedRevision']
 when 'mark_checkout_uncertain' then array['operationId','attemptId','expectedRevision']
 when 'resolve_checkout' then array['operationId','attemptId','expectedRevision','resolution','confirmed','reason']
 when 'prepare_reversal' then array['operationId','saleId','reason']
 when 'prepare_waiver' then array['operationId','orderId','expectedRevision','reason']
 when 'confirm_waiver' then array['operationId','waiverId','expectedRevision','confirmed']
 when 'report' then array['date'] else null end;
 if fields is null then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.ops_exact(p,array['command']||fields);
 for k in select unnest(array['operationId','orderId','shiftId','batchId','attemptId','saleId','waiverId']) loop
  if p ? k then perform app_private.ops_uuid(p->k); end if;
 end loop;
 if p ? 'tableId' and p->'tableId'<>'null'::jsonb then perform app_private.ops_uuid(p->'tableId'); end if;
 if p ? 'expectedRevision' and (p->'expectedRevision'<>'null'::jsonb or c not in ('save_order','save_table')) then perform app_private.ops_int(p->'expectedRevision',1,2147483647); end if;
 for k in select unnest(array['openingCents','countedCents','amountCents']) loop
  if p ? k then perform app_private.ops_int(p->k,case when k='amountCents' then 1 else 0 end,9999999999); end if;
 end loop;
 if p ? 'reason' then perform app_private.ops_text(p->'reason',1,200); end if;
 if p ? 'name' then perform app_private.ops_text(p->'name',1,case when c='save_table' then 60 else 100 end); end if;
 if c='cash_movement' and (jsonb_typeof(p->'kind') is distinct from 'string' or p->>'kind' not in ('in','out')) or c='save_table' and jsonb_typeof(p->'active') is distinct from 'boolean'
 or c='prepare_checkout' and (jsonb_typeof(p->'paymentMethod') is distinct from 'string' or p->>'paymentMethod' not in ('cash','card_external','transfer'))
 or c='set_kitchen_status' and (jsonb_typeof(p->'status') is distinct from 'string' or p->>'status' not in ('preparing','ready','delivered'))
 or c='resolve_checkout' and (jsonb_typeof(p->'resolution') is distinct from 'string' or p->>'resolution' not in ('complete','abort') or p->'confirmed' is distinct from 'true'::jsonb)
 or c='confirm_waiver' and p->'confirmed' is distinct from 'true'::jsonb then raise exception 'VALIDATION_ERROR'; end if;
 if c='save_order' or c='prepare_checkout' then
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 40 then raise exception 'VALIDATION_ERROR'; end if;
  if (select count(distinct i->>'lineId') from jsonb_array_elements(p->'items') i)<>jsonb_array_length(p->'items') then raise exception 'VALIDATION_ERROR'; end if;
  for i in select * from jsonb_array_elements(p->'items') loop
   perform app_private.ops_uuid(i->'lineId'); perform app_private.ops_int(i->'quantity',1,999);
   if c='save_order' then
    perform app_private.ops_exact(i,array['lineId','productId','quantity','unitPriceCents','version','note']||case when i ? 'selection' then array['selection'] else '{}'::text[] end);
    perform app_private.ops_uuid(i->'productId'); perform app_private.ops_int(i->'unitPriceCents',0,99999999); perform app_private.ops_int(i->'version',1,2147483647); perform app_private.ops_text(i->'note',0,160);
    if i ? 'selection' then
     perform app_private.ops_exact(i->'selection',array['variationId','modifierIds','variablePriceCents']);
     if i#>'{selection,variationId}'<>'null'::jsonb then perform app_private.ops_uuid(i#>'{selection,variationId}'); end if;
     if i#>'{selection,variablePriceCents}'<>'null'::jsonb then perform app_private.ops_int(i#>'{selection,variablePriceCents}',0,99999999); end if;
     if jsonb_typeof(i#>'{selection,modifierIds}') is distinct from 'array' or jsonb_array_length(i#>'{selection,modifierIds}')>24
      or (select count(distinct m) from jsonb_array_elements(i#>'{selection,modifierIds}') m)<>jsonb_array_length(i#>'{selection,modifierIds}') then raise exception 'VALIDATION_ERROR'; end if;
     for d in select * from jsonb_array_elements(i#>'{selection,modifierIds}') loop perform app_private.ops_uuid(d); end loop;
    end if;
   else perform app_private.ops_exact(i,array['lineId','quantity']); end if;
  end loop;
 end if;
 if c='set_order_discount' and p->'discount'<>'null'::jsonb then
  d:=p->'discount'; perform app_private.ops_exact(d,array['kind','value','reason']);
  if jsonb_typeof(d->'kind') is distinct from 'string' or d->>'kind' not in ('fixed','percent') then raise exception 'VALIDATION_ERROR'; end if;
  perform app_private.ops_int(d->'value',0,case when d->>'kind'='fixed' then 9999999999 else 10000 end); perform app_private.ops_text(d->'reason',1,200);
 end if;
 if c='report' and (jsonb_typeof(p->'date') is distinct from 'string' or p->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or to_char((p->>'date')::date,'YYYY-MM-DD')<>p->>'date') then raise exception 'VALIDATION_ERROR'; end if;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_ERROR';
end; $$;

create function app_private.ops_report(p_business uuid,p_day date) returns jsonb language plpgsql stable set search_path='' as $$
declare timezone_name text; start_at timestamptz; end_at timestamptz; result jsonb;
begin
 select timezone into timezone_name from app_private.businesses where id=p_business;
 start_at:=p_day::timestamp at time zone timezone_name; end_at:=(p_day+1)::timestamp at time zone timezone_name;
 -- Effective date is the server business day. Corrections remain on their own date.
 with s as (select * from app_private.sales where business_id=p_business and created_at>=start_at and created_at<end_at),
 i as (select i.* from app_private.sale_items i join s on s.id=i.sale_id and s.business_id=i.business_id),
 r as (select * from app_private.sale_reversals where business_id=p_business and created_at>=start_at and created_at<end_at)
 select jsonb_build_object('date',p_day,'timezone',timezone_name,
 'grossCents',coalesce((select sum(quantity::bigint*unit_price_cents) from i),0),'discountCents',coalesce((select sum(discount_cents) from i),0),
 'salesCents',coalesce((select sum(total_cents) from s),0),'taxCents',coalesce((select sum(tax_cents) from i),0),
 'reversalCents',coalesce((select sum(amount_cents) from r),0),'reversalTaxCents',coalesce((select sum(tax_cents) from r),0),
 'netCents',coalesce((select sum(total_cents) from s),0)-coalesce((select sum(amount_cents) from r),0),'saleCount',(select count(*) from s),
 'waivedCents',coalesce((select sum(amount_cents) from app_private.balance_waivers where business_id=p_business and status='completed' and resolved_at>=start_at and resolved_at<end_at),0),
 'payments',coalesce((select jsonb_agg(jsonb_build_object('paymentMethod',method,'salesCents',sales,'reversalCents',reversed,'netCents',sales-reversed) order by method)
  from (select method,coalesce((select sum(total_cents) from s where payment_method=method),0) sales,coalesce((select sum(amount_cents) from r where payment_method=method),0) reversed from unnest(array['cash','card_external','transfer']) method) p),'[]'::jsonb),
 'operators',coalesce((select jsonb_agg(jsonb_build_object('name',name,'salesCents',sales,'reversalCents',reversed,'netCents',sales-reversed) order by name)
  from (select name,coalesce((select sum(total_cents) from s where operator_name=name),0) sales,coalesce((select sum(amount_cents) from r where original_operator_name=name),0) reversed
   from (select operator_name name from s union select original_operator_name name from r) names) p),'[]'::jsonb),
 'products',coalesce((select jsonb_agg(jsonb_build_object('productId',product_id,'name',name,'quantity',quantity,'salesCents',total,'taxCents',tax) order by name,product_id)
  from (select product_id,name,sum(quantity) quantity,sum(total_cents) total,sum(tax_cents) tax from i group by product_id,name) p),'[]'::jsonb),
 'cashDifferences',coalesce((select jsonb_agg(jsonb_build_object('shiftId',id,'closedAt',closed_at,'expectedCents',expected_cents,'countedCents',counted_cents,'differenceCents',difference_cents) order by closed_at,id)
  from app_private.cash_shifts where business_id=p_business and status='closed' and closed_at>=start_at and closed_at<end_at),'[]'::jsonb)) into result;
 return result;
end; $$;

create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
#variable_conflict use_column
<<pos_command>>
declare
 actor app_private.employees%rowtype; business app_private.businesses%rowtype; o app_private.operational_orders%rowtype;
 s app_private.cash_shifts%rowtype; t app_private.dining_tables%rowtype; l app_private.order_lines%rowtype;
 a app_private.checkout_attempts%rowtype; w app_private.balance_waivers%rowtype; b app_private.kitchen_batches%rowtype;
 product app_private.products%rowtype; sale app_private.sales%rowtype; operation app_private.pos_operations%rowtype;
 c text:=p_payload->>'command'; p jsonb; fingerprint bytea; operation_id uuid; result jsonb; rows jsonb; lines jsonb;
 line jsonb; pricing jsonb; slices jsonb; line_id uuid; order_id uuid; table_id uuid; qty integer; revision integer;
 total bigint; tax bigint; discount bigint; expected bigint; enabled boolean; permitted boolean; permission text; reason text;
 read_orders boolean; manage_orders boolean; create_sales boolean; read_cash boolean; own_counter boolean;
begin
 -- These are reached only after live Auth/operator/device checks in public service-only RPCs.
 select * into actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active and deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
 select * into business from app_private.businesses where id=p_business_id;
 if c in ('catalog','save_product','set_product_active','set_product_sold_out','delete_product','upload_product_image','complete_sale','sales','sale') then
  if c='complete_sale' then
   if not app_private.has_permission(p_business_id,actor.id,'sales.create') then raise exception 'PERMISSION_DENIED'; end if;
   -- Authorize before replay; the old function still verifies actor and fingerprint itself.
   if exists(select 1 from app_private.pos_operations where business_id=p_business_id and operation_id=(p_payload->>'operationId')::uuid) then
    return app_private.legacy_pos_command(p_business_id,p_employee_id,p_payload);
   end if;
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
   if exists(select 1 from app_private.operational_settings where business_id=p_business_id and enabled) then raise exception 'LEGACY_CHECKOUT_DISABLED'; end if;
  end if;
  return app_private.legacy_pos_command(p_business_id,p_employee_id,p_payload);
 end if;
 p:=p_payload-array['action','businessId','operatorToken','deviceToken'];
 perform app_private.ops_validate(p);
 if p ? 'operationId' then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0)); end if;
 read_orders:=app_private.has_permission(p_business_id,actor.id,'orders.read');
 manage_orders:=app_private.has_permission(p_business_id,actor.id,'orders.manage');
 create_sales:=app_private.has_permission(p_business_id,actor.id,'sales.create');
 read_cash:=app_private.has_permission(p_business_id,actor.id,'cash.read');
 if p ? 'orderId' then
  order_id:=app_private.ops_uuid(p->'orderId'); select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id;
  own_counter:=o.id is not null and o.actor_id=actor.id and o.table_id is null;
 else own_counter:=false; end if;
 permission:=case c
 when 'shifts' then 'cash.read' when 'open_shift' then 'cash.open' when 'cash_movement' then 'cash.move'
 when 'begin_shift_close' then 'cash.close' when 'abort_shift_close' then 'cash.close' when 'close_shift' then 'cash.close'
 when 'orders' then 'orders.read' when 'set_order_discount' then 'sales.discount' when 'cancel_order' then 'orders.cancel'
 when 'send_order' then 'orders.manage' when 'kitchen' then 'kitchen.read' when 'set_kitchen_status' then 'kitchen.operate'
 when 'tables' then 'orders.read' when 'save_table' then 'tables.manage' when 'move_order' then 'tables.manage'
 when 'prepare_checkout' then 'sales.create' when 'prepare_reversal' then 'sales.reverse' when 'report' then 'reports.read'
 else null end;
 if permission is not null and not app_private.has_permission(p_business_id,actor.id,permission) then
  if not (c='tables' and manage_orders) then raise exception 'PERMISSION_DENIED'; end if;
 end if;
 if c='activate_operations' or c in ('prepare_waiver','confirm_waiver') then
  if actor.role<>'owner' or actor.user_id is null then raise exception 'PERMISSION_DENIED'; end if;
  if current_setting('app.pos_session_kind',true) is distinct from 'personal' then raise exception 'PERMISSION_DENIED'; end if;
  perform app_private.assert_owner(actor.user_id,p_business_id);
 elsif c='operations' then
  if not (read_orders or manage_orders or create_sales or read_cash or app_private.has_permission(p_business_id,actor.id,'cash.open') or app_private.has_permission(p_business_id,actor.id,'kitchen.read')) then raise exception 'PERMISSION_DENIED'; end if;
 elsif c='save_order' then
  if not manage_orders and not (create_sales and p->'tableId'='null'::jsonb and (p->'expectedRevision'='null'::jsonb or own_counter)) then raise exception 'PERMISSION_DENIED'; end if;
 elsif c='order' then
  if not (read_orders or manage_orders or create_sales and own_counter) then raise exception 'PERMISSION_DENIED'; end if;
 elsif c in ('begin_order_checkout','resume_order_service','close_order') then
  if not (manage_orders or create_sales and (own_counter or read_orders) or c='close_order' and app_private.has_permission(p_business_id,actor.id,'tables.manage')) then raise exception 'PERMISSION_DENIED'; end if;
 elsif c in ('attempt','start_checkout','mark_checkout_uncertain','resolve_checkout') then
  select * into a from app_private.checkout_attempts where business_id=p_business_id and id=app_private.ops_uuid(p->'attemptId');
  if a.id is null then
   if not (create_sales or app_private.has_permission(p_business_id,actor.id,'sales.reverse')) then raise exception 'PERMISSION_DENIED'; end if;
   raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if a.kind='reversal' then permitted:=app_private.has_permission(p_business_id,actor.id,'sales.reverse');
  else permitted:=create_sales and (a.actor_identity=actor.id or manage_orders); end if;
  if not permitted then raise exception 'PERMISSION_DENIED'; end if;
 end if;
 if c='prepare_checkout' and not (read_orders or manage_orders or own_counter) then raise exception 'PERMISSION_DENIED'; end if;
 select coalesce((select os.enabled from app_private.operational_settings os where os.business_id=p_business_id),false) into enabled;
 -- Reading enabled=false is how a compatible client decides whether to use legacy checkout.
 if c='operations' then
  select * into s from app_private.cash_shifts where business_id=p_business_id and status in ('open','closing');
  result:=case when s.id is null then 'null'::jsonb else app_private.ops_shift_json(s) end;
  if s.id is not null and not read_cash then result:=result||jsonb_build_object('openingCents',0,'countedCents',null,'expectedCents',null,'differenceCents',null,'movements','[]'::jsonb); end if;
  select coalesce(jsonb_agg(app_private.ops_order_json(oo) order by oo.updated_at desc,oo.id),'[]'::jsonb) into rows
   from (select * from app_private.operational_orders where business_id=p_business_id and status in ('open','paid','waived','cancelled') and (read_orders or manage_orders or create_sales and actor_id=actor.id and table_id is null) order by updated_at desc,id limit 100) oo;
  select coalesce(jsonb_agg(app_private.ops_attempt_json(aa) order by aa.created_at,aa.id),'[]'::jsonb) into lines
   from app_private.checkout_attempts aa where aa.business_id=p_business_id and aa.status in ('prepared','collection_started','uncertain')
    and (aa.kind='payment' and create_sales and (aa.actor_identity=actor.id or manage_orders) or aa.kind='reversal' and app_private.has_permission(p_business_id,actor.id,'sales.reverse'));
  return jsonb_build_object('data',jsonb_build_object('enabled',enabled,'shift',result,'orders',rows,'attempts',lines,'tables',
   case when read_orders or manage_orders then coalesce((select jsonb_agg(app_private.ops_table_json(dt) order by dt.name,dt.id) from app_private.dining_tables dt where dt.business_id=p_business_id),'[]'::jsonb) else '[]'::jsonb end));
 end if;
 if not enabled and c not in ('activate_operations','report') then raise exception 'OPERATIONS_DISABLED'; end if;
 if c='orders' then
  select coalesce(jsonb_agg(app_private.ops_order_json(oo) order by oo.updated_at desc,oo.id),'[]'::jsonb) into rows from
   (select * from app_private.operational_orders where business_id=p_business_id order by updated_at desc,id limit 100) oo;
  return jsonb_build_object('data',jsonb_build_object('orders',rows));
 elsif c='order' then
  if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if; return jsonb_build_object('data',app_private.ops_order_json(o));
 elsif c='shifts' then
  select coalesce(jsonb_agg(app_private.ops_shift_json(ss) order by ss.opened_at desc,ss.id),'[]'::jsonb) into rows from
   (select * from app_private.cash_shifts where business_id=p_business_id order by opened_at desc,id limit 50) ss;
  return jsonb_build_object('data',jsonb_build_object('shifts',rows));
 elsif c='tables' then
  select coalesce(jsonb_agg(app_private.ops_table_json(dt) order by dt.name,dt.id),'[]'::jsonb) into rows from app_private.dining_tables dt where dt.business_id=p_business_id;
  return jsonb_build_object('data',jsonb_build_object('tables',rows));
 elsif c='kitchen' then
  select coalesce(jsonb_agg(app_private.ops_batch_json(kb) order by kb.created_at,kb.id),'[]'::jsonb) into rows from
   (select * from app_private.kitchen_batches where business_id=p_business_id and (status<>'delivered' or created_at>clock_timestamp()-interval '1 day') order by created_at desc,id limit 100) kb;
  return jsonb_build_object('data',jsonb_build_object('batches',rows));
 elsif c='attempt' then return jsonb_build_object('data',app_private.ops_attempt_json(a));
 elsif c='report' then return jsonb_build_object('data',app_private.ops_report(p_business_id,(p->>'date')::date)); end if;

 operation_id:=app_private.ops_uuid(p->'operationId');
 if c in ('save_order','prepare_checkout') then
  select jsonb_agg(i order by i->>'lineId') into lines from jsonb_array_elements(p->'items') i;
  p:=jsonb_set(p,'{items}',lines);
 end if;
 fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 -- A business mutex serializes count/collection/table claims and UUID races. No external calls inside this transaction.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
 select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=pos_command.operation_id;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint<>fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 -- Re-read under the mutex after concurrent commands. Permissions were checked before replay.
 if order_id is not null then select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id for update; end if;
 if c='activate_operations' then
  insert into app_private.operational_settings(business_id,enabled,activated_at,activated_by) values(p_business_id,true,clock_timestamp(),actor.id)
   on conflict(business_id) do update set enabled=true,activated_at=coalesce(operational_settings.activated_at,excluded.activated_at),activated_by=coalesce(operational_settings.activated_by,excluded.activated_by);
  result:=jsonb_build_object('enabled',true);
 elsif c='open_shift' then
  if exists(select 1 from app_private.cash_shifts where business_id=p_business_id and status in ('open','closing')) then raise exception 'SHIFT_ALREADY_OPEN'; end if;
  insert into app_private.cash_shifts(business_id,opening_cents,opened_by,opener_name) values(p_business_id,(p->>'openingCents')::bigint,actor.id,actor.name) returning * into s;
  result:=app_private.ops_shift_json(s);
 elsif c in ('cash_movement','begin_shift_close','abort_shift_close','close_shift') then
  select * into s from app_private.cash_shifts where business_id=p_business_id and id=(p->>'shiftId')::uuid for update;
  if s.id is null or s.revision<>(p->>'expectedRevision')::integer then raise exception 'SHIFT_CHANGED'; end if;
  if c='cash_movement' then
   if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
   insert into app_private.cash_movements(business_id,shift_id,kind,amount_cents,reason,actor_id,actor_name)
    values(p_business_id,s.id,p->>'kind',(p->>'amountCents')::bigint,app_private.ops_text(p->'reason',1,200),actor.id,actor.name);
   update app_private.cash_shifts set revision=cash_shifts.revision+1 where business_id=p_business_id and id=s.id returning * into s;
  elsif c='begin_shift_close' then
   if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
   if app_private.ops_pending(p_business_id,null,s.id) then raise exception 'PENDING_COLLECTION'; end if;
   update app_private.cash_shifts set status='closing',revision=cash_shifts.revision+1 where business_id=p_business_id and id=s.id returning * into s;
  elsif c='abort_shift_close' then
   if s.status<>'closing' then raise exception 'SHIFT_NOT_OPEN'; end if;
   update app_private.cash_shifts set status='open',revision=cash_shifts.revision+1 where business_id=p_business_id and id=s.id returning * into s;
  else
   if s.status<>'closing' then raise exception 'SHIFT_NOT_OPEN'; end if;
   if app_private.ops_pending(p_business_id,null,s.id) then raise exception 'PENDING_COLLECTION'; end if;
   expected:=s.opening_cents
    +coalesce((select sum(case when m.kind='in' then m.amount_cents else -m.amount_cents end) from app_private.cash_movements m where m.business_id=p_business_id and m.shift_id=s.id),0)
    +coalesce((select sum(total_cents) from app_private.checkout_attempts where business_id=p_business_id and shift_id=s.id and kind='payment' and status='completed' and payment_method='cash'),0)
    -coalesce((select sum(amount_cents) from app_private.sale_reversals where business_id=p_business_id and shift_id=s.id and payment_method='cash'),0);
   update app_private.cash_shifts set status='closed',revision=cash_shifts.revision+1,closed_at=clock_timestamp(),closed_by=actor.id,closer_name=actor.name,
    counted_cents=(p->>'countedCents')::bigint,expected_cents=expected,difference_cents=(p->>'countedCents')::bigint-expected where business_id=p_business_id and id=s.id returning * into s;
  end if;
  result:=app_private.ops_shift_json(s);
 elsif c='save_table' then
  select * into t from app_private.dining_tables where business_id=p_business_id and id=(p->>'tableId')::uuid for update;
  if p->'expectedRevision'='null'::jsonb then
   if t.id is not null then raise exception 'TABLE_CHANGED'; end if;
   insert into app_private.dining_tables(business_id,id,name,active) values(p_business_id,(p->>'tableId')::uuid,app_private.ops_text(p->'name',1,60),(p->>'active')::boolean) returning * into t;
  else
   if t.id is null or t.revision<>(p->>'expectedRevision')::integer then raise exception 'TABLE_CHANGED'; end if;
   if not (p->>'active')::boolean and exists(select 1 from app_private.operational_orders where business_id=p_business_id and table_id=t.id and status in ('open','paid','waived','cancelled')) then raise exception 'TABLE_OCCUPIED'; end if;
   update app_private.dining_tables set name=app_private.ops_text(p->'name',1,60),active=(p->>'active')::boolean,revision=dining_tables.revision+1 where business_id=p_business_id and id=t.id returning * into t;
  end if;
  result:=app_private.ops_table_json(t);
 elsif c='set_kitchen_status' then
  select * into b from app_private.kitchen_batches where business_id=p_business_id and id=(p->>'batchId')::uuid for update;
  if b.id is null or b.revision<>(p->>'expectedRevision')::integer then raise exception 'BATCH_CHANGED'; end if;
  if not (b.status='queued' and p->>'status'='preparing' or b.status='preparing' and p->>'status'='ready' or b.status='ready' and p->>'status'='delivered'
   or b.kind='cancellation' and b.status='queued' and p->>'status'='delivered') then raise exception 'BATCH_CHANGED'; end if;
  update app_private.kitchen_batches set status=p->>'status',revision=kitchen_batches.revision+1 where business_id=p_business_id and id=b.id returning * into b;
  insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload)
   select p_business_id,b.order_id,oo.revision,c,actor.id,actor.name,jsonb_build_object('batchId',b.id,'status',b.status) from app_private.operational_orders oo where oo.business_id=p_business_id and oo.id=b.order_id;
  result:=app_private.ops_batch_json(b);
 else
  -- Order and checkout commands continue below.
  result:=null;
 end if;
 if result is null and c='save_order' then
  table_id:=case when p->'tableId'='null'::jsonb then null else (p->>'tableId')::uuid end;
  if p->'expectedRevision'='null'::jsonb then
   if o.id is not null then raise exception 'ORDER_CHANGED'; end if;
   insert into app_private.operational_orders(business_id,id,name,table_id,actor_id,operator_name)
    values(p_business_id,order_id,app_private.ops_text(p->'name',1,100),table_id,actor.id,actor.name) returning * into o;
  else
   if o.id is null or o.revision<>(p->>'expectedRevision')::integer then raise exception 'ORDER_CHANGED'; end if;
   if o.status<>'open' or o.frozen or o.phase<>'service' then raise exception 'ORDER_LOCKED'; end if;
   if app_private.ops_pending(p_business_id,o.id) then raise exception 'PENDING_COLLECTION'; end if;
   if table_id is distinct from o.table_id and not app_private.has_permission(p_business_id,actor.id,'tables.manage') then raise exception 'PERMISSION_DENIED'; end if;
   if exists(select 1 from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and ol.sent_quantity>0
    and not exists(select 1 from jsonb_array_elements(p->'items') i where i->>'lineId'=ol.id::text)) then raise exception 'ORDER_LOCKED'; end if;
   update app_private.operational_orders set name=app_private.ops_text(p->'name',1,100),table_id=pos_command.table_id,revision=operational_orders.revision+1,updated_at=clock_timestamp()
    where business_id=p_business_id and id=o.id returning * into o;
  end if;
  if table_id is not null then
   if not exists(select 1 from app_private.dining_tables where business_id=p_business_id and id=table_id and active) then raise exception 'TABLE_CHANGED'; end if;
   if exists(select 1 from app_private.operational_orders oo where oo.business_id=p_business_id and oo.table_id=pos_command.table_id and oo.id<>o.id and oo.status in ('open','paid','waived','cancelled')) then raise exception 'TABLE_OCCUPIED'; end if;
  end if;
  -- Lock selected catalog rows in UUID order only while accepting new quantities. Checkout never re-reads prices.
  perform 1 from app_private.products pp where pp.business_id=p_business_id and pp.id in (select (i->>'productId')::uuid from jsonb_array_elements(p->'items') i) order by pp.id for share;
  for line in select * from jsonb_array_elements(p->'items') loop
   line_id:=(line->>'lineId')::uuid; qty:=(line->>'quantity')::integer;
   select * into l from app_private.order_lines where business_id=p_business_id and order_id=o.id and id=line_id;
   if l.id is not null then
    if l.product_id<>(line->>'productId')::uuid or l.product_version<>(line->>'version')::integer or l.unit_price_cents<>(line->>'unitPriceCents')::integer
     or l.selection is distinct from line->'selection' then raise exception 'ORDER_CHANGED'; end if;
    if qty<l.sent_quantity or (l.sent_quantity>0 and l.note<>app_private.ops_text(line->'note',0,160)) then raise exception 'ORDER_LOCKED'; end if;
    if qty>l.quantity then
     select * into product from app_private.products where business_id=p_business_id and id=l.product_id;
     if product.deleted_at is not null or not product.active or coalesce((product.details->>'soldOut')::boolean,false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
     perform app_private.product_selection(product,l.selection);
    end if;
    update app_private.order_lines set quantity=qty,note=app_private.ops_text(line->'note',0,160),gross_cents=qty::bigint*l.unit_price_cents,discount_cents=0,
     total_cents=qty::bigint*l.unit_price_cents,tax_cents=app_private.included_vat_cents(qty::bigint*l.unit_price_cents,l.tax_bps)
     where business_id=p_business_id and order_id=o.id and id=l.id;
   else
    select * into product from app_private.products where business_id=p_business_id and id=(line->>'productId')::uuid;
    if product.id is null or product.deleted_at is not null or not product.active or coalesce((product.details->>'soldOut')::boolean,false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    pricing:=app_private.product_selection(product,line->'selection');
    if product.version<>(line->>'version')::integer or (pricing->>'price')::integer<>(line->>'unitPriceCents')::integer then raise exception 'PRODUCT_CHANGED'; end if;
    insert into app_private.order_lines(business_id,order_id,id,product_id,product_version,selection,name,kitchen_name,category,selection_label,note,quantity,unit_price_cents,gross_cents,total_cents,tax_cents,tax_bps,tax_treatment)
     values(p_business_id,o.id,line_id,product.id,product.version,line->'selection',product.name,coalesce(nullif(product.details->>'kitchenName',''),product.name),product.category,pricing->>'label',
      app_private.ops_text(line->'note',0,160),qty,(pricing->>'price')::integer,qty::bigint*(pricing->>'price')::integer,qty::bigint*(pricing->>'price')::integer,
      app_private.included_vat_cents(qty::bigint*(pricing->>'price')::integer,coalesce((product.details->>'taxBps')::integer,0)),coalesce((product.details->>'taxBps')::integer,0),app_private.product_tax_treatment(product.details));
   end if;
  end loop;
  delete from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and not exists(select 1 from jsonb_array_elements(p->'items') i where i->>'lineId'=ol.id::text);
  perform app_private.ops_price_order(p_business_id,o.id);
  result:=app_private.ops_order_json(o);
 elsif result is null and c in ('set_order_discount','cancel_order','send_order','begin_order_checkout','resume_order_service','move_order','close_order','prepare_checkout','prepare_waiver') then
  if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.revision<>(p->>'expectedRevision')::integer then raise exception 'ORDER_CHANGED'; end if;
  if app_private.ops_pending(p_business_id,o.id) then raise exception 'PENDING_COLLECTION'; end if;
  if c='move_order' then
   if o.status not in ('open','paid','waived','cancelled') then raise exception 'ORDER_LOCKED'; end if;
   table_id:=case when p->'tableId'='null'::jsonb then null else (p->>'tableId')::uuid end;
   if table_id is not null then
    if not exists(select 1 from app_private.dining_tables where business_id=p_business_id and id=table_id and active) then raise exception 'TABLE_CHANGED'; end if;
    if exists(select 1 from app_private.operational_orders oo where oo.business_id=p_business_id and oo.table_id=pos_command.table_id and oo.id<>o.id and oo.status in ('open','paid','waived','cancelled')) then raise exception 'TABLE_OCCUPIED'; end if;
   end if;
   update app_private.operational_orders set table_id=pos_command.table_id,revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_order_json(o);
  elsif c='close_order' then
   if o.status not in ('paid','waived','cancelled') then raise exception 'ORDER_LOCKED'; end if;
   update app_private.operational_orders set status='closed',revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_order_json(o);
  elsif c='cancel_order' then
   if o.status<>'open' then raise exception 'ORDER_LOCKED'; end if;
   if exists(select 1 from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and ol.paid_quantity<ol.quantity
    and (select coalesce(sum((i->>'quantity')::integer),0) from app_private.kitchen_batches kb cross join lateral jsonb_array_elements(kb.items) i
     where kb.business_id=p_business_id and kb.order_id=o.id and kb.kind='items' and kb.status in ('preparing','ready','delivered') and i->>'lineId'=ol.id::text)>ol.paid_quantity) then raise exception 'ORDER_LOCKED'; end if;
   slices:='[]'::jsonb; total:=0;
   for l in select * from app_private.order_lines where business_id=p_business_id and order_id=o.id and quantity>paid_quantity order by id loop
    pricing:=app_private.ops_slice(l,l.quantity-l.paid_quantity); slices:=slices||jsonb_build_array(pricing); total:=total+(pricing->>'totalCents')::bigint;
   end loop;
   if jsonb_array_length(slices)=0 then raise exception 'ORDER_HAS_PAYMENTS'; end if;
   insert into app_private.order_cancellations(business_id,order_id,amount_cents,reason,items,actor_id,actor_name)
    values(p_business_id,o.id,total,app_private.ops_text(p->'reason',1,200),slices,actor.id,actor.name);
   select jsonb_agg(jsonb_build_object('lineId',ol.id,'name',ol.kitchen_name,'selectionLabel',ol.selection_label,'note',ol.note,'quantity',ol.sent_quantity-ol.paid_quantity) order by ol.id) into lines
    from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and ol.sent_quantity>ol.paid_quantity;
   if lines is not null then
    insert into app_private.kitchen_batches(business_id,order_id,order_name,table_name,kind,reason,items,actor_id,actor_name)
     values(p_business_id,o.id,o.name,(select name from app_private.dining_tables where business_id=p_business_id and id=o.table_id),'cancellation',app_private.ops_text(p->'reason',1,200),lines,actor.id,actor.name);
   end if;
   update app_private.operational_orders set status='cancelled',revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_order_json(o);
  elsif c='send_order' then
   if o.status<>'open' or o.phase<>'service' or o.frozen then raise exception 'ORDER_LOCKED'; end if;
   select jsonb_agg(jsonb_build_object('lineId',ol.id,'name',ol.kitchen_name,'selectionLabel',ol.selection_label,'note',ol.note,'quantity',ol.quantity-ol.sent_quantity) order by ol.id) into lines
    from app_private.order_lines ol where ol.business_id=p_business_id and ol.order_id=o.id and ol.quantity>ol.sent_quantity;
   if lines is null then raise exception 'ORDER_CHANGED'; end if;
   insert into app_private.kitchen_batches(business_id,order_id,order_name,table_name,kind,items,actor_id,actor_name)
    values(p_business_id,o.id,o.name,(select name from app_private.dining_tables where business_id=p_business_id and id=o.table_id),'items',lines,actor.id,actor.name);
   update app_private.order_lines set sent_quantity=quantity where business_id=p_business_id and order_id=o.id;
   update app_private.operational_orders set revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_order_json(o);
  elsif c='begin_order_checkout' or c='resume_order_service' then
   if o.status<>'open' then raise exception 'ORDER_LOCKED'; end if;
   if c='begin_order_checkout' then
    if o.phase<>'service' then raise exception 'ORDER_LOCKED'; end if;
    update app_private.operational_orders set phase='checkout',revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   else
    if o.phase<>'checkout' or o.frozen then raise exception 'ORDER_LOCKED'; end if;
    update app_private.operational_orders set phase='service',revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   end if;
   result:=app_private.ops_order_json(o);
  elsif c='set_order_discount' then
   if o.status<>'open' or o.frozen or o.phase<>'service' then raise exception 'ORDER_LOCKED'; end if;
   update app_private.operational_orders set discount=nullif(p->'discount','null'::jsonb),revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   perform app_private.ops_price_order(p_business_id,o.id);
   result:=app_private.ops_order_json(o);
  elsif c='prepare_checkout' then
   if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;
   select * into s from app_private.cash_shifts where business_id=p_business_id and status in ('open','closing') for update;
   if s.id is null then raise exception 'SHIFT_REQUIRED'; end if;
   if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
   if not (business.profile->'paymentMethods' ? (p->>'paymentMethod')) then raise exception 'PAYMENT_METHOD_DISABLED'; end if;
   slices:='[]'::jsonb; total:=0; tax:=0; discount:=0;
   for line in select * from jsonb_array_elements(p->'items') loop
    select * into l from app_private.order_lines where business_id=p_business_id and order_id=o.id and id=(line->>'lineId')::uuid;
    qty:=(line->>'quantity')::integer;
    if l.id is null or qty>l.quantity-l.paid_quantity then raise exception 'ORDER_CHANGED'; end if;
    pricing:=app_private.ops_slice(l,qty); slices:=slices||jsonb_build_array(pricing);
    total:=total+(pricing->>'totalCents')::bigint; tax:=tax+(pricing->>'taxCents')::bigint; discount:=discount+(pricing->>'discountCents')::bigint;
   end loop;
   insert into app_private.checkout_attempts(business_id,kind,order_id,shift_id,payment_method,total_cents,tax_cents,discount_cents,items,actor_id,actor_identity,operator_name)
    values(p_business_id,'payment',o.id,s.id,p->>'paymentMethod',total,tax,discount,slices,actor.id,actor.id,actor.name) returning * into a;
   update app_private.operational_orders set revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
   result:=app_private.ops_attempt_json(a);
  else
   -- A prepared waiver exposes the exact balance; confirming is a distinct owner action.
   if o.status<>'open' then raise exception 'ORDER_LOCKED'; end if;
   slices:='[]'::jsonb; total:=0;
   for l in select * from app_private.order_lines where business_id=p_business_id and order_id=o.id and quantity>paid_quantity order by id loop
    pricing:=app_private.ops_slice(l,l.quantity-l.paid_quantity); slices:=slices||jsonb_build_array(pricing); total:=total+(pricing->>'totalCents')::bigint;
   end loop;
   if jsonb_array_length(slices)=0 then raise exception 'ORDER_HAS_PAYMENTS'; end if;
   insert into app_private.balance_waivers(business_id,order_id,order_revision,amount_cents,reason,actor_id,actor_identity,operator_name,timezone,items)
    values(p_business_id,o.id,o.revision,total,app_private.ops_text(p->'reason',1,200),actor.id,actor.id,actor.name,business.timezone,slices) returning * into w;
   result:=app_private.ops_waiver_json(w);
  end if;
 elsif result is null and c='prepare_reversal' then
  select * into sale from app_private.sales where business_id=p_business_id and id=(p->>'saleId')::uuid for share;
  if sale.id is null then raise exception 'SALE_NOT_FOUND'; end if;
  if exists(select 1 from app_private.sale_reversals where business_id=p_business_id and sale_id=sale.id)
   or exists(select 1 from app_private.checkout_attempts where business_id=p_business_id and original_sale_id=sale.id and kind='reversal' and status<>'aborted') then raise exception 'SALE_ALREADY_REVERSED'; end if;
  select * into s from app_private.cash_shifts where business_id=p_business_id and status in ('open','closing') for update;
  if s.id is null then raise exception 'SHIFT_REQUIRED'; end if;
  if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
  select coalesce(sum(si.tax_cents),0),coalesce(sum(si.discount_cents),0),jsonb_agg(jsonb_build_object('lineId',si.line_id,'productId',si.product_id,'name',si.name,'category',si.category,'selectionLabel',si.selection_label,
   'quantity',si.quantity,'unitPriceCents',si.unit_price_cents,'discountCents',si.discount_cents,'totalCents',si.total_cents,'taxCents',si.tax_cents,'taxBps',si.tax_bps,'taxTreatment',coalesce(si.tax_treatment,'legacy')) order by si.line_id)
   into tax,discount,slices from app_private.sale_items si where si.business_id=p_business_id and si.sale_id=sale.id;
  insert into app_private.checkout_attempts(business_id,kind,shift_id,original_sale_id,payment_method,total_cents,tax_cents,discount_cents,items,actor_id,actor_identity,operator_name,reason)
   values(p_business_id,'reversal',s.id,sale.id,sale.payment_method,sale.total_cents,tax,discount,slices,actor.id,actor.id,actor.name,app_private.ops_text(p->'reason',1,200)) returning * into a;
  result:=app_private.ops_attempt_json(a);
 elsif result is null and c in ('start_checkout','mark_checkout_uncertain','resolve_checkout') then
  select * into a from app_private.checkout_attempts where business_id=p_business_id and id=(p->>'attemptId')::uuid for update;
  if a.id is null then raise exception 'ATTEMPT_NOT_FOUND'; end if;
  if a.revision<>(p->>'expectedRevision')::integer then raise exception 'ATTEMPT_CHANGED'; end if;
  select * into s from app_private.cash_shifts where business_id=p_business_id and id=a.shift_id for update;
  if s.status<>'open' then raise exception 'SHIFT_NOT_OPEN'; end if;
  if c='start_checkout' then
   if a.status<>'prepared' then raise exception 'ATTEMPT_STATE_INVALID'; end if;
   update app_private.checkout_attempts set status='collection_started',revision=checkout_attempts.revision+1 where business_id=p_business_id and id=a.id returning * into a;
  elsif c='mark_checkout_uncertain' then
   if a.status<>'collection_started' then raise exception 'ATTEMPT_STATE_INVALID'; end if;
   update app_private.checkout_attempts set status='uncertain',revision=checkout_attempts.revision+1 where business_id=p_business_id and id=a.id returning * into a;
  else
   if a.status not in ('prepared','collection_started','uncertain') then raise exception 'ATTEMPT_STATE_INVALID'; end if;
   if p->>'resolution'='complete' and a.status='prepared' then raise exception 'ATTEMPT_STATE_INVALID'; end if;
   reason:=app_private.ops_text(p->'reason',1,200);
   if p->>'resolution'='complete' and a.kind='payment' then
    select * into o from app_private.operational_orders where business_id=p_business_id and id=a.order_id for update;
    if o.status<>'open' or o.phase<>'checkout' then raise exception 'ORDER_LOCKED'; end if;
    insert into app_private.sales(business_id,employee_id,operator_name,operation_id,total_cents,item_count,payment_method,timezone)
     values(p_business_id,a.actor_id,a.operator_name,a.id,a.total_cents,(select sum((x->>'quantity')::integer) from jsonb_array_elements(a.items) x),a.payment_method,business.timezone) returning * into sale;
    insert into app_private.sale_items(business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps,discount_cents)
     select p_business_id,sale.id,(x->>'productId')::uuid,x->>'name',x->>'category',(x->>'quantity')::integer,(x->>'unitPriceCents')::integer,(x->>'totalCents')::bigint,
      x->>'selectionLabel',(x->>'taxCents')::bigint,x->>'taxTreatment',(x->>'taxBps')::integer,(x->>'discountCents')::bigint from jsonb_array_elements(a.items) x;
    for line in select * from jsonb_array_elements(a.items) loop
     update app_private.order_lines set paid_quantity=paid_quantity+(line->>'quantity')::integer where business_id=p_business_id and order_id=o.id and id=(line->>'lineId')::uuid
      and paid_quantity+(line->>'quantity')::integer<=quantity;
     if not found then raise exception 'ORDER_CHANGED'; end if;
    end loop;
    update app_private.operational_orders set frozen=true,status=case when exists(select 1 from app_private.order_lines where business_id=p_business_id and order_id=o.id and quantity>paid_quantity) then 'open' else 'paid' end,
     revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
    update app_private.checkout_attempts set sale_id=sale.id where business_id=p_business_id and id=a.id;
   elsif p->>'resolution'='complete' then
    select * into sale from app_private.sales where business_id=p_business_id and id=a.original_sale_id;
    insert into app_private.sale_reversals(business_id,sale_id,attempt_id,shift_id,amount_cents,tax_cents,payment_method,original_operator_name,actor_id,actor_identity,actor_name,resolver_id,resolver_name,reason,timezone)
     values(p_business_id,sale.id,a.id,s.id,a.total_cents,a.tax_cents,a.payment_method,sale.operator_name,a.actor_id,a.actor_identity,a.operator_name,actor.id,actor.name,a.reason||' / '||reason,business.timezone);
   end if;
   update app_private.checkout_attempts set status=case when p->>'resolution'='complete' then 'completed' else 'aborted' end,revision=checkout_attempts.revision+1,
    resolver_id=actor.id,resolver_name=actor.name,resolution_reason=reason,resolved_at=clock_timestamp() where business_id=p_business_id and id=a.id returning * into a;
   if a.kind='payment' and p->>'resolution'='abort' then
    update app_private.operational_orders set revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=a.order_id returning * into o;
   end if;
   -- Financial effect and immutable accepted response commit together.
   if a.order_id is not null then
    insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload)
     values(p_business_id,a.order_id,o.revision,c,actor.id,actor.name,jsonb_build_object('attemptId',a.id,'status',a.status,'originalActor',a.actor_identity,'resolver',actor.id));
   end if;
  end if;
  result:=app_private.ops_attempt_json(a);
 elsif result is null and c='confirm_waiver' then
  select * into w from app_private.balance_waivers where business_id=p_business_id and id=(p->>'waiverId')::uuid for update;
  if w.id is null or w.revision<>(p->>'expectedRevision')::integer or w.status<>'prepared' then raise exception 'WAIVER_CHANGED'; end if;
  select * into o from app_private.operational_orders where business_id=p_business_id and id=w.order_id for update;
  if o.status<>'open' or o.revision<>w.order_revision then raise exception 'WAIVER_CHANGED'; end if;
  if app_private.ops_pending(p_business_id,o.id) then raise exception 'PENDING_COLLECTION'; end if;
  update app_private.balance_waivers set status='completed',revision=balance_waivers.revision+1,resolver_id=actor.id,resolver_name=actor.name,resolved_at=clock_timestamp() where business_id=p_business_id and id=w.id returning * into w;
  update app_private.operational_orders set status='waived',frozen=true,revision=operational_orders.revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
  insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload) values(p_business_id,o.id,o.revision,c,actor.id,actor.name,jsonb_build_object('waiverId',w.id,'amountCents',w.amount_cents));
  result:=app_private.ops_waiver_json(w);
 end if;
 if result is null then raise exception 'VALIDATION_ERROR'; end if;
 if order_id is not null and c not in ('prepare_waiver') then
  insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload) values(p_business_id,o.id,o.revision,c,actor.id,actor.name,
   case when c='save_order' then app_private.ops_order_json(o) else p-'operationId' end);
 end if;
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,pos_command.operation_id,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
exception when unique_violation then
 -- Expected state races map to stable domain errors; unrelated constraints must remain server errors.
 if sqlerrm like '%one_occupied_table_account%' then raise exception 'TABLE_OCCUPIED';
 elsif sqlerrm like '%one_active_cash_shift%' then raise exception 'SHIFT_ALREADY_OPEN';
 elsif sqlerrm like '%one_pending_order_collection%' then raise exception 'PENDING_COLLECTION';
 elsif sqlerrm like '%one_live_sale_reversal%' or sqlerrm like '%sale_reversals_business_id_sale_id_key%' then raise exception 'SALE_ALREADY_REVERSED';
 else raise; end if;
end; $$;

-- No new public RPC: the signed personal dispatcher and restricted shared-device dispatcher call this wrapper.
create or replace function public.pos_device(p_device_token text,p_operator_token text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 context:=public.account_device('device_context',jsonb_build_object('deviceToken',p_device_token,'operatorToken',p_operator_token));
 if context ? 'error' then return context; end if;
 perform set_config('app.pos_session_kind','device',true);
 return app_private.pos_command((context#>>'{data,business,id}')::uuid,(context#>>'{data,business,employee,id}')::uuid,p_payload);
end; $$;
revoke all on function public.pos_device(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.pos_device(text,text,jsonb) to service_role;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and (p.proname like 'ops_%' or p.proname in ('legacy_pos_command','pos_command')) loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 end loop;
end $$;
