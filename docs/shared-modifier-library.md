# Biblioteca de extras compartidos

Contrato implementado el 7 de octubre de 2026 sobre `ded0f20`. Las instrucciones humanas del piloto y el catálogo actual son la fuente de esta ampliación; los documentos de producto se consultaron en la tarea principal. Este documento recoge biblioteca, reglas anidadas y combos fijos; no acredita por sí solo todas las fases del piloto.

En **Productos → Biblioteca de extras** se crean y editan grupos. Antes de guardar se muestran los productos afectados. El editor de producto permite **enlazar** un grupo existente, **desenlazarlo** o **convertirlo en copia independiente**. Copiar extras de otro producto continúa creando identidades nuevas sin enlazar la biblioteca. Los cambios de un grupo compartido actualizan sus productos enlazados en una sola transacción e incrementan sus versiones; no reescriben cuentas, comandas ni ventas anteriores.

Cada opción puede marcarse **No disponible** y admitir de 1 a 24 unidades por producto. Los mínimos y máximos del grupo cuentan unidades: dos shots son dos selecciones. Hay hasta 12 opciones por grupo, 6 grupos por producto y 24 selecciones totales. Si un grupo obligatorio no tiene suficientes unidades disponibles, el producto queda bloqueado con una razón visible. Otros productos y opciones disponibles se pueden seguir vendiendo.

El precio de una opción puede sumar o restar centavos enteros. El selector evita confirmar si el precio final queda por debajo de cero o supera 99,999,999 centavos. El servidor comprueba los mismos límites antes de aceptar una elección nueva. Los descuentos, el IVA y los cobros parciales siguen usando los importes finales y snapshots existentes, con los redondeos financieros centralizados.

## Contratos y persistencia

- `modifier_groups` requiere `catalog.read`; devuelve grupos versionados y los productos enlazados.
- `save_modifier_group` requiere `catalog.manage`; incluye UUID de operación, ID de grupo, versión esperada, nombre, mínimos, máximos y opciones completas.
- `set_modifier_option_sold_out` requiere `catalog.availability`; incluye producto/version, opción y disponibilidad. Si el grupo está compartido, el cambio se propaga al grupo y a sus productos.
- `ModifierSet.libraryId?` identifica el grupo canónico y coincide con `id`; sus opciones se conservan inline para clientes anteriores. El servidor rechaza una referencia ajena o una copia que ya no coincide con la biblioteca actual.
- `Modifier.soldOut?` y `maxQuantity?` son opcionales; sus valores anteriores equivalen a disponible y una unidad. `priceCents` admite ajustes con signo. `ItemSelection.modifierIds` conserva su shape y repite un ID por cada unidad elegida; se ordena al validar HTTP/recuperación.

La migración `20261007120000_shared_modifier_library.sql` crea tablas privadas con RLS y claves compuestas por negocio. Conserva los dispatchers financieros/Point/caja anteriores detrás de un wrapper de catálogo. Usa un lock por negocio para ordenar las escrituras de biblioteca y producto, junto con locks por UUID de operación. La autorización del actor actual precede a un replay; un replay aceptado devuelve el resultado original antes de consultar el catálogo cambiado.

La migración `20261007130000_modifier_selection.sql` sustituye exclusivamente `product_selection` y retira una prohibición de IDs repetidos en `ops_validate_before_amount`. El patch exige una única coincidencia exacta con el validador anterior y falla si cambia ese predecesor. Mantiene validación de UUID/shape y el límite de 24. Las migraciones posteriores deben delegar al `pos_command` vigente y conservar esta cadena.

## Extras dependientes

`ModifierSet.parentOptionId?` enlaza el grupo con una opción del mismo producto. El editor permite elegirla en **Mostrar cuando**. Hay hasta tres niveles, sin ciclos ni referencias inexistentes. Los grupos hijos sólo aparecen y exigen sus mínimos al elegir su opción principal. Cambiar la opción principal elimina las selecciones que quedan ocultas; el servidor rechaza payloads que intenten conservarlas. Una opción principal queda no disponible si alguna rama obligatoria no se puede completar, mientras las otras opciones siguen disponibles.

La definición compartida conserva su identidad canónica y el enlace de dependencia pertenece al producto. Cambiar la biblioteca conserva ese enlace. Quitar una opción que otro grupo referencia hace fallar la edición completa, sin propagación parcial. Copiar extras genera también enlaces nuevos entre las opciones copiadas. Los mínimos cuentan unidades por producto; seleccionar dos unidades de una opción principal activa una sola configuración de su rama hija.

La migración `20261007170000_nested_modifiers.sql` valida jerarquía y disponibilidad recursiva, mantiene el validador anterior de metadatos y extiende únicamente la selección de extras. El helper privado `modifier_option_available` permite reutilizar el mismo criterio sin reconstruir una selección automática.

## Combos fijos

En **Precio e IVA → Configurar como combo** se eligen hasta ocho preparaciones diferentes, cada una con 1–24 unidades. Los componentes pueden incluir variantes, precio abierto o extras cuando se especifica una selección válida; sus precios no se suman ni alteran el precio explícito del combo. El producto combo necesita precio fijo y no admite variantes propias ni otros combos como componentes. No se infieren costos, margen, disponibilidad de inventario ni cantidades fraccionarias.

`ProductDetails.comboComponents?` guarda `{productId,version,quantity,selection?}`. Una preparación nueva verifica producto del mismo negocio, versión y opciones disponibles. Su snapshot contiene nombre para cliente, nombre para cocina, selección legible y cantidad. Editar la categoría u otro dato del combo sin cambiar componentes conserva esa preparación. Cambiarla requiere elegir componentes vigentes. La disponibilidad actual de un componente puede bloquear una venta nueva, pero no altera la cuenta aceptada ni su recuperación.

La migración `20261007180000_catalog_combos.sql` guarda snapshots en producto, línea de cuenta y línea de venta. DTOs y lotes de cocina incorporan `comboComponents?` de forma aditiva. Los cobros por cantidad/importe y Point copian la preparación de la cotización aceptada; las cancelaciones copian la línea original. No reconstruyen la receta a partir del catálogo posterior. Los patches financieros requieren una única coincidencia exacta y mantienen los importes, permisos, locks y replay anteriores. Las funciones nuevas son privadas, con search path vacío y sin ejecución para navegador.

## Evidencia local

La suite focal de seis archivos pasó 36 casos de validadores/helpers, copia, recuperación, editor/selector y SQL. La comprobación adicional de compatibilidad pasó 70 casos en catálogo Square, operaciones, POS y disponibilidad. Estos conteos se solapan y no se suman. Lint de los archivos de esta ampliación pasó.

SQL verifica propagación a dos productos y copia independiente, replay tras edición, permiso/tenant/revocación, grants privados, rollback de una edición que supera mínimos acumulados, dos shots con ajuste negativo y conservación de snapshots al bloquear una opción, descuento e IVA exactos al dividir el cobro. PGlite usa una sesión embebida y no acredita concurrencia entre conexiones ni Auth/Edge real.

Las suites focales adicionales de reglas anidadas y combos pasaron ocho casos SQL y cinco de interfaz. Verifican rechazo de ciclos y referencias inválidas, rollback al quitar una opción referenciada, cambio de rama sin extras ocultos, componentes después de edición de catálogo, cobro dividido con descuento e IVA, KDS automático y cancelación con acuse, venta directa y materialización Point con evidencia repetida. No prueban dispositivo Point físico ni comunicación real con el proveedor.

`tests/integration/shared-modifier-library.integration.test.ts` contiene cuatro casos con Auth/Edge/PostgreSQL loopback y fixtures sintéticos: propagación concurrente/replay/aislamiento; cobro con extras repetidos después de cambiar disponibilidad; combo con extras dependientes, recuperación concurrente y cocina automática; y promoción por categoría con snapshot y recuperación. Los cuatro pasaron el 7 de octubre a las 10:42 CDT (15:42 UTC) contra API `40601` y `supabase_db_pos-dev-fe2a8635e6`; la limpieza comprobó cero negocios de fixture restantes y ninguna eliminación Auth fallida. El wrapper mantuvo claves sólo en memoria, verificó el proyecto/puerto exactos y no imprimió credenciales. Auth por contraseña sintética local y prueba de firma no acreditan OAuth Google real ni hardware físico.

Requiere las variables `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_LOCAL_DB_CONTAINER`; sin ellas se omite. La tarea principal aplicó las migraciones locales sin resetear el stack persistente. No se modificaron datos cloud ni se publicó desde esta subtarea.
