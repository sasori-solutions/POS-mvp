-- Keep legacy explicit table moves/closes compatible with one-account visits.
-- Automatic closes nested inside payment keep the visit and its table claims.
-- Authorization, revision checks and accepted retries remain in the dispatcher.
do $migration$
declare
 definition text;
 old_condition text:=$condition$o.id is null or not (o.order_kind='service' or o.order_kind is null and o.table_id is not null)$condition$;
 new_condition text:=$condition$o.id is null or not (coalesce(o.order_kind='service',false) or o.order_kind is null and o.table_id is not null)$condition$;
 old_close text:=$condition$if o.status not in ('paid','waived','cancelled') then raise exception 'ORDER_LOCKED'; end if;$condition$;
 new_close text:=$condition$if o.status not in ('paid','waived','cancelled') and not (o.status='closed' and exists(select 1 from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=p_business_id and vo.order_id=o.id and sv.status='active')) then raise exception 'ORDER_LOCKED'; end if;$condition$;
 old_move text:=$condition$if o.status not in ('open','paid','waived','cancelled') then raise exception 'ORDER_LOCKED'; end if;$condition$;
 new_move text:=$condition$if o.status not in ('open','paid','waived','cancelled') and not (o.status='closed' and exists(select 1 from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=p_business_id and vo.order_id=o.id and sv.status='active')) then raise exception 'ORDER_LOCKED'; end if;$condition$;
begin
 definition:=pg_catalog.pg_get_functiondef('app_private.service_checkout_visit()'::regprocedure);
 if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,old_condition,'')))/pg_catalog.length(old_condition)<>1 then raise exception 'Service quote guard differs from the expected migration chain'; end if;
 execute pg_catalog.replace(definition,old_condition,new_condition);
 definition:=pg_catalog.pg_get_functiondef('app_private.pos_command_before_point(uuid,uuid,jsonb)'::regprocedure);
 if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,old_close,'')))/pg_catalog.length(old_close)<>1
  or (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,old_move,'')))/pg_catalog.length(old_move)<>1 then raise exception 'Legacy table guards differ from the expected migration chain'; end if;
 execute pg_catalog.replace(pg_catalog.replace(definition,old_close,new_close),old_move,new_move);
end;
$migration$;

-- The command context is transaction-local and only scopes the persistent
-- guards. It does not authorize an actor or skip any existing permission check.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_service_legacy_tables;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
declare
 previous_depth text:=pg_catalog.current_setting('app.pos_service_command_depth',true);
 previous_action text:=pg_catalog.current_setting('app.pos_service_legacy_action',true);
 depth integer:=coalesce(nullif(previous_depth,''),'0')::integer;
 command text:=p_payload->>'command'; result jsonb;
begin
 perform pg_catalog.set_config('app.pos_service_command_depth',(depth+1)::text,true);
 perform pg_catalog.set_config('app.pos_service_legacy_action',case when depth=0 and command in ('move_order','close_order') then command else '' end,true);
 result:=app_private.pos_command_before_service_legacy_tables(p_business_id,p_employee_id,p_payload);
 perform pg_catalog.set_config('app.pos_service_command_depth',coalesce(previous_depth,''),true);
 perform pg_catalog.set_config('app.pos_service_legacy_action',coalesce(previous_action,''),true);
 return result;
exception when others then
 perform pg_catalog.set_config('app.pos_service_command_depth',coalesce(previous_depth,''),true);
 perform pg_catalog.set_config('app.pos_service_legacy_action',coalesce(previous_action,''),true);
 raise;
end; $$;

create or replace function app_private.service_order_table_guard() returns trigger language plpgsql set search_path='' as $$
declare linked uuid; occupied uuid; visit app_private.service_visits%rowtype;
begin
 select visit_id into linked from app_private.service_visit_orders where business_id=new.business_id and order_id=new.id;
 if tg_op='UPDATE' and new.table_id is distinct from old.table_id and linked is not null
  and pg_catalog.current_setting('app.pos_service_legacy_action',true)='move_order' then
  select * into visit from app_private.service_visits where business_id=new.business_id and id=linked for update;
  if visit.status is distinct from 'active'
   or (select count(*) from app_private.service_visit_orders where business_id=new.business_id and visit_id=linked)<>1 then raise exception 'VISIT_CHANGED'; end if;
  if new.table_id is not null then
   if not exists(select 1 from app_private.dining_tables where business_id=new.business_id and id=new.table_id and active) then raise exception 'TABLE_CHANGED'; end if;
   select visit_id into occupied from app_private.service_visit_tables where business_id=new.business_id and table_id=new.table_id and released_at is null;
   if occupied is not null and occupied<>linked then raise exception 'TABLE_OCCUPIED'; end if;
  end if;
  update app_private.service_visit_tables set released_at=clock_timestamp() where business_id=new.business_id and visit_id=linked and released_at is null and table_id is distinct from new.table_id;
  if new.table_id is not null and not exists(select 1 from app_private.service_visit_tables where business_id=new.business_id and visit_id=linked and table_id=new.table_id and released_at is null) then
   insert into app_private.service_visit_tables(business_id,visit_id,table_id) values(new.business_id,linked,new.table_id);
  end if;
  update app_private.service_visits set revision=revision+1 where business_id=new.business_id and id=linked;
 end if;
 if linked is not null and new.table_id is not null and not exists(select 1 from app_private.service_visit_tables where business_id=new.business_id and visit_id=linked and table_id=new.table_id and released_at is null) then raise exception 'VISIT_CHANGED'; end if;
 if new.table_id is not null then
  select visit_id into occupied from app_private.service_visit_tables where business_id=new.business_id and table_id=new.table_id and released_at is null;
  if occupied is not null and occupied is distinct from linked then raise exception 'TABLE_OCCUPIED'; end if;
 end if;
 return new;
end; $$;

create function app_private.service_legacy_close_guard() returns trigger language plpgsql set search_path='' as $$
declare visit app_private.service_visits%rowtype;
begin
 if new.status<>'closed' or pg_catalog.current_setting('app.pos_service_legacy_action',true) is distinct from 'close_order' then return new; end if;
 select sv.* into visit from app_private.service_visit_orders vo join app_private.service_visits sv on sv.business_id=vo.business_id and sv.id=vo.visit_id where vo.business_id=new.business_id and vo.order_id=new.id for update of sv;
 if not found then return new; end if;
 if visit.status<>'active' or (select count(*) from app_private.service_visit_orders where business_id=new.business_id and visit_id=visit.id)<>1 then raise exception 'VISIT_CHANGED'; end if;
 if (app_private.ops_order_json(old)->>'balanceCents')::bigint<>0 then raise exception 'VISIT_BALANCE_PENDING'; end if;
 if app_private.ops_pending(new.business_id,new.id) then raise exception 'PENDING_COLLECTION'; end if;
 if exists(select 1 from app_private.service_courses where business_id=new.business_id and order_id=new.id and status='held') then raise exception 'COURSE_HELD'; end if;
 update app_private.service_visit_tables set released_at=clock_timestamp() where business_id=new.business_id and visit_id=visit.id and released_at is null;
 update app_private.service_visits set status='closed',closed_at=clock_timestamp(),revision=revision+1 where business_id=new.business_id and id=visit.id;
 update app_private.service_reservations set status='completed',revision=revision+1,updated_at=clock_timestamp() where business_id=new.business_id and visit_id=visit.id and status='seated';
 return new;
end; $$;
create trigger service_legacy_explicit_close before update of status on app_private.operational_orders for each row execute function app_private.service_legacy_close_guard();

revoke all on function app_private.pos_command(uuid,uuid,jsonb),app_private.pos_command_before_service_legacy_tables(uuid,uuid,jsonb),app_private.service_legacy_close_guard() from public,anon,authenticated;
grant execute on function app_private.pos_command(uuid,uuid,jsonb),app_private.pos_command_before_service_legacy_tables(uuid,uuid,jsonb) to service_role;
