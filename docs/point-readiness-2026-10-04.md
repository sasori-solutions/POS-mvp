# Auditoría de cobros y terminal — 4 de octubre de 2026

Agente de Larios, rama `fix/point-shared-sandbox`, base `9c4faed`. La solicitud humana exige revisar los cobros y presentar una sola opción **Tarjeta**, enviada a Mercado Pago. Este documento registra evidencia y límites; no garantiza ausencia absoluta de errores.

## Alcance

PWA, métodos, reservas, división por artículos, descuentos/IVA, Auth y revocación, Orders/Payments, vinculación, worker, notificaciones, reintentos, materialización y devoluciones. Fuentes: contratos/migraciones actuales, README, design-system, runbook y Drive 02, 04 y entradas recientes de 05. Drive no se modificó; las notas anteriores son contexto y la solicitud actual determina la unificación de tarjeta.

## Hallazgos corregidos

| Problema | Corrección |
| --- | --- |
| Consulta terminaba a los dos minutos | Seguimiento continuo; regreso de foco/conexión consulta inmediatamente. |
| El evento de prueba se confundía con resultado | `204` sólo acepta el evento; el saldo cambia tras GET verificado y venta materializada. |
| Cancelación oficial quedaba en revisión | Se reconoce el detalle observado `cancel_by_terminal`; estados desconocidos conservan revisión. |
| Payments devuelve importes como texto | Decimales exactos como cadena o número JSON; Orders/Payments concordantes. Financiación no aumenta la venta. |
| Payload saliente sin comprobación independiente del snapshot | Estructura exacta, importe decimal, referencia, terminal, receptor y entorno se validan antes del POST; no se altera la identidad del reintento. |
| Segundo recibo del mismo artículo colisionaba | UUID propio por línea del recibo; snapshot conserva identidad de la línea de cuenta. Prueba 1+2 unidades con descuento/IVA, replay y devolución aislada. |
| Logout durante bloqueo podía terminar en venta | Reproducción con tres conexiones PostgreSQL reales. Lock Auth serializa aceptación y revocación; el replay posterior no se autoriza. |
| OAuth terminaba después de revocar | Reautorización final con locks de sesión/operador/empleado/membresía, estado de un uso y protección de conexión más reciente. Cuatro revocaciones concurrentes rechazadas. |
| Alta de caja con contrato anterior | `/v2/pos`, clave idempotente estable, external ID alfanumérico de 38 caracteres, nombre válido y respuesta sin exigir `store_id`. Sucursal verificada antes del POST. |
| Recursos truncados | Paginación acotada, POS máximo 30 por página, filtro de sucursal y verificación de receptor/duplicados/paging. Exceso falla explícitamente. |
| Importe no admitido reservaba terminal | Rechazo antes de checkout Point: mínimo $5.00 sólo virtual oficial y máximo del adaptador. Sin orden, trabajo o movimiento monetario. |
| Tarjeta y Mercado Pago como opciones distintas | Una sola Tarjeta. Perfiles anteriores se convierten al guardar como dueño; contratos históricos y recuperación exacta anterior permanecen. |
| Home conservaba configuración anterior al volver | Consulta de estado al salir de Configuración o guardar métodos; no inicia consultas en cada render. |
| Rechazo parcial documentado retenía saldo disponible | Sólo `400 unsupported_partially_refunds`, primer parcial y dos GET sin devoluciones permiten cerrar la solicitud como rechazada. Dinero e historial no cambian. |
| Auditoría de aprobadas fuera de ventana API | Confirmadas se auditan dentro de tres meses; pendientes no se resuelven por antigüedad. |

Worker cada 15 segundos, con leases/backoff e invocación sólo cuando hay trabajo. Recuperación continúa con nuevos cargos apagados. Aprobar exige importe, moneda, receptor, entorno, terminal y referencia originales; devolver exige ID remoto exacto. Snapshots e historial permanecen inmutables.

## Terminal virtual oficial

Se verificó `/users/me` como cuenta de prueba mexicana (`test_user`). Cinco órdenes sintéticas propias de $5.00; ningún cobro humano de la PWA fue modificado.

| Evento | GET observado | Tiempo observado |
| --- | --- | --- |
| Aprobar | `processed/accredited` | 44 s |
| Rechazar | `failed/insufficient_amount` | 4 s |
| Cancelar | `canceled/cancel_by_terminal` | 3 s |
| Expirar | `expired/expired` | 3 s |
| Revisión | `action_required/check_on_terminal` | 33 s |

Los cinco GET coincidieron con identidad, terminal, moneda, importe y referencia. El primer script falló en su limpieza: cancelar revisión devolvió HTTP 400. La misma orden se resolvió mediante `processed`, confirmado por GET el 5 de octubre a las 00:03 UTC. UI/servidor sólo ofrecen esa transición comprobada para revisión virtual; no aprueban manualmente una operación real.

Una devolución parcial de $2.00 de esa orden sintética respondió HTTP 412. **No se acredita devolución oficial exitosa**, ni se interpreta ese código desconocido como rechazo definitivo. Devoluciones están probadas en loopback y necesitan ensayo oficial/físico adicional. Los fixtures son sintéticos; ninguna credencial está en el repositorio.

## Verificación y entrega

Suites de dinero/snapshots/IVA/descuentos/doble envío/respuesta perdida/aborto/devolución/revocación. Resultado final: **294 unitarias**, **497 de componentes/SQL**, **23 del adaptador HTTP**, **15 integraciones Point** y **33 integraciones financieras**, sin fallos ni omisiones. Build, TypeScript, lint y los tres bundles standalone comprobados con Deno. La integración financiera estándar incluye tres regresiones Auth concurrentes; Point usa Auth/Edge/PostgreSQL locales reales y proveedor HTTP loopback. Auditor local de ledger: nueve contadores cero. Commit exacto y CI quedan en el PR.

No se usó navegador para revisar diseño, conforme al usuario. Desarrollo de esta rama: `http://127.0.0.1:5181/`. Backend compatible se aplica antes del frontend; el frontend sigue PR revisado y CI de DEPLOYMENT. Aplicar backend no significa publicar los nuevos assets.

### Backend publicado — 5 octubre, 00:47 UTC

Proyecto `sdisalomdxgejyhpxtri`: cinco migraciones nuevas aplicadas, historial canónico normalizado únicamente tras comprobar nombre/hash exactos y ausencia de la versión destino. Los cuerpos SQL coinciden con el PostgreSQL local probado; permisos y `search_path` conservados. `public.point_service` sólo admite service role, y sus helpers anteriores no tienen acceso directo.

| Endpoint | Versión | SHA-256 de la fuente standalone |
| --- | --- | --- |
| account | 20 | `6c298b69b4767d27a8af4ec127e031100fe82b110b96b1ee8cbb30f8322ada26` |
| point-worker | 5 | `74af0a2b88d0f0433f68e15cbde1df44b5b881fcb89ef5999c4c2a4756ac5b4d` |
| point-webhook | 5 | `3d4b379b052da37e3d21bbe42319dc9a3b5ae9fd107af51b91301abd97fe3607` |

Fuentes descargadas idénticas a los bundles. Cron activo `15 seconds`, comando exacto comprobado por MD5 `c38450cf91189d6c84b8c4d98579b636`. Ejecución 00:47 UTC: HTTP 200, `failed=0`; cero trabajos pendientes y cero aprobadas sin materializar. Probes anónimos: account/worker 401, origen no permitido 403 y `no-store`.

Webhook sin firma devolvió **503 SERVER_ERROR**: la configuración de firmas continúa incompleta; no acredita notificaciones operativas. No se configuraron nuevas credenciales ni se modificaron cobros humanos para obtener esta evidencia. El frontend publicado conserva el commit `446d3ed`; los nuevos assets esperan revisión humana y CI de PR #24.

## Producción y límites pendientes

- Conservar negocio/token de pruebas separados. `MP_ENVIRONMENT=live` afecta nuevas conexiones OAuth; el dispositivo virtual conserva su credencial independiente. Negocios marcados como pruebas no se convierten en reales.
- Configurar secreto OAuth principal y redirect exacto; el Access Token de prueba no sustituye ese secreto.
- Firmas principal/pruebas: `MP_WEBHOOK_SECRET` y `MP_WEBHOOK_TEST_SECRET`. Recuperación por cron no acredita entrega de webhook.
- Validar OAuth real, terminal/PDV físicos, cobro, rechazo, corte, turno y devolución. No comprobados mientras llega hardware.
- Devoluciones externas fuera de la ventana Orders y contracargos necesitan otro recorrido verificable; no se presentan como conciliados.
- Orders permite consultas dentro de tres meses calendario y las devoluciones se documentan hasta 90 días. Las ventanas no siempre coinciden; no se omite la prueba autoritativa para una devolución tardía.
- `Dividir por cantidad` está sin integrar en otro worktree. Revisión separada: 20 pruebas enfocadas aprobadas, sin editar ni incluir esos cambios. Antes de integrar necesita nuevas regresiones Point.
- Backend conserva compatibilidad con contratos y recuperación manual anteriores. La nueva UI no ofrece registrar una tarjeta nueva manualmente como alternativa a Point.

Fuentes primarias: [payload](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/create-order/post), [estados](https://www.mercadopago.com.mx/developers/es/docs/mp-point/resources/status-order-transaction), [simulador](https://www.mercadopago.com.mx/developers/es/docs/mp-point/integration-test), [POS v2](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/pos/create-pos/post), [GET Orders](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/get-order/get), [devoluciones](https://www.mercadopago.com.mx/developers/es/reference/in-person-payments/point/orders/refund-order/post), [producción](https://www.mercadopago.com.mx/developers/es/docs/mp-point/go-to-production).
