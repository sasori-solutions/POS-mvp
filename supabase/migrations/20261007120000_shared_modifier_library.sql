-- Shared extras remain inline in product snapshots for older clients. Only
-- catalog writes synchronize the private library; orders and receipts never do.
create table app_private.modifier_groups (
 business_id uuid not null references app_private.businesses(id) on delete cascade,
 id uuid not null, version integer not null default 1 check(version>0), details jsonb not null,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id)
);
create table app_private.product_modifier_groups (
 business_id uuid not null, product_id uuid not null, group_id uuid not null,
 primary key(business_id,product_id,group_id),
 foreign key(business_id,product_id) references app_private.products(business_id,id) on delete cascade,
 foreign key(business_id,group_id) references app_private.modifier_groups(business_id,id)
);
create index product_modifier_group_links on app_private.product_modifier_groups(business_id,group_id,product_id);
alter table app_private.modifier_groups enable row level security;
alter table app_private.product_modifier_groups enable row level security;
revoke all on app_private.modifier_groups,app_private.product_modifier_groups from public,anon,authenticated;

create function app_private.validate_modifier_group(g jsonb,allow_library boolean default true)
returns void language plpgsql set search_path='' as $$
declare o jsonb; ids uuid[]:='{}'; gid uuid; minimum integer; maximum integer; capacity integer:=0;
 trim_chars text:=U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
 perform app_private.ops_exact(g,array['id','name','min','max','options']||case when allow_library and g ? 'libraryId' then array['libraryId'] else '{}'::text[] end);
 gid:=app_private.ops_uuid(g->'id');
 if jsonb_typeof(g->'name') is distinct from 'string' or char_length(g->>'name')>60
  or char_length(btrim(g->>'name',trim_chars))<1 or g->>'name' ~ '[\x01-\x1f\x7f]'
  or jsonb_typeof(g->'options') is distinct from 'array' or jsonb_array_length(g->'options') not between 1 and 12 then raise exception 'VALIDATION_ERROR'; end if;
 if g ? 'libraryId' and app_private.ops_uuid(g->'libraryId')<>gid then raise exception 'VALIDATION_ERROR'; end if;
 ids:=array_append(ids,gid);
 for o in select * from jsonb_array_elements(g->'options') loop
  perform app_private.ops_exact(o,array['id','name','priceCents']
   ||case when o ? 'soldOut' then array['soldOut'] else '{}'::text[] end
   ||case when o ? 'maxQuantity' then array['maxQuantity'] else '{}'::text[] end);
  ids:=array_append(ids,app_private.ops_uuid(o->'id'));
  if jsonb_typeof(o->'name') is distinct from 'string' or char_length(o->>'name')>60
   or char_length(btrim(o->>'name',trim_chars))<1 or o->>'name' ~ '[\x01-\x1f\x7f]' then raise exception 'VALIDATION_ERROR'; end if;
  if jsonb_typeof(o->'priceCents') is distinct from 'number' or o->>'priceCents' !~ '^-?[0-9]+$'
   or (o->>'priceCents')::numeric not between -99999999 and 99999999 then raise exception 'VALIDATION_ERROR'; end if;
  if o ? 'soldOut' and jsonb_typeof(o->'soldOut') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
  capacity:=capacity+case when o ? 'maxQuantity' then app_private.ops_int(o->'maxQuantity',1,24) else 1 end;
 end loop;
 minimum:=app_private.ops_int(g->'min',0,24); maximum:=app_private.ops_int(g->'max',1,least(capacity,24));
 if minimum>maximum or cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception 'VALIDATION_ERROR'; end if;
end; $$;

-- Reuse the exact historical metadata validator after projecting only the new
-- modifier fields. This projection validates; it never rewrites saved details.
alter function app_private.validate_product_details(uuid,jsonb) rename to validate_product_details_before_shared_modifiers;
create function app_private.validate_product_details(p_business uuid,d jsonb)
returns void language plpgsql set search_path='' as $$
declare g jsonb; normalized jsonb; normalized_groups jsonb:='[]'; group_details jsonb; required integer:=0;
begin
 if jsonb_typeof(d->'modifierSets') is distinct from 'array' or jsonb_array_length(d->'modifierSets')>6 then raise exception 'VALIDATION_ERROR'; end if;
 for g in select * from jsonb_array_elements(d->'modifierSets') loop
  perform app_private.validate_modifier_group(g);
  required:=required+(g->>'min')::integer;
  if g ? 'libraryId' then
   select details into group_details from app_private.modifier_groups where business_id=p_business and id=(g->>'libraryId')::uuid for share;
   if not found or group_details is distinct from g-'libraryId' then raise exception 'PRODUCT_CHANGED'; end if;
  end if;
  normalized:=jsonb_set(jsonb_set(g-'libraryId','{min}',to_jsonb(least((g->>'min')::integer,jsonb_array_length(g->'options')))),
   '{max}',to_jsonb(least((g->>'max')::integer,jsonb_array_length(g->'options'))));
  normalized:=jsonb_set(normalized,'{options}',(select jsonb_agg(jsonb_set(o-array['soldOut','maxQuantity'],'{priceCents}',to_jsonb(abs((o->>'priceCents')::integer)))) from jsonb_array_elements(g->'options') o));
  normalized_groups:=normalized_groups||jsonb_build_array(normalized);
 end loop;
 if required>24 then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.validate_product_details_before_shared_modifiers(p_business,jsonb_set(d,'{modifierSets}',normalized_groups));
end; $$;

create function app_private.synchronize_product_modifier_links() returns trigger
language plpgsql set search_path='' as $$
declare g jsonb;
begin
 delete from app_private.product_modifier_groups where business_id=new.business_id and product_id=new.id;
 for g in select * from jsonb_array_elements(coalesce(new.details->'modifierSets','[]')) loop
  if g ? 'libraryId' then
   -- A composite foreign key prevents cross-business references independently
   -- of the HTTP validator and of privileged callers.
   insert into app_private.product_modifier_groups(business_id,product_id,group_id) values(new.business_id,new.id,(g->>'libraryId')::uuid);
  end if;
 end loop;
 return new;
end; $$;
create trigger synchronize_product_modifier_links after insert or update of details on app_private.products
 for each row execute function app_private.synchronize_product_modifier_links();

create function app_private.modifier_group_json(g app_private.modifier_groups) returns jsonb
language sql stable set search_path='' as $$
 select g.details||jsonb_build_object('version',g.version,'linkedProducts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name,p.id)
  from app_private.product_modifier_groups link join app_private.products p on p.business_id=link.business_id and p.id=link.product_id
  where link.business_id=g.business_id and link.group_id=g.id and p.deleted_at is null),'[]'::jsonb));
$$;

create function app_private.propagate_modifier_group(g app_private.modifier_groups) returns jsonb
language plpgsql set search_path='' as $$
declare item app_private.products%rowtype; next_details jsonb; result jsonb:='[]';
begin
 for item in select prod.* from app_private.products prod join app_private.product_modifier_groups link
  on link.business_id=prod.business_id and link.product_id=prod.id
  where link.business_id=g.business_id and link.group_id=g.id and prod.deleted_at is null order by prod.id for update of prod loop
  next_details:=jsonb_set(item.details,'{modifierSets}',(select jsonb_agg(case when x->>'libraryId'=g.id::text then g.details||jsonb_build_object('libraryId',g.id) else x end order by position)
   from jsonb_array_elements(item.details->'modifierSets') with ordinality sets(x,position)));
  perform app_private.validate_product_details(g.business_id,next_details);
  update app_private.products set details=next_details,version=version+1,updated_at=clock_timestamp() where business_id=item.business_id and id=item.id returning * into item;
  result:=result||jsonb_build_array(app_private.product_json(item));
 end loop;
 return result;
end; $$;

-- Keep the latest shift-summary/Point/operations dispatchers intact. Future
-- operation migrations must delegate through this wrapper for catalog commands.
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_shared_modifiers;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path='' as $$
<<shared_catalog>>
declare actor app_private.employees%rowtype; g app_private.modifier_groups%rowtype; product app_private.products%rowtype;
 operation app_private.pos_operations%rowtype; p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken'];
 c text:=p_payload->>'command'; result jsonb; rows jsonb; details jsonb; sets jsonb; chosen jsonb; modifier_id uuid;
 operation_id uuid; group_id uuid; expected_version integer; fingerprint bytea;
begin
 if c not in ('modifier_groups','save_modifier_group','set_modifier_option_sold_out') or c is null then
  if c='save_product' then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:'||p_business_id::text,0)); end if;
  return app_private.pos_command_before_shared_modifiers(p_business_id,p_employee_id,p_payload);
 end if;
 select * into actor from app_private.employees where business_id=p_business_id and id=p_employee_id and active and deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
 if not app_private.has_permission(p_business_id,actor.id,case c when 'modifier_groups' then 'catalog.read' when 'save_modifier_group' then 'catalog.manage' else 'catalog.availability' end) then raise exception 'PERMISSION_DENIED'; end if;
 if c='modifier_groups' then
  perform app_private.ops_exact(p,array['command']);
  select coalesce(jsonb_agg(app_private.modifier_group_json(groups) order by groups.details->>'name',groups.id),'[]') into rows from app_private.modifier_groups groups where business_id=p_business_id;
  return jsonb_build_object('data',jsonb_build_object('groups',rows));
 end if;
 if c='save_modifier_group' then
  perform app_private.ops_exact(p,array['command','operationId','groupId','expectedVersion','name','min','max','options']);
  group_id:=app_private.ops_uuid(p->'groupId');
  details:=jsonb_build_object('id',group_id,'name',p->'name','min',p->'min','max',p->'max','options',p->'options');
  perform app_private.validate_modifier_group(details,false);
 else
  perform app_private.ops_exact(p,array['command','operationId','productId','expectedVersion','modifierId','soldOut']);
  perform app_private.ops_uuid(p->'productId'); modifier_id:=app_private.ops_uuid(p->'modifierId');
  if jsonb_typeof(p->'soldOut') is distinct from 'boolean' then raise exception 'VALIDATION_ERROR'; end if;
 end if;
 if p->'expectedVersion'='null'::jsonb and c='save_modifier_group' then expected_version:=null;
 else expected_version:=app_private.ops_int(p->'expectedVersion',1,2147483647); end if;
 operation_id:=app_private.ops_uuid(p->'operationId'); fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 -- One catalog lock gives shared edits and product saves a consistent lock order.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:'||p_business_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
 select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=shared_catalog.operation_id;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 if c='save_modifier_group' then
  select * into g from app_private.modifier_groups where business_id=p_business_id and id=group_id for update;
  if found then
   if expected_version is distinct from g.version then raise exception 'PRODUCT_CHANGED'; end if;
   update app_private.modifier_groups set details=shared_catalog.details,version=version+1,updated_at=clock_timestamp() where business_id=p_business_id and id=group_id returning * into g;
  else
   if expected_version is not null then raise exception 'PRODUCT_CHANGED'; end if;
   insert into app_private.modifier_groups(business_id,id,details) values(p_business_id,group_id,details) returning * into g;
  end if;
  rows:=app_private.propagate_modifier_group(g);
  result:=jsonb_build_object('group',app_private.modifier_group_json(g),'products',rows);
 else
  select * into product from app_private.products where business_id=p_business_id and id=(p->>'productId')::uuid and deleted_at is null for update;
  if not found or product.version<>expected_version then raise exception 'PRODUCT_CHANGED'; end if;
  select s into chosen from jsonb_array_elements(product.details->'modifierSets') s where exists(select 1 from jsonb_array_elements(s->'options') o where o->>'id'=modifier_id::text);
  if not found then raise exception 'VALIDATION_ERROR'; end if;
  if chosen ? 'libraryId' then
   select * into g from app_private.modifier_groups where business_id=p_business_id and id=(chosen->>'libraryId')::uuid for update;
   if not found then raise exception 'PRODUCT_CHANGED'; end if;
   details:=jsonb_set(g.details,'{options}',(select jsonb_agg(case when o->>'id'=modifier_id::text then o||jsonb_build_object('soldOut',p->'soldOut') else o end order by position) from jsonb_array_elements(g.details->'options') with ordinality options(o,position)));
   update app_private.modifier_groups set details=shared_catalog.details,version=version+1,updated_at=clock_timestamp() where business_id=p_business_id and id=g.id returning * into g;
   rows:=app_private.propagate_modifier_group(g);
   result:=jsonb_build_object('products',rows,'group',app_private.modifier_group_json(g));
  else
   sets:=(select jsonb_agg(case when s->>'id'=chosen->>'id' then jsonb_set(s,'{options}',(select jsonb_agg(case when o->>'id'=modifier_id::text then o||jsonb_build_object('soldOut',p->'soldOut') else o end order by position) from jsonb_array_elements(s->'options') with ordinality options(o,position))) else s end order by position) from jsonb_array_elements(product.details->'modifierSets') with ordinality groups(s,position));
   details:=jsonb_set(product.details,'{modifierSets}',sets);
   perform app_private.validate_product_details(p_business_id,details);
   update app_private.products set details=shared_catalog.details,version=version+1,updated_at=clock_timestamp() where business_id=p_business_id and id=product.id returning * into product;
   result:=jsonb_build_object('products',jsonb_build_array(app_private.product_json(product)));
  end if;
 end if;
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,operation_id,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
end; $$;

revoke all on function app_private.validate_modifier_group(jsonb,boolean),app_private.validate_product_details(uuid,jsonb),app_private.validate_product_details_before_shared_modifiers(uuid,jsonb),
 app_private.synchronize_product_modifier_links(),app_private.modifier_group_json(app_private.modifier_groups),app_private.propagate_modifier_group(app_private.modifier_groups),
 app_private.pos_command_before_shared_modifiers(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function app_private.pos_command_before_shared_modifiers(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb) to service_role;
