-- Persisted floor layout; this dispatcher delegates through shared modifiers,
-- shift summaries, Point and the existing financial operations without replacing them.
alter table app_private.dining_tables add column floor_layout jsonb;

create function app_private.validate_table_layout(p jsonb) returns void
language plpgsql set search_path='' as $$
begin
 if p is null then return; end if;
 perform app_private.ops_exact(p,array['zone','row','column','seats','shape']);
 perform app_private.ops_text(p->'zone',1,40);
 perform app_private.ops_int(p->'row',1,12);
 perform app_private.ops_int(p->'column',1,12);
 perform app_private.ops_int(p->'seats',1,24);
 if jsonb_typeof(p->'shape') is distinct from 'string' or p->>'shape' not in ('square','round','rectangle') then raise exception 'VALIDATION_ERROR'; end if;
end; $$;

create function app_private.assert_table_layout() returns trigger
language plpgsql set search_path='' as $$
begin
 perform app_private.validate_table_layout(new.floor_layout);
 return new;
end; $$;
create trigger valid_table_layout before insert or update of floor_layout on app_private.dining_tables
for each row execute function app_private.assert_table_layout();
create unique index dining_tables_floor_position on app_private.dining_tables
(business_id,lower(floor_layout->>'zone'),(floor_layout->>'row'),(floor_layout->>'column'))
where active and floor_layout is not null;

create or replace function app_private.ops_table_json(t app_private.dining_tables) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'name',t.name,'active',t.active,'revision',t.revision,'layout',t.floor_layout,
 'orderId',(select o.id from app_private.operational_orders o where o.business_id=t.business_id and o.table_id=t.id and o.status in ('open','paid','waived','cancelled')));
$$;

alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_table_layout;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
<<table_layout>>
declare actor app_private.employees%rowtype; t app_private.dining_tables%rowtype;
 operation app_private.pos_operations%rowtype; p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken'];
 c text:=p_payload->>'command'; operation_id uuid; fingerprint bytea; result jsonb; layout jsonb; violated_constraint text;
begin
 if c is distinct from 'set_table_layout' then
  return app_private.pos_command_before_table_layout(p_business_id,p_employee_id,p_payload);
 end if;
 select * into actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active and deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
 if not app_private.has_permission(p_business_id,actor.id,'tables.manage') then raise exception 'PERMISSION_DENIED'; end if;
 perform app_private.ops_exact(p,array['command','operationId','tableId','expectedRevision','layout']);
 operation_id:=app_private.ops_uuid(p->'operationId');
 perform app_private.ops_uuid(p->'tableId');
 perform app_private.ops_int(p->'expectedRevision',1,2147483647);
 layout:=case when p->'layout'='null'::jsonb then null else p->'layout' end;
 perform app_private.validate_table_layout(layout);
 if layout is not null then layout:=jsonb_set(layout,'{zone}',to_jsonb(app_private.ops_text(layout->'zone',1,40))); end if;
 fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('operations:'||p_business_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
 select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=table_layout.operation_id;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 if not exists(select 1 from app_private.operational_settings where business_id=p_business_id and enabled) then raise exception 'OPERATIONS_DISABLED'; end if;
 select * into t from app_private.dining_tables where business_id=p_business_id and id=(p->>'tableId')::uuid for update;
 if not found or t.revision<>(p->>'expectedRevision')::integer then raise exception 'TABLE_CHANGED'; end if;
 update app_private.dining_tables set floor_layout=table_layout.layout,revision=revision+1 where business_id=p_business_id and id=t.id returning * into t;
 result:=app_private.ops_table_json(t);
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,operation_id,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
exception when unique_violation then
 get stacked diagnostics violated_constraint=constraint_name;
 if violated_constraint='dining_tables_floor_position' then raise exception 'TABLE_POSITION_OCCUPIED'; end if;
 raise;
end; $$;

revoke all on function app_private.validate_table_layout(jsonb),app_private.assert_table_layout(),
 app_private.pos_command_before_table_layout(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.pos_command_before_table_layout(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) to service_role;
