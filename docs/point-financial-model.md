# Modelo financiero de Mercado Pago Point

## Evidencia y efectos

`card_integrated` es un medio distinto de `card_external`. El cliente sólo envía identidades de checkout/terminal y operaciones UUID. PostgreSQL congela artículos, cantidades, impuestos, descuentos, total, zona y tarifa sobre el checkout operativo existente. El servidor verifica identidad, sesión viva, membresía, permiso y prueba de dispositivo antes de aceptarlo. Las RPC y tablas privadas nunca son accesibles al navegador.

El intento tiene identidad, payload y clave de idempotencia persistentes antes del HTTP. La reserva de terminal no vence por tiempo local. Un lease de trabajo vencido permite recuperar el trabajo; no permite liberar una operación bancaria incierta. Un reenvío conserva clave y payload y se restringe a 23 horas desde el primer envío, margen dentro de la ventana documentada de 24 horas. Fuera de ella se conserva revisión y se requiere evidencia del proveedor. No se usa una búsqueda por referencia que el proveedor no documente.

Orden y transacción deben concordar. La consulta autenticada verifica tipo Point, terminal, importe decimal exacto, referencia y receptor. El pago referenciado aporta MXN, importe, collector y `live_mode` cuando Orders omite esos campos. Sólo estados definitivos conocidos producen aprobación/rechazo; `action_required`, `failed/in_review` y detalles desconocidos conservan revisión. La palabra del operador no verifica un pago. Pago verificado y materialización de venta son estados separados: si falla la transacción local, el locator remoto permite recuperar mediante GET sin volver a crear el cargo.

La materialización usa exclusivamente el snapshot reservado y produce una venta, aplicación de cantidades pagadas, emisión de cocina y entrada de comisión una sola vez. Conciliar un pago iniciado no depende de que el cajero siga activo. El POS actual no consume existencias al vender; esta integración no inventa movimientos de inventario.

## Devoluciones

El servidor autoriza `sales.reverse`, bloquea el intento y reserva el saldo pendiente de devolución. Suma confirmaciones y reservas pendientes, incluidos resultados desconocidos. Cada solicitud tiene operación/clave propias; cada confirmación se deduplica por intento e ID remoto. Devoluciones externas se descubren mediante consultas autenticadas de Orders. Un evento antiguo de aprobación nunca reduce una devolución confirmada.

Las ventas permanecen inmutables. Cada devolución agrega pago devuelto y asiento inverso de comisión; reposición de mercancía es una operación independiente. Los snapshots operativos actuales contienen mercancía sin propina: se exige `tipCents=0` y asignación íntegra a mercancía. Cuando se introduzcan propinas, será necesario ampliar el snapshot y la asignación antes de habilitarlas. No se deduce una asignación sin evidencia.

## Comisión exacta y cierre

La tarifa inicial solicitada es **30 puntos base (0.30%)**, IVA configurable inicialmente 16%, versión `sasori-0.30-v1`. Cada checkout congela su tarifa y tratamiento fiscal. Base elegible: importe confirmado de mercancía por la integración en producción. Sandbox, tarjeta externa, intentos y errores no generan comisión. La base y tarifa originales se conservan incluso cuando posteriormente cambia la configuración.

Cada asiento guarda `exact_numerator = base_cents × rate_bps`; el denominador es 10,000. No se redondea por ticket. Mil pagos de $1 MXN preservan $1,000 de base y **$3 de comisión neta**, más $0.48 de IVA con 16%.

El cierre conserva la lista de asientos y numeradores, agrupa por IVA original y redondea una sola vez el neto acumulado. Distribuye los centavos entre grupos mediante restos mayores, con desempate por IVA, y resta los cierres anteriores. El IVA se calcula sobre el acumulado asignado de cada grupo, restando también el IVA ya cerrado. Así una devolución total tardía revierte neto e IVA completos, incluidos residuos de centavos. Un periodo cerrado no se reescribe: evidencia tardía se contabiliza en el siguiente periodo abierto, preservando su fecha efectiva y tarifa original.

Los cierres son **estados de cuenta, no CFDI**. Registrar evidencia de facturación no genera una factura fiscal ni confirma su validez. Abonos manuales incluyen importe positivo, fecha, referencia/evidencia y actor, requieren documento facturado y no pueden superar su saldo. Las métricas distinguen neto facturado, IVA y abonos con IVA; no llaman ingreso al impuesto. Créditos por devolución permanecen visibles; no se cobran como deuda positiva.

## Notificaciones y recuperación

La firma usa el manifiesto oficial `id:<query data.id en minúsculas>;request-id:<header>;ts:<timestamp>;`, HMAC SHA-256 y verificación constante con clave actual/anterior. El JSON no es evidencia financiera firmada. Se guarda únicamente locator autenticado, huella y tiempos antes del ACK, incluso si aún no existe el locator local. Duplicados incrementan un contador; un barrido vincula los eventos adelantados. No se rechazan reintentos oficiales sólo por antigüedad.

Los workers reclaman un trabajo por vez con `FOR UPDATE SKIP LOCKED`, lease exclusivo, token, presupuesto limitado, backoff y máximo de intentos. Confirman primero el locator remoto y después consultan evidencia. El barrido y los webhooks siguen activos con nuevos cargos deshabilitados. El interruptor impide el primer envío de trabajos nuevos; una recuperación ya enviada conserva su identidad dentro de la ventana segura. Agotamiento o pérdida de credenciales conserva reservas e incidencias para intervención.

Referencias oficiales consultadas: [Orders y cancelaciones](https://www.mercadopago.com.mx/developers/es/docs/mp-point/payment-processing), [idempotencia](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/create-order/post), [estados](https://www.mercadopago.com.mx/developers/es/docs/mp-point/resources/status-order-transaction), [OAuth con PKCE](https://www.mercadopago.com.mx/developers/en/docs/security/oauth/creation). Deben revalidarse en el piloto con la aplicación, cuenta y firmware autorizados.
