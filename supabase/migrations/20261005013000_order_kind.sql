-- Persist the intent of new clients without guessing the intent of an earlier
-- order from its name or table. Omitted legacy requests remain unknown (NULL).
alter table app_private.operational_orders add column order_kind text;
alter table app_private.operational_orders add constraint operational_order_kind_known
 check(order_kind is null or order_kind in ('counter','service'));
alter table app_private.operational_orders add constraint operational_counter_without_table
 check(order_kind is distinct from 'counter' or table_id is null);

create function app_private.ops_order_kind_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if old.order_kind is not null and new.order_kind is distinct from old.order_kind then
  raise exception 'ORDER_CHANGED' using errcode='P0001';
 end if;
 return new;
end $$;
create trigger operational_order_kind_immutable before update of order_kind
 on app_private.operational_orders for each row execute function app_private.ops_order_kind_immutable();

do $migration$
declare definition text; needle text; replacement text;
begin
 select pg_get_functiondef('app_private.ops_validate(jsonb)'::regprocedure) into definition;
 needle:=$old$when 'save_order' then array['operationId','orderId','expectedRevision','name','tableId','items']$old$;
 replacement:=needle||$new$||case when p ? 'orderKind' then array['orderKind'] else '{}'::text[] end$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind validator fields'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$perform app_private.ops_exact(p,array['command']||fields);$old$;
 replacement:=needle||$new$
 if p ? 'orderKind' and (jsonb_typeof(p->'orderKind') is distinct from 'string'
   or p->>'orderKind' not in ('counter','service')
   or p->>'orderKind'='counter' and p->'tableId' is distinct from 'null'::jsonb) then
  raise exception 'VALIDATION_ERROR';
 end if;
$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind validator exact keys'; end if;
 execute replace(definition,needle,replacement);

 select pg_get_functiondef('app_private.ops_order_json(app_private.operational_orders)'::regprocedure) into definition;
 needle:=$old$'id',o.id,'revision',o.revision,'name',o.name,'tableId',o.table_id$old$;
 replacement:=needle||$new$,'orderKind',o.order_kind$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind projection'; end if;
 execute replace(definition,needle,replacement);

 -- Point owns the outer dispatcher. Change the operational implementation,
 -- keeping its live actor authorization and exact accepted-replay path intact.
 select pg_get_functiondef('app_private.pos_command_before_point(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$own_counter:=o.id is not null and o.actor_id=actor.id and o.table_id is null;$old$;
 replacement:=$new$own_counter:=o.id is not null and o.actor_id=actor.id and o.table_id is null and (o.order_kind is null or o.order_kind='counter');$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind own counter'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$accepted.result->'tableId'='null'::jsonb$old$;
 replacement:=needle||$new$ and (accepted.result->>'orderKind' is null or accepted.result->>'orderKind'='counter')$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind accepted counter receipt'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$accepted.result#>'{order,tableId}'='null'::jsonb$old$;
 replacement:=needle||$new$ and (accepted.result#>>'{order,orderKind}' is null or accepted.result#>>'{order,orderKind}'='counter')$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind accepted payment receipt'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$(select event.payload->'tableId' from app_private.order_events event$old$;
 replacement:=$new$(select event.payload->'tableId'='null'::jsonb and (event.payload->>'orderKind' is null or event.payload->>'orderKind'='counter') from app_private.order_events event$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind accepted checkout scope'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$order by event.revision desc,event.created_at desc,event.id desc limit 1)='null'::jsonb else false end);$old$;
 replacement:=$new$order by event.revision desc,event.created_at desc,event.id desc limit 1) else false end);$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind accepted checkout scope result'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$create_sales and p->'tableId'='null'::jsonb and (p->'expectedRevision'='null'::jsonb or own_counter)$old$;
 replacement:=$new$create_sales and p->'tableId'='null'::jsonb and (not p ? 'orderKind' or p->>'orderKind'='counter') and (p->'expectedRevision'='null'::jsonb or own_counter)$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind creation permission'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$create_sales and actor_id=actor.id and table_id is null)$old$;
 replacement:=$new$create_sales and actor_id=actor.id and table_id is null and (order_kind is null or order_kind='counter'))$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind counter list scope'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$if result is null and c='save_order' then
  table_id:=case when p->'tableId'='null'::jsonb then null else (p->>'tableId')::uuid end;$old$;
 replacement:=needle||$new$
  if o.order_kind is not null and p ? 'orderKind' and o.order_kind is distinct from p->>'orderKind' then raise exception 'ORDER_CHANGED'; end if;
  if coalesce(o.order_kind,p->>'orderKind')='counter' and table_id is not null then raise exception 'ORDER_CHANGED'; end if;
$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind mutation guard'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$insert into app_private.operational_orders(business_id,id,name,table_id,actor_id,operator_name)
    values(p_business_id,order_id,app_private.ops_text(p->'name',1,100),table_id,actor.id,actor.name)$old$;
 replacement:=$new$insert into app_private.operational_orders(business_id,id,name,table_id,actor_id,operator_name,order_kind)
    values(p_business_id,order_id,app_private.ops_text(p->'name',1,100),table_id,actor.id,actor.name,p->>'orderKind')$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind insert'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$update app_private.operational_orders set name=app_private.ops_text(p->'name',1,100),table_id=pos_command.table_id,revision=$old$;
 replacement:=$new$update app_private.operational_orders set name=app_private.ops_text(p->'name',1,100),table_id=pos_command.table_id,order_kind=coalesce(o.order_kind,p->>'orderKind'),revision=$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind update'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$if c='move_order' then$old$;
 replacement:=needle||$new$
   if o.order_kind='counter' and p->'tableId'<>'null'::jsonb then raise exception 'PERMISSION_DENIED'; end if;
$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind table move'; end if;
 definition:=replace(definition,needle,replacement);
 needle:=$old$elsif c='send_order' then$old$;
 replacement:=needle||$new$
   if o.order_kind='counter' then raise exception 'PERMISSION_DENIED'; end if;
$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind service send'; end if;
 execute replace(definition,needle,replacement);

 -- This is the business-preferences wrapper, subsequently renamed by metrics.
 -- Existing orders and accepted UUIDs remain editable/replayable after disabling
 -- new accounts. Explicit service intent cannot bypass the rule by using a name.
 select pg_get_functiondef('app_private.pos_command_before_employee_metrics(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$(p_payload->>'name' is distinct from 'Mostrador' or p_payload->>'tableId' is not null)$old$;
 replacement:=$new$(p_payload ? 'orderKind' and p_payload->>'orderKind'<>'counter'
      or not p_payload ? 'orderKind' and (p_payload->>'name' is distinct from 'Mostrador' or p_payload->>'tableId' is not null))$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected order-kind business account preference'; end if;
 execute replace(definition,needle,replacement);
end $migration$;

revoke all on function app_private.ops_order_kind_immutable() from public,anon,authenticated;
