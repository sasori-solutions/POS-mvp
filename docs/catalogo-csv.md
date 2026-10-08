# Catálogo: CSV y edición masiva

Desde **Productos → Gestionar catálogo**, el dueño o una persona con `catalog.manage` puede exportar, importar o editar varios productos. Antes de guardar siempre se muestran los cambios. Cambiar el catálogo conserva las ventas registradas y sus precios históricos.

Para actualizar productos existentes, exporta primero el catálogo y conserva **id** y **version**. Si otro dispositivo modificó un producto, exporta nuevamente antes de editarlo. Un registro sin ID crea otro producto, aunque tenga el mismo nombre.

Un archivo nuevo admite las columnas `nombre,precio_mxn`; las columnas opcionales son `formato,id,version,categoria,activo,iva,descripcion,sku,codigo_barras,detalles_json`. Usa UTF-8 y separador coma. El precio se expresa en pesos MXN con hasta dos decimales, sin símbolos monetarios ni separadores de miles. Los decimales con coma deben estar entre comillas. `activo` admite `si` o `no`. `iva` admite `vat_16`, `vat_0`, `exempt`, `border_8` o `unconfigured`; para un producto nuevo sin IVA se usa la elección inicial del negocio.

La exportación añade `formato=pos_mexico_v1` y protege los textos que una hoja de cálculo podría interpretar como fórmulas. Conserva esa columna: al importar, el POS retira únicamente la protección que añadió, sin eliminar apóstrofos originales. SKU y códigos de barras son texto; configura esas columnas como texto al abrir el archivo en una hoja de cálculo para conservar ceros iniciales.

`detalles_json` conserva el resto de la ficha: tamaños, extras, precios negativos, disponibilidad, vínculos con grupos compartidos y demás opciones. Las columnas descripción, SKU y código de barras permiten editar esos campos sin modificar el JSON. Un grupo compartido debe existir con sus opciones vigentes en el mismo negocio. Las fotos se conservan mediante referencias del mismo negocio; el CSV no transporta imágenes a otro negocio. El servidor rechaza referencias inválidas o datos modificados concurrentemente.

El límite de archivo es **500 productos y 512 KB**. Cada solicitud contiene como máximo 20 productos y 7.000 bytes de catálogo, dejando espacio para la autorización dentro del límite HTTP de 8 KiB. Cada lote se acepta completo o se rechaza completo. Un archivo puede tener varios lotes; la pantalla muestra cuántos se guardaron y cuáles están pendientes. Los lotes ya aceptados se conservan si falla uno posterior.

La solicitud original se guarda en el navegador por negocio y empleado, sin PIN ni credenciales. Si se pierde una respuesta, **reintenta desde la misma pantalla y navegador**: se usa el mismo UUID y payload para recuperar el resultado sin repetir efectos. Un lote de resultado desconocido no se puede descartar ni sustituir hasta confirmar su solicitud original. Una recuperación ilegible bloquea nuevas ediciones en ese navegador para evitar sobrescribirla.

Evidencia del 7 de octubre de 2026: revisión independiente de `/root/catalog_contract_audit` y reproducción de `/root/business_setup_devices` detectaron que una respuesta tardía de una sesión anterior podía sobrescribir el progreso de otra edición del mismo actor. Las escrituras de progreso, rechazos y borrado ahora requieren sesión vigente y coincidencia con el plan original almacenado. Tras cambiar de sesión se conserva la solicitud incierta hasta que el actor autorizado la reintenta; su resultado tardío no pisa una nueva edición. Las regresiones cubren aceptación y rechazo tardíos y preservan el UUID/payload nuevo.

La edición masiva admite categoría, estado activo, IVA y precio base. Los tamaños conservan sus precios propios. Todas las filas usan la versión del catálogo revisado y las mismas garantías de autorización, aislamiento e idempotencia que la importación.
