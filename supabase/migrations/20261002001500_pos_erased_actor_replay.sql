-- Keep the permanent-unlink protection from 0011 in the expanded catalog.
-- Deleting an employee nulls the recorded actor; another actor must never own that replay.
do $migration$
declare definition text; needle text := 'v_operation.actor_id<>v_actor.id';
begin
  select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
  if position(needle in definition)=0 then raise exception 'Unexpected POS function revision'; end if;
  execute replace(definition,needle,'v_operation.actor_id is distinct from v_actor.id');
end;
$migration$;
