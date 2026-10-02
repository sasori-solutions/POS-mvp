-- PostgreSQL bounds repetition counts to 255. Keep the 4 KiB part limit explicit.
do $migration$
declare definition text; needle text := $needle$p_payload->>'data' !~ '^[A-Za-z0-9+/=]{1,4096}$'$needle$;
begin
  select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
  if position(needle in definition)=0 then raise exception 'Unexpected POS function revision'; end if;
  execute replace(definition,needle,$replacement$p_payload->>'data' !~ '^[A-Za-z0-9+/=]+$' or char_length(p_payload->>'data') not between 1 and 4096$replacement$);
end;
$migration$;
