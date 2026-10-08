# Restaurantes: alcance y comprobación — 2026-10-07

La entrega diferencia de forma operativa el cobro previo y las cuentas de servicio, e incorpora las funciones compatibles de la lista del socio. Está disponible en el entorno local de desarrollo; no se ha publicado esta nueva entrega en producción.

Base: `origin/main` `ded0f20dea1b36ceb3bfd1b661abb1359061612f`. Rama `feat/restaurante-piloto`, checkout propio. Fuentes: código y migraciones actuales, análisis humano aportado, documentos 02/04/05 y sesiones recientes de Drive consultados en esta tarea. Se revalidó la metadata de Drive el 7 de octubre y no se modificó Drive. Las notas históricas no acreditan pruebas físicas del piloto.

## Funciones y límites

| Necesidad | Comportamiento implementado y comprobación |
| --- | --- |
| Cobro previo | Catálogo → pago → comanda automática → comprobante → siguiente venta. Se configuró y ejecutó en navegador con efectivo; integración de catálogo verifica también combos, cocina y reintentos. |
| Cobro posterior | Mesas/cuentas → consumos modificables → tiempos/envíos a cocina → pago → visita finalizada. Una mesa pagada sigue ocupada hasta resolver toda la visita. Navegador y Auth/Edge/Postgres locales comprobados. |
| Hora del negocio | Detectada al crear. Corrección discreta; cambiar de dispositivo no reescribe la zona de negocios existentes. Los horarios y cierres usan la zona guardada; agenda y menú muestran el nombre de la ciudad. |
| Impuestos | Elección explícita en el alta, con opción de definir después por producto. Default sólo para productos nuevos; los productos y ventas anteriores conservan su tratamiento. |
| Dispositivos | Navegadores personales del dueño/empleado y cajas compartidas, actividad y revocación. Se observó Este dispositivo y se verificó revocación real de sesiones en integración. |
| Transferencias | Beneficiario, banco y CLABE opcionales y privados. Instrucciones al cajero y confirmación explícita de depósito. El registro no verifica la transferencia con el banco ni valida titularidad. |
| Efectivo | Calculadora opcional de cambio, billetes rápidos, bloqueo si el recibido es insuficiente y reset al cambiar total/método. No cambia el importe financiero de la venta. |
| CSV y edición masiva | Exportación, previsualización/validación de importación, lotes atómicos con versiones, resultado y recuperación con UUID original. Campos complejos se conservan mediante JSON; no promete compatibilidad con cualquier CSV ajeno. [Detalle](catalogo-csv.md). |
| Modificadores | Biblioteca compartida o copia independiente, dependencias anidadas hasta tres niveles, ajustes negativos, unidades repetidas limitadas y agotado individual. Selecciones y disponibilidad se validan en servidor. [Detalle](shared-modifier-library.md). |
| Combos | Precio explícito y componentes configurados, hasta ocho componentes. Capturas inmutables para venta, cocina y comprobante. No ofrece combos recursivos ni combinaciones libres elegidas al cobrar. |
| Menú QR | Publicación explícita de selecciones del catálogo con enlace/QR estable; precio y disponibilidad actuales, consulta sin iniciar sesión. Refresco manual, al volver a la página y periódico. No permite ordenar ni pagar desde el QR. [Detalle](public-menus.md). |
| Ubicación y horarios de menú | Menús para barra, terraza u otro punto del mismo negocio, con franjas y cruce de medianoche. Son colecciones; no hay cajas, impuestos ni contabilidad de sucursales independientes. |
| Mesas y plano | Crear, nombrar, activar, colocar por zona/fila/columna, forma y lugares; abrir y retomar cuentas. Las mesas con visita activa indican Ocupada y abren su detalle, sin presentar el saldo de una cuenta como total de la visita. En teléfono el plano permite desplazamiento dentro de su propia región. |
| Visitas y mesas juntas | Asociar varias mesas a una visita; saldos de todas sus cuentas y liberación sólo cuando estén resueltas. No fusiona ni modifica comprobantes ya pagados. |
| Tiempos de cocina | Retener y enviar grupos. Los retenidos bloquean cobro/envío global; quitar del tiempo libera los artículos para otro envío y conserva su consumo financiero. El envío conserva productos, extras, notas y avisos de cancelación. |
| Sobremesa y bar | Nueva cuenta vinculada después de un pago parcial o completo, conservando la venta original y mostrando saldos previos. Sin preautorización ni almacenamiento de tarjetas. |
| Reservaciones | Agenda persistida con nombre/contacto, personas, mesas, horarios, conflictos y estados. Sentar requiere una cuenta real. No es un sistema público de reservaciones. |
| Promociones | Biblioteca y descuento manual por producto/categoría, cálculo sobre consumos elegibles y capturas inmutables. Una promoción reemplaza el descuento actual; no hay aplicación automática ni acumulación. [Detalle](scoped-promotions.md). |
| MiroFish | Dos ejecuciones del motor oficial y ocho entrevistas verificadas. Una duda dirigida sobre el precio del QR se reprodujo y corrigió en la aplicación. El informe distingue opiniones del modelo, revisiones independientes y pruebas reales. [Informe](mirofish-restaurant-2026-10-07.md). |

## Lo que se deja para después

- Cantidades decimales o venta por peso: el motor actual trabaja con unidades enteras en cocina, división de pagos y devoluciones. Para porciones, se pueden configurar variantes u opciones como Media porción con precio explícito; esto no implementa cantidades fraccionarias.
- Cancelación financiera parcial de un tiempo ya preparado, combos configurables al cobrar, promociones automáticas/acumulables y operación contable multisucursal.
- Integraciones de reservación/pedido público, preautorización de tarjeta, facturación, delivery, recetas e inventario por ingrediente. Las funciones futuras de cocina no descritas por el socio no se inventaron.
- Offline operativo y pruebas físicas de terminal, impresora, Google real e instalación de PWA. El piloto propuesto depende de internet. El comprobante imprimible/PDF no es CFDI.

## Evidencia de desarrollo

Se conservaron los datos del stack local propio `pos-dev-fe2a8635e6`; no se reseteó la base ni se tocaron otros stacks. Las 15 migraciones nuevas `20261007100000` a `20261007240000` se aplicaron en orden y están congeladas. Correcciones posteriores usan otra migración.

Integraciones ejecutadas contra Auth, firmas de dispositivo, Edge y Postgres reales en loopback, con fixtures sintéticos y limpieza comprobada:

- Foundation: 3 casos, banco/impuestos/zona, importación/lotes, respuestas perdidas y revocación personal.
- Restaurante: 4 casos, tiempos, visitas, ocupación, sobremesa, pago parcial y compatibilidad de perfiles anteriores.
- Catálogo: 4 casos, biblioteca, negativos/repeticiones/agotados, anidados/combos y promociones con actor/tenant/reintentos.
- Menú público: 1 recorrido completo, privacidad, publicación, restricciones del dueño personal, consulta anónima, actualización y despublicación.
- Compatibilidad de servicio: 24 casos de operaciones anteriores y los 4 de restaurante pasaron nuevamente después de la migración 23. Mover o cerrar una cuenta anterior mantiene las mesas de su visita; cobrar una cuenta no libera la visita prematuramente.
- Equipo: 9 casos reales adicionales pasaron, incluyendo la proyección actual del perfil con cuenta de transferencia opcional.
- Point: 17/17 con el proveedor HTTP local persistente, worker manual, conexión OAuth, cobros, devoluciones, conciliación y reintentos. La limpieza de los negocios y usuarios sintéticos se verificó; no se reinició el proveedor ni se alteraron cuentas de desarrollo existentes. No acredita una terminal física ni OAuth humano de Mercado Pago.

Comprobación local final: `test:smoke` 531/531, componentes 554/554 en 60 archivos y toda la suite SQL 334/334 en 31 archivos. Las integraciones anteriores cubren 62 casos distintos con servicios reales y fixtures sintéticos, sin omisiones. En las nueve suites E2E seleccionadas pasaron 216 de 222 casos inicialmente; se corrigió la proyección del modo del negocio en el fixture de empleado y los seis casos fallidos pasaron al repetirse. No se presenta ese resultado como una ejecución única de 222 casos sin fallos. `npm run build`, incluido TypeScript y la comprobación de ausencia de acceso/credenciales de desarrollo en los artefactos, `npm run lint`, `git diff --check` y `deno check` del standalone account y public-menu pasaron. Estas pruebas no sustituyen hardware ni OAuth reales. El resultado del CI requerido completo se registra en el PR.

En navegador se observó el flujo de servicio completo con venta de $35, sobremesa de $28, cuentas originales conservadas y mesa liberada; luego el modo directo con venta de $36, recibido de $50, cambio de $14 y comanda automática. Se creó un plano y se publicó el menú sintético; cambiar un precio conservó el enlace. El proveedor de navegador recibió tamaños solicitados de teléfono, pero se midieron 487 píxeles CSS en la vista estrecha: no se afirma prueba en un teléfono físico ni 390 píxeles CSS exactos.

Una comprobación adicional en el mismo backend local creó un modificador compartido con ajuste negativo y un grupo hijo condicionado, más un combo fijo de dos componentes. La venta sintética conservó tres renglones de $37, $40 y $55, total $132, extras y componentes en cocina y comprobante, recibido $150 y cambio $18. Marcar una opción compartida agotada y cambiar otra de −$3 a −$4 se reflejó en el selector de una nueva cuenta; el comprobante anterior conservó sus precios originales. Se descartó el nuevo borrador antes de guardarlo.

También se creó y sentó una reservación sintética de 13:00 a 14:30, con una cuenta real de $36 y dos mesas asociadas. Después del pago ambas siguieron ocupadas; al completar su comanda y finalizar la visita, ambas quedaron libres y la agenda indicó Visita finalizada. Guardar y volver a abrir el editor de la misma mesa y su posición conservó los valores. No se modificaron la cuenta de $90 ni las tres comandas anteriores existentes en el entorno.

Los controles nativos de reservaciones se comprobaron en Chromium con reloj del dispositivo en Nueva York y negocio en Ciudad de México: creación, cambios de inicio/fin, selección de mesa, edición y recarga conservaron los instantes exactos, con dos guardados y las versiones esperadas. Pasaron los dos casos de escritorio/teléfono. La automatización de datetime-local del navegador integrado no conservó uno de los valores durante la entrada; se contrastó con la regresión de componentes y Chromium, sin atribuirlo a un defecto reproducido de la aplicación ni afirmar compatibilidad de WebKit. Después de las correcciones de mesa y etiquetas pasaron otros 30 casos específicos de componentes (15 de workspace, 11 de paneles y 4 de precios públicos); el CI completo del commit final se registra en el PR.

## Defectos corregidos durante la iteración

| Origen | Defecto | Resultado |
| --- | --- | --- |
| Revisión de interfaz | Desaparecer la categoría seleccionada dejaba el QR vacío. | Vuelve a Todo cuando la selección deja de existir. |
| Navegador | Primera mesa sin posición causaba una pantalla blanca. | Las mesas sin plano siguen disponibles como tarjetas; regresión del primer guardado. |
| Navegador + regresión de componentes | Volver a editar una mesa o su posición después de guardarla cerraba el formulario por reutilizar un resultado anterior. | Cada resultado se consume una vez; abrir nuevamente el mismo formulario conserva el borrador hasta una nueva respuesta aceptada. |
| Revisión de visitas + componentes | La tarjeta de una mesa tomaba el estado y saldo de una cuenta representativa aunque su visita podía tener otras cuentas pendientes; el listado decía Cuentas sin mesa para cuentas asociadas mediante visitas. | Las visitas activas muestran Ocupada/Ver visita y el detalle conserva el saldo agregado del servidor. Cuentas por nombre evita la afirmación incorrecta; el comportamiento anterior se conserva cuando no hay visita. |
| Navegador + backend | Perfiles antiguos sin flag explícito permitían cuentas en UI y rechazaban sobremesa en SQL. | Migración 22 conserva el contrato existente: desactivado sólo cuando el flag es false. Actor, sesión, permisos y replay se mantienen. |
| CI + integración real | Mover/cerrar cuentas mediante comandos anteriores no actualizaba la ocupación de su visita y podía producir VISIT_CHANGED o TABLE_OCCUPIED. | Migración 23 conserva la autorización y el resultado de reintentos; actualiza las mesas atómicamente y evita liberar visitas con varias cuentas o consumos retenidos. |
| CI + reproducción real | Point perdía la prueba del navegador en las RPC posteriores al I/O y convertía SESSION_INVALID en SERVER_ERROR. | Migración 24 y Edge conservan sólo el hash ya verificado, mantienen las comprobaciones vivas y restauran el contexto entre llamadas. [Detalle](point-browser-context.md). |
| Revisión de promociones | Recuperación incompleta podía fallar; más de 24 categorías y criterios heredados invisibles. | Validación de recuperación sin canonicalizar la solicitud, límites y criterios removibles visibles. Biblioteca actualizable. |
| Revisión de concurrencia | Respuesta antigua podía borrar/sobrescribir la recuperación nueva de menú o CSV del mismo actor. | Guard de sesión vigente y comparación exacta de ledger/UUID/payload antes de persistir o borrar. |
| Navegador | Cuenta pagada con saldo cero se etiquetaba Pago parcial y liberación esperaba polling. | Etiqueta pagada y actualización inmediata tras acciones de servicio. |
| Navegador + regresión de componentes | Una actualización periódica del padre cerraba el borrador de un tiempo de cocina al cambiar la referencia del manejador de errores. | El formulario conserva su texto y cantidades ante cambios del callback; cambiar actor o cuenta sí invalida el acceso anterior. 11/11 casos de paneles de servicio. |
| MiroFish dirigido + reproducción en navegador | QR mostraba $30 aunque las únicas variantes costaban $40 y $55. | Muestra Desde $40 y considera disponibilidad de tamaños; regresión de precios fijos/abiertos/agotados. |

## Backend y publicación

Esta rama añade contratos y backend. Antes de fusionar, verificar el proyecto y su historial, aplicar las 15 migraciones nuevas en orden y publicar `account`, `public-menu` y los endpoints que empaquetan los módulos Point compatibles. Las funciones privadas conservan RLS/grants mínimos y la autorización del endpoint account. Seguir [DEPLOYMENT.md](../DEPLOYMENT.md); CI no aplica migraciones ni publica Edge Functions.

La migración 11 vincula sesiones personales al navegador y la 24 transporta esa prueba entre RPC de Point. El Edge anterior no conserva el contexto; el Edge nuevo no debe enviar el campo interno a las RPC antiguas. Este bloque exige una ventana coordinada para Point: pausar operaciones nuevas, identificar y conservar cobros pendientes o inciertos, aplicar el bloque en el orden del historial y publicar las funciones compatibles. Comprobar después grants, contexto del navegador, OAuth/configuración y conciliación durable antes de restablecer Point; fusionar el frontend sólo cuando el backend esté verificado. No se resuelven cobros desconocidos por el mantenimiento ni se promete continuidad durante ese bloque. [Fronteras y plan](point-browser-context.md).

El PR permite revisar una entrega concreta. Un build local o un PR abierto no acreditan publicación. No se hizo merge ni se modificó el backend alojado para esta entrega.
