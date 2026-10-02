# Catálogo del MVP e IVA en México — 2 de octubre de 2026

Autor: Codex. Fuente de alcance: instrucción humana de esta sesión. El dueño y quien toma pedidos usan su celular; no hay hardware propio ni pantalla para el cliente. Tailwind, IBM Plex Sans y los iconos originales se conservan.

## Revisión de las opciones heredadas de Square

| Opción | Decisión para el MVP | Uso real |
| --- | --- | --- |
| Nombre, categoría y descripción | Conservar | Encontrar y reconocer alimentos/bebidas al tomar el pedido. |
| Una foto | Conservar | Identificación en el catálogo del celular; carga privada real. |
| Alérgenos | Conservar como dato opcional | Se muestran a quien toma el pedido antes de agregar el producto. No se infieren ingredientes ni ausencias. |
| Precio fijo final en MXN | Conservar | El mismo precio anunciado en producto, tamaño y extra. |
| Tamaños/presentaciones y su precio | Conservar | Lista directa de variantes, sin generador de combinaciones. |
| Extras y selecciones obligatorias | Conservar | Leches, acompañamientos y personalización del pedido; límites verificables por servidor. |
| Favoritos | Conservar | Acceso rápido desde Venta. |
| Agotado por producto/variante | Conservar | Acción directa del operador en Venta; persistencia y permisos actuales. |
| Unidades disponibles y aviso de pocas existencias | Conservar opcional | Conteo del producto completo, compartido entre variantes; no ingredientes/recetas/mermas. |
| Tipos servicio, digital, evento y otro | Retirar del editor | Sin entregas digitales, agenda ni venta de entradas en este MVP. |
| Precio abierto introducido al vender | Retirar de altas nuevas | Los productos anteriores siguen operando hasta que una edición exige ingresar un precio fijo explícito. Nunca se convierten automáticamente en productos gratuitos. |
| Generador de varias opciones/combinaciones | Retirar | Basta una lista de tamaños o presentaciones; las variantes ya guardadas se conservan. |
| SKU y códigos de barras | Retirar del editor | El MVP no tiene flujo de escáner ni búsqueda operativa por cámara. |
| Nombre para cliente/cocina | Retirar del editor | Un solo nombre. Las nuevas ventas guardan ese nombre; los snapshots anteriores mantienen el suyo. No hay pantalla de cliente ni módulo de cocina operativo. |
| Color/etiqueta personalizados de ficha | Retirar del editor | Foto o iniciales automáticas suficientes para identificar el producto. |
| Costo unitario | Retirar del editor | No hay compras, historial de costos ni margen. |
| Calorías y preferencias alimentarias | Retirar del editor | No hay menú público ni módulo nutricional. |

Los campos retirados del formulario no borran metadata existente. Se conserva el contrato anterior para que clientes y registros previos sigan siendo compatibles. La nueva pantalla deja de crear esos ajustes. Los permisos, la navegación por rol y los cobros con terminal externa/transferencia manual permanecen iguales.

## IVA y precio final

- Los nuevos productos proponen **IVA 16 %**. El dueño puede seleccionar **tasa 0 %**, **exento** o **8 % por estímulo fronterizo**, según la operación. Son clasificaciones diferentes; no se decide por el nombre/categoría del producto ni por el régimen de ISR.
- El precio ingresado es el **precio final al público**. El editor muestra base, IVA incluido y precio final. La cuenta no añade IVA encima del precio del catálogo. El IVA del producto se aplica también a sus tamaños y extras.
- El 8 % se identifica como estímulo y exige una declaración explícita del comercio en el formulario. Esto no verifica el aviso/requisitos ante SAT ni constituye autorización fiscal. No se activa por dirección ni por defecto.
- Los productos anteriores con `taxBps: 0` y sin clasificación son **IVA sin definir**, nunca se reinterpretan como tasa 0 o exentos. Al editarlos se pide una elección explícita; sus precios se conservan. Mientras tanto, el registro identifica el desglose incompleto.
- Con IVA definido, la cuenta/historial muestran subtotal sin IVA y filas separadas por clasificación. Cuando falta clasificación se muestra importe de productos y los impuestos conocidos como incluidos, sin afirmar una base fiscal completa.
- Dinero en centavos enteros. Se extrae IVA del importe final: `IVA = redondear(total de línea × tasa / (10000 + tasa))`; se redondea una vez por línea, después de cantidad y extras. La base es el importe menos ese IVA. PostgreSQL usa `numeric`; el cliente usa `BigInt`. Se suman los importes ya redondeados por línea.

La [LIVA vigente, artículos 1 y 2-A](https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf) establece la tasa general y el tratamiento de alimentos preparados, incluso para llevar/a domicilio. La [LFPC, artículo 7 Bis](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf) exige informar el monto total incluyendo impuestos/cargos. El [SAT explica el estímulo de IVA fronterizo](https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/region_fronteriza_norte_iva/en_que_consiste.html) y sus [requisitos para facturar](https://www.sat.gob.mx/minisitio/EstimulosFiscalesFronteraNorteSur/region_fronteriza_norte_iva/que_necesito_para_facturar.html). Fuentes consultadas el 2 de octubre de 2026. El editor es un registro de IVA: no emite/timbra CFDI, calcula ISR/retenciones ni implementa IEPS. La facturación sigue en el sistema del comercio.

## Persistencia y compatibilidad

La nueva migración `20261002001400_mvp_mexican_vat.sql` amplía la validación exacta con `taxTreatment` opcional y agrega `tax_treatment`/`tax_bps` a snapshots de líneas nuevas. HTTP y SQL rechazan clasificaciones/tasas incoherentes. Las operaciones antiguas sin el campo siguen válidas; los reintentos aceptados conservan su resultado original.

No se modifican los importes ni se reconstruyen tasas de ventas cerradas a partir del catálogo actual. Las líneas anteriores se identifican como registro anterior y sus columnas nuevas quedan nulas. Nuevas ventas conservan tasa, clasificación e IVA por línea aun después de cambiar/desactivar el producto. Se mantienen autorización, bloqueo ordenado, stock, atomicidad, huella/UUID y permisos privados. La corrección del validador de imágenes de la migración 0013 se conserva.

Desarrollo: `npm ci` y `npm run dev -- --port 5177`, Node 24 y Docker. La migración se aplica solo al stack loopback de este checkout, sin reset; las cuentas y productos sintéticos existentes se conservan. Para producción, migración/Edge compatibles deben verificarse antes de integrar el frontend, conforme a DEPLOYMENT. La verificación inicial de esta revisión fue local; el usuario pidió publicar después, como se registra a continuación.

Contexto remoto revisado: Drive 02, 04 y últimas entradas de 05, incluyendo las sesiones recientes de acceso y publicación. Las propuestas históricas de hardware y “todo Square” no reemplazan esta reducción humana del alcance. No se modificó Drive. La evidencia de pruebas de esta revisión se registra en la rama; capturas y logs sintéticos permanecen en `artifacts/qa/`, ignorado por Git.

## Verificación local de esta revisión

Con Node 24.15.0 y el stack aislado `pos-dev-0c2a8637f8`, pasan lint, build/TypeScript y el guard de credenciales de desarrollo, 28 pruebas unitarias, 20 de PostgreSQL embebido, 14 de validación Deno, y los typechecks de Edge modular y empaquetado independiente. La suite de productos/ventas pasa **9/9 casos con Auth, Edge y PostgreSQL reales, sin omisiones**, ejecutada sola con los mismos límites de CI (`--no-file-parallelism --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000`). La suite de navegador pasa **44/44 casos en escritorio y móvil en una sola ejecución con `--workers=2`**.

El primer intento solapó integración real y navegador con mayor concurrencia: fallaron siete casos de integración por el límite predeterminado de cinco segundos y ocho de navegador por tiempos de carga/acceso. La repetición separada anterior pasó sin cambiar los límites de la aplicación ni omitir casos. El primer SQL detectó que la nueva definición reintroducía el regex anterior de imágenes; se corrigió antes de aplicar 0014 y la suite completa de SQL pasó. No se editaron migraciones previamente aplicadas.

Se verificó que el stack local tiene 0014, las columnas nuevas nullable y los helpers de IVA sin permiso de ejecución para navegador. Se abrió la app con la cuenta ficticia local y se comprobó el editor reducido con IVA 16 % inicial. Las pruebas cubren fotos, tamaños/extras, stock/agotados, precio anunciado, cuatro tratamientos de IVA, clasificación pendiente de productos anteriores, conversión explícita del precio abierto y snapshots/reintentos después de cambiar impuestos. Los tests de navegador interceptan autenticación/HTTP sintéticos y ejecutan SQL; se distinguen de los nueve casos de integración real. No se ejecutó toda la batería de acceso de módulos ajenos, ni se acredita Google alojado, instalación en teléfono físico, hardware, CFDI o publicación cloud.

## Preparación de publicación — 2 de octubre de 2026

La petición humana posterior «push a produccion y live» autoriza publicar estos cambios. PR [#11](https://github.com/sasori-solutions/POS-mvp/pull/11), con revisión solicitada a siriuslatte. El backend se verifica antes del merge; Cloudflare se publica únicamente por el flujo automático vigente.

La revisión de compatibilidad encontró que 0012 había sustituido accidentalmente la comparación de actor de 0011 por `<>`, que no rechaza un actor borrado convertido en `NULL`. Una prueba SQL reprodujo el reintento indebido. La nueva migración `20261002001500_pos_erased_actor_replay.sql` restablece `IS DISTINCT FROM`; no se editan migraciones aplicadas ni se modifican resultados anteriores. La suite completa específica pasa **21/21 SQL** y **10/10 Auth/Edge/PostgreSQL reales**, incluyendo eliminación, reinvitación con empleado nuevo, rechazo de reintentos antiguos y conservación del historial. Lint pasa. El frontend y sus 44 pruebas anteriores no cambian por esta corrección.

La preparación de migraciones verifica los once hashes del historial y las 67 definiciones/permisos de funciones anteriores, se ejecuta en una sola transacción y comprueba que los hashes de ventas, líneas financieras y operaciones existentes no cambien. Una base nueva desechable del contenedor loopback, con fixtures sintéticos anteriores a 0012, pasa el salto **0011→0015**, conserva snapshots/reintentos, registra una venta con el contrato del cliente anterior y verifica las 71 funciones finales. Se elimina sólo esa base de pruebas; el entorno de desarrollo y sus datos siguen funcionando. La inspección cloud previa confirmó exactamente 0011 y las 67 funciones/permisos; la aplicación y verificación final de la publicación se registran en el PR, sin considerar estos preparativos prueba de entrega live.
