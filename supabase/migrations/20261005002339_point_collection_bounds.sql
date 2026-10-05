-- Reject unsupported amounts before reserving a provider checkout/terminal.
-- Existing accepted UUIDs still replay in the unchanged authorized dispatcher.
do $$
declare definition text; prepare_needle text; start_needle text; check_amount text;
begin
 definition:=pg_get_functiondef('app_private.point_command_before_official_sandbox(uuid,uuid,jsonb)'::regprocedure);
 prepare_needle:=$old$if q.status<>'prepared' or q.kind<>'payment' or q.payment_method<>'card_integrated' or q.total_cents<=0 then raise exception 'POINT_STATE_INVALID'; end if;$old$;
 start_needle:=$old$if q.status<>'prepared' or q.sale_id is not null then raise exception 'POINT_STATE_INVALID'; end if;$old$;
 if length(definition)-length(replace(definition,prepare_needle,''))<>length(prepare_needle)
  or length(definition)-length(replace(definition,start_needle,''))<>length(start_needle) then
  raise exception 'Point amount boundary source changed; review before applying';
 end if;
 check_amount:=$check$
  if q.total_cents>999999999 or (con.official_sandbox and q.total_cents<500) then raise exception 'POINT_AMOUNT_INVALID'; end if;$check$;
 definition:=replace(definition,prepare_needle,prepare_needle||check_amount);
 definition:=replace(definition,start_needle,start_needle||check_amount);
 execute definition;
end $$;
