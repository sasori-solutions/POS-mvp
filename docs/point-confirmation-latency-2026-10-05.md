# Confirmación Point sin esperar al scheduler

Fecha: 5 de octubre de 2026. Autor: agente Codex en el chat de Larios. Alcance humano: corregir la demora de confirmación y publicar directamente; esa autorización corresponde a esta entrega y no cambia el procedimiento general de publicación.

## Diagnóstico

El simulador HTTP local aprobaba inmediatamente y ejecutaba el worker cada tres segundos. En cloud, crear la orden y conciliar su resultado dependían del scheduler de quince segundos. La simulación oficial sólo aceptaba el evento; después había que esperar otro ciclo. El webhook persistía el aviso sin despertar al conciliador. La PWA mantenía consultas rápidas durante dos minutos desde la apertura, pero no reiniciaba esa ventana tras enviar o simular.

La inspección alojada previa encontró el scheduler activo y ningún trabajo fallido. No había eventos firmados procesados que acreditaran el webhook oficial. Un único HTTP 503 con User-Agent `node` coincide con una comprobación técnica; no demuestra un fallo de entrega de Mercado Pago.

## Cambio

- Migración nueva `20261005144214_point_confirmation_fast_path.sql`, después de las 59 anteriores, sin modificar ventas ni snapshots. Se creó con CLI y se alineó su nombre con la versión asignada por el backend al aplicar el mismo SQL.
- SQL devuelve una indicación privada sólo después de autorizar al actor personal o al dispositivo. Edge la elimina de la respuesta del navegador.
- `EdgeRuntime.waitUntil` procesa únicamente ese negocio e intento mediante la cola existente. Un webhook firmado despierta sólo el intento identificado por el servidor después de guardar el aviso.
- Un lock por intento y leases impiden que dos trabajos distintos cobren simultáneamente. Se conservan UUID, huella, replay, backoff, permisos y las comprobaciones del proveedor.
- Las lecturas activas pueden encolar conciliación cada tres segundos. El scheduler permanece como recuperación durable.
- La PWA lee inmediatamente tras enviar o simular y al recuperar visibilidad, foco o conexión. Las respuestas tardías no reviven una sesión cerrada y no se solapan solicitudes.

Aceptar una simulación nunca confirma el pago. Orders/Payments deben acreditar receptor, entorno, identidad, moneda, importe y estado antes de materializar el snapshot y cambiar el saldo. No se añaden atajos para terminales reales ni para pagos parciales.

## Comprobaciones de la candidatura

- Smoke final: 384/384; build de producción y guard de credenciales locales aprobados.
- Componentes: 403/403, incluidos pagos divididos, visibilidad, cambios de sesión, recuperación y reactivación de consultas rápidas.
- PostgreSQL Point y división por importe: 61/61; proveedor HTTP Deno: 24/24.
- Point y SQL seleccionados: 234/234; background/webhook/configuración: 32/32. Las regresiones de dispositivos compartidos preservan el tenant autorizado en servidor y la redacción de metadata.
- Los checks de despliegue y la integración de conexiones concurrentes se registran para el commit exacto en GitHub Actions. Estas cifras locales no acreditan por sí solas publicación.

Las pruebas usan datos sintéticos. La integración local con conexiones independientes quedó omitida porque Docker estaba pausado manualmente; no se reinició el motor ni se modificaron los datos persistentes. Esa prueba se ejecuta en el stack loopback desechable de CI antes de publicar. El modo de worker manual conserva pruebas deterministas de respuesta perdida; la prueba específica ejecuta el conciliador acotado con conexiones independientes.

## Backend alojado previo al frontend

Se aplicó la migración 60 en `sdisalomdxgejyhpxtri` y se publicaron `account` v22, `point-worker` v6 y `point-webhook` v6. El source descargado de cada función coincide exactamente con su artefacto standalone comprobado con Deno. Las tres funciones SQL afectadas coinciden con la cadena local de migraciones, conservan search path vacío y no conceden ejecución al navegador. Los nueve diagnósticos financieros devuelven cero incidencias. No se cambiaron credenciales, cron ni datos financieros.

La comparación anterior al cambio verificó que las funciones alojadas correspondían a la cadena de 59 migraciones. El frontend anterior sigue siendo compatible: los metadatos nuevos son privados y la cola periódica mantiene su contrato.

## Límites y operación

La corrección elimina esperas de nuestra cola; no reduce la demora de Mercado Pago. Su [sandbox oficial](https://www.mercadopago.com.mx/developers/es/docs/mp-point/integration-test) contempla hasta diez segundos y cuarenta para `action_required`. Esos tiempos no son un SLA de terminal real.

La entrega real del webhook requiere **Order (Mercado Pago)**, URL HTTPS del runbook y firma de la aplicación de pruebas en `MP_WEBHOOK_TEST_SECRET` (principal en `MP_WEBHOOK_SECRET`). No se deduce esa firma del Access Token. A la fecha de preparar esta candidatura, esa configuración y una entrega firmada real siguen sin acreditarse. Las consultas activas y el scheduler funcionan como recuperación independiente del webhook.

La integración con hardware físico, su firmware, conectividad y liquidación bancaria requieren el piloto separado del [runbook](point-pilot-runbook.md). Fuentes técnicas: [background tasks de Supabase](https://supabase.com/docs/guides/functions/background-tasks), [notificaciones Point](https://www.mercadopago.com.mx/developers/es/docs/mp-point/notifications).
