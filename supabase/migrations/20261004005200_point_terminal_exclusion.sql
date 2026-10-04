-- The physical terminal remains reserved across OAuth reconnections. Changing
-- collector/connection must not permit a second charge while the first is unknown.
create unique index point_one_physical_terminal_charge on app_private.point_terminal_reservations(terminal_id);
create function app_private.point_guard_terminal_binding() returns trigger
language plpgsql set search_path='' as $$
begin
 if (new.connection_id,new.branch_id,new.register_id) is distinct from (old.connection_id,old.branch_id,old.register_id)
  and exists(select 1 from app_private.point_terminal_reservations where terminal_id=old.id) then raise exception 'POINT_TERMINAL_BUSY'; end if;
 return new;
end $$;
create trigger point_terminal_reserved_binding before update on app_private.point_terminals
 for each row execute function app_private.point_guard_terminal_binding();
revoke all on function app_private.point_guard_terminal_binding() from public,anon,authenticated;
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('app_private.point_command(uuid,uuid,jsonb)'::regprocedure) into d;
 needle:=$old$where connection_id=con.id and terminal_id=t.id) then raise exception 'POINT_TERMINAL_BUSY';$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point reservation version'; end if;
 execute replace(d,needle,$new$where terminal_id=t.id) then raise exception 'POINT_TERMINAL_BUSY';$new$);
end $patch$;
