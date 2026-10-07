-- Restaurant service is separate from immutable orders, payments and sale snapshots.
-- An active visit claims its physical tables until every linked account is settled.
create table app_private.service_visits (
 business_id uuid not null references app_private.businesses(id) on delete cascade,
 id uuid not null, origin_order_id uuid not null, name text not null check(length(name) between 1 and 100),
 revision integer not null default 1 check(revision>0), status text not null default 'active' check(status in ('active','closed')),
 actor_id uuid, actor_name text not null, created_at timestamptz not null default clock_timestamp(), closed_at timestamptz,
 primary key(business_id,id), foreign key(business_id,origin_order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id),
 check((status='closed')=(closed_at is not null))
);
create table app_private.service_visit_orders (
 business_id uuid not null, order_id uuid not null, visit_id uuid not null, source_order_id uuid,
 primary key(business_id,order_id), foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,visit_id) references app_private.service_visits(business_id,id) on delete cascade,
 foreign key(business_id,source_order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 check(source_order_id is null or source_order_id<>order_id)
);
create unique index service_one_continuation on app_private.service_visit_orders(business_id,source_order_id) where source_order_id is not null;
create table app_private.service_visit_tables (
 business_id uuid not null, id uuid not null default extensions.gen_random_uuid(), visit_id uuid not null, table_id uuid not null,
 claimed_at timestamptz not null default clock_timestamp(), released_at timestamptz,
 primary key(business_id,id), foreign key(business_id,visit_id) references app_private.service_visits(business_id,id) on delete cascade,
 foreign key(business_id,table_id) references app_private.dining_tables(business_id,id) on delete cascade,
 check(released_at is null or released_at>=claimed_at)
);
create unique index service_one_table_visit on app_private.service_visit_tables(business_id,table_id) where released_at is null;
create table app_private.service_courses (
 business_id uuid not null, id uuid not null, order_id uuid not null, name text not null check(length(name) between 1 and 60),
 status text not null default 'held' check(status in ('held','sent','released')), batch_id uuid, selection jsonb not null default '[]'::jsonb check(jsonb_typeof(selection)='array'),
 created_at timestamptz not null default clock_timestamp(), sent_at timestamptz,
 primary key(business_id,id), unique(business_id,order_id,id),
 foreign key(business_id,order_id) references app_private.operational_orders(business_id,id) on delete cascade,
 foreign key(business_id,batch_id) references app_private.kitchen_batches(business_id,id) on delete cascade,
 check((status='sent')=(batch_id is not null and sent_at is not null))
);
create table app_private.service_course_lines (
 business_id uuid not null, order_id uuid not null, course_id uuid not null, line_id uuid not null, quantity integer not null check(quantity between 1 and 999),
 primary key(business_id,course_id,line_id),
 foreign key(business_id,order_id,course_id) references app_private.service_courses(business_id,order_id,id) on delete cascade,
 foreign key(business_id,order_id,line_id) references app_private.order_lines(business_id,order_id,id) on delete cascade deferrable initially deferred
);
create table app_private.service_reservations (
 business_id uuid not null references app_private.businesses(id) on delete cascade, id uuid not null,
 revision integer not null default 1 check(revision>0), name text not null check(length(name) between 1 and 100),
 contact text not null default '' check(length(contact)<=80), party_size integer not null check(party_size between 1 and 100),
 starts_at timestamptz not null, ends_at timestamptz not null,
 status text not null default 'confirmed' check(status in ('confirmed','seated','cancelled','no_show','completed')),
 visit_id uuid, note text not null default '' check(length(note)<=200), actor_id uuid, actor_name text not null,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id), foreign key(business_id,visit_id) references app_private.service_visits(business_id,id) on delete cascade,
 foreign key(business_id,actor_id) references app_private.employees(business_id,id) on delete set null(actor_id),
 check(ends_at-starts_at between interval '15 minutes' and interval '12 hours'),
 check((status in ('seated','completed'))=(visit_id is not null))
);
create table app_private.service_reservation_tables (
 business_id uuid not null, reservation_id uuid not null, table_id uuid not null,
 primary key(business_id,reservation_id,table_id),
 foreign key(business_id,reservation_id) references app_private.service_reservations(business_id,id) on delete cascade,
 foreign key(business_id,table_id) references app_private.dining_tables(business_id,id) on delete cascade
);
create index service_visit_order_lookup on app_private.service_visit_orders(business_id,visit_id);
create index service_courses_order_lookup on app_private.service_courses(business_id,order_id,status);
create index service_reservations_day_lookup on app_private.service_reservations(business_id,starts_at,ends_at);
do $$ declare t text; begin
 foreach t in array array['service_visits','service_visit_orders','service_visit_tables','service_courses','service_course_lines','service_reservations','service_reservation_tables'] loop
  execute format('alter table app_private.%I enable row level security',t);
  execute format('revoke all on app_private.%I from public,anon,authenticated',t);
 end loop;
end $$;

create function app_private.service_visit_json(v app_private.service_visits) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',v.id,'revision',v.revision,'name',v.name,'status',v.status,'createdAt',v.created_at,'closedAt',v.closed_at,
 'tableIds',coalesce((select jsonb_agg(table_id order by table_id) from app_private.service_visit_tables where business_id=v.business_id and visit_id=v.id and released_at is null),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(app_private.ops_order_json(o) order by o.created_at,o.id) from app_private.service_visit_orders vo join app_private.operational_orders o on o.business_id=vo.business_id and o.id=vo.order_id where vo.business_id=v.business_id and vo.visit_id=v.id),'[]'::jsonb),
 'balanceCents',coalesce((select sum((app_private.ops_order_json(o)->>'balanceCents')::bigint) from app_private.service_visit_orders vo join app_private.operational_orders o on o.business_id=vo.business_id and o.id=vo.order_id where vo.business_id=v.business_id and vo.visit_id=v.id),0));
$$;
create function app_private.service_courses_json(p_business uuid,p_order uuid) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'orderId',c.order_id,'name',c.name,'status',c.status,'batchId',c.batch_id,'createdAt',c.created_at,'sentAt',c.sent_at,'batch',(select app_private.ops_batch_json(b) from app_private.kitchen_batches b where b.business_id=c.business_id and b.id=c.batch_id),
 'items',coalesce((select jsonb_agg(jsonb_build_object('lineId',l.line_id,'quantity',l.quantity) order by l.line_id) from app_private.service_course_lines l where l.business_id=c.business_id and l.course_id=c.id),c.selection)) order by c.created_at,c.id),'[]'::jsonb)
 from app_private.service_courses c where c.business_id=p_business and c.order_id=p_order;
$$;
create function app_private.service_reservation_json(r app_private.service_reservations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'revision',r.revision,'name',r.name,'contact',r.contact,'partySize',r.party_size,'startsAt',r.starts_at,'endsAt',r.ends_at,'status',r.status,'visitId',r.visit_id,'note',r.note,'createdAt',r.created_at,'updatedAt',r.updated_at,
 'tableIds',coalesce((select jsonb_agg(table_id order by table_id) from app_private.service_reservation_tables where business_id=r.business_id and reservation_id=r.id),'[]'::jsonb));
$$;
create function app_private.service_table_names(p_business uuid,p_order uuid) returns text language sql stable set search_path='' as $$
 select coalesce((select string_agg(t.name,', ' order by t.name,t.id) from app_private.service_visit_orders vo join app_private.service_visit_tables vt on vt.business_id=vo.business_id and vt.visit_id=vo.visit_id and vt.released_at is null join app_private.dining_tables t on t.business_id=vt.business_id and t.id=vt.table_id where vo.business_id=p_business and vo.order_id=p_order),
 (select t.name from app_private.operational_orders o join app_private.dining_tables t on t.business_id=o.business_id and t.id=o.table_id where o.business_id=p_business and o.id=p_order));
$$;
alter function app_private.ops_table_json(app_private.dining_tables) rename to ops_table_json_before_service;
create function app_private.ops_table_json(t app_private.dining_tables) returns jsonb language sql stable set search_path='' as $$
 select app_private.ops_table_json_before_service(t) || jsonb_build_object('visitId',vt.visit_id) || case when vt.visit_id is null then '{}'::jsonb else jsonb_build_object('orderId',
 (select o.id from app_private.service_visit_orders vo join app_private.operational_orders o on o.business_id=vo.business_id and o.id=vo.order_id where vo.business_id=t.business_id and vo.visit_id=vt.visit_id order by o.created_at desc,o.id desc limit 1)) end
 from (select (select visit_id from app_private.service_visit_tables where business_id=t.business_id and table_id=t.id and released_at is null) visit_id) vt;
$$;

-- Persistent guards cover legacy commands as well as the new service dispatcher.
create function app_private.service_order_table_guard() returns trigger language plpgsql set search_path='' as $$
declare linked uuid; occupied uuid;
begin
 select visit_id into linked from app_private.service_visit_orders where business_id=new.business_id and order_id=new.id;
 if linked is not null and new.table_id is not null and not exists(select 1 from app_private.service_visit_tables where business_id=new.business_id and visit_id=linked and table_id=new.table_id and released_at is null) then raise exception 'VISIT_CHANGED'; end if;
 if new.table_id is not null then
  select visit_id into occupied from app_private.service_visit_tables where business_id=new.business_id and table_id=new.table_id and released_at is null;
  if occupied is not null and occupied is distinct from linked then raise exception 'TABLE_OCCUPIED'; end if;
 end if;
 return new;
end; $$;
create trigger service_order_table_claim before insert or update of table_id on app_private.operational_orders for each row execute function app_private.service_order_table_guard();
create function app_private.service_table_active_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if not new.active and exists(select 1 from app_private.service_visit_tables where business_id=new.business_id and table_id=new.id and released_at is null) then raise exception 'TABLE_OCCUPIED'; end if;
 return new;
end; $$;
create trigger service_table_active_claim before update of active on app_private.dining_tables for each row execute function app_private.service_table_active_guard();
create function app_private.service_line_hold_guard() returns trigger language plpgsql set search_path='' as $$
declare held integer;
begin
 if not exists(select 1 from app_private.businesses where id=old.business_id) then if tg_op='DELETE' then return old; else return new; end if; end if;
 select coalesce(sum(l.quantity),0)::integer into held from app_private.service_course_lines l join app_private.service_courses c on c.business_id=l.business_id and c.id=l.course_id where l.business_id=old.business_id and l.order_id=old.order_id and l.line_id=old.id and c.status='held';
 if held>0 and (tg_op='DELETE' or held>new.quantity-new.sent_quantity) then raise exception 'COURSE_HELD'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;
create trigger service_line_hold before delete or update of quantity,sent_quantity on app_private.order_lines for each row execute function app_private.service_line_hold_guard();

create function app_private.service_ensure_visit(p_business uuid,p_order uuid,p_actor uuid,p_actor_name text) returns app_private.service_visits language plpgsql set search_path='' as $$
declare v app_private.service_visits%rowtype; o app_private.operational_orders%rowtype;
begin
 select sv.* into v from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=p_business and vo.order_id=p_order for update of sv;
 if found then if v.status<>'active' then raise exception 'VISIT_CHANGED'; end if; return v; end if;
 select * into o from app_private.operational_orders where business_id=p_business and id=p_order for update;
 if not found then raise exception 'ORDER_CHANGED'; end if;
 if o.order_kind='counter' then raise exception 'PERMISSION_DENIED'; end if;
 insert into app_private.service_visits(business_id,id,origin_order_id,name,actor_id,actor_name) values(p_business,p_order,p_order,o.name,p_actor,p_actor_name) returning * into v;
 insert into app_private.service_visit_orders(business_id,order_id,visit_id) values(p_business,p_order,v.id);
 if o.table_id is not null then
  if exists(select 1 from app_private.service_visit_tables where business_id=p_business and table_id=o.table_id and released_at is null)
   or exists(select 1 from app_private.operational_orders other where other.business_id=p_business and other.table_id=o.table_id and other.id<>o.id and other.status in ('open','paid','waived','cancelled')) then raise exception 'TABLE_OCCUPIED'; end if;
  insert into app_private.service_visit_tables(business_id,visit_id,table_id) values(p_business,v.id,o.table_id);
 end if;
 return v;
end; $$;

create function app_private.service_ids(p jsonb) returns uuid[] language plpgsql immutable set search_path='' as $$
declare result uuid[]; row jsonb;
begin
 if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p)>20 then raise exception 'VALIDATION_ERROR'; end if;
 for row in select * from jsonb_array_elements(p) loop perform app_private.ops_uuid(row); end loop;
 select coalesce(array_agg((value#>>'{}')::uuid order by (value#>>'{}')::uuid),'{}'::uuid[]) into result from jsonb_array_elements(p);
 if cardinality(result)<>(select count(distinct x) from unnest(result) x) then raise exception 'VALIDATION_ERROR'; end if;
 return result;
end; $$;
create function app_private.service_associate_tables(p_business uuid,p_visit uuid,p_tables uuid[]) returns void language plpgsql set search_path='' as $$
<<association>>
declare table_id uuid;
begin
 foreach table_id in array p_tables loop
  if not exists(select 1 from app_private.dining_tables where business_id=p_business and id=table_id and active) then raise exception 'TABLE_CHANGED'; end if;
  if exists(select 1 from app_private.service_visit_tables where business_id=p_business and service_visit_tables.table_id=association.table_id and released_at is null and visit_id<>p_visit)
   or exists(select 1 from app_private.operational_orders o where o.business_id=p_business and o.table_id=association.table_id and o.status in ('open','paid','waived','cancelled') and not exists(select 1 from app_private.service_visit_orders vo where vo.business_id=p_business and vo.order_id=o.id and vo.visit_id=p_visit)) then raise exception 'TABLE_OCCUPIED'; end if;
 end loop;
 -- A source order keeps its historical table while the visit owns it. Reassigning
 -- physical seats uses this operation rather than editing the finalized account.
 if exists(select 1 from app_private.operational_orders o join app_private.service_visit_orders vo on vo.business_id=o.business_id and vo.order_id=o.id where vo.business_id=p_business and vo.visit_id=p_visit and o.table_id is not null and not o.table_id=any(p_tables) and o.status in ('open','paid','waived','cancelled')) then raise exception 'VISIT_CHANGED'; end if;
 update app_private.service_visit_tables set released_at=clock_timestamp() where business_id=p_business and visit_id=p_visit and released_at is null and not service_visit_tables.table_id=any(p_tables);
 foreach table_id in array p_tables loop
  if not exists(select 1 from app_private.service_visit_tables where business_id=p_business and visit_id=p_visit and service_visit_tables.table_id=association.table_id and released_at is null) then insert into app_private.service_visit_tables(business_id,visit_id,table_id) values(p_business,p_visit,association.table_id); end if;
 end loop;
end; $$;

-- Also give automatically generated kitchen work the visit's table names.
-- The string is captured only when creating the batch, never recomputed in history.
create function app_private.service_batch_table_snapshot() returns trigger language plpgsql set search_path='' as $$
begin
 if new.table_name is null then new.table_name:=app_private.service_table_names(new.business_id,new.order_id); end if;
 return new;
end; $$;
create trigger service_batch_table before insert on app_private.kitchen_batches for each row execute function app_private.service_batch_table_snapshot();

-- Quotes and completion cover direct/legacy payment routes and provider settlement.
-- This runs in their transaction; a rejected quote/payment leaves no orphan visit.
create function app_private.service_checkout_visit() returns trigger language plpgsql set search_path='' as $$
declare o app_private.operational_orders%rowtype;
begin
 if new.kind<>'payment' or new.order_id is null then return new; end if;
 if tg_op='UPDATE' and (new.status<>'completed' or old.status='completed') then return new; end if;
 select * into o from app_private.operational_orders where business_id=new.business_id and id=new.order_id;
 if o.id is null or not (o.order_kind='service' or o.order_kind is null and o.table_id is not null) then return new; end if;
 if exists(select 1 from app_private.service_courses where business_id=new.business_id and order_id=o.id and status='held') then raise exception 'COURSE_HELD'; end if;
 perform app_private.service_ensure_visit(new.business_id,o.id,new.actor_id,new.operator_name);
 return new;
end; $$;
create trigger service_checkout_visit before insert or update of status on app_private.checkout_attempts for each row execute function app_private.service_checkout_visit();

create function app_private.service_timestamp(p jsonb) returns timestamptz language plpgsql immutable set search_path='' as $$
declare result timestamptz;
begin
 if jsonb_typeof(p) is distinct from 'string' or p#>>'{}' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'VALIDATION_ERROR'; end if;
 result:=(p#>>'{}')::timestamptz;
 if result<'2000-01-01T00:00:00Z'::timestamptz or result>='2101-01-01T00:00:00Z'::timestamptz then raise exception 'VALIDATION_ERROR'; end if;
 return result;
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_ERROR';
end; $$;

alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_service;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
<<service>>
declare p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken']; c text:=p_payload->>'command';
 actor app_private.employees%rowtype; operation app_private.pos_operations%rowtype; o app_private.operational_orders%rowtype;
 v app_private.service_visits%rowtype; course app_private.service_courses%rowtype; reservation app_private.service_reservations%rowtype;
 line app_private.order_lines%rowtype; selection jsonb; result jsonb; response jsonb; fingerprint bytea; operation_id uuid;
 tables uuid[]; order_id uuid; course_id uuid; reservation_id uuid; target_visit_id uuid; batch_id uuid;
 starts_at timestamptz; ends_at timestamptz; local_day date; zone text; qty integer; held integer; rows jsonb; new_status text;
begin
 if c is null or c not in ('service_day','service_order','associate_service_tables','release_service_visit','continue_service_order','save_service_course','send_service_course','cancel_service_course','save_service_reservation','set_service_reservation_status') then
  if c in ('send_order','begin_order_checkout','prepare_checkout','cancel_order') then
   select * into actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active and deleted_at is null for share;
   if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
   if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
   if (c='send_order' and not app_private.has_permission(p_business_id,actor.id,'orders.manage'))
    or (c='cancel_order' and not app_private.has_permission(p_business_id,actor.id,'orders.cancel'))
    or (c='begin_order_checkout' and not (app_private.has_permission(p_business_id,actor.id,'orders.manage') or app_private.has_permission(p_business_id,actor.id,'sales.create') and app_private.has_permission(p_business_id,actor.id,'orders.read')))
    or (c='prepare_checkout' and not (app_private.has_permission(p_business_id,actor.id,'sales.create') and (app_private.has_permission(p_business_id,actor.id,'orders.read') or app_private.has_permission(p_business_id,actor.id,'orders.manage')))) then
    return app_private.pos_command_before_service(p_business_id,p_employee_id,p_payload);
   end if;
   perform app_private.ops_validate(p);
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
   if not exists(select 1 from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=app_private.ops_uuid(p->'operationId'))
    and exists(select 1 from app_private.service_courses where business_id=p_business_id and service_courses.order_id=app_private.ops_uuid(p->'orderId') and status='held') then raise exception 'COURSE_HELD'; end if;
   if c='begin_order_checkout' and not exists(select 1 from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=app_private.ops_uuid(p->'operationId')) then
    select * into o from app_private.operational_orders where business_id=p_business_id and id=app_private.ops_uuid(p->'orderId');
    if o.id is not null and (o.order_kind='service' or o.order_kind is null and o.table_id is not null) then perform app_private.service_ensure_visit(p_business_id,o.id,actor.id,actor.name); end if;
   end if;
  end if;
  response:=app_private.pos_command_before_service(p_business_id,p_employee_id,p_payload);
  if c='operations' and (app_private.has_permission(p_business_id,p_employee_id,'orders.read') or app_private.has_permission(p_business_id,p_employee_id,'orders.manage')) then
   -- Paid accounts remain discoverable while their physical visit is active.
   select coalesce(jsonb_agg(x.dto order by x.dto->>'createdAt',x.dto->>'id'),'[]'::jsonb) into rows from (
    select distinct on (dto->>'id') dto from (
     select value dto from jsonb_array_elements(response#>'{data,orders}')
     union all select app_private.ops_order_json(ord) from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id and sv.status='active' join app_private.operational_orders ord on ord.business_id=vo.business_id and ord.id=vo.order_id where vo.business_id=p_business_id
    ) all_orders order by dto->>'id'
   ) x;
   response:=jsonb_set(response,'{data,orders}',rows);
  end if;
  return response;
 end if;
 select * into actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active and deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
 if c='service_day' then
  if not (app_private.has_permission(p_business_id,actor.id,'tables.manage') or app_private.has_permission(p_business_id,actor.id,'orders.manage')) then raise exception 'PERMISSION_DENIED'; end if;
 elsif c='service_order' then
  if not (app_private.has_permission(p_business_id,actor.id,'orders.read') or app_private.has_permission(p_business_id,actor.id,'orders.manage')) then raise exception 'PERMISSION_DENIED'; end if;
 else
  if not app_private.has_permission(p_business_id,actor.id,'orders.manage') then raise exception 'PERMISSION_DENIED'; end if;
  if c in ('associate_service_tables','release_service_visit','save_service_reservation','set_service_reservation_status') and not app_private.has_permission(p_business_id,actor.id,'tables.manage') then raise exception 'PERMISSION_DENIED'; end if;
 end if;
 if c='service_day' then
  perform app_private.ops_exact(p,array['command','date']);
  if jsonb_typeof(p->'date') is distinct from 'string' or p->>'date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VALIDATION_ERROR'; end if;
  begin local_day:=(p->>'date')::date; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_ERROR'; end;
  if local_day<'2000-01-01'::date or local_day>'2100-12-31'::date then raise exception 'VALIDATION_ERROR'; end if;
  select timezone into zone from app_private.businesses where id=p_business_id;
  starts_at:=local_day::timestamp at time zone zone; ends_at:=(local_day+1)::timestamp at time zone zone;
  return jsonb_build_object('data',jsonb_build_object('date',local_day,'timezone',zone,
   'reservations',coalesce((select jsonb_agg(app_private.service_reservation_json(r) order by r.starts_at,r.id) from app_private.service_reservations r where r.business_id=p_business_id and r.starts_at<service.ends_at and r.ends_at>service.starts_at),'[]'::jsonb),
   'visits',coalesce((select jsonb_agg(app_private.service_visit_json(sv) order by sv.created_at,sv.id) from app_private.service_visits sv where sv.business_id=p_business_id and sv.status='active'),'[]'::jsonb)));
 elsif c='service_order' then
  perform app_private.ops_exact(p,array['command','orderId']); order_id:=app_private.ops_uuid(p->'orderId');
  select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id;
  if not found then raise exception 'ORDER_CHANGED'; end if;
  if o.order_kind='counter' then raise exception 'PERMISSION_DENIED'; end if;
  select sv.* into v from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=p_business_id and vo.order_id=o.id;
  return jsonb_build_object('data',jsonb_build_object('visit',case when v.id is null then null else app_private.service_visit_json(v) end,'courses',app_private.service_courses_json(p_business_id,o.id)));
 end if;
 perform app_private.ops_exact(p,array['command','operationId'] || case c
  when 'associate_service_tables' then array['orderId','expectedRevision','expectedVisitRevision','tableIds']
  when 'release_service_visit' then array['visitId','expectedRevision']
  when 'continue_service_order' then array['sourceOrderId','expectedRevision','orderId','name']
  when 'save_service_course' then array['orderId','expectedRevision','courseId','name','items']
  when 'send_service_course' then array['orderId','expectedRevision','courseId']
  when 'cancel_service_course' then array['orderId','expectedRevision','courseId']
  when 'save_service_reservation' then array['reservationId','expectedRevision','name','contact','partySize','startsAt','endsAt','tableIds','note']
  when 'set_service_reservation_status' then array['reservationId','expectedRevision','status','orderId'] end);
 operation_id:=app_private.ops_uuid(p->'operationId');
 if c='save_service_reservation' and p->'expectedRevision'='null'::jsonb then null; else perform app_private.ops_int(p->'expectedRevision',1,2147483647); end if;
 if p ? 'tableIds' then tables:=app_private.service_ids(p->'tableIds'); p:=jsonb_set(p,'{tableIds}',to_jsonb(tables)); end if;
 if c='associate_service_tables' and p->'expectedVisitRevision'<>'null'::jsonb then perform app_private.ops_int(p->'expectedVisitRevision',1,2147483647); end if;
 if p ? 'courseId' then course_id:=app_private.ops_uuid(p->'courseId'); end if;
 if p ? 'reservationId' then reservation_id:=app_private.ops_uuid(p->'reservationId'); end if;
 if p ? 'orderId' and p->'orderId'<>'null'::jsonb then order_id:=app_private.ops_uuid(p->'orderId'); end if;
 if p ? 'name' then p:=jsonb_set(p,'{name}',to_jsonb(app_private.ops_text(p->'name',1,case when c='save_service_course' then 60 else 100 end))); end if;
 if c='save_service_course' then
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') not between 1 and 40 then raise exception 'VALIDATION_ERROR'; end if;
  for selection in select * from jsonb_array_elements(p->'items') loop perform app_private.ops_exact(selection,array['lineId','quantity']); perform app_private.ops_uuid(selection->'lineId'); perform app_private.ops_int(selection->'quantity',1,999); end loop;
  if (select count(distinct value->>'lineId') from jsonb_array_elements(p->'items'))<>jsonb_array_length(p->'items') then raise exception 'VALIDATION_ERROR'; end if;
  select jsonb_agg(value order by value->>'lineId') into rows from jsonb_array_elements(p->'items'); p:=jsonb_set(p,'{items}',rows);
 elsif c='save_service_reservation' then
  perform app_private.ops_int(p->'partySize',1,100); p:=jsonb_set(p,'{contact}',to_jsonb(app_private.ops_text(p->'contact',0,80))); p:=jsonb_set(p,'{note}',to_jsonb(app_private.ops_text(p->'note',0,200)));
  starts_at:=app_private.service_timestamp(p->'startsAt'); ends_at:=app_private.service_timestamp(p->'endsAt');
  if ends_at-starts_at not between interval '15 minutes' and interval '12 hours' then raise exception 'VALIDATION_ERROR'; end if;
 elsif c='set_service_reservation_status' then
  new_status:=p->>'status'; if jsonb_typeof(p->'status') is distinct from 'string' or new_status not in ('confirmed','seated','cancelled','no_show','completed') or (new_status='seated') is distinct from (p->'orderId'<>'null'::jsonb) then raise exception 'VALIDATION_ERROR'; end if;
 elsif c='continue_service_order' then perform app_private.ops_uuid(p->'sourceOrderId');
 elsif c='release_service_visit' then target_visit_id:=app_private.ops_uuid(p->'visitId'); end if;
 fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
 select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=service.operation_id;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 if not exists(select 1 from app_private.operational_settings where business_id=p_business_id and enabled) then raise exception 'OPERATIONS_DISABLED'; end if;
 if c in ('associate_service_tables','continue_service_order','save_service_course','send_service_course','cancel_service_course') then
  select * into o from app_private.operational_orders where business_id=p_business_id and id=case when c='continue_service_order' then (p->>'sourceOrderId')::uuid else order_id end for update;
  if not found or o.revision<>(p->>'expectedRevision')::integer then raise exception 'ORDER_CHANGED'; end if;
  if o.order_kind='counter' then raise exception 'PERMISSION_DENIED'; end if;
  if app_private.ops_pending(p_business_id,o.id) then raise exception 'PENDING_COLLECTION'; end if;
 end if;
 if c='continue_service_order' then
  if not o.frozen or (app_private.ops_order_json(o)->>'paidCents')::bigint<=0 or o.status not in ('open','paid','closed') then raise exception 'ORDER_LOCKED'; end if;
  if not exists(select 1 from app_private.businesses where id=p_business_id and profile->'accountsEnabled'='true'::jsonb) then raise exception 'PERMISSION_DENIED'; end if;
  if exists(select 1 from app_private.operational_orders where business_id=p_business_id and id=order_id) or exists(select 1 from app_private.service_visit_orders where business_id=p_business_id and source_order_id=o.id) then raise exception 'ORDER_CHANGED'; end if;
  v:=app_private.service_ensure_visit(p_business_id,o.id,actor.id,actor.name);
  if (select count(*) from app_private.service_visit_orders where business_id=p_business_id and service_visit_orders.visit_id=v.id)>=100 then raise exception 'VISIT_LIMIT_REACHED'; end if;
  insert into app_private.operational_orders(business_id,id,name,table_id,order_kind,actor_id,operator_name) values(p_business_id,order_id,p->>'name',null,'service',actor.id,actor.name) returning * into o;
  insert into app_private.service_visit_orders(business_id,order_id,visit_id,source_order_id) values(p_business_id,o.id,v.id,(p->>'sourceOrderId')::uuid);
  update app_private.service_visits set revision=revision+1 where business_id=p_business_id and id=v.id returning * into v;
  insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload) values(p_business_id,o.id,o.revision,c,actor.id,actor.name,p);
  result:=jsonb_build_object('order',app_private.ops_order_json(o),'visit',app_private.service_visit_json(v));
 elsif c='associate_service_tables' then
  if o.status not in ('open','paid','closed') then raise exception 'ORDER_LOCKED'; end if;
  select sv.* into v from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=p_business_id and vo.order_id=o.id for update of sv;
  if (v.id is null) is distinct from (p->'expectedVisitRevision'='null'::jsonb) or v.id is not null and v.revision<>(p->>'expectedVisitRevision')::integer then raise exception 'VISIT_CHANGED'; end if;
  v:=app_private.service_ensure_visit(p_business_id,o.id,actor.id,actor.name);
  perform app_private.service_associate_tables(p_business_id,v.id,tables);
  update app_private.service_visits set revision=revision+1 where business_id=p_business_id and id=v.id returning * into v;
  if not o.frozen and o.status='open' then update app_private.operational_orders set revision=revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o; end if;
  result:=jsonb_build_object('order',app_private.ops_order_json(o),'visit',app_private.service_visit_json(v));
 elsif c='release_service_visit' then
  select * into v from app_private.service_visits where business_id=p_business_id and id=target_visit_id for update;
  if not found or v.revision<>(p->>'expectedRevision')::integer or v.status<>'active' then raise exception 'VISIT_CHANGED'; end if;
  if exists(select 1 from app_private.service_visit_orders vo join app_private.operational_orders ord on ord.business_id=vo.business_id and ord.id=vo.order_id where vo.business_id=p_business_id and vo.visit_id=v.id and ((app_private.ops_order_json(ord)->>'balanceCents')::bigint<>0 or app_private.ops_pending(p_business_id,ord.id))) then raise exception 'VISIT_BALANCE_PENDING'; end if;
  if exists(select 1 from app_private.service_courses co join app_private.service_visit_orders vo on vo.business_id=co.business_id and vo.order_id=co.order_id where vo.business_id=p_business_id and vo.visit_id=v.id and co.status='held') then raise exception 'COURSE_HELD'; end if;
  update app_private.operational_orders ord set status='closed',revision=revision+1,updated_at=clock_timestamp() from app_private.service_visit_orders vo where vo.business_id=p_business_id and vo.visit_id=v.id and ord.business_id=vo.business_id and ord.id=vo.order_id and ord.status<>'closed';
  update app_private.service_visit_tables set released_at=clock_timestamp() where business_id=p_business_id and visit_id=v.id and released_at is null;
  update app_private.service_visits set status='closed',closed_at=clock_timestamp(),revision=revision+1 where business_id=p_business_id and id=v.id returning * into v;
  update app_private.service_reservations set status='completed',revision=revision+1,updated_at=clock_timestamp() where business_id=p_business_id and visit_id=v.id and status='seated';
  result:=app_private.service_visit_json(v);
 elsif c in ('save_service_course','send_service_course','cancel_service_course') then
  if o.status<>'open' or o.phase<>'service' or o.frozen then raise exception 'ORDER_LOCKED'; end if;
  select * into course from app_private.service_courses where business_id=p_business_id and id=course_id for update;
  if course.id is not null and (course.order_id<>o.id or course.status<>'held') then raise exception 'COURSE_CHANGED'; end if;
  if c='save_service_course' then
   for selection in select * from jsonb_array_elements(p->'items') loop
    select * into line from app_private.order_lines where business_id=p_business_id and order_lines.order_id=o.id and id=(service.selection->>'lineId')::uuid;
    select coalesce(sum(l.quantity),0)::integer into held from app_private.service_course_lines l join app_private.service_courses co on co.business_id=l.business_id and co.id=l.course_id where l.business_id=p_business_id and l.order_id=o.id and l.line_id=line.id and co.status='held' and co.id<>service.course_id;
    if line.id is null or line.line_kind='amount' or (selection->>'quantity')::integer>line.quantity-line.sent_quantity-held then raise exception 'COURSE_CHANGED'; end if;
   end loop;
   v:=app_private.service_ensure_visit(p_business_id,o.id,actor.id,actor.name);
   insert into app_private.service_courses(business_id,id,order_id,name,selection) values(p_business_id,course_id,o.id,p->>'name',p->'items') on conflict(business_id,id) do update set name=excluded.name,selection=excluded.selection;
   delete from app_private.service_course_lines where business_id=p_business_id and service_course_lines.course_id=service.course_id;
   insert into app_private.service_course_lines(business_id,order_id,course_id,line_id,quantity) select p_business_id,o.id,course_id,(value->>'lineId')::uuid,(value->>'quantity')::integer from jsonb_array_elements(p->'items');
  elsif course.id is null then raise exception 'COURSE_CHANGED';
  elsif c='cancel_service_course' then
   -- Release the hold. No consumption, money or kitchen work is cancelled.
   update app_private.service_courses set status='released' where business_id=p_business_id and id=course.id;
   delete from app_private.service_course_lines where business_id=p_business_id and service_course_lines.course_id=course.id;
  else
   select jsonb_agg(jsonb_build_object('lineId',ol.id,'name',ol.kitchen_name,'selectionLabel',ol.selection_label,'note',ol.note,'quantity',cl.quantity) order by ol.id) into rows from app_private.service_course_lines cl join app_private.order_lines ol on ol.business_id=cl.business_id and ol.order_id=cl.order_id and ol.id=cl.line_id where cl.business_id=p_business_id and cl.course_id=course.id;
   if rows is null then raise exception 'COURSE_CHANGED'; end if;
   insert into app_private.kitchen_batches(business_id,order_id,order_name,table_name,kind,items,actor_id,actor_name) values(p_business_id,o.id,o.name||' · '||course.name,app_private.service_table_names(p_business_id,o.id),'items',rows,actor.id,actor.name) returning id into batch_id;
   update app_private.service_courses set status='sent',batch_id=service.batch_id,sent_at=clock_timestamp() where business_id=p_business_id and id=course.id;
   update app_private.order_lines ol set sent_quantity=sent_quantity+cl.quantity from app_private.service_course_lines cl where cl.business_id=p_business_id and cl.course_id=course.id and ol.business_id=cl.business_id and ol.order_id=cl.order_id and ol.id=cl.line_id;
  end if;
  update app_private.operational_orders set revision=revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=o.id returning * into o;
  result:=jsonb_build_object('order',app_private.ops_order_json(o),'courses',app_private.service_courses_json(p_business_id,o.id));
 elsif c in ('save_service_reservation','set_service_reservation_status') then
  select * into reservation from app_private.service_reservations where business_id=p_business_id and id=reservation_id for update;
  if c='save_service_reservation' then
   if p->'expectedRevision'='null'::jsonb then if reservation.id is not null then raise exception 'RESERVATION_CHANGED'; end if;
   elsif reservation.id is null or reservation.revision<>(p->>'expectedRevision')::integer or reservation.status<>'confirmed' then raise exception 'RESERVATION_CHANGED'; end if;
   if exists(select 1 from unnest(tables) t where not exists(select 1 from app_private.dining_tables dt where dt.business_id=p_business_id and dt.id=t and dt.active)) then raise exception 'TABLE_CHANGED'; end if;
   if exists(select 1 from app_private.service_reservations r join app_private.service_reservation_tables rt on rt.business_id=r.business_id and rt.reservation_id=r.id where r.business_id=p_business_id and r.id<>service.reservation_id and r.status in ('confirmed','seated') and rt.table_id=any(tables) and r.starts_at<service.ends_at and r.ends_at>service.starts_at) then raise exception 'RESERVATION_CONFLICT'; end if;
   if reservation.id is null then
    insert into app_private.service_reservations(business_id,id,name,contact,party_size,starts_at,ends_at,note,actor_id,actor_name) values(p_business_id,reservation_id,p->>'name',p->>'contact',(p->>'partySize')::integer,starts_at,ends_at,p->>'note',actor.id,actor.name) returning * into reservation;
   else
    update app_private.service_reservations set name=p->>'name',contact=p->>'contact',party_size=(p->>'partySize')::integer,starts_at=service.starts_at,ends_at=service.ends_at,note=p->>'note',revision=revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=reservation.id returning * into reservation;
   end if;
   delete from app_private.service_reservation_tables where business_id=p_business_id and service_reservation_tables.reservation_id=service.reservation_id;
   insert into app_private.service_reservation_tables(business_id,reservation_id,table_id) select p_business_id,reservation.id,unnest(tables);
   result:=app_private.service_reservation_json(reservation);
  else
   if reservation.id is null or reservation.revision<>(p->>'expectedRevision')::integer then raise exception 'RESERVATION_CHANGED'; end if;
   if reservation.status='confirmed' and new_status in ('cancelled','no_show') then null;
   elsif reservation.status='confirmed' and new_status='seated' then
    select * into o from app_private.operational_orders where business_id=p_business_id and id=order_id for update;
    if not found then raise exception 'ORDER_CHANGED'; end if;
    if o.order_kind='counter' then raise exception 'PERMISSION_DENIED'; end if;
    if o.status<>'open' or o.frozen or o.phase<>'service' then raise exception 'ORDER_LOCKED'; end if;
    if app_private.ops_pending(p_business_id,o.id) then raise exception 'PENDING_COLLECTION'; end if;
    v:=app_private.service_ensure_visit(p_business_id,o.id,actor.id,actor.name);
    if exists(select 1 from app_private.service_reservations where business_id=p_business_id and visit_id=v.id and status='seated') then raise exception 'RESERVATION_CONFLICT'; end if;
    select coalesce(array_agg(table_id order by table_id),'{}'::uuid[]) into tables from app_private.service_reservation_tables where business_id=p_business_id and service_reservation_tables.reservation_id=service.reservation_id;
    select coalesce(array_agg(distinct t),'{}'::uuid[]) into tables from unnest(tables || array(select table_id from app_private.service_visit_tables where business_id=p_business_id and visit_id=v.id and released_at is null)) t;
    perform app_private.service_associate_tables(p_business_id,v.id,tables);
    update app_private.service_visits set revision=revision+1 where business_id=p_business_id and id=v.id returning * into v;
   elsif reservation.status='seated' and new_status='completed' then
    select * into v from app_private.service_visits where business_id=p_business_id and id=reservation.visit_id;
    if v.status<>'closed' then raise exception 'VISIT_BALANCE_PENDING'; end if;
   else raise exception 'RESERVATION_CHANGED'; end if;
   update app_private.service_reservations set status=new_status,visit_id=coalesce(v.id,service_reservations.visit_id),revision=revision+1,updated_at=clock_timestamp() where business_id=p_business_id and id=reservation.id returning * into reservation;
   result:=jsonb_build_object('reservation',app_private.service_reservation_json(reservation),'visit',case when v.id is null then null else app_private.service_visit_json(v) end);
  end if;
 end if;
 if o.id is not null and c<>'continue_service_order' then insert into app_private.order_events(business_id,order_id,revision,kind,actor_id,actor_name,payload) values(p_business_id,o.id,o.revision,c,actor.id,actor.name,p); end if;
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,operation_id,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
end; $$;

-- Functions are reachable only through the existing live-session account RPC.
revoke all on function app_private.service_visit_json(app_private.service_visits),app_private.service_courses_json(uuid,uuid),app_private.service_reservation_json(app_private.service_reservations),app_private.service_table_names(uuid,uuid),app_private.ops_table_json_before_service(app_private.dining_tables),app_private.ops_table_json(app_private.dining_tables),app_private.service_order_table_guard(),app_private.service_table_active_guard(),app_private.service_line_hold_guard(),app_private.service_ensure_visit(uuid,uuid,uuid,text),app_private.service_ids(jsonb),app_private.service_associate_tables(uuid,uuid,uuid[]),app_private.service_batch_table_snapshot(),app_private.service_checkout_visit(),app_private.service_timestamp(jsonb),app_private.pos_command_before_service(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.pos_command_before_service(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) to service_role;
