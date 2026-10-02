-- Agente de Larios. Read-only aggregate preview of 0010's legacy deletion purge.
-- Run on the exact 0001–0009 schema before approving the guarded migration.
-- No names, IDs, emails, hashes, PINs, tokens or row-level records are returned.
-- Counts are a snapshot; the migration transaction rechecks its exact ledger.
begin read only;
with targets as (
  select id,business_id,user_id,merged_into_employee_id from app_private.employees
  where role<>'owner' and deleted_at is not null
), memberships as (
  select m.* from app_private.business_memberships m
  where exists(select 1 from targets t where t.business_id=m.business_id and t.user_id=m.user_id)
)
select jsonb_build_object(
  'migration_versions',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
  'employees_to_remove',(select count(*) from targets),
  'linked_employees_to_remove',(select count(*) from targets where user_id is not null),
  'retired_placeholders_to_remove',(select count(*) from targets where merged_into_employee_id is not null),
  'businesses_affected',(select count(distinct business_id) from targets),
  'memberships_to_remove',(select count(*) from memberships),
  'unexpected_owner_memberships',(select count(*) from memberships where role='owner'),
  'deleted_owners_blocking_migration',(select count(*) from app_private.employees where role='owner' and deleted_at is not null),
  'personal_pin_credentials_to_remove',(select count(*) from app_private.operator_credentials x join memberships m using(business_id,user_id)),
  'personal_sessions_to_remove',(select count(*) from app_private.operator_sessions x join memberships m using(business_id,user_id)),
  'shared_pin_credentials_to_remove',(select count(*) from app_private.shared_employee_credentials x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'shared_sessions_to_remove',(select count(*) from app_private.device_operator_sessions x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'invitations_to_remove',(select count(*) from app_private.business_invitations x where exists(select 1 from targets t where t.business_id=x.business_id and (t.id=x.employee_id or t.id=x.accepted_employee_id))),
  'creation_operations_to_retire',(select count(*) from app_private.employee_create_operations x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'pin_setup_codes_to_remove',(select count(*) from app_private.employee_pin_setup_codes x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'email_recoveries_to_remove',(select count(*) from app_private.pin_email_recoveries x where exists(select 1 from targets t where t.business_id=x.business_id and (t.id=x.employee_id or t.user_id=x.user_id))),
  'pin_security_operations_to_remove',(select count(*) from app_private.pin_security_operations x join memberships m using(business_id,user_id)),
  'legacy_recovery_credentials_to_remove',(select count(*) from app_private.owner_pin_recovery_credentials x join memberships m using(business_id,user_id)),
  'personal_device_bindings_to_remove',(select count(*) from app_private.employee_personal_devices x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'device_notifications_to_remove',(select count(*) from app_private.owner_notifications x where exists(select 1 from targets t where t.business_id=x.business_id and t.id=x.employee_id)),
  'account_audit_associations_to_anonymize',(select count(*) from app_private.account_audit_events x where exists(select 1 from targets t where t.business_id=x.business_id and t.user_id=x.user_id)),
  'pin_audit_associations_to_anonymize',(select count(*) from app_private.pin_security_audit_events x where exists(select 1 from targets t where t.business_id=x.business_id and t.user_id=x.user_id)),
  'global_auth_accounts_preserved',(select count(*) from auth.users u where exists(select 1 from targets t where t.user_id=u.id)),
  'global_auth_sessions_preserved',(select count(*) from auth.sessions s where exists(select 1 from targets t where t.user_id=s.user_id)),
  'other_business_memberships_preserved',(select count(*) from app_private.business_memberships m where exists(select 1 from targets t where t.user_id=m.user_id) and not exists(select 1 from targets t where t.user_id=m.user_id and t.business_id=m.business_id)),
  'active_or_disabled_nonowners_preserved',(select count(*) from app_private.employees where role<>'owner' and deleted_at is null),
  'owners_preserved',(select count(*) from app_private.employees where role='owner'),
  'shared_register_devices_preserved',(select count(*) from app_private.devices),
  'global_nonce_replay_records_preserved',(select count(*) from app_private.employee_device_proofs)
) as purge_preflight;
commit;
