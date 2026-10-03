# Point: alta, piloto y operación

Esta entrega se implementa sobre `main` 43c0de4. Las credenciales, el ensayo físico y la activación comercial son etapas independientes. El simulador HTTP sirve para verificar el software; no acredita un cobro bancario productivo.

## Configuración y publicación por etapas

1. Revisar el PR y el historial del proyecto destino. Aplicar las migraciones aditivas de Point después de todas las migraciones heredadas; conservar ventas, empleados y documentos cerrados. Publicar `account`, `point`, `point-webhook` y `point-worker` antes del frontend.
2. Configurar en secretos del backend `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `MP_ENVIRONMENT`, `MP_TOKEN_KEYS`, `MP_TOKEN_ACTIVE_KEY`, `MP_WEBHOOK_SECRET` y `POINT_WORKER_SECRET`. Registrar exactamente el mismo redirect HTTPS `/point/callback` en la aplicación del proveedor. `POINT_CHARGES_ENABLED=false` es el estado inicial. Ningún secreto pertenece a `VITE_*`.
3. `MP_TOKEN_KEYS` es un mapa de ID de clave a 32 bytes aleatorios en base64url; el ID activo se indica en `MP_TOKEN_ACTIVE_KEY`. Las claves se mantienen en secretos del backend, separados de los ciphertexts PostgreSQL. Para rotar, añadir una clave, cambiar el ID activo y conservar las anteriores hasta que se recifren o reconecten las conexiones que las necesitan. Respaldar claves y datos mediante los controles del proyecto; perder una clave impide recuperar sus pendientes.
4. Configurar la notificación de tipo **Order** en la aplicación de Mercado Pago con el endpoint específico `point-webhook`. Verificar firma, ACK después de persistencia y reintentos con el simulador antes de habilitar un comercio.
5. Guardar en Vault `sasori_point_worker_url` y `sasori_point_worker_secret`, que coincida con el secreto Edge. Ejecutar [install-point-scheduler.sql](../scripts/install-point-scheduler.sql). El job usa pg_cron/pg_net del stack existente; no contrata servicios. Confirmar invocaciones HTTP exitosas, renovación de leases y progreso real de cola en `cron.job_run_details` y `net._http_response`. Tener un job registrado no prueba que esté procesando.
6. Verificar backend compatible y permisos antes de considerar el merge. El merge activa la publicación automática de Pages; este encargo sólo prepara el PR y no autoriza esa publicación.

El interruptor del entorno y el del negocio deben permitir nuevos cobros. Desactivarlos conserva webhooks, consultas, conciliación y recuperación de los intentos existentes.

## Alta del dueño

1. Entrar con la identidad del dueño y desbloquear su negocio. Abrir Mercado Pago en Más y autorizar la cuenta del comercio. Un state aleatorio vincula negocio, usuario y sesión; expira y se consume una sola vez. Si se rechaza o vence, iniciar una autorización nueva.
2. Verificar la cuenta receptora. Seleccionar o crear sucursal y caja del proveedor. Los nombres de sucursal/caja local siguen siendo la configuración del local; el vínculo del proveedor queda registrado por separado.
3. Identificar la terminal por su serial. En la app de Mercado Pago, el dueño debe asociarla a esa sucursal/caja. Una caja en modo PDV admite una sola terminal. Habilitar el modo PDV mediante la capacidad documentada; reiniciar y completar las instrucciones físicas cuando se solicite.
4. Ejecutar la comprobación de configuración, revisar cuenta, entorno, caja y serial, y activar el negocio. La comprobación no ejecuta un cargo ni demuestra que el equipo esté online.
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
