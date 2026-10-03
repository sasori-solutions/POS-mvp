-- A compatible older client can still move an unpaid remainder. Accepted
-- payment retries use their accepted scope, without exposing the moved account.
do $patch$ declare definition text; needle text; begin
 select pg_get_functiondef('app_private.pos_command(uuid,uuid,jsonb)'::regprocedure) into definition;
 needle:=$old$when c='prepare_checkout' then (select event.payload->'tableId'$old$;
 if position(needle in definition)=0 then raise exception 'Unexpected accepted payment scope'; end if;
 execute replace(definition,needle,$new$when c='record_payment' then accepted.result#>'{order,tableId}'='null'::jsonb
      when c='prepare_checkout' then (select event.payload->'tableId'$new$);
end $patch$;
