-- Final operational review: align table grants and keep pending kitchen work visible.
-- Normalize grants under the previous constraint. The existing permission-change
-- trigger revokes personal and shared-device operators whose grants change.
update app_private.employees set permissions=array_append(permissions,'orders.read')
 where 'tables.manage'=any(permissions) and not 'orders.read'=any(permissions);

create or replace function app_private.employee_permissions_valid(p_permissions text[])
returns boolean language sql immutable set search_path='' as $$
 select coalesce(p_permissions <@ app_private.permission_keys() and array_position(p_permissions,null) is null
  and cardinality(p_permissions)=(select count(distinct value) from unnest(p_permissions) value)
  and not exists(select 1 from (values
   ('catalog.manage','catalog.read'),('catalog.availability','catalog.read'),('sales.create','catalog.read'),
   ('sales.discount','sales.create'),('sales.reverse','sales.read_all'),
   ('orders.manage','orders.read'),('orders.cancel','orders.read'),('kitchen.operate','kitchen.read'),
   ('cash.open','cash.read'),('cash.move','cash.read'),('cash.close','cash.read'),('tables.manage','orders.read')
  ) dependencies(permission,prerequisite) where permission=any(p_permissions) and not prerequisite=any(p_permissions)),false);
$$;
-- PostgreSQL assumes CHECK helper immutability, so revalidate all existing rows after
-- replacing its definition rather than relying on the old validation flag.
alter table app_private.employees drop constraint employee_permissions_known;
alter table app_private.employees add constraint employee_permissions_known check(app_private.employee_permissions_valid(permissions));
revoke all on function app_private.employee_permissions_valid(text[]) from public,anon,authenticated;

do $patch$ declare definition text; needle text; replacement text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$(select * from app_private.kitchen_batches where business_id=p_business_id and (status<>'delivered' or created_at>clock_timestamp()-interval '1 day') order by created_at desc,id limit 100) kb;$old$;
 replacement:=$new$(select * from app_private.kitchen_batches where business_id=p_business_id and (status<>'delivered' or created_at>clock_timestamp()-interval '1 day')
    order by (status='delivered'),case when status<>'delivered' then created_at end asc nulls last,
     case when status='delivered' then created_at end desc nulls last,id limit 100) kb;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational kitchen query revision'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
