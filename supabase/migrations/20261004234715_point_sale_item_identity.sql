-- An order line can be collected in several receipts. Each immutable receipt
-- needs its own sale-item identity; checkout snapshots retain the order-line ID
-- for reservation and quantity updates. Match ordinary checkout's UUID default.
-- Patch the deployed body so the later authorization/reservation guards survive.
do $$
declare definition text;
 columns_before text := 'business_id,sale_id,line_id,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps,discount_cents';
 values_before text := 'select a.business_id,s.id,(x->>''lineId'')::uuid,(x->>''productId'')::uuid';
begin
 definition := pg_get_functiondef('app_private.point_materialize(app_private.point_attempts)'::regprocedure);
 if length(definition)-length(replace(definition,columns_before,''))<>length(columns_before)
  or length(definition)-length(replace(definition,values_before,''))<>length(values_before) then
  raise exception 'Point sale-item identity source changed; review the migration before applying';
 end if;
 definition := replace(definition,columns_before,'business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents,selection_label,tax_cents,tax_treatment,tax_bps,discount_cents');
 definition := replace(definition,values_before,'select a.business_id,s.id,(x->>''productId'')::uuid');
 execute definition;
end $$;
