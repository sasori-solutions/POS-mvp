-- Preserve complete-tenant deletion regardless of the FK cascade order.
-- Removing a product also removes its public-menu link; no receipt is rewritten.
alter table app_private.public_menu_products
 drop constraint public_menu_products_business_id_product_id_fkey,
 add constraint public_menu_products_business_id_product_id_fkey
  foreign key(business_id,product_id) references app_private.products(business_id,id) on delete cascade;
