# Separación de experiencias: dueño y empleado

Plan aprobado en esta conversación · 3 de octubre de 2026 · Implementado en dev; revisión visual pendiente de Larios.

## Objetivo y referencia

Después del PIN, el dueño debe entender cómo va su negocio; el empleado debe poder trabajar inmediatamente. La imagen aportada por Larios guía la composición: navegación oscura para la gestión, superficies blancas, números destacados, tarjetas discretas, búsqueda compacta y catálogo con fotografías.

La referencia es visual. Los importes, porcentajes, nombres y funcionalidades de la imagen son ejemplos; las pantallas de la aplicación mostrarán datos reales. Se conservan las decisiones humanas posteriores al plan original: registrar el pago envía la comanda; comandas únicamente pendientes/completadas; sin mesas en el recorrido de mostrador; cuenta compacta y cobro negro a pantalla completa.

## 1. Entrada y navegación

| Experiencia | Entrada tras el PIN | Navegación principal en teléfono | Navegación en tablet/escritorio |
| --- | --- | --- | --- |
| Dueño | Inicio: resumen del negocio | Inicio, Ventas, Productos, Reportes, Más | Sidebar: Inicio, Ventas, Productos, Empleados, Caja, Reportes, Configuración |
| Empleado con permiso para vender | Venta | Venta, Comandas, Historial, Más, mostrando solo los destinos autorizados | Sidebar blanca con esos mismos destinos autorizados |
| Empleado de cocina sin permiso para vender | Comandas | Comandas y Más; otras secciones solo si tiene permiso | Misma disponibilidad en sidebar blanca |
| Empleado con otros permisos | Primer módulo autorizado | Destinos correspondientes a sus permisos | Mismos módulos y acciones |

El dueño tendrá una acción visible **Ir a venta** y podrá volver a **Inicio del negocio**. Esto cambia el espacio de trabajo de la misma sesión; no lo convierte en otro empleado ni cambia sus permisos. No se añade una elección antes del PIN.

En la experiencia de operación del dueño se ofrecen Venta, Comandas e Historial. El acceso a gestión permanece visible. Se conserva la cuenta en curso al alternar entre gestión y operación, sin guardar PIN o tokens en almacenamiento persistente.

**Más** conserva Caja, Productos y Reportes cuando el empleado tiene los permisos correspondientes, además de sus acciones de sesión. Un permiso previamente concedido no desaparece por reorganizar el menú. Empleados, dispositivos y configuración del negocio mantienen sus comprobaciones exclusivas de dueño.

Prioridad inicial para empleados: Venta si tiene `sales.create` y `catalog.read`; después Comandas si tiene `orders.read` o `kitchen.read`; después Historial, Productos, Caja o Reportes según acceso. Sin módulos operativos autorizados, Más explica la falta de acceso. Los enlaces internos, recargas y botones Atrás aplican la misma autorización y regresan a un destino permitido.

La navegación móvil ajusta sus columnas al número de destinos visibles. No deja espacios reservados para opciones que el empleado no puede usar.

## 2. Inicio del dueño

Pantalla blanca con encabezado **Inicio**, nombre del negocio y selector de día. Jerarquía inspirada en la imagen:

1. Tarjeta principal de **Ventas netas**, con cobrado y devoluciones como detalle.
2. Dos tarjetas pequeñas: **Cobros** y **Ticket promedio**.
3. Distribución por método de pago y productos más vendidos.
4. Accesos a Caja, Empleados y Venta.
5. En una entrega posterior, gráfico de ventas por hora y comparación con otro período.

El primer inicio funciona con `BusinessDayReport`, que ya ofrece totales diarios, cantidad de ventas, métodos de pago, productos y diferencias de cierres. No necesita reconstruir cifras descargando páginas del historial.

Definiciones visibles y consistentes:

- Ventas netas = cobros registrados menos devoluciones efectivas en el período. Puede ser un importe negativo.
- Cobros = ventas registradas, no cuentas abiertas ni comandas. Con futuras cuentas divididas, cada venta registrada cuenta como un cobro, no como un nuevo cliente.
- Ticket promedio = importe cobrado después de descuentos, con IVA incluido, dividido entre cantidad de cobros. Se calcula con redondeo exacto en centavos. Sin cobros, muestra «—».
- Descuentos, devoluciones, IVA conocido y condonaciones permanecen disponibles en el detalle del reporte. Las condonaciones no se suman a ingresos.
- El día pertenece a la zona horaria del negocio. Una devolución aparece en su fecha efectiva y conserva el vínculo con la venta original.

No se muestra crecimiento porcentual hasta disponer de una comparación válida. Si el período anterior es cero, se muestra «Sin base de comparación». Un día en curso se identifica como parcial y se compara con una ventana equivalente, no con un día completo. «Sin ventas» y «No pudimos cargar» son estados diferentes; un error nunca se presenta como $0.

## 3. Experiencia del empleado

**Venta.** Búsqueda discreta, categorías en chips, catálogo con fotografías reales o el fallback actual, nombre y precio alineados. Dos columnas en teléfono; más columnas según el espacio disponible en tablet. Cuenta lateral en pantallas amplias y panel deslizante en teléfono. Se conserva la edición compacta de cantidades, modificadores, borrado con confirmación e IVA relevante.

**Cobro.** Continúa a pantalla completa negra, con importe destacado y métodos disponibles desde la entrada. Registrar pago es la única acción final. La flecha regresa a editar la cuenta. La confirmación de éxito aparece después de la respuesta aceptada del servidor; una respuesta incierta conserva su recuperación. No se añade preparación manual, un envío separado a cocina ni otro paso para finalizar.

**Comandas.** Dos vistas: Pendientes y Completadas. Cada tarjeta muestra folio, hora y artículos/modificadores. Quien tiene `kitchen.operate` puede completar; quien solo tiene lectura puede consultar. Se mantiene la burbuja de pendientes y la actualización silenciosa, evitando flashes de alertas o pantallas vacías.

**Historial.** Reutiliza Ventas con el alcance del servidor: ventas propias con `sales.read_own`, todas con `sales.read_all`. La etiqueta Historial evita confundir tomar una Venta con consultar Ventas. Las devoluciones requieren su permiso y el recorrido de confirmación existente.

**Caja y disponibilidad.** Accesibles según las casillas concedidas por el dueño. Un diseño operativo más sencillo no elimina apertura/cierre de turno, movimientos, bloqueo durante conteo ni controles de disponibilidad manual.

## 4. Lenguaje visual

- Sidebar del dueño en carbón cercano a `#232527`, texto blanco y selección gris clara sobre el carbón; contenido blanco o gris muy tenue.
- Empleado: superficies blancas, texto negro, controles simples y selección negra. La sidebar de teléfono se adapta a navegación inferior; no se encogen las maquetas de tablet.
- Mantener IBM Plex Sans local y Lucide. Títulos de 24–28 px, cifras principales de 32–40 px, texto de 14–16 px; precios y cantidades alineados.
- Tarjetas con bordes discretos, radios de aproximadamente 12 px y poca o ninguna sombra. Espaciado de 8/16/24 px; sin separadores repetidos entre artículos.
- Botones principales negros como en la referencia. La cuenta conserva su jerarquía de total y Cobrar; el cambio de color no modifica el proceso de venta.
- Verde solo para estados o variaciones positivas reales. Los datos financieros no se representan únicamente por color.
- Animaciones GSAP de 150–200 ms para transiciones y paneles, con limpieza en React y reduced motion. Sin animaciones decorativas continuas ni movimiento que retrase vender.
- Objetivos táctiles de al menos 48 px, foco visible, nombres accesibles y adaptación al teclado y a las áreas seguras del dispositivo.

## 5. Estructura de implementación

Conservar React, Vite, Tailwind, Supabase y los transportes firmados existentes. Separar composición visual y navegación; reutilizar la operación y la gestión actuales.

| Pieza | Cambio previsto |
| --- | --- |
| `src/lib/navigation.ts` | Resolver experiencia, destino inicial y destinos autorizados a partir de dueño/permisos actuales. Identificadores de destino independientes de sus etiquetas. |
| `src/components/HomeScreen.tsx` | Extraer el shell y los menús gradualmente; mantener control sobre la cuenta, intentos y sesión compartidos. |
| `WorkspaceShell` | Encabezado, sidebar adaptable y navegación móvil. La experiencia decide la presentación; los permisos deciden los accesos. |
| `OwnerDashboard` | Inicio del dueño sobre los agregados diarios existentes. |
| `ReportsScreen` y un hook de reporte | Compartir carga autorizada y resumen con Inicio, sin duplicar cálculos financieros. |
| `SaleScreen`, `CheckoutPanel`, `OrdersScreen`, `SalesScreen` | Refinar presentación conservando sus contratos y reglas de operación. |
| `src/App.tsx` y entrada compartida de empleados | Abrir el destino apropiado después del PIN y limpiar vistas privadas al terminar la sesión. |

La primera separación no requiere migrar identidades ni sustituir las casillas por los puestos Cajero/Cocina/Gerente de la imagen. El dueño sigue siendo la identidad protegida; los permisos explícitos siguen autorizando al empleado en el servidor.

Cargar datos por la pantalla que los necesita: no descargar catálogo para dibujar Inicio ni reportes completos para mostrar Venta. Mantener la consulta necesaria para el contador de comandas y las recuperaciones autorizadas. Cualquier ampliación del endpoint debe devolver solo la información permitida al actor actual.

La cuenta en edición debe vivir por encima del cambio de experiencia o permanecer montada cuando se oculta. No crear dos copias del carrito ni dos controladores de cobro. Bloqueo, cambio de negocio y cambio de operador ocultan/limpian datos de la sesión anterior; respuestas tardías no restauran esa vista. Los intentos duraderos inciertos conservan la recuperación existente y vuelven a autorizar al resolverlos.

## 6. Entregas progresivas

| Entrega | Resultado revisable | Backend |
| --- | --- | --- |
| 1. Separación e Inicio básico | Dueño entra a Inicio con cifras diarias reales; empleado entra a su tarea. Menús distintos y acceso del dueño a Venta, conservando su cuenta. | Reutilizar permisos y reporte diarios. |
| 2. Interfaz operativa | Catálogo, cuenta, historial y comandas coherentes con la referencia; recorrido de cobro directo conservado. | Contratos actuales. |
| 3. Gestión | Rediseño de Productos, Empleados, Caja, Configuración y reporte diario; accesos directos desde la gestión. | Contratos actuales. |
| 4. Analíticas por período | Hoy/fecha, semana y mes; series por hora/día y comparaciones correctas. | Agregados de período autorizados, con rango acotado e índices verificados. Publicar backend compatible antes del frontend. |
| 5. Consistencia y estados | Ajustar teléfono/tablet, carga silenciosa, errores, foco, reduced motion y navegación de vuelta. | Solo correcciones demostradas por la revisión. |

Cada entrega debe funcionar por sí sola y quedar disponible en el mismo dev de esta conversación para la revisión visual de Larios. No hacer commits hasta su instrucción. Larios realiza las pruebas de navegador, según su preferencia vigente.

La entrega 4 ampliará validación HTTP, tipos y SQL conjuntamente mediante una migración nueva. El reporte seguirá siendo la fuente de totales; gráficos y tarjetas usarán exactamente sus filtros. No calcular semana/mes sumando registros truncados por paginación ni haciendo cientos de consultas diarias. El desfase de UTC, días de 23/25 horas y fechas parciales deben resolverse en servidor. Las agrupaciones por empleado requieren identidad estable; nombres coincidentes no acreditan ser la misma persona.

## 7. Verificación

Pruebas específicas de destino inicial, destinos autorizados, enlaces/recarga, consultas que no se envían sin permiso, y transición de dueño entre Inicio y Venta sin perder la cuenta. Cubrir empleados de venta, cocina de lectura/operación, catálogo, reportes y sin permisos, incluyendo el registro compartido.

Conservar regresiones de doble envío, respuesta perdida, revocación durante una consulta, cambio de operador, bloqueo/cierre de caja y contador de comandas. Para analíticas: centavos exactos, IVA desconocido, período vacío, devolución de una venta anterior, promedio sin cobros, límites de rango, zona horaria, comparación parcial e identidad de operador.

Ejecutar pruebas enfocadas y Basic checks por entrega. Las pruebas de componente no sustituyen aislamiento/autorización en servidor. No repetir toda la batería ni automatizar el navegador para cada ajuste visual.

## 8. Alcance del MVP

Clientes/CRM, cuenta a crédito del cliente, impresión, WhatsApp, pagos por QR integrados, liquidación bancaria y nuevas etapas de preparación quedan fuera de esta separación. Los métodos de pago siguen siendo los configurados y registrados manualmente. Los reportes por operador describen cobros; no se presentan como una medición completa del desempeño laboral.

## Fuentes y estado observado

Instrucción e imagen aportadas por Larios en esta conversación, 3 de octubre de 2026. Las decisiones anteriores de esta misma conversación gobiernan el cobro, las comandas y la cuenta compacta.

Código observado al preparar el plan en el worktree `lean-pos-mvp`: `HomeScreen.tsx` usa actualmente la misma lista de cinco destinos e inicia con el primero autorizado; `navigation.ts` y `hasPermission` ya separan propietario/permisos; `ReportsScreen.tsx` y `BusinessDayReport` ofrecen agregados diarios, pero no un contrato de series horarias o períodos. Consultados `docs/employee-permissions.md`, `docs/lean-pos-mvp.md`, `design-system.md` y `reference-read.md`.

Drive consultado el 3 de octubre: [02 — Estado y contexto](https://docs.google.com/document/d/1LscJgrEZqeErmUNrTtjyPCqzyyvbQxLbWoQiZUOnezw/edit), [04 — Decisiones](https://docs.google.com/document/d/1LH-eIYL7TUmlANXWsbVNvZlnKitns02nMrQZ9PXUOPM/edit) y [05 — Sesiones recientes](https://docs.google.com/document/d/1D7nis14wckYZuFodOX2gkW10wdn9DCLhkr3H4Df9aJ0/edit). Conservan antecedentes y recomendaciones sobre terminales; no aportan autorización para ampliar pagos, publicar o contactar a terceros. No se modificó Drive.

## Implementación y evidencia · 3 de octubre de 2026

Las cinco entregas están conectadas en el worktree de esta conversación. `WorkspaceShell` separa gestión y operación; `ReportDashboard` comparte Inicio/Reportes con el hook `usePeriodReport`. App conserva una sola instancia de Home al visitar Empleados, Configuración, Dispositivos, Notificaciones y cambio de PIN. Venta permanece montada al cambiar de destino. La entrada del registro compartido reutiliza esta misma composición con sus permisos.

La revisión independiente de `/root/owner_employee_plan_review` detectó y motivó tres correcciones: conservar la cuenta al salir de Home, consultar turno/intentos al abrir Ventas desde gestión y admitir lectura operativa restringida para empleados que solo consultan historial y hacen devoluciones. No se modificó la identidad protegida del dueño ni el modelo de sesiones. Las respuestas operativas de esos empleados siguen ocultando importes/movimientos de caja y órdenes/cobros sin permiso.

La migración nueva `20261003002900_owner_analytics.sql` agrega `report_period` con fechas 2000–2100, Día/Semana/Mes, series por hora o día, y comparación con la ventana anterior. Reutiliza la definición financiera aceptada del reporte diario, incluidos snapshots y devoluciones efectivas. Las series leen el índice existente de negocio/fecha. Un mes parcial que ya supera los días disponibles del mes anterior marca la comparación como no equivalente y no muestra crecimiento. Los períodos futuros se identifican y sus puntos del gráfico aparecen como pendientes. Los agregados por nombre se etiquetan explícitamente; no representan identidad ni desempeño.

El backend compatible se aplicó primero al stack loopback `pos-dev-fc8131d388` mediante `migration up`, sin resetear datos. El servidor Vite de este worktree sirve en http://127.0.0.1:5183/. No hubo commits, push, PR, cambios en Drive ni publicación alojada. Larios conserva la revisión en navegador; no se automatizó el navegador ni se acreditan pruebas físicas de teléfono/tablet.

La verificación enfocada cubre entrada/destinos por permiso, conservación y borrado confirmado de cuenta, estados de comandas, carga autorizada para devoluciones, descarte de respuestas de filtros/sesiones anteriores y revocación de reportes. Las migraciones reales se prueban en PostgreSQL embebido: aislamiento, cantidades/centavos, calendario semanal/mensual, días DST de 23/25 horas, devolución de venta anterior y redacción para empleados con solo devoluciones. Dos pruebas seleccionadas de integración ejercen Auth/Edge/Postgres locales con firmas reales, reportes y revocación; las demás pruebas de esa suite no se ejecutaron en esta entrega. Se ejecutan también Basic checks y lint. Los casos de navegador anteriores conservan textos/selecciones históricos y requieren actualizarse cuando Larios autorice retomar esa automatización.

Resultado final de verificación local: **59/59** unitarias (`test:smoke`), **54/54** casos enfocados de componentes/PostgreSQL embebido y **2/2** casos seleccionados de integración Auth/Edge/Postgres (14 casos de esa suite omitidos por selección), `npm run build`, lint y `git diff --check` correctos. Vite respondió HTTP 200 y el ledger local alcanzó 20261003002900. Un primer intento de integración esperaba HTTP 403 al reutilizar una credencial de otro negocio: el servidor devuelve correctamente `SESSION_INVALID`/401. Se corrigió la expectativa y se comprobó además el rechazo 403 de un reporte con credencial fresca pero sin permiso.
