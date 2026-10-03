-- Comandas have one UI transition: pending directly to completed. Keep legacy
-- prepared statuses readable, but normalize current work to pending.
update app_private.kitchen_batches set status='queued',revision=revision+1
 where status in ('preparing','ready');

do $patch$
declare definition text; needle text; replacement text;
begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$if not (b.status='queued' and p->>'status'='preparing' or b.status='preparing' and p->>'status'='ready' or b.status='ready' and p->>'status'='delivered'
   or b.kind='cancellation' and b.status='queued' and p->>'status'='delivered') then raise exception 'BATCH_CHANGED'; end if;$old$;
 replacement:=$new$if p->>'status'<>'delivered' or b.status='delivered' then raise exception 'BATCH_CHANGED'; end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected comanda status transition'; end if;
 definition:=replace(definition,needle,replacement);

 needle:=$old$'attempts',lines,'tables',$old$;
 replacement:=$new$'attempts',lines,'pendingKitchenCount',case when app_private.has_permission(p_business_id,actor.id,'kitchen.read')
   then (select count(*)::integer from app_private.kitchen_batches kb where kb.business_id=p_business_id and app_private.ops_batch_pending(kb))
   else 0 end,'tables',$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected operational snapshot shape'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
