-- Deferred constraint triggers run at COMMIT after the service RPC has returned
-- from its SECURITY DEFINER context. The caller (including authenticator) must
-- not receive private-schema privileges just to reconcile that committed graph.
-- Elevate only the two trigger entrypoints; all checks and command authorization
-- remain unchanged and no browser/API grants are added.
alter function app_private.ops_check_financial_graph() owner to postgres;
alter function app_private.ops_check_financial_graph() security definer;
alter function app_private.ops_check_financial_graph() set search_path='';
alter function app_private.ops_check_adjustment_order() owner to postgres;
alter function app_private.ops_check_adjustment_order() security definer;
alter function app_private.ops_check_adjustment_order() set search_path='';
revoke all on function app_private.ops_check_financial_graph(),app_private.ops_check_adjustment_order() from public,anon,authenticated;
