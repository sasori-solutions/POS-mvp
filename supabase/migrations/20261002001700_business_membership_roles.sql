-- Membership roles identify each access in the account selector, never grant it.
create or replace function public.account_status(p_user_id uuid,p_auth_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_businesses jsonb;
begin
  perform app_private.assert_live_auth(p_user_id,p_auth_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'businessType',b.business_type,
    'role',m.role,'canRecoverPin',true,'recoveryReady',true) order by b.created_at,b.id),'[]'::jsonb) into v_businesses
    from app_private.businesses b join app_private.business_memberships m on m.business_id=b.id
    join app_private.employees e on e.business_id=m.business_id and e.user_id=m.user_id
    where m.user_id=p_user_id and m.active and e.active and e.deleted_at is null and m.role=e.role;
  return jsonb_build_object('data',jsonb_build_object('businesses',v_businesses));
end;
$$;
revoke all on function public.account_status(uuid,uuid) from public,anon,authenticated;
grant execute on function public.account_status(uuid,uuid) to service_role;
