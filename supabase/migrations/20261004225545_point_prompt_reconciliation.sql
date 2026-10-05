-- A simulation event only requests a provider transition. Reconcile active
-- attempts promptly through the existing GET worker, without waiting for a
-- webhook or changing a financial fact from the requested simulation status.
alter function public.point_service(text,jsonb) rename to point_service_before_prompt_reconciliation;
create function public.point_service(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare response jsonb; a app_private.point_attempts%rowtype;
begin
 -- Preserve unmatched notifications, expired lease recovery and the existing
 -- periodic audit of already confirmed payments/refunds.
 response:=public.point_service_before_prompt_reconciliation(p_action,p_payload);
 if p_action='pending_sweep' then
  for a in select pa.* from app_private.point_attempts pa
   where pa.state in ('pending','sent_to_terminal','processing','unknown_review')
    and pa.sale_state<>'materialized' and pa.remote_order_id is not null
    and coalesce(pa.last_reconciled_at,pa.observed_at,pa.created_at)<clock_timestamp()-interval '10 seconds'
    and not exists(select 1 from app_private.point_jobs j where j.attempt_id=pa.id and j.status in ('queued','leased'))
   order by coalesce(pa.last_reconciled_at,pa.observed_at,pa.created_at),pa.id
   limit greatest(1,least(coalesce((p_payload->>'limit')::integer,100),500))
   for update skip locked loop
   -- Serialize per attempt and leave an existing lease or retry/backoff alone.
   if not exists(select 1 from app_private.point_jobs j where j.attempt_id=a.id and j.status in ('queued','leased')) then
    insert into app_private.point_jobs(business_id,connection_id,attempt_id,kind,dedupe_key)
     values(a.business_id,a.connection_id,a.id,'reconcile_order','active-sweep:'||a.id::text||':'||floor(extract(epoch from clock_timestamp())/15)::text)
     on conflict(dedupe_key) do nothing;
   end if;
  end loop;
 end if;
 return response;
end $$;
revoke all on function public.point_service(text,jsonb),public.point_service_before_prompt_reconciliation(text,jsonb) from public,anon,authenticated;
revoke all on function public.point_service_before_prompt_reconciliation(text,jsonb) from service_role;
grant execute on function public.point_service(text,jsonb) to service_role;
