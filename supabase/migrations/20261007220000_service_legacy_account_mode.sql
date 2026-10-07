-- Legacy profiles omit accountsEnabled; their existing effective mode enables
-- accounts unless explicitly false, matching profile normalization and the POS.
-- Patch only the service dispatcher's mode guard, retaining auth/replay/grants.
do $migration$
declare
 definition text:=pg_catalog.pg_get_functiondef('app_private.pos_command_before_catalog_bulk(uuid,uuid,jsonb)'::regprocedure);
 old_condition text:=$condition$profile->'accountsEnabled'='true'::jsonb$condition$;
 new_condition text:=$condition$profile->'accountsEnabled' is distinct from 'false'::jsonb$condition$;
begin
 if (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,old_condition,'')))/pg_catalog.length(old_condition)<>1 then
  raise exception 'Service account-mode guard differs from the expected migration chain';
 end if;
 execute pg_catalog.replace(definition,old_condition,new_condition);
end;
$migration$;
