-- One explicit promotion per account. Scope uses accepted line identities and
-- categories, never today's catalogue. Prices, IVA and prefix splits stay exact.
create table app_private.promotions (
 business_id uuid not null references app_private.businesses(id) on delete cascade,
 id uuid not null, revision integer not null check(revision>0), name text not null,
 active boolean not null, kind text not null check(kind in ('fixed','percent')),
 value bigint not null check(value>=0 and value<=case when kind='fixed' then 9999999999 else 10000 end),
 scope jsonb not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 primary key(business_id,id)
);
alter table app_private.promotions enable row level security;
revoke all on app_private.promotions from public,anon,authenticated;

create function app_private.promotion_category(p_value text) returns text language sql immutable set search_path='' as $$
 select pg_catalog.normalize(regexp_replace(btrim(p_value),'\s+',' ','g'),'NFC');
$$;
create function app_private.validate_promotion_scope(p_scope jsonb) returns void language plpgsql immutable set search_path='' as $$
declare item jsonb;
begin
 perform app_private.ops_exact(p_scope,array['productIds','categories']);
 if jsonb_typeof(p_scope->'productIds') is distinct from 'array' or jsonb_array_length(p_scope->'productIds')>100
  or jsonb_typeof(p_scope->'categories') is distinct from 'array' or jsonb_array_length(p_scope->'categories')>24
  or jsonb_array_length(p_scope->'productIds')+jsonb_array_length(p_scope->'categories')=0 then raise exception 'VALIDATION_ERROR'; end if;
 for item in select value from jsonb_array_elements(p_scope->'productIds') loop perform app_private.ops_uuid(item); end loop;
 for item in select value from jsonb_array_elements(p_scope->'categories') loop
  perform app_private.ops_text(item,1,60);
  if item#>>'{}' is distinct from app_private.promotion_category(item#>>'{}') then raise exception 'VALIDATION_ERROR'; end if;
 end loop;
 if (select count(distinct lower(value)) from jsonb_array_elements_text(p_scope->'productIds'))<>jsonb_array_length(p_scope->'productIds')
  or (select count(distinct value) from jsonb_array_elements_text(p_scope->'categories'))<>jsonb_array_length(p_scope->'categories') then raise exception 'VALIDATION_ERROR'; end if;
end; $$;
create function app_private.promotion_matches(p_scope jsonb,p_product uuid,p_category text) returns boolean language sql immutable set search_path='' as $$
 select p_scope is null or exists(select 1 from jsonb_array_elements_text(p_scope->'productIds') value where value::uuid=p_product)
  or p_scope->'categories' ? app_private.promotion_category(p_category);
$$;
create function app_private.validate_scoped_discount(p_discount jsonb,p_allow_promotion boolean) returns void language plpgsql immutable set search_path='' as $$
begin
 if p_discount is null or p_discount='null'::jsonb then return; end if;
 perform app_private.ops_exact(p_discount,array['kind','value','reason']||case when p_discount ? 'scope' then array['scope'] else '{}'::text[] end||case when p_allow_promotion and p_discount ? 'promotion' then array['promotion'] else '{}'::text[] end);
 if jsonb_typeof(p_discount->'kind') is distinct from 'string' or p_discount->>'kind' not in ('fixed','percent') then raise exception 'VALIDATION_ERROR'; end if;
 perform app_private.ops_int(p_discount->'value',0,case when p_discount->>'kind'='fixed' then 9999999999 else 10000 end);
 perform app_private.ops_text(p_discount->'reason',1,200);
 if p_discount ? 'scope' then perform app_private.validate_promotion_scope(p_discount->'scope'); end if;
 if p_discount ? 'promotion' then
  if not p_allow_promotion or not p_discount ? 'scope' then raise exception 'VALIDATION_ERROR'; end if;
  perform app_private.ops_exact(p_discount->'promotion',array['id','revision','name']);
  perform app_private.ops_uuid(p_discount#>'{promotion,id}'); perform app_private.ops_int(p_discount#>'{promotion,revision}',1,2147483647);
  perform app_private.ops_text(p_discount#>'{promotion,name}',1,60);
 end if;
end; $$;

-- Extend precisely the legacy validator behind free-amount/Point wrappers.
-- The public dispatcher below rejects promotion metadata on manual commands.
do $$ declare definition text:=pg_get_functiondef('app_private.ops_validate_before_amount(jsonb)'::regprocedure); needle text;
begin
 needle:=$old$d:=p->'discount'; perform app_private.ops_exact(d,array['kind','value','reason']);
  if jsonb_typeof(d->'kind') is distinct from 'string' or d->>'kind' not in ('fixed','percent') then raise exception 'VALIDATION_ERROR'; end if;
  perform app_private.ops_int(d->'value',0,case when d->>'kind'='fixed' then 9999999999 else 10000 end); perform app_private.ops_text(d->'reason',1,200);$old$;
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'PROMOTION_VALIDATOR_PREDECESSOR_CHANGED'; end if;
 execute replace(definition,needle,'perform app_private.validate_scoped_discount(p->''discount'',true);');
end; $$;

create or replace function app_private.ops_price_order(p_business uuid,p_order uuid) returns void language plpgsql set search_path='' as $$
declare d jsonb; gross bigint; eligible_gross bigint; eligible_count integer; discount bigint; scope jsonb;
begin
 select o.discount into d from app_private.operational_orders o where o.business_id=p_business and o.id=p_order;
 perform app_private.validate_scoped_discount(d,true); scope:=d->'scope';
 select coalesce(sum(quantity::bigint*unit_price_cents),0),coalesce(sum(quantity::bigint*unit_price_cents) filter(where app_private.promotion_matches(scope,product_id,category)),0),count(*) filter(where app_private.promotion_matches(scope,product_id,category))
  into gross,eligible_gross,eligible_count from app_private.order_lines where business_id=p_business and order_id=p_order;
 if gross>9999999999 then raise exception 'VALIDATION_ERROR'; end if;
 if scope is not null and (eligible_count=0 or eligible_gross=0) then raise exception 'PROMOTION_NOT_APPLICABLE'; end if;
 discount:=case when d is null then 0 when d->>'kind'='fixed' then (d->>'value')::bigint else round(eligible_gross::numeric*(d->>'value')::integer/10000)::bigint end;
 if discount>eligible_gross then raise exception 'VALIDATION_ERROR'; end if;
 with shares as (select id,quantity::bigint*unit_price_cents g,
  case when eligible_gross=0 then 0 else floor(discount::numeric*(quantity::bigint*unit_price_cents)/eligible_gross)::bigint end base,
  case when eligible_gross=0 then 0 else mod(discount::numeric*(quantity::bigint*unit_price_cents),eligible_gross) end remainder
  from app_private.order_lines where business_id=p_business and order_id=p_order and app_private.promotion_matches(scope,product_id,category)),
 ranked as (select *,row_number() over(order by remainder desc,id) rank,sum(base) over() bases from shares),
 allocated as (select id,base+case when rank<=discount-bases then 1 else 0 end amount from ranked)
 update app_private.order_lines l set gross_cents=l.quantity::bigint*l.unit_price_cents,discount_cents=coalesce(a.amount,0),total_cents=l.quantity::bigint*l.unit_price_cents-coalesce(a.amount,0),tax_cents=app_private.included_vat_cents(l.quantity::bigint*l.unit_price_cents-coalesce(a.amount,0),l.tax_bps)
 from (select line.id,allocated.amount from app_private.order_lines line left join allocated on allocated.id=line.id where line.business_id=p_business and line.order_id=p_order) a
 where l.business_id=p_business and l.order_id=p_order and l.id=a.id;
end; $$;

create function app_private.promotion_json(p app_private.promotions) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'revision',p.revision,'name',p.name,'active',p.active,'kind',p.kind,'value',p.value,'scope',p.scope);
$$;
create function app_private.promotion_operation_uuid(p_operation uuid) returns uuid language sql immutable set search_path='' as $$
 with value as(select encode(extensions.digest('promotion:'||p_operation::text,'sha256'),'hex') h)
 select (substring(h from 1 for 8)||'-'||substring(h from 9 for 4)||'-5'||substring(h from 14 for 3)||'-8'||substring(h from 18 for 3)||'-'||substring(h from 21 for 12))::uuid from value;
$$;
alter function app_private.pos_command(uuid,uuid,jsonb) rename to pos_command_before_promotions;
create function app_private.pos_command(p_business_id uuid,p_employee_id uuid,p_payload jsonb) returns jsonb language plpgsql set search_path='' as $$
<<promotion_command>>
declare p jsonb:=p_payload-array['action','businessId','operatorToken','deviceToken']; c text:=p_payload->>'command'; actor app_private.employees%rowtype;
 operation app_private.pos_operations%rowtype; promotion app_private.promotions%rowtype; p_operation uuid; p_id uuid; p_revision integer; fingerprint bytea; result jsonb; discount jsonb;
begin
 if c is null or c not in ('promotions','save_promotion','apply_order_promotion','set_order_discount') then return app_private.pos_command_before_promotions(p_business_id,p_employee_id,p_payload); end if;
 select e.* into actor from app_private.employees e where e.business_id=p_business_id and e.id=p_employee_id and e.active and e.deleted_at is null for share;
 if not found then raise exception 'EMPLOYEE_INACTIVE'; end if;
 if actor.user_id is not null then perform app_private.assert_member(actor.user_id,p_business_id); end if;
 if not app_private.has_permission(p_business_id,actor.id,'sales.discount') or (c='save_promotion' and not app_private.has_permission(p_business_id,actor.id,'catalog.manage')) then raise exception 'PERMISSION_DENIED'; end if;
 if octet_length(p::text)>8192 then raise exception 'PAYLOAD_TOO_LARGE'; end if;
 if c='set_order_discount' then
  perform app_private.validate_scoped_discount(p->'discount',false);
  -- The delegated dispatcher authorizes/fingerprints accepted replays itself.
  -- Only a new manual scope checks tenant ownership, including archived items.
  if p->'discount' ? 'scope' and not exists(select 1 from app_private.pos_operations po where po.business_id=p_business_id and po.operation_id=app_private.ops_uuid(p->'operationId'))
   and exists(select 1 from jsonb_array_elements_text(p#>'{discount,scope,productIds}') item where not exists(select 1 from app_private.products prod where prod.business_id=p_business_id and prod.id=item::uuid)) then raise exception 'PRODUCT_CHANGED'; end if;
  return app_private.pos_command_before_promotions(p_business_id,p_employee_id,p_payload);
 elsif c='promotions' then
  perform app_private.ops_exact(p,array['command']);
  return jsonb_build_object('data',jsonb_build_object('promotions',coalesce((select jsonb_agg(app_private.promotion_json(pr) order by pr.name,pr.id) from app_private.promotions pr where pr.business_id=p_business_id),'[]')));
 elsif c='save_promotion' then
  perform app_private.ops_exact(p,array['command','operationId','promotionId','expectedRevision','name','active','kind','value','scope']);
  p_id:=app_private.ops_uuid(p->'promotionId');
  if p->'expectedRevision'<>'null'::jsonb then p_revision:=app_private.ops_int(p->'expectedRevision',1,2147483647); end if;
  perform app_private.ops_text(p->'name',1,60); perform app_private.validate_promotion_scope(p->'scope');
  if jsonb_typeof(p->'active') is distinct from 'boolean' or jsonb_typeof(p->'kind') is distinct from 'string' or p->>'kind' not in ('fixed','percent') then raise exception 'VALIDATION_ERROR'; end if;
  perform app_private.ops_int(p->'value',0,case when p->>'kind'='fixed' then 9999999999 else 10000 end);
 else
  perform app_private.ops_exact(p,array['command','operationId','orderId','expectedRevision','promotionId','promotionRevision']);
  perform app_private.ops_uuid(p->'orderId'); perform app_private.ops_int(p->'expectedRevision',1,2147483647);
  p_id:=app_private.ops_uuid(p->'promotionId'); p_revision:=app_private.ops_int(p->'promotionRevision',1,2147483647);
 end if;
 p_operation:=app_private.ops_uuid(p->'operationId'); fingerprint:=extensions.digest((p-'operationId')::text,'sha256');
 if c='save_promotion' then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:'||p_business_id::text,0)); end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pos:'||p_business_id::text||':'||p_operation::text,0));
 select * into operation from app_private.pos_operations po where po.business_id=p_business_id and po.operation_id=p_operation;
 if found then
  if operation.actor_id is distinct from actor.id or operation.payload_fingerprint is distinct from fingerprint then raise exception 'OPERATION_CONFLICT'; end if;
  return jsonb_build_object('data',operation.result);
 end if;
 if c='save_promotion' then
  if exists(select 1 from jsonb_array_elements_text(p->'scope'->'productIds') item where not exists(select 1 from app_private.products prod where prod.business_id=p_business_id and prod.id=item::uuid and prod.deleted_at is null)) then raise exception 'PRODUCT_CHANGED'; end if;
  select * into promotion from app_private.promotions pr where pr.business_id=p_business_id and pr.id=p_id for update;
  if found then
   if p_revision is null or promotion.revision<>p_revision then raise exception 'PROMOTION_CHANGED'; end if;
   update app_private.promotions pr set revision=pr.revision+1,name=app_private.ops_text(p->'name',1,60),active=(p->>'active')::boolean,kind=p->>'kind',value=(p->>'value')::bigint,scope=p->'scope',updated_at=clock_timestamp() where pr.business_id=p_business_id and pr.id=p_id returning * into promotion;
  else
   if p_revision is not null then raise exception 'PROMOTION_CHANGED'; end if;
   insert into app_private.promotions(business_id,id,revision,name,active,kind,value,scope) values(p_business_id,p_id,1,app_private.ops_text(p->'name',1,60),(p->>'active')::boolean,p->>'kind',(p->>'value')::bigint,p->'scope') returning * into promotion;
  end if;
  result:=app_private.promotion_json(promotion);
 else
  select * into promotion from app_private.promotions pr where pr.business_id=p_business_id and pr.id=p_id for share;
  if not found then raise exception 'PROMOTION_NOT_FOUND'; end if;
  if promotion.revision<>p_revision then raise exception 'PROMOTION_CHANGED'; end if;
  if not promotion.active then raise exception 'PROMOTION_NOT_APPLICABLE'; end if;
  discount:=jsonb_build_object('kind',promotion.kind,'value',promotion.value,'reason',promotion.name,'scope',promotion.scope,'promotion',jsonb_build_object('id',promotion.id,'revision',promotion.revision,'name',promotion.name));
  result:=app_private.pos_command_before_promotions(p_business_id,p_employee_id,jsonb_build_object('command','set_order_discount','operationId',app_private.promotion_operation_uuid(p_operation),'orderId',p->'orderId','expectedRevision',p->'expectedRevision','discount',discount))->'data';
 end if;
 insert into app_private.pos_operations(business_id,operation_id,actor_id,payload_fingerprint,result) values(p_business_id,p_operation,actor.id,fingerprint,result);
 return jsonb_build_object('data',result);
end; $$;

revoke all on function app_private.promotion_category(text),app_private.validate_promotion_scope(jsonb),app_private.promotion_matches(jsonb,uuid,text),app_private.validate_scoped_discount(jsonb,boolean),
 app_private.promotion_json(app_private.promotions),app_private.promotion_operation_uuid(uuid),app_private.ops_price_order(uuid,uuid),app_private.ops_validate_before_amount(jsonb),app_private.pos_command(uuid,uuid,jsonb),app_private.pos_command_before_promotions(uuid,uuid,jsonb) from public,anon,authenticated;
