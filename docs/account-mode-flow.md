# Modalidad de cuentas en Venta

Solicitud humana de Larios, 5 de octubre de 2026: la modalidad guardada del negocio debe cambiar el recorrido de la PWA, además de permitir configurar esa diferencia.

En **Configuración → Cómo cobras**, el dueño elige **Cobro directo** o **Cuentas abiertas** y guarda los cambios. Se conserva la preferencia existente `profile.accountsEnabled`; cambiar el tipo de negocio desde Configuración no reemplaza esa elección.

| Modalidad | Recorrido desde Venta |
| --- | --- |
| Cobro directo | Añadir productos → Cobrar → registrar el pago. El servidor genera la comanda con el pago aceptado. |
| Cuentas abiertas | Añadir productos y nombre → Abrir cuenta → enviar a cocina, editar y enviar nuevos artículos → Cobrar al final. Guardar o enviar no registra ingresos. |

Las cuentas persisten en el servidor y se retoman en **Comandas → Cuentas**. Cada envío crea una preparación inmutable sólo con las cantidades nuevas; cobrar no duplica lo ya enviado. Abrir y enviar cuentas requiere la operación activada, conexión y permisos para administrar cuentas; cobrar exige permiso de venta y un turno abierto. Un empleado autorizado para tomar órdenes puede usar Venta sin recibir permiso para cobrar.

Desactivar cuentas impide nuevas altas de servicio, pero permite resolver las existentes. Una venta directa ya guardada conserva su modalidad aunque se cambie la configuración. Los reintentos conservan UUID, payload y tipo original; mientras una solicitud esté pendiente, el borrador permanece bloqueado. Una cuenta aceptada desde Venta libera ese borrador para la siguiente orden.

Se reutilizan los contratos y migraciones existentes; esta corrección no agrega esquema ni Edge Functions. Fuentes: código y migraciones de `origin/main` `d97fe6c`, [revisión del módulo](business-operations-review-2026-10-04.md), documentos 02/04 y últimas entradas de 05 del [Drive del equipo](https://drive.google.com/drive/folders/17SUbtEJYeKy_zc8M2ZKR_0QV_ZsNiCZ3), consultados en esta tarea sin modificarlos. Las notas de Drive llegan al 2 de octubre y no sustituyen la solicitud humana actual.

La evidencia de pruebas y los límites de verificación se registran en el PR. Implementación local y PR abierto no acreditan publicación; la entrega sigue [DEPLOYMENT](../DEPLOYMENT.md).
