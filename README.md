# POS México

Punto de venta para cafeterías y restaurantes en México, con cobro directo o servicio con cuentas abiertas. Incluye catálogo, mesas, comandas, caja, empleados, reportes, menús QR y pagos integrados con Mercado Pago Point. La interfaz está en español, usa MXN y se adapta a teléfono, tablet y escritorio.

Es una PWA construida con React, TypeScript y Vite. Cloudflare Pages sirve el frontend; Supabase proporciona Auth, Edge Functions y PostgreSQL. La operación requiere conexión a internet.

[Aplicación pública](https://pos-mexico-mvp.pages.dev) · [Reglas para agentes](AGENTS.md) · [Mapa del código](docs/code-map.md) · [Colaboración](CONTRIBUTING.md) · [Publicación](DEPLOYMENT.md)

Este README describe el código actual del repositorio. La evidencia de publicación y pruebas de cada entrega está en su PR y en [GitHub Actions](https://github.com/sasori-solutions/POS-mvp/actions/workflows/ci.yml). Los documentos fechados conservan el alcance de su revisión; no acreditan por sí solos la versión alojada ni pruebas de hardware.

## Clonar y empezar

Necesitas acceso al repositorio, Git, **Node.js 24** con npm y **Docker Desktop en ejecución**. En Windows, Docker debe usar contenedores Linux.

```sh
git clone https://github.com/sasori-solutions/POS-mvp.git
cd POS-mvp
git switch -c feat/mi-tarea origin/main
npm ci
npm run dev
```

Elige un nombre de rama para tu tarea. Tu clon es tu entorno de trabajo; si vas a realizar varias tareas en paralelo, usa un worktree propio para cada una según [CONTRIBUTING.md](CONTRIBUTING.md).

Abre **http://127.0.0.1:5173**, pulsa **Entrar en desarrollo** y selecciona la cuenta del dueño. El PIN inicial es **`123456`**, exclusivamente para este entorno sintético.

| Cuenta local | Para qué sirve |
| --- | --- |
| `owner@pos.local.test` | Dueño de Cafetería de desarrollo, con tres productos y PIN inicial `123456` |
| `new@pos.local.test` | Crear un negocio y configurar su PIN |
| `employee@pos.local.test` | Aceptar una invitación del dueño en otro contexto de navegador y elegir su PIN |

La pantalla completa la contraseña local. **No necesitas Google, credenciales de Mercado Pago ni crear un `.env.local`** para el arranque normal. Los datos de prueba se guardan en PostgreSQL real: permisos, sesiones, PIN, revocación y persistencia usan el backend de la aplicación.

`npm run dev` prepara un stack Supabase exclusivo para la ruta de tu checkout, aplica migraciones pendientes sin borrar datos, sirve las Edge Functions actuales e inicia Vite. El primer arranque puede tardar mientras Docker descarga imágenes. El runner imprime las URL del API y del buzón Mailpit, donde se capturan los correos de recuperación sin enviarlos a personas reales.

Los cambios, ventas y PIN se conservan al reiniciar. Cambiar de carpeta cambia la identidad del stack; no se comparten automáticamente los datos entre clones/worktrees. Ctrl+C detiene los servidores de esa sesión. Para detener también los contenedores de este checkout conservando sus datos:

```sh
npm run dev:stop
```

Si el puerto del frontend está ocupado:

```sh
npm run dev -- --port 5177
```

El runner falla de forma visible si falta Docker o hay conflictos de puertos; no cambia al backend alojado. Consulta [Desarrollo local](docs/local-development.md) para persistencia, recuperación y diagnóstico. `npm run dev:frontend` queda para pruebas o un backend elegido explícitamente con su configuración pública; no prepara el backend local.

## Funciones actuales

### Negocio, acceso y equipo

- Alta y edición del negocio: nombre, tipo, ubicación, contacto, logos, nombres de sucursal/caja, zona horaria, medios de pago y modalidad de cobro. La zona se detecta al crear el negocio y se puede corregir; los horarios y reportes usan la zona guardada.
- Elección de IVA predeterminado para productos nuevos, con posibilidad de definirlo después por producto. Los productos y comprobantes anteriores conservan su tratamiento.
- Inicio de sesión con Google en el entorno alojado, selección de negocio y PIN personal de seis dígitos, incluidos ceros iniciales. Bloqueo, cierre de sesión, cambio de PIN conocido y recuperación por enlace de correo de un uso y 15 minutos. Recuperar el PIN no concede una sesión de acceso.
- Invitaciones de empleados por enlace/QR y lectura de QR desde la interfaz. Cada empleado entra por `/employee` con Google y elige su propio PIN; el dueño asigna permisos por grupos para catálogo, venta, cuentas, cocina, caja, historial y reportes.
- Vinculación del navegador del empleado, solicitudes de reemplazo y aprobación/rechazo del dueño mediante notificaciones. Dispositivos personales y cajas compartidas muestran actividad y permiten revocar acceso.
- Eliminación permanente del acceso del empleado a ese negocio. Una invitación posterior crea una identidad de empleado, PIN y vinculación nuevos.
- Emparejamiento de cajas compartidas en `/register` para empleados existentes con acceso sólo por PIN. Los empleados vinculados a Google usan su navegador personal autorizado.
- Inicio del dueño con indicadores del negocio y acceso al espacio operativo. La navegación de empleados muestra los módulos permitidos; un empleado puede tomar órdenes sin recibir permiso para cobrar.

### Catálogo

- Crear, editar, buscar, filtrar por categoría, marcar favoritos, activar, desactivar y eliminar productos. La eliminación conserva las ventas históricas; la disponibilidad manual permite marcar productos, variantes y opciones como agotados.
- Fotografía, descripción, categoría/tipo, nombres para cliente/cocina, SKU, código de barras, etiqueta/color, información nutricional, alérgenos y hasta ocho atributos personalizados. No hay lectura integrada de escáner de códigos de barras.
- Precio fijo o abierto, tamaños/variantes con precios propios y generador de combinaciones de hasta tres dimensiones y veinte variantes. Precio abierto sin variantes; cantidades de venta en unidades enteras.
- Modificadores con selección opcional/obligatoria, límites, ajustes positivos o negativos y repeticiones limitadas. Biblioteca compartida reutilizable, copia de otro producto o copia independiente; grupos condicionales anidados hasta tres niveles.
- Combos con precio explícito y hasta ocho componentes fijos. Los componentes, extras y precios quedan capturados para venta, cocina y comprobante; no son combos recursivos ni configurables al cobrar.
- IVA por producto y desglose de los importes conocidos, con asignaciones exactas de descuentos e impuestos.
- Exportación e importación CSV con previsualización y validación, hasta 500 productos/512 KB. Cada lote se guarda de forma atómica; una importación con varios lotes conserva el progreso aceptado y recupera respuestas perdidas con la solicitud original. El formato propio conserva campos complejos mediante JSON y referencias de fotos del mismo negocio; no transporta archivos de imagen ni promete aceptar cualquier CSV externo.
- Edición masiva de categoría, estado activo, IVA y precio base, conservando los precios propios de las variantes y comprobando versiones del catálogo.

### Venta, cobro y comprobantes

| Modalidad | Recorrido |
| --- | --- |
| **Cobro directo** | Catálogo → cobro → comanda automática de productos → comprobante → siguiente venta |
| **Cuentas abiertas** | Mesas/cuentas/reservaciones → consumos → envíos a cocina → cobro al final → finalizar visita |

El dueño elige la modalidad en **Configuración → Cómo cobras**. Guardar una cuenta o enviarla a cocina no registra ingresos. Desactivar nuevas cuentas permite resolver las existentes.

- Carrito con productos, variantes, modificadores, cantidades y notas. **Venta → Importe** añade un cargo libre con concepto opcional, solo o combinado con productos; no crea catálogo ni preparación de cocina.
- Cobro completo, división por artículos o **Dividir por cantidad**, hasta veinte importes. Cada parte reduce el saldo únicamente después del pago confirmado y conserva su comprobante. Después del primer pago por importe, esa cuenta continúa por importe o salda el resto completo.
- Reservas de cobro en servidor para evitar cobros concurrentes sobre el mismo saldo, versiones de cuenta y recuperación de operaciones cuyo resultado se desconoce. Reintentar la misma solicitud aceptada no registra otra venta.
- Descuentos fijos o porcentuales para toda la cuenta o para productos/categorías elegibles. Biblioteca de promociones guardadas, aplicadas manualmente; una promoción reemplaza el descuento vigente y no se acumula automáticamente.
- Historial paginado y detalle de ventas propias o del negocio según permisos. Los comprobantes conservan nombres, precios, extras, combos, descuentos, IVA, operador y medio de pago del momento de la venta.
- Comprobante imprimible o guardable como PDF mediante el diálogo del navegador. **No es CFDI**; no se afirma compatibilidad con una impresora física sin probarla.

### Medios de pago y Mercado Pago Point

Los cuatro medios son independientes y se habilitan según la configuración del negocio:

| Medio | Comportamiento |
| --- | --- |
| Efectivo | Registro del pago y calculadora opcional de recibido/cambio, con billetes rápidos y validación de recibido suficiente |
| Tarjeta externa | Registro manual después de confirmar aprobación en una terminal externa; el POS no envía el cargo a esa terminal |
| Transferencia | Instrucciones con beneficiario, banco y CLABE opcionales privados; el cajero confirma la recepción, sin verificación bancaria automática |
| Mercado Pago Point | Envía el importe reservado a una terminal vinculada y registra el pago después de verificar su aprobación con el proveedor |

Point incluye conexión OAuth, selección y comprobación de terminal, entornos de prueba/producción, activación controlada, intentos persistentes, conciliación por worker/webhook, estados pendientes o inciertos y devoluciones totales/parciales por importe verificadas con el proveedor. Una respuesta de envío o un timeout no equivalen a pago aprobado; recargar o bloquear el navegador conserva el intento en servidor.

Su panel y estados mensuales distinguen pagos del proveedor y comisión SASORI cuando corresponde, con exportación de estados de cuenta en CSV. El recorrido administrativo registra evidencia de facturación y abonos manuales con una autorización privilegiada separada; no emite CFDI ni verifica una liquidación bancaria.

La integración envía el importe, no el catálogo de productos, y solicita `no_ticket`; el comprobante del POS usa sus propios datos históricos. La configuración productiva, scheduler, OAuth y terminal requieren el [runbook de Point](docs/point-pilot-runbook.md). Los datos de tarjeta no se capturan en el POS.

Para desarrollar todo el recorrido con un **proveedor HTTP sintético local**, sin cargos bancarios:

```sh
npm run dev -- --point-simulator --port 5177
```

Entra con el dueño local, abre **Vincular una terminal**, conserva **Pruebas**, conecta Mercado Pago, vincula/comprueba **Terminal de prueba** y activa el modo prueba. Activa la operación en Caja y abre un turno antes de cobrar. El worker local procesa la cola mientras el runner está abierto; las claves y órdenes sintéticas persisten en `.local-dev/`.

Este proveedor local es distinto del simulador oficial y de una terminal física. El arranque normal sin `--point-simulator` mantiene los nuevos cobros Point deshabilitados. Los escenarios de rechazo, respuesta perdida y conciliación están explicados en [Desarrollo local](docs/local-development.md).

### Servicio de restaurante y cocina

- Cuentas persistentes por nombre o mesa, edición de consumos autorizada y envío de nuevos artículos a cocina. Cada envío conserva una preparación inmutable y cobrar no duplica artículos ya enviados.
- Comandas compartidas con estados **Pendientes**, **En proceso** y **Completadas**, notas, extras, componentes de combos y avisos de cancelación.
- Tiempos de cocina para agrupar, retener y enviar artículos. Los retenidos bloquean el cobro/envío global hasta resolverlos; quitar un artículo de un tiempo conserva su consumo financiero.
- Mesas con nombre, estado activo, zona, posición, forma y lugares; plano y acceso al detalle de una mesa ocupada. Movimiento y cierre de cuentas con validación del servidor.
- Visitas con varias cuentas y mesas juntas. Pagar una cuenta no libera sus mesas: se liberan al finalizar la visita, con todas las cuentas resueltas y sin cobros pendientes ni tiempos retenidos.
- Sobremesa o bar mediante una nueva cuenta vinculada después de un pago parcial/completo, conservando comprobantes anteriores.
- Agenda interna de reservaciones con nombre/contacto, personas, mesas, horarios, conflictos y estados de llegada, cancelación o no-show. Sentar una reservación requiere una cuenta real; finalizar la visita actualiza la agenda.
- Cancelación de cuentas no pagadas, condonaciones autorizadas por el dueño y devoluciones manuales completas vinculadas a la venta original. Las correcciones conservan el historial financiero.

### Caja y reportes

- Activación explícita de la operación por el dueño, tras conciliar registros anteriores pendientes. Cobrar exige permisos y un turno abierto.
- Turnos de caja compartidos, fondo inicial, entradas, retiros, recuperación de cobros y conteo ciego de cierre. El cierre congela la actividad monetaria antes de contar y guarda esperado, contado y diferencia. Las cuentas pendientes continúan entre turnos.
- Resumen de cobrado, devuelto y neto registrado por método en turnos abiertos/cerrados. Los recibos antiguos sin vínculo a un turno no se atribuyen artificialmente. Las devoluciones Point sin turno se consultan en Pagos integrados y no se descuentan de ese neto registrado.
- Reportes por día/semana/mes y comparaciones de períodos en la zona horaria del negocio: ventas, descuentos, ajustes/devoluciones, IVA conocido, productos, operadores, medios de pago y diferencias de caja. Paneles con gráficas; los importes libres se distinguen del catálogo.
- Métricas personales de empleados con un permiso separado de los reportes generales. Los datos disponibles dependen de la autorización del servidor.

### Menús públicos QR

- El dueño configura en **Productos → Menús QR** y publica explícitamente menús por colección, como barra, terraza o desayuno, con enlace/QR estable en `/menu/:publicUUID`, copia del enlace y descarga del QR en SVG.
- Consulta anónima sin Google ni PIN: nombre/ubicación del negocio, información pública de productos, fotos, precios, tamaños, extras, combos y alérgenos. Los agotados se indican; los inactivos/eliminados se ocultan.
- Hasta 100 productos y 14 franjas semanales por menú, con horarios evaluados en la zona del negocio y soporte de cruce de medianoche. Fuera de horario se oculta la colección.
- Catálogo actual al consultar, actualización manual, al regresar a la pestaña y cada 45 segundos mientras está visible. Despublicar impide consultas posteriores.
- Menús informativos: no reciben pedidos, pagos ni reservaciones. No publican bancos, costos, conteos de stock, empleados, credenciales ni campos internos.

## Límites del producto

El negocio es la unidad de aislamiento. Los nombres de sucursal/caja, zonas del plano y ubicaciones de menús pertenecen al mismo negocio; no implementan operación contable multisucursal.

Quedan fuera del alcance actual:

- Operación y ventas offline, inventario automático por cantidades/ingredientes, recetas, costos o márgenes calculados.
- Venta por peso o cantidades fraccionarias; las porciones se pueden modelar como variantes con precios explícitos.
- CFDI/facturación, delivery, pedidos o reservaciones públicas, preautorización de tarjetas y conciliación de liquidaciones bancarias.
- Combos configurables al cobrar, promociones automáticas/acumulables y cancelación financiera parcial de un tiempo ya preparado.

La PWA precarga su interfaz, pero eso no permite vender sin conexión. Una ventana ya abierta puede conservar el worker anterior: completa las operaciones pendientes y cierra/reabre las ventanas para recibir una actualización; no borres almacenamiento con recuperaciones pendientes. Instalación en dispositivos, cámaras, impresoras, Google real y terminales físicas requieren su propia comprobación.

## Continuar con Claude

Las reglas del proyecto están en **[AGENTS.md](AGENTS.md)** y aplican también al trabajo que hagas con Claude. **[CLAUDE.md](CLAUDE.md)** es su entrada al repositorio: remite a esas reglas, al [mapa Graphify](docs/code-map.md) y a las fuentes actuales. El [informe](graphify-out/GRAPH_REPORT.md), [grafo interactivo](graphify-out/graph.html) y [JSON](graphify-out/graph.json) se incluyen al clonar; leer el informe o JSON no requiere instalar Graphify.

Puedes usar este mensaje, cambiando la última línea por tu tarea:

```text
Trabajamos en POS México. Antes de editar, lee CLAUDE.md, AGENTS.md,
README.md, CONTRIBUTING.md y la documentación del módulo que vamos a tocar.
Usa docs/code-map.md y graphify-out/GRAPH_REPORT.md para localizar fuentes;
verifica el código actual y las huellas del mapa antes de concluir.
Comprueba la rama y git status; usa mi clon/worktree propio y una rama
feat/, fix/ o chore/ desde origin/main. Conserva cambios ajenos.
Contrasta documentos fechados con código, contratos y migraciones actuales.
Desarrolla con Node 24, npm ci y npm run dev sobre el backend local de Docker.
Mantén autorización real, persistencia, centavos exactos, historial y reintentos;
no sustituyas esos recorridos por mocks en la aplicación.
Ejecuta las comprobaciones pertinentes, revisa el diff y prepara un PR a main
para revisión humana. Sigue DEPLOYMENT.md para cualquier publicación.
Tarea: [describe aquí el cambio y cómo comprobar que está terminado].
```

Para decisiones nuevas de producto, consulta Drive 02/04, las últimas entradas de 05 y las sesiones pertinentes según AGENTS; si no hay acceso, declara las fuentes locales y lo que no pudiste revalidar. Las notas históricas no autorizan nuevos cambios ni publicaciones. Para actualizar sólo documentación/proceso no hace falta reabrir decisiones que no se modifican.

### Mapa del código

| Ruta | Contenido |
| --- | --- |
| `src/App.tsx` | Entrada, rutas públicas, autenticación y cambios de sesión |
| `src/components/` | Venta, catálogo, acceso, equipo, configuración, comprobantes y paneles Point/menús |
| `src/features/operations/` | Cuentas, cocina, servicio, reservaciones, cobro, caja y reportes |
| `src/lib/` | Contratos compartidos, clientes HTTP, dinero/IVA, validación de respuestas y recuperación |
| `src/styles.css` y estilos de módulos | Interfaz; tokens y pautas en design-system/reference-read |
| `supabase/functions/account/` | Entrada autorizada de operaciones personales y cajas compartidas |
| `supabase/functions/point/`, `point-worker/`, `point-webhook/` | Proveedor, OAuth, conciliación y notificaciones Point |
| `supabase/functions/public-menu/` | Lectura anónima limitada de menús publicados |
| `supabase/migrations/` | Historial SQL, permisos, persistencia y operaciones atómicas |
| `scripts/` | Desarrollo local, empaquetado, integración y verificación de publicación |
| `tests/` | Dominio, componentes, SQL, Auth/Edge/Postgres, proveedor y Playwright |
| `.github/workflows/` | CI, suites completas y publicación de Cloudflare Pages |

La lógica de negocio se autoriza en servidor: Auth/credencial de dispositivo → Edge → RPC privilegiada → PostgreSQL. Las tablas `app_private` tienen RLS y no están expuestas al navegador; una service role no reemplaza la validación de actor, sesión, negocio y permisos. Dinero en centavos enteros, cantidades enteras, snapshots financieros y UUID/huella de solicitud protegen el historial y los reintentos. Los cambios de esquema van en **migraciones nuevas**, con contratos HTTP/TypeScript/SQL compatibles.

`npm run dev` genera archivos ignorados en `.local-dev/`; no los subas. `.env.production` contiene configuración pública de Supabase para el build alojado. Sólo URL/clave pública pertenecen a `VITE_*`: secretos OAuth, service role y credenciales de proveedores quedan en servidor. El acceso local por contraseña requiere modo desarrollo, bandera explícita y backend loopback; `npm run build` comprueba que no se incluya en artefactos de producción. No uses `db:reset` sobre datos de desarrollo conservados, compartidos o cloud; su uso se limita a entornos desechables identificados.

## Comprobar y entregar cambios

Comprobación básica local:

```sh
npm run test:smoke
npm run build
```

| Comando | Alcance |
| --- | --- |
| `npm run lint` | Lint de frontend, Edge y pruebas |
| `npm run typecheck` | TypeScript del frontend; también incluido en el build |
| `npm run test:domain` / `npm run test:smoke` | Pruebas unitarias de dominio y validación |
| `npm run test:sql` | Migraciones y RPC reales en PostgreSQL embebido PGlite |
| `npm test` | Vitest: unidades, componentes, SQL e integración según servicios disponibles |
| `npm run test:e2e` | Playwright; requiere Chromium instalado y usa un servidor de prueba dedicado |
| `npm run test:integrity` | Regresiones específicas de integridad financiera y recuperación |
| `npm run test:integrity:integration` | Integración financiera con el stack loopback persistente de este checkout; requiere `npm run dev` |
| `npm run test:provider` | Adaptador Point con proveedor HTTP local y Deno |
| `npm run test:point:local` | Integración Point del checkout con simulador y worker manual; preparación en Desarrollo local |
| `npm run test:dev` | Smoke del acceso local con Auth/Edge/Postgres; requiere Chromium y el stack de desarrollo iniciado |
| `npm run check:live -- https://pos-mexico-mvp.pages.dev` | Compara rutas/assets públicos con el `dist` de la revisión exacta |

Para E2E, instala el navegador con `npx playwright install chromium`. Las comprobaciones Edge/proveedor usan Deno; su preparación se detalla en la guía de pruebas.

Ejecuta pruebas proporcionales a lo que cambies; para documentación basta revisar contenido, fuentes, enlaces y diff. [tests/README.md](tests/README.md) explica fixtures, dependencias y límites: integración omitida no cuenta como verificada, OAuth interceptado no demuestra Google real y PGlite no demuestra concurrencia entre conexiones.

**Clon/worktree propio → rama → PR → revisión de la otra persona → merge autorizado → CI → verificación.** No hagas push directo ni force push a `main`. CI actual ejecuta **Basic checks** y **Required financial checks** en PR y `main`; esta última reutiliza las suites completas, también disponibles como **Full checks (manual)**. Un PR sólo verifica. El merge publica automáticamente el mismo `dist` comprobado si ambos gates pasan.

Si el frontend depende de backend nuevo, aplica y verifica primero las migraciones/Edge compatibles; CI no publica Supabase. El procedimiento único, la recuperación y la evidencia exigida están en [DEPLOYMENT.md](DEPLOYMENT.md). No hagas subidas manuales paralelas ni declares publicación por tener un build o PR verde.

## Documentación por módulo

| Tema | Fuentes |
| --- | --- |
| Mapa para agentes | [Entrada de Claude](CLAUDE.md), [guía Graphify](docs/code-map.md), [informe](graphify-out/GRAPH_REPORT.md) |
| Trabajo del equipo y agentes | [AGENTS](AGENTS.md), [CONTRIBUTING](CONTRIBUTING.md), [DEPLOYMENT](DEPLOYMENT.md) |
| Arranque y pruebas | [Desarrollo local](docs/local-development.md), [backend](supabase/README.md), [pruebas](tests/README.md) |
| Acceso, empleados y PIN | [Acceso al negocio](docs/business-access.md), [permisos](docs/employee-permissions.md), [dispositivos](docs/employee-device-access.md), [eliminación permanente](docs/employee-permanent-unlink.md), [recuperación](docs/pin-email-recovery.md) |
| Catálogo e impuestos | [Productos y ventas](docs/products-sales.md), [IVA](docs/catalogo-mvp-iva.md), [CSV](docs/catalogo-csv.md), [modificadores compartidos](docs/shared-modifier-library.md), [promociones](docs/scoped-promotions.md) |
| Cuentas y servicio | [POS operativo](docs/lean-pos-mvp.md), [backend operativo](docs/lean-operations-backend.md), [modalidad de cobro](docs/account-mode-flow.md), [restaurantes](docs/restaurant-pilot-2026-10-07.md) |
| Cobro y caja | [Importe libre](docs/custom-amount-charge.md), [división por cantidad](docs/amount-split-checkout.md), [resumen del turno](docs/shift-payment-summary.md), [integridad financiera](docs/financial-integrity-2026-10-03.md) |
| Point | [Runbook](docs/point-pilot-runbook.md), [modelo financiero](docs/point-financial-model.md), [confirmación/conciliación](docs/point-confirmation-latency-2026-10-05.md), [contexto del navegador](docs/point-browser-context.md) |
| Menús QR | [Menús públicos y horarios](docs/public-menus.md) |
| Interfaz | [Design system](design-system.md), [referencias](reference-read.md), [auditoría de UI](docs/ui-audit-2026-10-03.md) |
| Contexto histórico | [PRD/reglas anteriores](docs/history/2026-10-02-agents-before-workflow-cleanup.md), [README anterior](docs/history/2026-10-02-readme-before-workflow-cleanup.md) |

Contrasta siempre las notas fechadas con el código y las migraciones actuales. Los nombres de ramas, cifras de pruebas y procedimientos de entregas anteriores conservan su contexto; AGENTS, CONTRIBUTING y DEPLOYMENT son las guías operativas vigentes.
