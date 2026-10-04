-- point_service uses #variable_conflict use_variable. Qualify the persisted
-- state in the sweep so the local NULL state variable cannot suppress recovery.
do $patch$ declare d text; needle text; begin
 select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) into d;
 needle:=$old$for a in select * from app_private.point_attempts where state in ('pending','sent_to_terminal','processing','unknown_review','partially_refunded','approved_verified') and (observed_at is null or observed_at<clock_timestamp()-interval '5 minutes') order by updated_at,id$old$;
 if position(needle in d)=0 then raise exception 'Unexpected Point sweep version'; end if;
 execute replace(d,needle,$new$for a in select pa.* from app_private.point_attempts pa where pa.state in ('pending','sent_to_terminal','processing','unknown_review','partially_refunded','approved_verified') and (pa.observed_at is null or pa.observed_at<clock_timestamp()-interval '5 minutes') order by pa.updated_at,pa.id$new$);
end $patch$;
