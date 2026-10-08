-- Published menu IDs are capabilities for read-only, explicitly projected data.
create table app_private.public_menus (
 business_id uuid not null references app_private.businesses(id) on delete cascade,
 id uuid not null, public_id uuid not null default gen_random_uuid() unique,
 revision integer not null default 1 check(revision>0), name text not null, location_label text not null default '',
 published boolean not null default false, schedules jsonb not null default '[]', updated_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id), check(jsonb_typeof(schedules)='array')
);
create table app_private.public_menu_products (
 business_id uuid not null, menu_id uuid not null, product_id uuid not null, position integer not null check(position between 0 and 99),
 primary key(business_id,menu_id,product_id), unique(business_id,menu_id,position),
 foreign key(business_id,menu_id) references app_private.public_menus(business_id,id) on delete cascade,
 foreign key(business_id,product_id) references app_private.products(business_id,id)
);
alter table app_private.public_menus enable row level security;
alter table app_private.public_menu_products enable row level security;
revoke all on app_private.public_menus,app_private.public_menu_products from public,anon,authenticated;

create function app_private.validate_menu_schedules(value jsonb) returns void language plpgsql immutable set search_path='' as $$
declare schedule jsonb; day jsonb; previous integer; weekday integer; first_minute integer; last_minute integer;
begin
 if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value)>14 then raise exception 'VALIDATION_ERROR'; end if;
 for schedule in select * from jsonb_array_elements(value) loop
  perform app_private.ops_exact(schedule,array['weekdays','startMinute','endMinute']);
  if jsonb_typeof(schedule->'weekdays') is distinct from 'array' or jsonb_array_length(schedule->'weekdays') not between 1 and 7 then raise exception 'VALIDATION_ERROR'; end if;
  previous:=-1;
  for day in select * from jsonb_array_elements(schedule->'weekdays') loop
   weekday:=app_private.ops_int(day,0,6); if weekday<=previous then raise exception 'VALIDATION_ERROR'; end if; previous:=weekday;
  end loop;
  first_minute:=app_private.ops_int(schedule->'startMinute',0,1439); last_minute:=app_private.ops_int(schedule->'endMinute',1,1440);
  if first_minute=last_minute then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
end; $$;

create function app_private.menu_schedule_open(schedules jsonb,instant timestamptz,zone text) returns boolean
language sql stable set search_path='' as $$
 with local as (select instant at time zone zone time), clock as (
  select extract(dow from time)::integer weekday,extract(hour from time)::integer*60+extract(minute from time)::integer minute_of_day from local
 ) select jsonb_array_length(schedules)=0 or exists(select 1 from jsonb_array_elements(schedules) s cross join clock c where
  case when (s->>'startMinute')::integer<(s->>'endMinute')::integer
   then s->'weekdays' @> to_jsonb(array[c.weekday]) and c.minute_of_day>=(s->>'startMinute')::integer and c.minute_of_day<(s->>'endMinute')::integer
   else (s->'weekdays' @> to_jsonb(array[c.weekday]) and c.minute_of_day>=(s->>'startMinute')::integer)
     or (s->'weekdays' @> to_jsonb(array[(c.weekday+6)%7]) and c.minute_of_day<(s->>'endMinute')::integer)
  end);
$$;

create function app_private.menu_configuration(m app_private.public_menus) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',m.id,'publicId',m.public_id,'revision',m.revision,'name',m.name,'locationLabel',m.location_label,
  'published',m.published,'schedules',m.schedules,'updatedAt',m.updated_at,'productIds',coalesce((select jsonb_agg(product_id order by position)
   from app_private.public_menu_products where business_id=m.business_id and menu_id=m.id),'[]'::jsonb));
$$;

create function app_private.menu_product_available(p app_private.products) returns boolean language plpgsql stable set search_path='' as $$
declare group_value jsonb; option_value jsonb; capacity integer;
begin
 if not p.active or p.deleted_at is not null or coalesce((p.details->>'soldOut')::boolean,false) then return false; end if;
 if coalesce(jsonb_array_length(p.details->'variations'),0)>0 and not exists(select 1 from jsonb_array_elements(p.details->'variations') v where not (v->>'soldOut')::boolean) then return false; end if;
 for group_value in select * from jsonb_array_elements(coalesce(p.details->'modifierSets','[]')) g where not g ? 'parentOptionId' loop
  capacity:=0;
  for option_value in select * from jsonb_array_elements(group_value->'options') loop
   if app_private.modifier_option_available(p.details->'modifierSets',option_value->>'id') then capacity:=capacity+coalesce((option_value->>'maxQuantity')::integer,1); end if;
  end loop;
  if capacity<(group_value->>'min')::integer then return false; end if;
 end loop;
 if coalesce(jsonb_array_length(p.details->'comboComponents'),0)>0 and app_private.combo_availability_reason(p.business_id,p.details->'comboComponents') is not null then return false; end if;
 return true;
end; $$;

create function app_private.menu_public_product(p app_private.products) returns jsonb language plpgsql stable set search_path='' as $$
declare dto jsonb; groups jsonb:='[]'; group_value jsonb; options jsonb; image_data text; product_dto jsonb;
begin
 -- Never return product_json wholesale: it contains preparation and cost data.
 for group_value in select * from jsonb_array_elements(coalesce(p.details->'modifierSets','[]')) loop
  select coalesce(jsonb_agg(jsonb_build_object('id',o->'id','name',o->'name','priceCents',o->'priceCents',
   'soldOut',not app_private.modifier_option_available(p.details->'modifierSets',o->>'id'),'maxQuantity',coalesce(o->'maxQuantity','1'::jsonb)) order by position),'[]') into options
   from jsonb_array_elements(group_value->'options') with ordinality entries(o,position);
  groups:=groups||jsonb_build_array(jsonb_build_object('id',group_value->'id','name',group_value->'name','min',group_value->'min','max',group_value->'max','options',options)
   ||case when group_value ? 'parentOptionId' then jsonb_build_object('parentOptionId',group_value->'parentOptionId') else '{}'::jsonb end);
 end loop;
 select data into image_data from app_private.product_images where business_id=p.business_id and id=(p.details->>'imageId')::uuid;
 if image_data is not null and (char_length(image_data)>245760 or image_data !~ '^[A-Za-z0-9+/=]+$') then image_data:=null; end if;
 product_dto:=app_private.product_json(p);
 dto:=jsonb_build_object('id',p.id,'name',coalesce(nullif(p.details->>'customerName',''),p.name),'category',p.category,'priceCents',p.price_cents,'available',app_private.menu_product_available(p),
  'variablePrice',coalesce((p.details->>'variablePrice')::boolean,false),'description',coalesce(p.details->>'description',''),
  'dietary',coalesce(p.details->>'dietary',''),'allergens',coalesce(p.details->>'allergens',''),
  'image',case when image_data is not null then 'data:image/jpeg;base64,'||image_data end,'modifierGroups',groups,
  'variations',coalesce((select jsonb_agg(jsonb_build_object('id',v->'id','name',v->'name','priceCents',v->'priceCents','soldOut',v->'soldOut') order by position)
   from jsonb_array_elements(coalesce(p.details->'variations','[]')) with ordinality entries(v,position)),'[]'::jsonb),
  'comboComponents',coalesce((select jsonb_agg(jsonb_build_object('name',component->'name','quantity',component->'quantity','selectionLabel',component->'selectionLabel') order by position)
   from jsonb_array_elements(coalesce(product_dto->'comboComponents','[]')) with ordinality entries(component,position)),'[]'::jsonb));
 return dto;
end; $$;

-- This RPC accepts one opaque published ID, not an employee identity or tenant.
create function public.public_menu_read(p_menu_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare menu app_private.public_menus%rowtype; business app_private.businesses%rowtype; instant timestamptz:=clock_timestamp(); opened boolean; products jsonb:='[]';
begin
 select * into menu from app_private.public_menus where public_id=p_menu_id and published;
 if not found then return jsonb_build_object('error',jsonb_build_object('code','MENU_UNAVAILABLE')); end if;
 select * into business from app_private.businesses where id=menu.business_id;
 opened:=app_private.menu_schedule_open(menu.schedules,instant,business.timezone);
 if opened then select coalesce(jsonb_agg(app_private.menu_public_product(p) order by link.position),'[]') into products
  from app_private.public_menu_products link join app_private.products p on p.business_id=link.business_id and p.id=link.product_id
  where link.business_id=menu.business_id and link.menu_id=menu.id and p.active and p.deleted_at is null; end if;
 return jsonb_build_object('data',jsonb_build_object('publicId',menu.public_id,'businessName',business.name,'name',menu.name,'locationLabel',menu.location_label,
  'timezone',business.timezone,'asOf',instant,'availability',case when opened then 'open' else 'outside_hours' end,'schedules',menu.schedules,'products',products));
end; $$;

alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_public_menus;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
<<menu_command>>
declare actor app_private.employees%rowtype; menu app_private.public_menus%rowtype; operation app_private.pos_operations%rowtype;
 p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken']; c text:=p_payload->>'command'; operation_id uuid; menu_id uuid; fingerprint bytea; result jsonb; product_id uuid;
begin
 if c is null or c not in ('menus','save_menu') then return app_private.pos_command_before_public_menus(p_business_id,p_employee_id,p_payload); end if;
 select e.* into actor from app_private.employees e where e.business_id=p_business_id and e.id=p_employee_id and e.active and e.deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.role<>'owner' or actor.user_id is null or current_setting('app.pos_session_kind',true) is distinct from 'personal'
  or not app_private.has_permission(p_business_id,actor.id,'catalog.manage') then raise exception 'PERMISSION_DENIED'; end if;
 perform app_private.assert_member(actor.user_id,p_business_id);
 if c='menus' then
  perform app_private.ops_exact(p,array['command']);
  return jsonb_build_object('data',jsonb_build_object('menus',coalesce((select jsonb_agg(app_private.menu_configuration(m) order by m.name,m.id) from app_private.public_menus m where m.business_id=p_business_id),'[]')));
 end if;
 perform app_private.ops_exact(p,array['command','operationId','menuId','expectedRevision','name','locationLabel','published','productIds','schedules']);
 if octet_length(p::text)>8192 then raise exception 'PAYLOAD_TOO_LARGE'; end if;
 if jsonb_typeof(p->'name') is distinct from 'string' or char_length(p->>'name')>100 or char_length(btrim(p->>'name'))<1 or p->>'name' ~ '[\x01-\x1f\x7f]'
  or jsonb_typeof(p->'locationLabel') is distinct from 'string' or char_length(p->>'locationLabel')>80 or p->>'locationLabel' ~ '[\x01-\x1f\x7f]'
  or jsonb_typeof(p->'published') is distinct from 'boolean' or jsonb_typeof(p->'productIds') is distinct from 'array' or jsonb_array_length(p->'productIds')>100
  or (select count(distinct lower(value)) from jsonb_array_elements_text(p->'productIds'))<>jsonb_array_length(p->'productIds')
  or ((p->>'published')::boolean and jsonb_array_length(p->'productIds')=0) then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.validate_menu_schedules(p->'schedules');
 operation_id:=app_private.ops_uuid(p->'operationId'); menu_id:=app_private.ops_uuid(p->'menuId'); fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 if p->'expectedRevision'<>'null'::jsonb then perform app_private.ops_int(p->'expectedRevision',1,2147483647); end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:'||p_business_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||operation_id::text,0));
 select * into operation from app_private.pos_operations where business_id=p_business_id and pos_operations.operation_id=menu_command.operation_id;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 for product_id in select app_private.ops_uuid(value) from jsonb_array_elements(p->'productIds') loop
  if not exists(select 1 from app_private.products where business_id=p_business_id and id=product_id and deleted_at is null) then raise exception 'PRODUCT_CHANGED'; end if;
 end loop;
 select * into menu from app_private.public_menus where business_id=p_business_id and id=menu_id for update;
 if found then
  if menu.revision is distinct from (p->>'expectedRevision')::integer then raise exception 'MENU_CHANGED'; end if;
  update app_private.public_menus set name=p->>'name',location_label=p->>'locationLabel',published=(p->>'published')::boolean,schedules=p->'schedules',revision=revision+1,updated_at=clock_timestamp()
   where business_id=p_business_id and id=menu_id returning * into menu;
 else
  if p->'expectedRevision' is distinct from 'null'::jsonb then raise exception 'MENU_CHANGED'; end if;
  insert into app_private.public_menus(business_id,id,name,location_label,published,schedules) values(p_business_id,menu_id,p->>'name',p->>'locationLabel',(p->>'published')::boolean,p->'schedules') returning * into menu;
 end if;
 delete from app_private.public_menu_products where business_id=p_business_id and public_menu_products.menu_id=menu_command.menu_id;
 insert into app_private.public_menu_products(business_id,menu_id,product_id,position)
  select p_business_id,menu_id,app_private.ops_uuid(value),position::integer-1 from jsonb_array_elements(p->'productIds') with ordinality entries(value,position);
 result:=app_private.menu_configuration(menu);
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,operation_id,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
end; $$;

revoke all on function app_private.validate_menu_schedules(jsonb),app_private.menu_schedule_open(jsonb,timestamptz,text),app_private.menu_configuration(app_private.public_menus),
 app_private.menu_product_available(app_private.products),app_private.menu_public_product(app_private.products),app_private.pos_command_before_public_menus(uuid,uuid,jsonb),app_private.pos_command(uuid,uuid,jsonb),public.public_menu_read(uuid) from public,anon,authenticated;
grant execute on function public.public_menu_read(uuid) to service_role;
