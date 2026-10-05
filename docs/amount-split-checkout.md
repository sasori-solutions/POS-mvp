# Dividir por cantidad

Implementación local solicitada por Larios el 4 de octubre de 2026. Se añade a Cobrar todo y Dividir cuenta. Se consultaron Drive 02/04, las últimas entradas pertinentes de 05 y el contrato actual de operaciones; la solicitud humana vigente define este alcance.

## Uso

En Cobrar, seleccionar **Dividir por cantidad**. Introducir los importes de las primeras personas; la última recibe el restante automáticamente. Añadir o quitar filas permite cambiar el número de personas, hasta veinte. Para $760.68, introducir $500 y $40 deja $220.68 para la última persona.

Cada importe debe ser positivo, tener como máximo dos decimales y la suma debe coincidir exactamente con el saldo pendiente. El botón de pago permanece desactivado hasta que la reserva del servidor coincide con la selección. Cada persona usa el flujo existente de efectivo, Tarjeta mediante terminal vinculada o transferencia. Los registros antiguos de tarjeta externa conservan su historial. El siguiente importe aparece solamente tras un pago confirmado. Una reserva, envío a terminal, rechazo, cancelación o resultado incierto no descuenta saldo.

Se pueden modificar las partes pendientes y su método. Los pagos aceptados se conservan. Después del primer pago por cantidad, Dividir cuenta por artículos queda desactivado para esa cuenta; Cobrar todo permite saldar el resto por importe. El descuento continúa disponible antes del primer pago, con las mismas reglas de congelación existentes.

## Contrato e integridad

`prepare_checkout` y `update_checkout` admiten `items: []` junto a `amountsCents: number[]`. HTTP y SQL validan las claves exactas, enteros positivos, límites y suma. El primer importe reserva el siguiente cobro; las partes restantes se conservan en el intento. La respuesta de la orden conserva el plan pendiente y las asignaciones financieras pagadas por línea. `record_checkout` y la materialización verificada de Point siguen siendo los recorridos de cobro.

Todos los importes son centavos enteros. El cliente usa BigInt para la vista previa; PostgreSQL usa numeric para repartir los centavos de descuento e IVA incluidos. El servidor asigna dinero a las líneas históricas en orden estable de UUID, sin que el cliente seleccione productos. Cada asignación conserva bruto, descuento, importe cobrado e IVA; la última asignación de una línea absorbe su restante exacto.

Una línea parcialmente saldada registra dinero y cero unidades nuevas. Sus unidades se contabilizan una sola vez cuando termina de saldarse esa línea. Los recibos muestran «Parte de cuenta»; el catálogo, sus precios y sus unidades originales no cambian. Las comandas siguen el recorrido existente de unidades saldadas, sin duplicar preparaciones enviadas previamente. Los reportes de importes incorporan cada pago confirmado y mantienen bruto menos descuentos igual a cobrado. Las cancelaciones, condonaciones y devoluciones conservan los pagos anteriores y sólo afectan su importe correspondiente.

La migración nueva integrada es `20261005014000_amount_split_checkout.sql`, adaptada después de las preferencias, métricas propias y tipo canónico de orden. La fuente `20261004120000_amount_split_checkout.sql` del worktree anterior se conserva sin cambios. La adaptación mantiene `orderKind` y los recibos aceptados anteriores; los reportes del negocio y de cada empleado calculan el bruto desde los importes históricos realmente asignados, incluso cuando una parte aún no salda unidades completas.

Conserva las comprobaciones de actor, negocio, sesión, permisos, turno abierto, revisión, exclusión de cobros concurrentes, UUID y huella del payload. Los snapshots confirmados permanecen inmutables. Una respuesta perdida reintenta la misma operación; una operación aceptada no produce una segunda venta.

## Verificación local

La adaptación integrada pasó **97/97 casos PostgreSQL** en `amount-checkout`, `point-payments`, `financial-integrity`, `financial-adjustments`, `employee-metrics` y `order-kind`. Incluye reintentos exactos de reservas pendientes y recibos aceptados antes de la migración, importes descontados sólo al confirmar, rollback inyectado, permisos privados, métricas de empleado y materialización de Point. TypeScript, lint y revisión de espacios del diff también pasaron.

La integración posterior del cliente pasó **727 pruebas unitarias y de componentes** (347 + 380), **233 pruebas SQL** de la suite actual y **38 integraciones financieras/operativas por Auth/Edge/PostgreSQL reales**, sin omisiones. Incluye la cuenta de $760.68 en tres cobros, doble envío concurrente, respuesta perdida del segundo pago, recibos exactos, conservación de `orderKind` y regreso a Venta con el saldo e IVA pendientes. Build, lint, comprobación de Edge con Deno y revisión del diff aprobados. El servidor 5181 entrega el selector integrado.

También pasaron **16 integraciones Point por HTTP real con el proveedor sintético local** y **24 pruebas del adaptador Deno**. El caso nuevo envía $500, $40 y $220.68 como tres cobros de la misma cuenta; no descuenta mientras espera al proveedor, confirma cada parte una sola vez y devuelve la primera sin reabrir el saldo original. La suite usa una cuenta y terminal ficticias propias para evitar apropiarse de la conexión Mercado Pago del negocio de desarrollo. Las tres pruebas de aislamiento incluidas en la suite unitaria comprueban separación de controles, identidad, terminales, estados y persistencia tras reiniciar.

Durante esta verificación se detectó que el barrido global normal del worker también consulta cobros históricos del negocio de desarrollo y renueva sus tokens cuando corresponde. Se conservaron sus usuarios, negocio, conexión, órdenes y claves; no se afirma que su registro de llamadas o versión de refresh hayan permanecido idénticos. No se añadieron filtros de prueba ni bypass al backend.

La revisión visual queda a cargo de Larios. PGlite verifica las funciones y transacciones SQL en una sesión; las pruebas HTTP verifican conexiones PostgreSQL independientes y actores reales en el backend loopback. Estas verificaciones no acreditan una terminal física ni el simulador oficial de Mercado Pago.

La migración integrada ya fue aplicada al backend loopback de este checkout, conservando sus datos. Los arranques posteriores de `npm run dev` conservan ese historial. No requiere un reset ni credenciales de producción. La publicación de backend y frontend no forma parte de este encargo local.

## Entrega posterior

La solicitud posterior de Larios autorizó publicar el trabajo acumulado junto a las transiciones de cobro. La migración 050140 ya está aplicada y verificada en el proyecto alojado, junto a las preferencias y el tipo de cuenta que requiere. Véanse [la evidencia del backend](backend-release-2026-10-04.md) y [el alcance de esa entrega](checkout-method-transitions-2026-10-04.md). La evidencia local anterior conserva su fecha y sus límites.
