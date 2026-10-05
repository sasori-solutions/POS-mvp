-- Restore persisted preparation transitions without rewriting preparation history.
-- Current UI uses queued -> preparing -> delivered; ready remains readable for
-- older clients. Their already supported direct completion remains compatible.
do $patch$
declare definition text; needle text; replacement text;
begin
 -- Point wraps the operational dispatcher; preparation lives in this preserved
 -- implementation, whose authorization/replay path must remain intact.
 select pg_get_functiondef('app_private.pos_command_before_point(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$if p->>'status'<>'delivered' or b.status='delivered' then raise exception 'BATCH_CHANGED'; end if;$old$;
 replacement:=$new$if not (
   b.kind='items' and (
     b.status='queued' and p->>'status' in ('preparing','delivered')
     or b.status='preparing' and p->>'status' in ('ready','delivered')
     or b.status='ready' and p->>'status'='delivered'
   )
   or b.kind='cancellation' and b.status='queued' and p->>'status'='delivered'
 ) then raise exception 'BATCH_CHANGED'; end if;$new$;
 if position(needle in definition)=0 then raise exception 'Unexpected kitchen workflow transition'; end if;
 execute replace(definition,needle,replacement);
end $patch$;
