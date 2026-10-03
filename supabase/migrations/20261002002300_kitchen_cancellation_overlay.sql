-- Cancellation changes executable kitchen work while preserving sent snapshots and
-- the four preparation states. A cancellation notice is acknowledged independently.
alter table app_private.kitchen_batches add constraint kitchen_batches_order_identity unique(business_id,id,order_id);
alter table app_private.order_cancellations add constraint order_cancellations_order_identity unique(business_id,id,order_id);
create table app_private.kitchen_cancellations (
 business_id uuid not null, batch_id uuid not null, order_id uuid not null, line_id uuid not null, cancellation_id uuid not null,
 quantity integer not null check(quantity between 1 and 999), created_at timestamptz not null default clock_timestamp(),
 primary key(business_id,batch_id,line_id),
 foreign key(business_id,batch_id,order_id) references app_private.kitchen_batches(business_id,id,order_id) on delete cascade,
 foreign key(business_id,order_id,line_id) references app_private.order_lines(business_id,order_id,id) on delete cascade,
 foreign key(business_id,cancellation_id,order_id) references app_private.order_cancellations(business_id,id,order_id) on delete cascade
);
alter table app_private.kitchen_cancellations enable row level security;
revoke all on app_private.kitchen_cancellations from public,anon,authenticated;

create function app_private.ops_apply_kitchen_cancellation(p_business uuid,p_cancellation uuid,p_backfill boolean default false)
returns boolean language plpgsql set search_path='' as $$
declare cancellation app_private.order_cancellations%rowtype; l app_private.order_lines%rowtype; b app_private.kitchen_batches%rowtype;
 item jsonb; remaining integer; available integer; take integer; affected uuid[]:='{}';
begin
 select * into cancellation from app_private.order_cancellations where business_id=p_business and id=p_cancellation;
 if not found then raise exception 'VALIDATION_ERROR'; end if;
 -- Preflight every line before writing. Historical work already advanced after a
 -- cancellation cannot be reconstructed as unprepared; skip that entire backfill.
 for item in select * from jsonb_array_elements(cancellation.items) loop
  select * into l from app_private.order_lines where business_id=p_business and order_id=cancellation.order_id and id=(item->>'lineId')::uuid;
  if l.id is null then if p_backfill then return false; else raise exception 'BATCH_CHANGED'; end if; end if;
  -- Unsent cancelled units are consumed first. Only the rest stops sent work.
  remaining:=greatest((item->>'quantity')::integer-greatest(l.quantity-l.sent_quantity,0),0)
   -coalesce((select sum(k.quantity)::integer from app_private.kitchen_cancellations k where k.business_id=p_business and k.cancellation_id=p_cancellation and k.line_id=l.id),0);
  select coalesce(sum((i->>'quantity')::integer-coalesce(k.quantity,0)),0)::integer into available
   from app_private.kitchen_batches kb cross join lateral jsonb_array_elements(kb.items) i
   left join app_private.kitchen_cancellations k on k.business_id=kb.business_id and k.batch_id=kb.id and k.line_id=l.id
   where kb.business_id=p_business and kb.order_id=cancellation.order_id and kb.kind='items' and kb.status='queued' and i->>'lineId'=l.id::text;
  if remaining<0 or available<remaining then if p_backfill then return false; else raise exception 'BATCH_CHANGED'; end if; end if;
 end loop;
 for item in select * from jsonb_array_elements(cancellation.items) loop
  select * into l from app_private.order_lines where business_id=p_business and order_id=cancellation.order_id and id=(item->>'lineId')::uuid;
  remaining:=greatest((item->>'quantity')::integer-greatest(l.quantity-l.sent_quantity,0),0)
   -coalesce((select sum(k.quantity)::integer from app_private.kitchen_cancellations k where k.business_id=p_business and k.cancellation_id=p_cancellation and k.line_id=l.id),0);
  -- Cancel the newest queued units first, preserving already prepared batches and
  -- any older queued units which still belong to a paid portion of the account.
  for b in select kb.* from app_private.kitchen_batches kb where kb.business_id=p_business and kb.order_id=cancellation.order_id and kb.kind='items' and kb.status='queued'
   and exists(select 1 from jsonb_array_elements(kb.items) i where i->>'lineId'=l.id::text) order by kb.created_at desc,kb.id desc for update loop
   exit when remaining=0;
   select (i->>'quantity')::integer-coalesce((select sum(k.quantity)::integer from app_private.kitchen_cancellations k where k.business_id=p_business and k.batch_id=b.id and k.line_id=l.id),0)
    into available from jsonb_array_elements(b.items) i where i->>'lineId'=l.id::text;
   take:=least(remaining,available);
   if take>0 then
    insert into app_private.kitchen_cancellations(business_id,batch_id,order_id,line_id,cancellation_id,quantity)
     values(p_business,b.id,cancellation.order_id,l.id,p_cancellation,take);
    affected:=array_append(affected,b.id); remaining:=remaining-take;
   end if;
  end loop;
  if remaining<>0 then raise exception 'BATCH_CHANGED'; end if;
 end loop;
 update app_private.kitchen_batches set revision=revision+1 where business_id=p_business and id=any(affected);
 return true;
end; $$;

create function app_private.ops_batch_fully_cancelled(b app_private.kitchen_batches)
returns boolean language sql stable set search_path='' as $$
 select b.kind='items' and not exists(select 1 from jsonb_array_elements(b.items) i
  where (i->>'quantity')::integer>coalesce((select k.quantity from app_private.kitchen_cancellations k where k.business_id=b.business_id and k.batch_id=b.id and k.line_id=(i->>'lineId')::uuid),0));
$$;
create function app_private.ops_batch_pending(b app_private.kitchen_batches)
returns boolean language sql stable set search_path='' as $$
 select b.status<>'delivered' and not app_private.ops_batch_fully_cancelled(b);
$$;
create or replace function app_private.ops_batch_json(b app_private.kitchen_batches)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',b.id,'orderId',b.order_id,'orderName',b.order_name,'tableName',b.table_name,'createdAt',b.created_at,'revision',b.revision,'status',b.status,
  'kind',b.kind,'reason',b.reason,'fullyCancelled',app_private.ops_batch_fully_cancelled(b),'items',
  (select jsonb_agg(i||jsonb_build_object('cancelledQuantity',coalesce((select k.quantity from app_private.kitchen_cancellations k where k.business_id=b.business_id and k.batch_id=b.id and k.line_id=(i->>'lineId')::uuid),0)) order by ordinal)
   from jsonb_array_elements(b.items) with ordinality items(i,ordinal)));
$$;

do $backfill$ declare c record; skipped integer:=0; begin
 for c in select business_id,id from app_private.order_cancellations order by business_id,created_at,id loop
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||c.business_id::text,0));
  if not app_private.ops_apply_kitchen_cancellation(c.business_id,c.id,true) then skipped:=skipped+1; end if;
 end loop;
 -- No identities, payloads or financial values are written to logs.
 if skipped>0 then raise notice 'Kitchen cancellation backfill skipped % historical records with incompatible current preparation state',skipped; end if;
end $backfill$;

do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$values(p_business_id,o.id,total,app_private.ops_text(p->'reason',1,200),slices,actor.id,actor.name);$old$;
 replacement:=needle||$new$
   perform app_private.ops_apply_kitchen_cancellation(p_business_id,(select id from app_private.order_cancellations where business_id=p_business_id and order_id=o.id));$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational cancellation insertion'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$if b.id is null or b.revision<>(p->>'expectedRevision')::integer then raise exception 'BATCH_CHANGED'; end if;$old$;
 replacement:=needle||$new$
  if app_private.ops_batch_fully_cancelled(b) then raise exception 'BATCH_CHANGED'; end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational kitchen revision guard'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$(select * from app_private.kitchen_batches where business_id=p_business_id and (status<>'delivered' or created_at>clock_timestamp()-interval '1 day')
    order by (status='delivered'),case when status<>'delivered' then created_at end asc nulls last,
     case when status='delivered' then created_at end desc nulls last,id limit 100) kb;$old$;
 replacement:=$new$(select kb.* from app_private.kitchen_batches kb where kb.business_id=p_business_id and (app_private.ops_batch_pending(kb) or kb.created_at>clock_timestamp()-interval '1 day')
    order by not app_private.ops_batch_pending(kb),case when app_private.ops_batch_pending(kb) then kb.created_at end asc nulls last,
     case when not app_private.ops_batch_pending(kb) then kb.created_at end desc nulls last,kb.id limit 100) kb;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected prioritized operational kitchen query'; end if;
 execute replace(definition,needle,replacement);
end $patch$;

revoke all on function app_private.ops_apply_kitchen_cancellation(uuid,uuid,boolean),app_private.ops_batch_fully_cancelled(app_private.kitchen_batches),app_private.ops_batch_pending(app_private.kitchen_batches),app_private.ops_batch_json(app_private.kitchen_batches) from public,anon,authenticated;
