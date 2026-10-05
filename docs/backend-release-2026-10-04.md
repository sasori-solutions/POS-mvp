# Backend de negocio y cobro — 4 de octubre de 2026

Autor: Codex, subagente `business_setup` de la tarea actual. Verificación terminada el **5 de octubre de 2026 a las 04:35 UTC** (4 de octubre, hora local). La instrucción humana vigente autorizó publicar esta entrega; este documento acredita el backend, no la publicación del frontend.

## Destino y auditoría previa

- Proyecto **POS México**, `sdisalomdxgejyhpxtri`, estado `ACTIVE_HEALTHY`, PostgreSQL `17.11.0.002`.
- `origin/main` consultado antes de publicar: `446d3ed`. Supabase ya contenía el trabajo de Point posterior a ese commit, con **54 migraciones hasta `20261005003500_point_refund_definitive_rejection`**. No se reaplicó esa cadena ni se sustituyó por el estado de `main`.
- Las **152 funciones** de `app_private` y las RPC públicas `account_*`, `pos_*` y `point_*` coincidieron con la cadena local hasta 050035: cuerpo, `SECURITY DEFINER`, configuración de `search_path` y privilegios. No hubo diferencias ni funciones adicionales dentro de ese inventario.
- Los módulos de proveedor, servicio y criptografía Point incluidos en `account` coincidieron con los publicados. Esta entrega sólo necesitó desplegar `account`; se conservaron `point` v3, `point-webhook` v5 y `point-worker` v5.
- La suite SQL local completa pasó: **233/233 pruebas en 16 archivos**, incluidas las cinco migraciones nuevas, integridad financiera, reservas antiguas, reintentos, permisos, devoluciones y cobros Point. Pruebas locales de integración y frontend se registran por separado en la evidencia de la tarea.

## Migraciones publicadas

Se aplicaron en este orden, cada una en una transacción con un guard que exigía el número, versión, nombre y hash de todas las entradas anteriores. El historial final contiene **59 entradas**; las 54 anteriores conservaron exactamente sus metadatos y sentencias.

| Versión canónica | Migración | SHA-256 del archivo aplicado |
|---|---|---|
| `20261005010000` | `kitchen_workflow` | `f88cea8aac83d3bd8ce4ccd1cccb0c63b812f2ee665cc52d0109d04e0b66a006` |
| `20261005011000` | `business_preferences_images` | `cc6aab99115988047a728eac65ef2f2466e199223084eb4828547d68a577bd9c` |
| `20261005012000` | `employee_metrics` | `170cae399551116683c65215d8078ea3b5e33566e28e30d7c403088cf3387fea` |
| `20261005013000` | `order_kind` | `f83df9df1b8a9b08db367c7ba94a012b68cc560afae5bd35e9e0c8e3fb742459` |
| `20261005014000` | `amount_split_checkout` | `88320a17f48758cc6cf45d94b37e64fcd9b0286fb23905410f37bc085c58ab3e` |

El CLI instalado era 2.119.0, pero no tenía autenticación de administración. Se usó el conector Supabase autorizado. `apply_migration` genera su propia versión y no acepta la canónica como parámetro. Después de cada éxito se comprobó que su nueva entrada contenía exactamente el guard y el archivo enviado. Una actualización condicionada exclusivamente por **versión generada, nombre y sentencias exactas** normalizó esa nueva entrada a la versión del repositorio y a `[archivo SQL canónico]`. No repitió DDL ni cambió entradas anteriores. Una lectura final comparó todas las 59 entradas con el historial esperado.

Versiones generadas reconciliadas, respectivamente: `20261005042956`, `20261005043046`, `20261005043111`, `20261005043135`, `20261005043200`. Todos los pasos y verificaciones finalizaron correctamente; no quedó una versión generada duplicada.

## Edge y contrato publicado

`account` quedó **ACTIVE, versión 21**, con `verify_jwt=false` conservado: el handler sigue verificando identidad Auth/Google y sesiones actuales, y las acciones de dispositivo conservan la prueba firmada y su autorización SQL. No se añadió acceso de desarrollo al backend alojado.

- Fuente autónoma producida por `scripts/build-account-source.mjs`: **164.789 bytes UTF-8**.
- SHA-256 de esa fuente: `c92240a58f61f1a6b9659fcdd7fd7bca40fd364eab41de20f91459e4e5ebb33b`.
- SHA-256 del paquete ESZIP informado por Supabase: `6fc35903950f65d38e1070fe9a684625493dfe8d10c3cb5edc19222acb963530`.
- La fuente descargada después del despliegue coincidió **byte por byte** con el artefacto enviado. Fuente y ESZIP son artefactos distintos; sus hashes no se comparan entre sí.

Compatibilidad: perfiles que omiten preferencias nuevas conservan su configuración; el IVA por defecto sólo afecta productos nuevos. Las cuentas históricas y los payloads sin `orderKind` conservan `NULL` y su autorización anterior, sin inferir el tipo por nombre. Comandas antiguas aún pueden completar directamente a `delivered`. Las reservas y recibos aceptados anteriores a dividir por cantidad mantienen sus reintentos exactos. La división usa centavos enteros y sólo reduce saldo después del pago confirmado; preparación, resultado desconocido y simulación pendiente no registran dinero. No se modificaron ventas finalizadas ni precios históricos.

## Verificación posterior

- **170/170 funciones** del inventario financiero/de cuenta coincidieron con la cadena local final: cuerpo, privilegios y configuración. Cero diferencias, funciones inesperadas o funciones de ese inventario ejecutables por `anon`/`authenticated`; todas conservaron `search_path` vacío.
- **66 tablas privadas** con RLS. Cero accesos de navegador al esquema, tablas, vistas o secuencias privadas. Las RPC públicas del inventario siguen restringidas al servidor.
- Diagnóstico de sólo lectura sobre el estado publicado: `invalidQuotes`, `invalidSales`, `invalidCompletedAttempts`, `invalidReversals`, `invalidClosedShifts`, `invalidPendingSnapshots`, `invalidOrders`, `invalidCancellations` e `invalidWaivers`: **todos 0**. Sólo se obtuvieron conteos; no se imprimieron identidades, pedidos ni credenciales.
- **31/31 comprobaciones HTTP anónimas** pasaron contra el proyecto correcto. Los 19 payloads válidos sin sesión —incluidos preferencias, avatar/logo, informes propios, tipos de cuenta, división por cantidad y cobro reservado— devolvieron `401 AUTH_REQUIRED`. Cinco payloads inválidos devolvieron `400 VALIDATION_ERROR`; el límite de cuerpo devolvió `413 PAYLOAD_TOO_LARGE`; un origen no permitido, `403 ORIGIN_FORBIDDEN`; GET, `405 METHOD_NOT_ALLOWED`; OPTIONS, `204`. Las RPC `pos_device`, `account_secure` y `point_service` rechazaron ejecución anónima con `401`, código PostgreSQL `42501`.
- Los probes de Edge verificaron `Cache-Control: no-store`, CORS para el origen HTTPS exacto de la PWA y ausencia de autorización CORS para el origen rechazado. No crearon negocios, imágenes, empleados, sesiones ni movimientos financieros.

## Avisos existentes y límites

Los avisos de seguridad posteriores fueron los mismos que los previos: RLS sin políticas en tablas privadas (denegación intencional al navegador), dos avisos de `EXECUTE` sobre `public.rls_auto_enable()` y protección de contraseñas filtradas desactivada. La primera función pertenece a la configuración existente y devuelve `event_trigger`, con `search_path=pg_catalog`; no es una RPC de negocio ni se modificó en esta entrega. No se amplió ningún permiso para silenciar avisos. Referencias: [RLS sin política](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [funciones privilegiadas](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [protección de contraseñas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

No hubo reset, eliminación de datos, backfill por nombre ni cambios de secretos/proveedores/orígenes. Los datos y el servidor de desarrollo se conservaron. Estas comprobaciones no acreditan OAuth Google real, un pago humano en producción, hardware físico, el simulador externo de Mercado Pago, revisión visual ni activación del service worker. La publicación de Cloudflare, el commit final y sus assets públicos deben verificarse y registrarse por separado.
