# Negocio, operación y acceso — 4 de octubre de 2026

## Alcance y fuentes

Solicitud humana de Larios del 4 de octubre: creación/configuración del negocio, cuentas opcionales, estados de comandas, navegación, imágenes, notificaciones, métricas personales y estabilidad del cobro. Implementación en `feat/business-flow-polish`, worktree propio. La entrega de este documento es local; no acredita publicación.

Se consultaron README, contratos, migraciones, documentos del módulo y las entradas 02, 04 y últimas de 05 del [Drive del equipo](https://drive.google.com/drive/folders/17SUbtEJYeKy_zc8M2ZKR_0QV_ZsNiCZ3). Las notas fechadas hasta el 2 de octubre son antecedentes; las nuevas decisiones de operación proceden de la solicitud humana actual. No se modificó Drive.

## Recorrido

| Área | Comportamiento |
| --- | --- |
| Crear negocio | Negocio → Operación → PIN → Inicio. Sin pantalla de éxito intermedia. |
| Tipo y cuentas | Restaurante propone cuentas abiertas; cafetería y otro proponen cobro directo. El dueño puede cambiar la selección. |
| Configuración | Nombre, tipo, zona horaria, cuentas, IVA para nuevos productos, pagos, sucursal y contacto. |
| Cuentas abiertas | Crear/editar, enviar a cocina, seguir el servicio y cobrar al final. Guardar una cuenta no reserva ni registra un pago. |
| Comandas | Pendientes → En proceso → Completadas. Cancelaciones mantienen su aviso independiente e historial. |
| Menú | La terminal y la gestión son destinos exclusivos. Empleados, Dispositivos y Configuración abren su contenido. |
| Empleado | Productos, Caja y Mis métricas aparecen en el panel según permisos; teléfono ofrece el mismo menú mediante hamburguesa. |
| Notificaciones | Marcar como leída por fila, estado Leída y marcar todas las visibles. Cambian sólo tras confirmación del servidor. |
| Imágenes | Logo en Configuración; avatar personal en Mi cuenta. Aparecen en el panel una vez guardados. |
| Cobro | La vista conserva datos, selección y foco mientras procesa acciones; progreso localizado. Sólo la carga inicial usa skeleton. |

Las cuentas existentes conservan acceso cuando se desactiva la creación de nuevas cuentas. El pedido interno de Mostrador continúa existiendo para reservas y recibos exactos del cobro directo. El envío de cuentas a cocina no representa ingreso; pagar no vuelve a enviar cantidades ya enviadas.

La recuperación de una solicitud perdida conserva su UUID y el origen de la cuenta en una única escritura local. El origen no se envía al backend ni modifica importes o contratos. Una cuenta de servicio puede llamarse Mostrador sin convertirse en venta directa; las entradas guardadas por versiones anteriores siguen admitiendo un reintento con el payload original.

Las cuentas nuevas también guardan `orderKind` en el servidor. Esa clasificación es inmutable una vez definida y permite distinguir venta directa de servicio tras otra recarga o desde otro dispositivo autorizado. Los registros anteriores mantienen un origen desconocido; no se les asigna un tipo a partir de su nombre. Se conservan su consulta, edición, cobro e historial.

## IVA e imágenes

`defaultVatTreatment` reutiliza las clasificaciones de productos: 16 %, tasa 0 %, exento, frontera 8 % o definir por producto. Sólo inicializa productos nuevos. No cambia productos existentes, precios, recibos ni snapshots de IVA. El precio registrado incluye IVA. El 8 % exige cumplir los requisitos del estímulo; no se selecciona automáticamente por ubicación. [Fuente SAT](https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/region_fronteriza_norte_iva/en_que_consiste.html).

Las imágenes se convierten a JPEG estático, de hasta 512 px y 180 KiB, y se envían en partes de 4096 caracteres. Cada solicitud conserva el límite HTTP de 8 KiB, UUID y huella de payload. Persistencia privada en PostgreSQL; no se introduce almacenamiento público. El logo requiere dueño; una persona autenticada sólo modifica su propio avatar. Los dispositivos compartidos no modifican perfiles personales.

Cada parte y reintento revalida la sesión actual. Los locks de empleado, membresía y operador serializan la escritura con revocación. Los recibos de imagen son inmutables; el contexto incluido en un reintento se vuelve a calcular, de modo que no restaura permisos ni imágenes anteriores. Un guardado de configuración omite la referencia de imagen para conservar una subida concurrente.

## Métricas personales

En Empleados, el dueño activa **Consultar solo sus métricas** (`reports.read_own`). No se concede automáticamente a empleados existentes. **Consultar métricas del negocio** (`reports.read`) conserva su alcance amplio y separado.

`report_own_period` resuelve el empleado desde la sesión, sin selector de identidad. Ventas y devoluciones se filtran por ID del vendedor original, también en Point. Nombres duplicados no mezclan resultados. Operadores ajenos, diferencias de caja y analítica de la cuenta del proveedor no forman parte del resultado personal.

Filtros pendientes conservan cifras y rango confirmado; un error restablece la selección visible y permite reintentar la consulta fallida. Cambiar negocio, operador, autorización o zona horaria oculta el snapshot anterior. Un período con sólo devoluciones conserva neto negativo y no inventa productos vendidos.

## Backend y verificación

Migraciones nuevas, aplicadas sin reset al backend loopback de este checkout:

- `20261005010000_kitchen_workflow.sql`: transiciones persistidas y compatibilidad con estados históricos.
- `20261005011000_business_preferences_images.sql`: preferencias, aislamiento de imágenes y conservación de reintentos antiguos.
- `20261005012000_employee_metrics.sql`: permiso y reportes por actor histórico.
- `20261005013000_order_kind.sql`: tipo persistido de las cuentas nuevas, autorización y compatibilidad con solicitudes anteriores.

Comprobaciones reproducibles con Node 24:

```sh
npm run test:smoke
npx vitest run tests/components --no-file-parallelism
npx vitest run tests/sql --no-file-parallelism
npm run test:integrity:integration
node scripts/test-business-profile-local-integration.mjs
npm run lint
npm run build
deno check supabase/functions/account/index.ts
```

Las integraciones usan Auth/Edge/PostgreSQL reales, negocios sintéticos independientes y limpieza de fixtures. Cubren cocina antes/después del cobro, ausencia de duplicados, identidades con nombres iguales, atribución de devoluciones, permisos, aislamiento, imágenes por partes y revocación concurrente. Las pruebas de componentes cubren selección rápida, respuestas tardías, foco/DOM estable, navegación desde terminal, notificaciones y filtros de métricas.

Resultado local del 4 de octubre: **705 pruebas unitarias y de componentes**, **214 pruebas SQL** y **50 integraciones HTTP reales** aprobadas, sin omisiones en esas suites. Las 50 integraciones corresponden a 37 financieras/operativas, 4 de preferencias e imágenes y 9 de negocio/equipo. Build, lint, comprobación de Edge con Deno y revisión del diff aprobados. El build también verifica que la entrada y credenciales ficticias de desarrollo no aparezcan en sus artefactos. No se reinició la base de datos ni se reemplazaron datos existentes.

No se ejecutó revisión visual en navegador por la preferencia humana vigente. La revisión visual de teléfono, tablet, escritorio, imágenes propias y reduced motion queda a Larios. No se verificó hardware, Google real ni publicación cloud en esta entrega.

## Integración posterior: dividir por cantidad

La función pendiente en `feat/amount-split` se incorporó a este checkout, conservando el rediseño anterior y los cambios de su rama fuente. La adaptación usa la migración nueva `20261005014000_amount_split_checkout.sql`, aplicada al backend local sin reset, después de las migraciones de tipo de cuenta y métricas personales. Recorrido, contratos y evidencia específica: [Dividir por cantidad](amount-split-checkout.md).
