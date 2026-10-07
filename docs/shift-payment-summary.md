# Cobros por método del turno

Implementación local · 6 de octubre de 2026 · Solicitud humana del núcleo previo al primer cliente.

Caja muestra cobrado, devuelto y neto registrado para efectivo, tarjeta externa, Mercado Pago Point y transferencia al consultar un turno abierto o cerrado. Los métodos históricos aparecen aunque ya no estén habilitados en configuración. El fondo inicial, las entradas y los retiros conservan su sección; no se consideran ventas.

El turno se identifica por su UUID y negocio, nunca por fecha. `sales` no tiene `shift_id`: cada recibo se atribuye mediante su relación con un `checkout_attempts` de pago completado que guarda el turno. El resumen suma una sola vez el importe del recibo, no el importe de intentos preparados, fallidos o repetidos. Los recibos antiguos sin esa relación permanecen en los reportes de ventas y no se atribuyen artificialmente a un turno.

Las devoluciones manuales se suman desde `sale_reversals.shift_id`, que corresponde al turno donde se confirmó la devolución, aunque el cobro original pertenezca a otro. Un método o turno con sólo devoluciones puede tener neto negativo. El cierre anterior y el recibo original permanecen intactos.

Los cobros Point materializados también tienen una reserva completada y se incluyen. `point_refunds` no guarda turno: no se inventa esa atribución ni se modifica el historial. La fila de Point muestra su cobrado y deja devuelto/neto como «—», con referencia a Pagos integrados. El total se llama **Neto registrado** y señala expresamente que no descuenta devoluciones de Point sin atribución. El contrato `pointRefundsNotAttributed: true` conserva esta limitación; ese número no representa una liquidación bancaria ni un neto completo del proveedor.

La migración aditiva `20261006213000_shift_payment_summary.sql` añade `paymentSummary` a la proyección privada del turno. Usa aritmética PostgreSQL exacta; el cliente verifica los cuatro métodos, enteros seguros, sumas y diferencias con BigInt. El formato de los agregados también conserva el último centavo sin división monetaria binaria. No hay cambios de dinero, recibos ni reglas de conteo.

`paymentSummary` es opcional para conservar respuestas aceptadas antes de la migración. Un reintento devuelve su JSON original; el turno abierto utiliza una lectura fresca de `operations`, incluso cuando su revisión no cambia tras un cobro. Durante `closing` el servidor omite el resumen y la interfaz lo oculta. Sin `cash.read`, `operations` conserva el indicador de turno con importes enmascarados y sin resumen; la lectura de historial sigue exigiendo el permiso. Las funciones permanecen privadas, con search path vacío y sin ejecución del navegador.

## Verificación

`tests/sql/shift-payment-summary.test.ts` aplica las migraciones reales en PostgreSQL embebido: upgrade/replay original, cobros de los cuatro medios, confirmación Point repetida, reintegro Point sin atribución, recibos históricos sin vínculo, independencia de fechas, turnos del mismo día, devolución en el siguiente turno, tenant/permisos, cierre ciego y agregados superiores al límite de una sola cuenta. Las pruebas de contrato y Caja verifican conservación, formato exacto, compatibilidad, actualización sin cambio de revisión y visibilidad antes/después del conteo.

El caso **summarizes persisted payments and next-shift refunds through signed HTTP** de `tests/integration/lean-operations.integration.test.ts` está preparado para el stack loopback existente. Usa Auth real, llamadas firmadas a Edge y PostgreSQL, descarta una respuesta aceptada, reintenta el mismo UUID y comprueba dos turnos, permisos y aislamiento. Debe ejecutarse después de aplicar la migración compatible en ese stack; una prueba omitida no acredita integración. No necesita reset ni un proveedor físico.

En esta rama pasaron los cuatro casos SQL nuevos, los cuatro de contrato/formato y los cuatro de Caja. También pasaron los 62 casos existentes de operaciones/integridad/ajustes financieros, los 11 componentes existentes de pulido operativo, la suite smoke final de 388 casos, lint focalizado y build final con TypeScript y guard de artefactos de producción. Dos errores iniciales de fixtures nuevos (confirmación de aborto y tipos del parámetro de un recibo histórico) se corrigieron y la suite SQL final pasó. La integración real y la revisión visual en dev quedan pendientes de la integración de ramas; no se arrancó ni se modificó Docker desde este checkout.

Estas pruebas locales no acreditan publicación cloud, Google alojado, hardware ni liquidación de pagos. La publicación conserva el procedimiento de [DEPLOYMENT](../DEPLOYMENT.md).
