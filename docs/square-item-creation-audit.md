# Creación de productos: revisión de Square y adaptación al POS

Revisión del 6 de octubre de 2026, America/Chicago. Fuente primaria: el [editor de creación de artículos de Square](https://app.squareup.com/dashboard/items/library/new) abierto en el navegador del usuario. Se leyeron el formulario de alimento/bebida preparados y los paneles de nombres, nutrición, variaciones, conjuntos de opciones, atributos, unidades y ficha del POS. No se guardaron artículos ni atributos en Square. Las opciones observadas corresponden a esa cuenta y ese tipo de artículo; no acreditan todos los planes, países ni capacidades de Square.

Se consultaron en Drive **02 — Estado del negocio y contexto**, **04 — Decisiones y pendientes**, las últimas entradas de **05 — Registro de sesiones** y la guía de terminales del Agente de Ademir del 2 de octubre. Esos documentos conservan propuestas y evidencia fechada; el código vigente y este encargo humano gobiernan esta implementación. No se modificó Drive.

## Comparación y alcance

| Función observada en Square | Situación previa del POS | Resultado de esta entrega |
| --- | --- | --- |
| Nombre, categoría y descripción | Disponibles | Se conservan y se integran con los campos opcionales. |
| Nombre para cliente | Persistido, oculto; el flujo operativo usaba el nombre interno | Editor disponible; las nuevas líneas guardan el nombre para cliente en la cuenta y venta. |
| Nombre para cocina | Persistido, oculto; ya conectado a comandas | Editor disponible; se conserva el snapshot separado de cocina. |
| Tipo de artículo | Persistido, oculto | Alimento/bebida, producto físico, servicio u otro. Los tipos digitales/eventos existentes se conservan, sin ofrecer nuevas capacidades de entrega o reserva. |
| Fotografía por archivo o biblioteca | Carga individual | Se añade arrastrar/soltar y reutilizar fotos de otros productos del mismo negocio. Se conserva quitar/cambiar y la carga privada acotada. |
| Etiqueta y color de ficha | Persistidos, ocultos | Etiqueta de hasta 8 caracteres, paleta y vista previa; la foto prevalece sobre la etiqueta. |
| Precio fijo o variable | El backend admite ambos; editar convertía el variable a fijo | Elección explícita; editar conserva el precio abierto. El importe se pide al vender y conserva centavos exactos. |
| Impuestos | IVA mexicano ya conectado | Se conserva IVA incluido y la clasificación vigente por producto. |
| SKU y GTIN/código de barras | Persistidos y buscables, ocultos | Editables por producto y variante; se conservan ceros iniciales. No se promete lector físico ni certificación del dígito de control. |
| Calorías, preferencias y alérgenos | Persistidos; sólo alérgenos editables/visibles | Todos editables y visibles en los detalles de Venta. Vacío conserva información desconocida; no se infieren valores. |
| Variaciones manuales | Disponibles | Se conservan precios, identificadores y disponibilidad por variante. |
| Conjuntos de opciones que generan variaciones | No disponibles | Hasta 3 opciones generan una vista previa de hasta 20 variantes. Añadir combina con las existentes sin sobrescribir precios ni códigos. Los conjuntos son por producto. |
| Grupos de modificadores | Disponibles, con mínimo/máximo y precios | Se añaden copias independientes desde otros productos; cada copia recibe identificadores nuevos. El servidor impide exigir más de 24 selecciones en total. |
| Atributos personalizados: texto, número, selección, toggle | No disponibles | Adaptación de texto: hasta 8 atributos de nombre/valor, guardados, buscables y visibles. No se crea una biblioteca global de definiciones ni tipos adicionales. |
| Omitir personalización cuando sea posible | No configurable | Configurable por producto. Agrega directamente si no hay precio abierto, extras obligatorios ni varias variantes disponibles. Los detalles siguen permitiendo elegir extras opcionales. |
| Estado/disponibilidad | Activación y agotado manual ya conectados | Se conservan; no se recupera el inventario automático histórico. |
| Categorías | Una categoría por producto con filtros | Se conserva este contrato y sus snapshots de reporte. Categorías múltiples/rutas de impresora quedan fuera. |
| Control de inventario, unidades y venta de múltiples unidades | Disponibilidad manual y cantidades enteras | Fuera: requiere existencias, conversiones, reservas y reconciliación que el módulo actual no opera. |
| Artículo que no se vende individualmente/materiales internos | No disponible | Fuera: depende de composición y consumo de inventario/costos. |
| Elegibilidad para descuentos por artículo | El descuento actual se reparte a nivel de cuenta | Fuera: requiere extender descuentos, reparto de IVA, división y correcciones financieras de forma conjunta. |
| Tiempo de preparación y métodos de entrega | Comandas internas; no promesa de entrega | Fuera: el panel observado configura cumplimiento de pedidos online; no se introduce una estimación sin planificación operativa. |
| Preventa y precio promocional online | Sin tienda online | Fuera: requiere pedidos futuros, publicación y cumplimiento. |
| Peso/envío, SEO y enlaces sociales | Sin comercio electrónico | Fuera. |
| Menús, sucursales y canales | Un negocio/ubicación y PWA interna | Fuera: no se finge operación multiubicación ni publicación en terceros. |
| Creación automática con IA | Sin generación de catálogo | Fuera: no hay generador integrado ni validación de información alimentaria propuesta. |

## Recorrido y límites

**Productos → Agregar producto** conserva nombre, categoría, foto, precio e IVA como recorrido básico. Los nombres/códigos, apariencia, información alimentaria y atributos usan secciones opcionales. Los precios abiertos y las variantes son excluyentes; cambiar de modo no borra variantes silenciosamente. Los campos de precios de variantes/extras conservan su texto mientras se edita y rechazan un valor vacío, en vez de convertirlo a cero.

En **Venta**, el botón de tres puntos permite **Ver detalles y opciones** a los usuarios autorizados para vender. Los permisos siguen controlando cambios de agotado/favoritos. Consultar información alimentaria no obliga a confirmar cada producto sencillo. La opción de agregar directo nunca omite elecciones requeridas; la validación financiera en servidor sigue verificando variantes, extras, precio e IVA.

Los metadatos siguen privados al negocio. El comando firmado conserva el límite HTTP de 8 KiB y el editor reserva espacio limitando su payload a 6800 bytes. Atributos adicionales tienen claves exactas, nombres únicos y límites compartidos de 8 entradas, 40 caracteres de nombre y 120 de valor. Un reintento aceptado conserva UUID y payload; los cambios posteriores del catálogo no alteran el resultado original ni los snapshots de órdenes anteriores.

### Paridad al tomar y editar cuentas

La auditoría previa al primer cliente del 6 de octubre encontró que el editor de cuentas conservaba un recorrido anterior al catálogo ampliado. Ahora aplica la misma preferencia de agregar directamente, muestra «Precio abierto» o el mínimo de las variantes disponibles y ofrece **Detalles** para consultar nutrición, atributos y personalizar extras opcionales. Un precio abierto, un extra obligatorio o varias variantes disponibles continúan exigiendo elección.

Los detalles se pueden consultar al alcanzar 40 líneas o con una cuenta bloqueada, pero agregar y guardar permanecen desactivados. El editor calcula el subtotal bruto con los precios aceptados de las líneas y enteros exactos, respetando los límites existentes de cantidad, precio unitario y total. Cambiar el catálogo no recalcula una línea histórica. Una cantidad excesiva muestra un error antes de iniciar una solicitud nueva; reducirla permite guardar. La recuperación de una solicitud pendiente conserva el comando original fuera de ese guard.

No se impone a cuentas históricas el presupuesto conservador de 6800 bytes: el límite HTTP real incluye acceso y firma y puede admitir comandos anteriores mayores. Esa restricción adicional podría impedir editar una cuenta previamente aceptada. Se conserva la validación existente del transporte y servidor.

La corrección pasó 63 pruebas de componentes y 8 recorridos nuevos de escritorio/móvil. Estos últimos ejecutan SQL real embebido y verifican guardar, editar después de un cambio de catálogo, enviar a cocina y cobrar con snapshots originales; precios abiertos/variantes, agregado directo, subtotal máximo y geometría/tacto a 320, 390 y 1024 px.

## Backend y validación

La migración nueva `20261006200000_square_catalog_options.sql` mantiene las claves históricas y admite `skipCustomization` y `customAttributes` como campos opcionales. Amplía la validación privada y captura el nombre público únicamente al insertar líneas de orden, sin reescribir historia. Las líneas por importe sin producto conservan su propio nombre. No añade acceso de navegador a tablas privadas ni modifica cálculos monetarios.

Antes de publicar el cliente, aplicar y verificar la migración y el validador Edge compatible siguiendo DEPLOYMENT.md. Esta entrega se prepara para revisión y desarrollo local; abrir el PR o comprobar dev no publica el backend alojado.

Las suites específicas verifican persistencia y edición, reintento de respuesta perdida, permisos/tenant, snapshots de cliente/cocina, precio abierto con extras/IVA, variantes y códigos, atributos escapados, agregado directo con decisiones obligatorias y límites/touch targets a 320, 390, 1024 y 1440 px. Los tests embebidos usan PostgreSQL PGlite; los tests de navegador interceptan Auth/HTTP con fixtures sintéticos y ejecutan SQL real embebido. La verificación adicional Auth/Edge/PostgreSQL usa únicamente backend loopback. Ninguna de estas pruebas acredita instalación PWA física, lector de códigos, Google alojado o publicación productiva. La evidencia final y los comandos corresponden al PR.
