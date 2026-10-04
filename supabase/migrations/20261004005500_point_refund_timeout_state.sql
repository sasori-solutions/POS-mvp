-- A refund timeout must retain the payment's existing settled state. With
-- #variable_conflict use_variable, bare "state" denotes the local NULL variable.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) into d;
 needle:=$old$update app_private.point_attempts set state=case when sale_state='materialized' then state else 'unknown_review' end,status_detail=left(p->>'code',80),updated_at=clock_timestamp() where id=j.attempt_id;$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point failure state version'; end if;
 execute replace(d,needle,$new$update app_private.point_attempts pa set state=case when pa.sale_state='materialized' then pa.state else 'unknown_review' end,status_detail=left(p->>'code',80),updated_at=clock_timestamp() where pa.id=j.attempt_id;$new$);
end $patch$;
