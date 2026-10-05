# Point: alta, piloto y operación

La publicación requiere las migraciones financieras y Point completas del repositorio. Las credenciales, el ensayo físico y la activación comercial son etapas independientes. El simulador HTTP local sirve para verificar el software; no acredita una conexión al simulador oficial ni un cobro bancario productivo.

## Terminal virtual oficial de Mercado Pago

Este recorrido usa la API oficial y no requiere una terminal física. Es distinto de `npm run dev -- --point-simulator`, que ejecuta nuestro proveedor HTTP local.

1. Crea una aplicación Point de México en [Mercado Pago Developers](https://www.mercadopago.com.mx/developers/es/docs/mp-point/create-application) y activa sus credenciales de prueba. Conserva el Access Token únicamente en los secretos Edge de Supabase como `MP_TEST_ACCESS_TOKEN`; nunca en el navegador, Git, mensajes o variables `VITE_*`.
2. Configura `MP_ENVIRONMENT=sandbox`, `MP_REDIRECT_URI=https://pos-mexico-mvp.pages.dev/point/callback`, las claves de cifrado `MP_TOKEN_KEYS` / `MP_TOKEN_ACTIVE_KEY`, `POINT_WORKER_SECRET` y `MP_WEBHOOK_SECRET`. Para usar OAuth añade `MP_CLIENT_ID` y `MP_CLIENT_SECRET`; la conexión directa de pruebas usa el Access Token del servidor.
3. Publica las cuatro funciones y configura el scheduler descrito abajo. Habilita `POINT_CHARGES_ENABLED=true` sólo con las credenciales de prueba verificadas y el worker operativo. No configures `MP_API_BASE_URL` ni `MP_ALLOW_LOCAL_SIMULATOR` en cloud.
4. Crea un **negocio nuevo dedicado a pruebas**. En **Vincular una terminal → Pruebas**, pulsa **Vincular terminal virtual**. El servidor comprueba la identidad de prueba y vincula `NEWLAND_N950__SBX0000001`. El negocio queda marcado permanentemente como pruebas; no admite una conexión live posterior y no puede contener ventas reales anteriores al alta.
5. Activa el modo prueba. En **Configuración → Formas de pago**, marca **Mercado Pago** y guarda los cambios; activar la terminal no cambia los métodos del negocio. Después añade un producto de prueba, activa operaciones en Caja si es un negocio nuevo, abre un turno y crea una cuenta. En **Cobrar → Mercado Pago → Enviar a terminal**, espera a que exista la orden del proveedor. Selecciona un resultado en **Simulador de Mercado Pago** y pulsa **Simular resultado**.
6. El servidor envía el evento oficial a `/v1/orders/{id}/events`. La respuesta 204 sólo acepta la solicitud; la consulta posterior verifica identidad, importe, moneda y estado antes de registrar una venta. El simulador permite aprobación, rechazo, cancelación, expiración y revisión. Las pruebas aparecen únicamente en el negocio dedicado, no representan cobros reales ni liquidación bancaria.

Al enviar un cobro, consultar un intento activo, aceptar una simulación o persistir un webhook válido, Edge despierta en segundo plano el trabajo de ese intento. No espera al ciclo periódico ni bloquea la respuesta HTTP. Usa la misma cola, leases y validación financiera; no convierte una solicitud aceptada en un pago confirmado. Las consultas activas se limitan a una cada tres segundos y respetan el backoff existente.

El worker programado cada **15 segundos** sigue recuperando cobros pendientes cuya última consulta tiene más de diez segundos, incluso si se cierra la PWA, falla el trabajo inmediato o no llega un webhook. Respeta leases y backoff; no invoca Edge mientras no haya trabajo pendiente o auditoría vencida. La PWA consulta cada tres segundos durante los primeros dos minutos y después cada 15 segundos mientras esté visible y conectada. Después de enviar, simular, recuperar foco o conexión consulta inmediatamente y reinicia el intervalo rápido. No hay un límite de dos minutos que deje el cobro sin seguimiento. Si saliste del cobro, usa **Recuperar cobro → Consultar estado** para continuar con el mismo intento.

`POINT_IMMEDIATE_WORK_ENABLED=false` desactiva sólo el trabajo inmediato. El desarrollo interactivo con `--point-simulator` lo habilita; `--point-manual-worker` y la integración aislada de CI lo deshabilitan para comprobar explícitamente recuperación y reintentos. Cloud lo habilita por defecto. El runtime local usa `edge_runtime.policy="per_worker"` para permitir `EdgeRuntime.waitUntil`. [Cambio y comprobaciones](point-confirmation-latency-2026-10-05.md).

En la prueba oficial del 4 de octubre de 2026 se observaron estos resultados:

| Selección | Resultado comprobado por GET | Efecto en la cuenta |
| --- | --- | --- |
| Aprobar | `processed/accredited` | Registrar una venta, descontar el saldo una vez |
| Rechazar | `failed/insufficient_amount` | Ningún pago registrado |
| Cancelar | `canceled/cancel_by_terminal` | Ningún pago registrado |
| Expirar | `expired` | Ningún pago registrado |
| Revisión | `action_required/check_on_terminal` | Conservar la reserva y el saldo |

En la terminal virtual oficial se pudo resolver **Revisión** mediante una nueva simulación **Aprobar pago**. Cancelar desde ese estado devolvió HTTP 400; la UI y el servidor sólo ofrecen la aprobación admitida para resolver esa prueba. Se sigue esperando la consulta independiente y la materialización. Esto sólo se aplica al dispositivo virtual con credencial de prueba verificada; un `action_required` real requiere revisar físicamente la terminal. La aprobación tardó 44 segundos en esta observación; no se garantiza un tiempo de respuesta del proveedor. [Evidencia y límites](point-readiness-2026-10-04.md).

La terminal virtual exige un cobro de al menos **$5.00 MXN**. En una prueba directa contra la API oficial el 4 de octubre de 2026, Orders devolvió una orden `ORDTST…` aprobada con una referencia de pago sintética; consultar esa referencia en Payments devolvió 404. Para esta terminal, el conciliador usa la respuesta autorizada de Orders sólo con el token de prueba guardado en servidor, receptor de prueba verificado, entorno sandbox, terminal estándar, ID de prueba, país/moneda mexicanos e importes coincidentes. Una respuesta aceptada de simulación nunca confirma por sí sola el pago. Las conexiones OAuth y los cobros reales mantienen la consulta a Payments cuando la orden incluye una referencia; un 404 no se convierte en una aprobación.

Si faltan secretos, el acceso permanece visible pero deshabilitado. Un build aprobado no acredita una prueba oficial: conserva la evidencia de la orden y su resultado una vez configuradas las credenciales. El prefijo `APP_USR` por sí solo no distingue credenciales reales de prueba. La validación falla de forma segura si no puede verificar la identidad de prueba.

El receptor de prueba del servidor puede vincularse a varios negocios dedicados a pruebas. Cada uno conserva su conexión cifrada, permisos, cuentas e historial; reconectar uno no modifica los demás. La terminal compartida mantiene una sola operación pendiente a la vez. Las conexiones OAuth, tanto sandbox como live, conservan la restricción de un solo negocio por receptor. No retires ni sustituyas el token mientras tenga operaciones pendientes: la conexión cifrada debe coincidir con el secreto vigente para seguir conciliando. La activación requiere verificar la respuesta real de `/users/me`; actualmente se exige la etiqueta `test_user` y se rechaza cualquier identidad que no la acredite.

Fuentes: [terminal virtual](https://www.mercadopago.com.mx/developers/es/docs/mp-point/integration-test), [eventos de simulación](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/simulate-order/post).

## Configuración y publicación por etapas

1. Revisar el PR y el historial del proyecto destino. Aplicar las migraciones aditivas de Point después de todas las migraciones heredadas; conservar ventas, empleados y documentos cerrados. Publicar `account`, `point`, `point-webhook` y `point-worker` antes del frontend.
2. Configurar en secretos del backend `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `MP_ENVIRONMENT`, `MP_TOKEN_KEYS`, `MP_TOKEN_ACTIVE_KEY`, `MP_WEBHOOK_SECRET` y `POINT_WORKER_SECRET`. Registrar exactamente el mismo redirect HTTPS `/point/callback` en la aplicación del proveedor. `POINT_CHARGES_ENABLED=false` es el estado inicial. Ningún secreto pertenece a `VITE_*`.
3. `MP_TOKEN_KEYS` es un mapa de ID de clave a 32 bytes aleatorios en base64url; el ID activo se indica en `MP_TOKEN_ACTIVE_KEY`. Las claves se mantienen en secretos del backend, separados de los ciphertexts PostgreSQL. Para rotar, añadir una clave, cambiar el ID activo y conservar las anteriores hasta que se recifren o reconecten las conexiones que las necesitan. Respaldar claves y datos mediante los controles del proyecto; perder una clave impide recuperar sus pendientes.
4. Configurar la notificación de tipo **Order (Mercado Pago)** con `https://sdisalomdxgejyhpxtri.supabase.co/functions/v1/point-webhook`. Para pruebas, obtener usuario y contraseña en **Credenciales de prueba → Datos de las credenciales de prueba**, iniciar sesión en Developers con esa cuenta y configurar **Webhooks → Configurar notificaciones → Modo productivo**. Guardar la firma de la aplicación de pruebas como `MP_WEBHOOK_TEST_SECRET` y la de la aplicación principal como `MP_WEBHOOK_SECRET`; pueden coexistir. Esa pestaña no convierte las credenciales de prueba en productivas. `MP_WEBHOOK_PREVIOUS_SECRET` permite la rotación durante la ventana de reintentos. [Procedimiento oficial](https://www.mercadopago.com.mx/developers/es/docs/mp-point/notifications). Verificar firma, ACK después de persistencia y reintentos antes de habilitar un comercio. La firma sólo acepta el aviso: el worker vuelve a verificar todos los datos financieros mediante GET autenticado.
5. Guardar en Vault `sasori_point_worker_url` y `sasori_point_worker_secret`, que coincida con el secreto Edge. Ejecutar [install-point-scheduler.sql](../scripts/install-point-scheduler.sql). El job usa pg_cron/pg_net del stack existente; no contrata servicios. Confirmar invocaciones HTTP exitosas, renovación de leases y progreso real de cola en `cron.job_run_details` y `net._http_response`. Tener un job registrado no prueba que esté procesando.
6. Verificar backend compatible y permisos antes del merge autorizado. El merge activa la publicación automática de Pages; seguir [DEPLOYMENT.md](../DEPLOYMENT.md) y comprobar el deployment y sus assets públicos.

El interruptor del entorno y el del negocio deben permitir nuevos cobros. Desactivarlos conserva webhooks, consultas, conciliación y recuperación de los intentos existentes.

### Pasar a cobros reales conservando las pruebas

1. Conservar `MP_TEST_ACCESS_TOKEN` y los negocios marcados como pruebas. No se convierten en negocios reales.
2. Configurar `MP_CLIENT_ID` / `MP_CLIENT_SECRET` de la aplicación principal y su redirect HTTPS exacto; cambiar `MP_ENVIRONMENT=live` para las nuevas conexiones OAuth. La terminal virtual seguirá disponible con la credencial separada de pruebas. Los tokens de cada conexión conservan su propio entorno.
3. Crear un negocio real separado, autorizar la cuenta receptora mediante OAuth y vincular sucursal, caja y terminal. Los empleados usan el vínculo del negocio y sus permisos; no reciben tokens del proveedor. Completar PDV, reinicio y comprobación física.
4. Ejecutar el piloto físico acordado, incluidas aprobación, rechazo, recuperación y devolución, antes de dar por verificada la integración real. Configurar ambos secretos de firma y verificar entrega real de notificaciones. El worker mantiene recuperación si una notificación se pierde.

El frontend muestra los nuevos cobros deshabilitados si el interruptor del servidor está apagado. Al guardar el callback OAuth se vuelven a comprobar identidad, sesión Auth, permiso de dueño y operador; cerrar sesión o bloquear durante el intercambio no vincula una cuenta tardíamente. El estado OAuth se consume una sola vez y un callback antiguo no sobrescribe una conexión posterior.

La API Orders admite consultas de órdenes de menos de tres meses. La auditoría periódica de ventas aprobadas se limita a esa ventana; los intentos pendientes conservan su seguimiento y no se declaran pagados ni cancelados por antigüedad. La venta y sus reversos ya registrados permanecen. Las devoluciones externas posteriores a esa ventana necesitan un recorrido adicional verificable; no se infieren ni se presentan como sincronizadas. [Contrato de consulta](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/get-order/get).

## Alta del dueño

1. Entrar con la identidad del dueño y desbloquear su negocio. Abrir **Vincular una terminal**, elegir **Cobros reales** y autorizar la cuenta del comercio. Un state aleatorio vincula negocio, usuario y sesión; expira y se consume una sola vez. Si se rechaza o vence, iniciar una autorización nueva.
2. Verificar la cuenta receptora. Seleccionar o crear sucursal y caja del proveedor. Los nombres de sucursal/caja local siguen siendo la configuración del local; el vínculo del proveedor queda registrado por separado.
3. Identificar la terminal por su serial. En la app de Mercado Pago, el dueño debe asociarla a esa sucursal/caja. Una caja en modo PDV admite una sola terminal. Habilitar el modo PDV mediante la capacidad documentada; reiniciar y completar las instrucciones físicas cuando se solicite.
4. Ejecutar la comprobación de configuración, revisar cuenta, entorno, caja y serial, y activar el negocio. En **Configuración → Formas de pago**, habilitar **Mercado Pago** y guardar. La comprobación no ejecuta un cargo ni demuestra que el equipo esté online.
5. Para el piloto físico, el responsable humano confirma modelo/firmware compatible, conectividad, credenciales productivas, autorización comercial y disponibilidad de hardware. Ejecutar un importe acordado, observar la terminal, comparar evidencia bancaria, ticket, historial y comisión. Probar rechazo, cancelación en terminal, corte y recuperación, reembolso y turno. Registrar IDs y tiempos, sin PAN/CVV ni tokens.

Referencias vigentes: [configuración de terminal](https://www.mercadopago.com.mx/developers/es/docs/mp-point/configure-terminal), [OAuth](https://www.mercadopago.com.mx/developers/en/docs/security/oauth/introduction), [estados](https://www.mercadopago.com.mx/developers/es/docs/mp-point/resources/status-order-transaction).

La validación opcional con el [dispositivo virtual oficial](https://www.mercadopago.com.mx/developers/es/docs/mp-point/integration-test) se realiza separadamente con credenciales de prueba autorizadas. Guardar los resultados como evidencia del sandbox. No sustituye el ensayo físico ni la medición de calidad del proveedor.

## Incidencias y conciliación

| Situación | Acción |
| --- | --- |
| Timeout o respuesta perdida | Mantener intento, payload y clave originales. Consultar/reconciliar desde servidor. No crear otro cargo ni cambiar a efectivo mientras siga incierto. |
| Sin ID remoto | Usar únicamente el reenvío idempotente documentado dentro de su garantía. Fuera de la ventana, mantener revisión; no buscar por una referencia inventada. |
| `action_required` / `check_on_terminal` | Revisar físicamente la terminal y crear una incidencia con evidencia. Una declaración del cajero no acredita el pago; puede requerir soporte del proveedor para obtener evidencia verificable. |
| Cancelación | Mostrar la capacidad actual. Cerrar una ventana o borrar un carrito no cancela el cargo. Cuando corresponda, actuar en la terminal y esperar conciliación. |
| Pago confirmado, venta pendiente | Conservar evidencia del pago y reintentar la materialización del snapshot mediante el worker. No enviar otro cobro ni reconstruir el precio desde el catálogo actual. |
| Worker muerto | Recuperar leases vencidos, inspeccionar cola y errores seguros, reactivar el scheduler. La reserva de terminal no vence por TTL local. |
| Reintentos agotados | Conservar trabajo/incidencia y su referencia. Revisión del responsable autorizado y recuperación con identidad original. |
| Credenciales revocadas | Bloquear nuevos cargos, conservar conexión histórica y pendientes. Reconectar como dueño; no borrar registros necesarios para conciliación. |
| Devolución externa | La conciliación consulta evidencia del proveedor y agrega el reverso confirmado. La venta y su inventario permanecen; cualquier reposición requiere otro proceso. |

Revisar diariamente pendientes antiguos, última conciliación, firmas inválidas, duplicados y retraso de eventos. Exportar sólo datos financieros necesarios y texto escapado contra fórmulas CSV. No exportar eventos completos ni credenciales.

## Rollback

Desactivar nuevos cargos en el entorno y el negocio; mantener el backend Point y el scheduler hasta resolver pendientes y devoluciones. Volver a un frontend compatible conservando la navegación de recuperación, o mantener la versión actual con la función desactivada. Aplicar correcciones de esquema hacia adelante. No borrar ledger, intentos, conexiones, snapshots o evidencias para revertir una publicación.

## Administración SASORI

El acceso global exige un alta en `app_private.sasori_admins` por el operador de plataforma autorizado y deja auditoría. La lista comienza vacía; no existe administrador de demostración. Revisar identidad, motivo y responsable antes de concederlo mediante el canal administrativo del backend. Los roles de negocio y credenciales de caja no conceden ese acceso. IVA, costos ausentes y liquidación bancaria tienen tratamientos separados en los reportes; aprobación no demuestra depósito.
