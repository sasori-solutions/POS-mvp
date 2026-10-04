# Revisión de Mercado Pago Point — 3 de octubre de 2026

Revisión de Codex sobre [PR #21 de siriuslatte](https://github.com/sasori-solutions/POS-mvp/pull/21), commit `0259682004f61d267ce9a046e6fd2ae88eaab129`. Base examinada: `main` en `6a91c0722377a773c79c440164feadf1a375299a`. Fecha local America/Chicago; parte de la ejecución corresponde al 4 de octubre UTC.

## Dictamen

**La PR remota examinada no está lista para fusionar tal como está.** Está en borrador, tiene conflictos con `main` y contenía defectos de recuperación y consistencia financiera. Las correcciones de esta revisión quedan en la rama local `fix/point-review`; no se hizo push, merge remoto, despliegue ni cobro real.

La integración local conserva el trabajo acumulado de interfaz e integridad financiera mediante el checkpoint `fc747ea2cd8d86db7f7569fb3cfaa5e53b3f1261`. El checkout de desarrollo original no se modificó. Se resolvieron los conflictos de Inicio, panel lateral, cobro, configuración, estilos y pruebas sin restablecer las antiguas confirmaciones de dinero.

## Defectos encontrados y corregidos

| Prioridad | Defecto reproducible | Corrección / evidencia |
| --- | --- | --- |
| P1 | Un reembolso incierto podía reenviarse tras caducar la idempotencia del proveedor. | Consulta previa, identificador remoto persistido y límite conservador de 23 horas para repetir el mismo POST. Pruebas del adaptador y SQL. |
| P1 | Recargar una devolución permitía emitir otra solicitud; un reembolso externo del mismo importe podía atribuirse a la solicitud propia. | Recuperación por UUID y localizador remoto, una solicitud pendiente por intento, sin inferir identidad a partir del importe. Pruebas de componentes, SQL e integración. |
| P1 | Un cargo encolado podía enviarse por primera vez después de desactivar Point o desconectar la cuenta. | La adquisición del trabajo exige activación y conexión vigentes para el primer envío; conserva la conciliación de envíos anteriores. |
| P1 | El barrido de pendientes consultaba la variable local `state=NULL` en lugar de la columna. | Columna cualificada. El fallo se reprodujo con Auth, Edge y PostgreSQL reales, sin webhook. |
| P1 | Una devolución con respuesta perdida intentaba escribir `state=NULL` sobre un pago materializado. | Conservación explícita del estado guardado al registrar el fallo. Regresión de recuperación de reembolso parcial. |
| P1 | Un proceso que moría en el último intento de trabajo dejaba un lease agotado que bloqueaba toda conciliación posterior. | Cierre del lease vencido, incidencia persistida y nueva conciliación; no libera la terminal ni inventa un resultado. |
| P1 | Cambiar la conexión OAuth permitía utilizar una terminal ocupada por un cargo anterior. | Exclusión por identidad de la terminal física, también al revincularla. |
| P1 | Los reportes ordinarios omitían devoluciones Point y el método integrado. | Neto, series, métodos y operadores incluyen esos importes. Productos e IVA declaran la falta de asignación en devoluciones por importe. |
| P1 | Se podía iniciar un cobro con un importe distinto al mostrado si otra pestaña modificaba la reserva antes de prepararlo. | Contraste de revisión, artículos e importes antes de iniciar; bloqueo de respuestas tardías tras cambio de selección, turno o sesión. |
| P1 | Faltaba contrastar propinas, pagos inferiores al importe y totales devueltos con la evidencia consultada. | Verificación del snapshot y evidencia bancaria antes de materializar. El exceso por financiación no se convierte en ingreso del comercio. |
| P1 | Reutilizar una reserva abortada chocaba con su inmutabilidad. | Nueva reserva para un nuevo cobro; los intentos y recibos anteriores permanecen intactos. |
| P2 | Cancelaciones perdidas, rechazos con referencia bancaria o una reserva nunca enviada podían quedar bloqueados. | Conciliación de cancelación, estados bancarios compatibles y liberación autorizada de reservas sin envío. |
| P2 | Un 401 antiguo podía revocar una reconexión más reciente; `invalid_grant` HTTP 400 se reintentaba como error genérico. | Comparación de versión de credenciales y reconexión explícita para credenciales inválidas. |
| P2 | El registro manual de abonos de comisión perdía el UUID al recargar. | Comando pendiente por negocio/actor, guardado antes del envío y coordinación entre pestañas, sin credenciales en almacenamiento. |
| P2 | Respuestas tardías de Point podían restaurar información de otra sesión o período. | Invalidación por sesión/permisos, controles de secuencia y validación del resultado antes de limpiar un reintento. |
| P2 | La configuración permitía redirigir credenciales `live` al simulador. | Override permitido exclusivamente en sandbox local explícito. |
| P2 | El empaquetado standalone eliminaba un alias necesario para las devoluciones. | Binding corregido y comprobación Deno de account, point, webhook y worker generados. |

## Contraste con Mercado Pago

- Orders API, terminal en modo PDV, importe decimal con dos posiciones, `X-Idempotency-Key`, referencias sin datos personales y separación de cancelación API/terminal: [procesamiento de pagos](https://www.mercadopago.com.mx/developers/es/docs/mp-point/payment-processing).
- La idempotencia de reembolsos tiene una ventana documentada; se conserva la misma identidad y se evita repetir un POST fuera del margen conservador: [API de reembolsos](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/refund-order/post).
- Webhooks: firma sobre los componentes documentados, persistencia antes del ACK y consulta autenticada para obtener evidencia. El cuerpo de una notificación no registra por sí mismo una venta: [notificaciones](https://www.mercadopago.com.mx/developers/es/docs/mp-point/notifications).
- `action_required/check_on_terminal` conserva revisión y requiere evidencia adicional; no se transforma en éxito por declaración del operador: [estados de orden y transacción](https://www.mercadopago.com.mx/developers/es/docs/mp-point/resources/status-order-transaction).
- OAuth y renovación: secretos en servidor, cifrado ligado al negocio/entorno, exclusión de renovación y manejo de credenciales inválidas: [OAuth](https://www.mercadopago.com.mx/developers/es/reference/authentication/oauth/_oauth_token/post).

Estos contrastes verifican decisiones de implementación frente a documentación oficial. El simulador HTTP es propio y no acredita por sí solo las respuestas de la API real, la certificación de Mercado Pago ni la compatibilidad de un modelo de terminal.

## Fuentes de producto

Se consultaron en Drive los documentos 02 y 04, las últimas entradas de 05 y las notas de Ademir del 2 de octubre sobre terminales existentes/Plus y conexión/recuperación. Se contrastaron con `docs/point-financial-model.md`, `docs/point-pilot-runbook.md`, las migraciones actuales y el flujo local acumulado. Las notas históricas y la descripción de la PR no se trataron como autorización para activar tarifas, credenciales productivas o cobros reales. No se modificó Drive.

## Verificación y reproducción

La validación utiliza Node 24, un checkout aislado y su propio PostgreSQL/Auth/Edge. Las pruebas crean y eliminan únicamente sus tenants sintéticos. El simulador conserva identidades entre arranques; no se reseteó ningún entorno compartido.

```sh
npm ci
npm run dev -- --port 5179 --point-simulator --point-manual-worker
# En otra terminal, mismo checkout:
npm run test:point:local
npm run test:integrity:integration
npx vitest run tests/unit tests/components --maxWorkers=2
npm run test:sql -- --maxWorkers=2
npm run test:provider
npm run build
npm run lint
npm run check:ledger
```

`--point-manual-worker` permite que las pruebas controlen exactamente cuándo se envían y recuperan los trabajos. Para revisar la aplicación interactivamente, reiniciar con `--point-simulator` sin ese modificador.

Resultados de la versión corregida:

| Comprobación | Resultado |
| --- | --- |
| Unidades y componentes | 382/382, 44 archivos |
| PostgreSQL PGlite, todas las migraciones combinadas | 126/126; 23 casos de Point incluidos |
| Adaptador y worker con HTTP local, Deno | 23/23 |
| Integración financiera Auth/Edge/PostgreSQL | 30/30 |
| Integración Point Auth/Edge/PostgreSQL + simulador HTTP | 8/8, sin omisiones |
| Build, TypeScript y lint | Aprobados; Vite advierte un chunk de unos 508 kB |
| Deno check de entradas Point y cuatro artefactos standalone | Aprobado |
| Diagnóstico financiero local | Nueve contadores de inconsistencias en cero |
| Conflictos y whitespace | Sin entradas sin resolver ni errores en el diff |

Las migraciones nuevas `20261004005000` a `20261004005500` se aplicaron al stack aislado `pos-dev-2a96a85402`, sin editar migraciones ya aplicadas ni borrar datos. Los fallos de barrido y devolución perdida se reprodujeron antes de corregirlos y las pruebas correspondientes pasaron después. No se ejecutaron pruebas en navegador ni se realizó revisión visual. No se utilizaron credenciales de Mercado Pago, API live, terminal virtual de Mercado Pago ni hardware físico.

## Antes de fusionar y habilitar cobros reales

1. Incorporar las correcciones locales y el trabajo acumulado, actualizar la rama remota y obtener revisión humana. La PR remota conserva su estado original mientras no se suban estos commits.
2. Aplicar todas las migraciones compatibles, incluidas las protecciones financieras y las nuevas migraciones de revisión, antes de publicar las funciones y el frontend. No editar migraciones aplicadas. Las funciones y el frontend nuevos necesitan los campos de recuperación nuevos.
3. Ejecutar CI sobre el commit resultante. La PR cambia también el workflow para exigir Full checks; las pruebas de navegador de ese workflow quedan pendientes de ejecución, no se atribuyen a esta revisión local.
4. Configurar credenciales autorizadas, URL de retorno, firma webhook y scheduler según el runbook; comprobar que la conciliación continúa sin una pestaña abierta. Mantener los nuevos cobros apagados durante esa preparación.
5. Probar el modelo/firmware de terminal real autorizado: aceptación, rechazo, cancelación desde API/terminal, desconexión, respuesta perdida y devolución. Verificar POS, comprobante de Mercado Pago y terminal para el mismo intento.
6. Confirmar la aceptación comercial de la comisión implementada. El ledger de comisión no prueba una obligación comercial aceptada ni una liquidación bancaria.

La revisión reduce fallos concretos y aporta evidencia reproducible. No constituye una garantía absoluta de ausencia de errores ni una validación de hardware no ensayado.
