# Revisión sintética de restaurante con MiroFish — 2026-10-07

MiroFish completó dos ejecuciones reales con personas ficticias e inferencia local. En la segunda formuló una hipótesis dirigida sobre el precio público de productos con tamaños. **Root reprodujo ese caso en el navegador y confirmó un precio anunciado incorrecto; después comprobó la corrección.** La confirmación procede de esa prueba real, no de la opinión del modelo ni de usuarios auténticos. Las demás respuestas conservan sus límites y estados de reproducción.

El modelo de 3B produjo varios comentarios genéricos y confundió cancelaciones, visitas y referencias de evidencia. Conservamos las salidas originales y descartamos esas afirmaciones. M04 se atribuye a un caso dirigido de la ejecución 02 que root reprodujo antes y después de corregirlo; no fue un descubrimiento espontáneo. Los otros fallos encontrados mediante revisión independiente mantienen esa atribución.

## Motor, material y resultado

- Repositorio [oficial MiroFish](https://github.com/666ghj/MiroFish), commit `7657031ac01184afe2cb220f5ee3545573b5e843`; archivos rastreados intactos.
- Runner oficial `backend/scripts/run_parallel_simulation.py`, SHA-256 `e1ee10de9a4599a8b18d01f0678f9f9caf4e0846c2355f302aaf0d56ed95e942`. Invocado con `--config`, `--reddit-only`, `--max-rounds 3`; entrevistas mediante `SimulationIPCClient`/optimizador oficial, sin proveedor ficticio.
- Ollama loopback `http://127.0.0.1:11434/v1`, modelo `mirofish-pos-qwen2.5:3b`; digest `6f4438ffbbeedbbc39b04c658374d4a590ad8c337d4e50f5bdb4ff08ca10a11b`. Sin Zep/memoria remota, nuevas cuentas/proveedores ni gasto cloud. No se modificó Docker para esta simulación.
- Inicio UTC `2026-10-07T15:59:27.454090+00:00`, fin UTC `2026-10-07T16:04:24.684826+00:00`, duración `297.23` segundos; exitcode `0`. `engine_execution_verified=true`, `requested_interviews_verified=true` para los actores 0–5.
- `env_status.status=stopped`; `close_env` IPC terminó `completed`, sin error. El proceso del runner salió 0. La capacidad `reddit_available=true` del archivo no significa proceso activo: el estado final es detenido.
- El seed mezcla fuentes identificadas: C (código), T (pruebas), R (reportes de responsables), W (observación de navegador). Al iniciar sólo incluía W01 (hub Servicio/persistencia de mesa reportados por root). El modelo no dispone de navegador. W02–W07 llegaron después y no se añadieron retroactivamente al seed.
- Snapshot de entrada: worktree `feat/restaurante-piloto`, baseline reportado `ded0f20dea1b36ceb3bfd1b661abb1359061612f`, cambios locales y migraciones 19–21 aplicadas/congeladas según root. Los hashes exactos de fuentes se archivaron; no se afirma que el modelo evaluó todos los cambios posteriores, incluida 22.

| SQLite `trace.action` | Registros |
| --- | ---: |
| sign_up | 6 |
| create_post | 1 (seed manual) |
| refresh | 19 |
| create_comment | 13 |
| search_user | 2 |
| search_posts | 1 |
| interview | 6 |

**13 comentarios LLM y 6 entrevistas**, excluyendo el seed manual. El agregado upstream anuncia 18 acciones en las rondas, pero no representa 18 textos generados: usamos SQLite como fuente y no contamos el seed otra vez.

## Personas y filtro editorial

| Actor | Papel ficticio | Qué aportó la salida; límite |
| --- | --- | --- |
|0 Alma Café|Dueña, cobro antes|Pidió observar cobro antes/cambio; M01. Descartada extrapolación a varias visitas independientes.|
|1 Berta Caja|Cajera móvil|Mezcló importe libre con cancelación y atribuyó a T03 una prueba distinta. No se acepta como hecho ni bug.|
|2 Camilo Mesas|Mesero, cobro después|Confundió historial con borrar cambios al completar pago. Se descarta esa conclusión; M03 conserva historial.|
|3 Dalia Barra|Bar, cuenta/pago parcial|Sugirió saldo y mesa con varias cuentas; M02 se limita a la misma visita. No existe crédito de cliente entre visitas prometido.|
|4 Elena Cocina|Cocina|Duda genérica sobre envío/cancelación; M03. Las referencias a «mesa cancelada» o impresión no acreditan esas capacidades.|
|5 Fabián Menú|Cliente QR|Derivó a cancelaciones y cuentas, ignorando el foco QR. No produjo una hipótesis QR fiable en esta ejecución.|

## Hipótesis y reproducción

La tabla distingue preguntas pendientes, recorridos reproducidos sin fallo y M04, confirmado y corregido mediante navegador real por root. Las preguntas son interpretaciones editoriales de las salidas del modelo; cada estado indica la evidencia que permite aceptarlas o descartarlas. M04–M06 corresponden a la segunda ejecución enfocada; la simulación por sí sola no prueba un fallo.

| ID | Hipótesis/prueba concreta | Fuente y contraste existente | Estado por root |
| --- | --- | --- | --- |
| M01 | En modo cobro antes, vender 36.00, recibir 50.00 y entregar cambio de 14.00; verificar venta y comprobante por 36.00 y generación automática de una comanda. | Entrevista 0 y W08. Root guardó Cobro directo, vendió sin Enviar, registró efectivo y observó KDS de 2 a 3, comprobante de 3600 centavos e IVA de 497; cuenta reiniciada a 0. | Reproducido sin fallo: 36.00/50.00/14.00, KDS automático y comprobante. |
| M02 | En la misma visita, continuar consumo en una cuenta nueva y comprobar todos los saldos; Finalizar visita debe bloquear con deuda de cualquiera y liberar mesas después de resolverla. | Entrevista 3 y W09: UI con origen totalmente pagado, cuenta vinculada, saldo nuevo de 2800 centavos y liberación posterior. T03 cubre origen parcialmente pagado con 3 unidades, saldo de 2002 centavos y reintentos en backend. | Reproducido en UI con origen pagado completo, cuenta vinculada, saldo y liberación; parcial cubierto en integración backend, sin reproducción completa de UI parcial. |
| M03 | En cuenta sin pagos, enviar consumos y cancelar con autorización; comprobar saldo, historial y aviso en cocina. La variante con pagos previos conserva su requisito de respetar congelación y permisos. | W11: después de liberar el grupo y guardar una línea por 3600 centavos, root la envió y canceló la cuenta sin pagos, con batch aún nuevo y motivo Corrección de prueba sintética. Subtotal 3600, cancelado 3600, saldo 0 y artículos visibles; KDS mostró la comanda original completada y un aviso activo con motivo y 1 Americano, que root confirmó. | Reproducido en UI para cuenta sin pagos, liberación y aviso confirmado. No se editó una venta pagada ni se afirma reproducción de la variante con pagos previos. |
| M04 | Latte tamaños piloto: base de 3000 centavos y únicas variaciones Chico de 4000 y Grande de 5500. Comparar precio principal del QR con opciones realmente comprables. | Caso dirigido S04 de ejecución 02. Root reprodujo QR con encabezado $30.00 y tamaños $40.00/$55.00; POS mostraba Desde $40.00 y sólo permitía 40/55. Después de corregir PublicMenu, la misma URL pública mostró Desde $40.00 y ambos tamaños. | Confirmado por root antes de la corrección y verificado después: corregido sin SQL. Pruebas permanentes de precios públicos 4/4, reportadas por root. |
| M05 | Promoción sin consumos elegibles, calculadora de cambio y cambio de total o método: comprobar bloqueo, aviso y que recibido no se reutilice para otro importe. | Caso dirigido de 02; respuesta de cajera descartada. Root reportó verificaciones puntuales de componentes y servidor para promoción no elegible, descuento fijo y reset del efectivo recibido. No se observó el recorrido manual integrado completo. | Verificaciones puntuales completadas según root; reproducción manual integrada pendiente. No es un fallo confirmado ni está todo el backend pendiente. |
| M06 | Adaptación del caso: 3 líneas distintas de Americano × 1, total 10800 centavos; retener 2 líneas con cantidad 1 cada una e intentar quitar una retenida en editor. | W11: Guardar rechazó COURSE_HELD visible y dejó la cuenta en 10800. Root salió del editor, usó Quitar del tiempo, editó quitando 2 líneas y guardó 1 × 3600. Se comprobó la orientación y que liberar el grupo conserva consumos; no se usó una sola línea de cantidad 3. | Reproducido en UI con 2 de 3 líneas distintas: protección y orientación correctas. Adaptación explícita del caso dirigido, no descubrimiento espontáneo. |

## Evidencia posterior y atribución independiente

Mensajes de root, no observaciones realizadas por el modelo:

- W02/W03: mesa persistió tras recarga/PIN; Americano 3500 guardado, mesa ocupada antes de pago. Entradas 1 retenida deshabilitó Enviar todo/Cobrar con instrucciones; envío produjo 1 enviado/0 pagado en KDS y saldo 3500.
- W04/W06: UI de medios/división; cobro efectivo 3500 con recibido 5000 y comprobante 3500 con fecha/método; mesa pagada seguía ocupada, saldo 0 y acciones continuar/finalizar.
- W05/W07: dueño publicó explícitamente menú de 3 productos, URL estable abierta anónimamente mostró 3500/5500/2800, sólo consulta/sin Auth/PIN/checkout. Tras editar Americano 3600+IVA 16, Actualizar mostró 3600 con la misma URL. No verifica por sí mismo precios de variaciones, extras anidados ni agotados.
- Viewport: override del proveedor 390×844; root midió CSS 487 px posteriormente. No presentar 390 CSS exactos ni dispositivo físico.

Correcciones independientes excluidas como hallazgos MiroFish: F01 categoría desaparecida del menú (UI 4/4 reportado); F02 recuperación corrupta/límite de 24 categorías/criterios heredados/promociones cargadas (75/75 reportado por agente de catálogo); F03 primera mesa sin layout causaba pantalla blanca (guarda y regresión por root); F04 perfil legacy sin accountsEnabled rechazó continuidad (reproducción root; migración 22 aplicada y verificada por root y el agente de configuración). Nueva revisión independiente del MenuManager detectó respuesta vieja que podía borrar la recuperación/UUID nuevo; su corrección pertenece a ese agente, no al modelo.

## Artefactos locales y hashes

Los originales y SQLite permanecen **fuera del repositorio**. Este documento incluye sólo resultados sintéticos revisables, no tokens/PIN/credenciales ni contexto humano. Carpeta de ejecución: `/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01`.

- [Evidencia original](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/run_evidence.json): comandos, digest, retorno, conteos y textos originales.
- [Resumen seguro](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/public-evidence-summary.json), [salidas originales](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/llm-original-outputs.json), [SQLite](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/reddit_simulation.db).
- [Seed inmutable](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/seed.md), [configuración](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/simulation_config.json), [perfiles](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/reddit_profiles.json), [manifest](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/input_manifest.json), [acciones](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/reddit/actions.jsonl), [log](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/stdout.log).
- [Entrevistas IPC](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/interview_ipc_response.json), [cierre IPC](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/close_ipc_response.json), [estado final](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-01/env_status.json).
- [Fuentes del snapshot](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/final-review-2026-10-07/source-manifest.FINAL.json), [observaciones posteriores](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/final-review-2026-10-07/browser-observations-added-after-start.md).

| Artefacto | SHA-256 |
| --- | --- |
|Runner oficial|`e1ee10de9a4599a8b18d01f0678f9f9caf4e0846c2355f302aaf0d56ed95e942`|
|Seed copiado del run|`b1bdb3069ec62adf6e03fd7444e3cd48f6f7933efa23870ea5481c5e84412e4a`|
|Configuración|`bc4a9477e4f6c19ad79d2a00f069e3d10f593a736170700dd7d5591a99f6544a`|
|Perfiles|`95f2c62fe52dbe74a0b0e0727cca1275d052d0abf950101cc95232d940c5422e`|
|Preguntas IPC|`42a0c8e887e6578575c93feb980eb413e89321d45434ba550c009e92073e47b2`|
|SQLite final|`8ca9763fe86edb554160414c0ca168cdc95007717e4944a7a56526d3d86a00ee`|

Reproducción: desde la carpeta externa `mirofish-pos`, preparar una carpeta **nueva** con `prepare_scenario.py --seed <seed> --personas <perfiles> --output <nueva> --rounds 3 --source-type mixed`, luego `run_official.py <nueva> --max-rounds 3 --interviews <preguntas>`. Los helpers son locales, no modifican el runner oficial y fuerzan inferencia loopback/memoria remota desactivada. Conservar outputs/hashes; repetir no convierte una hipótesis en error reproducido.

La ejecución demuestra uso real del motor y el LLM, no calidad equivalente a usuarios reales ni cierre del piloto. Hardware, Google OAuth real, instalación PWA y dispositivos reales siguen requiriendo su comprobación correspondiente.

## Segunda ejecución oficial enfocada — restaurant-final-02

Root pidió una iteración breve con cliente QR y cajera: dos perfiles sintéticos, dos rondas y dos entrevistas IPC oficiales. Mismo commit/runner/modelo/digest de 01, con `--reddit-only --max-rounds 2`. Seed nuevo de 3848 caracteres diferenciados C/T/W y escenarios hipotéticos S04/S05/S06; no se modificaron inputs/evidencia de 01.

La entrada de 02 incluyó W05–W07 y el estado posterior de 22, confirmado por agente de configuración: integración real 4/4 sin skips y SQL 4/4; antes de 22, el caso legacy rechazaba continuidad, después se retuvo/envió/pagó/continuó conservando exactamente el comprobante. También excluyó como descubrimientos los fixes independientes de promociones y la corrección en curso de recuperaciones MenuManager/CatalogBulkPanel.

- Inicio UTC `2026-10-07T16:10:16.520984+00:00`, fin UTC `2026-10-07T16:11:18.421525+00:00`, duración `61.9` segundos, exitcode 0.
- `engine_execution_verified=true`, `requested_interviews_verified=true` para actores 0–1. Estado final `stopped`, cierre IPC `completed` sin error.
- Conteos SQLite: sign_up: 2, create_post: 1 (seed), refresh: 4, create_comment: 1, interview: 2. **Un comentario LLM y dos entrevistas**, excluyendo el seed. Configurar dos rondas no implica que cada actor publique en cada ronda: en la segunda el motor reportó cero acciones; no inventamos participación.

| Actor de 02 | Resultado real y filtro |
| --- | --- |
|0 Fabián Menú Enfocado|Formuló M04: encabezado 30.00 y únicas variaciones 40.00/55.00 podrían anunciar un precio no comprable. Fue una duda dirigida, ya presente en S04, no un descubrimiento espontáneo. Root posteriormente confirmó y corrigió el caso mediante comparación real de QR y selector POS.|
|1 Berta Caja Enfocada|Mezcló S05/S06, propuso marcar completados los consumos retenidos e inventó doble clic de confirmación. Se descarta esa salida; no describe controles/acciones reales. M05/M06 siguen siendo escenarios de revisión solicitados, no hallazgos fiables del modelo.|

Reproducción de M04 realizada por root después de la simulación: creó Latte tamaños piloto, base de 3000 centavos y únicas variaciones Chico de 4000 y Grande de 5500; publicó la carta y comparó el QR con el selector POS. El QR anunciaba $30.00 mientras el POS sólo ofrecía $40.00/$55.00 y su tile indicaba Desde $40.00. El caso quedó confirmado por esa evidencia real. La corrección de PublicMenu usa el menor precio de las variaciones disponibles y conserva el tratamiento de precio variable y agotados; no requirió SQL. Root verificó después, en la misma URL, encabezado Desde $40.00 con Chico $40.00 y Grande $55.00. MiroFish no realizó estas pruebas.

La iteración enfocada mejoró el foco del actor QR; su caso dirigido M04 fue confirmado y corregido posteriormente por root en el navegador. El modelo de 3B siguió fallando al seguir reglas de caja. No usar esas respuestas para alterar autorización, protecciones de cuentas congeladas, cantidades, pagos ni historial. M06 fue reproducido posteriormente por root con una adaptación de tres líneas distintas y funcionó con la protección esperada. M05 tiene verificaciones puntuales de componentes y servidor; todavía falta su recorrido manual integrado completo. Ninguna de esas salidas se acepta como prueba de fallo del modelo.

| Artefacto 02 | SHA-256 |
| --- | --- |
|Seed|`8b27cb13d181e27614a180a0f569a921c5171961dd3fcaef78945e2e8ea3f14d`|
|Configuración|`e39d293e246549b3c47c64796834befed68f804071fd48c99e04dcb2c1c53694`|
|Perfiles|`405cc3606f845f887a34ec96678caeb9ec294cc9d001efacade28a0d865c8640`|
|Preguntas IPC|`ddb40581909258067836ef8d966b90a6272c59398904a41b64ee34f81e5eee0f`|
|SQLite final|`260926d14a87cf388a419b8e9fbd6ae66f27df0aa4f482ac328856e55dcd683c`|

Artefactos externos 02: [evidencia original](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/run_evidence.json), [resumen seguro](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/public-evidence-summary.json), [salidas originales](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/llm-original-outputs.json), [SQLite](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/reddit_simulation.db), [seed](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/seed.md), [config](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/simulation_config.json), [perfiles](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/reddit_profiles.json), [manifest](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/input_manifest.json), [log](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/stdout.log), [acciones](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/reddit/actions.jsonl), [entrevistas IPC](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/interview_ipc_response.json), [cierre](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/close_ipc_response.json), [estado detenido](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/runs/restaurant-final-02/env_status.json). [Manifest de fuentes 02](/Users/larioscow/.codex/visualizations/2026/10/06/01a10f59-9fff-78f1-9ea6-58641c968909/mirofish-pos/focused-review-2026-10-07/source-manifest.json).

Para otra ejecución enfocada usar carpeta nueva, `prepare_scenario.py --rounds 2 --source-type mixed` y `run_official.py --max-rounds 2 --interviews <preguntas>`. No repetir sobre 01/02 ni sobrescribir los originales. Los dos entornos finalizaron; quedan artefactos locales sintéticos para revisión.

## Observaciones posteriores W08–W11 aportadas por root

Estas observaciones llegaron tras finalizar ambas ejecuciones; no se insertaron retroactivamente en los seeds ni se atribuyen al modelo. La tabla incorpora los resultados aportados por root y distingue los límites de cada recorrido.

- **W08/M01**, UI real modo Cobro directo: configuración guardada, catálogo en Venta sin hub Servicio, Americano 3600 centavos→Cuenta→Cobrar directo sin Enviar; recibido 5000 dio cambio 1400, registro de efectivo aceptado. KDS pasó de 2 a 3 automáticamente; comprobante 3600/IVA 497/método Dueño; cuenta reiniciada 0. El precio actual 36 sustituye al ejemplo 35 del seed sin cambiar la propiedad del cálculo.
- **W09/M02**, UI real después de 22: retry original de continuidad legacy tras pago completo 3500 produjo Sobremesa vacía; Pan 2800 guardado. Visita mostró origen saldo 0 y nueva cuenta 2800, Finalizar bloqueado. Enviar/pagar 2800 llevó visita a 0; Finalizar devolvió mesa libre. La UI observada usa origen totalmente pagado; la conservación de saldo de origen parcialmente pagado con 3 unidades se comprobó en backend T03, no se afirma que se observó ese mismo caso parcial en UI.
- **W10/M04**, root creó y publicó Latte tamaños piloto, base de 3000 centavos y tamaños Chico de 4000/Grande de 5500. Antes de corregirlo, el menú público mostraba encabezado $30.00 y lista $40.00/$55.00; POS anunciaba Desde $40.00 y sólo ofrecía radios por 40/55, con 40 seleccionado, sin opción de 30. Después de corregir PublicMenu, root comprobó en navegador real la misma URL: Desde $40.00, Chico $40.00 y Grande $55.00. Los cuatro casos permanentes de precios públicos pasaron según root (4/4). Es un caso dirigido de 02 confirmado por una reproducción posterior, no un descubrimiento espontáneo ni una prueba de usuarios auténticos.

Root también corrigió por revisión independiente la etiqueta de cuenta pagada/saldo 0 confundida con parcial (regresión 8 UI reportada) y actualización inmediata de Home al liberar mesas (Homeflow 53/53 reportado). Se mantienen fuera de los descubrimientos MiroFish.

- **W11/M03/M06**, recorrido real posterior de root con datos sintéticos propios: abrió Revisión cocina con **3 líneas distintas**, cada una Americano × 1 a 3600 centavos, total 10800. Retuvo **2 líneas**, cantidad 1 en cada una; no era una sola línea con cantidad 3. Intentó quitar una retenida y guardar: apareció COURSE_HELD y la cuenta financiera siguió en 10800, sin cambios. Salió del editor sin guardar, pulsó Quitar del tiempo —liberó el grupo y conservó los consumos—, volvió a editar, quitó 2 líneas y guardó 1 × 3600. Envió esa unidad a cocina y canceló la cuenta **sin pagos**, con el batch aún nuevo, usando el motivo **Corrección de prueba sintética**. La cuenta conservó subtotal 3600, cancelado 3600, saldo 0 y artículos visibles; después liberó la visita. En KDS, la comanda original estaba completada y existía un aviso de cancelación activo de Revisión cocina con motivo y 1 × Americano; root confirmó ese aviso. Este recorrido no editó una venta pagada ni prueba la variante de cancelación con pagos previos. El resultado procede del navegador real de root, no de MiroFish ni de usuarios auténticos.

Root reportó además estas comprobaciones posteriores: **11/11** pruebas de ServiceOrderPanel/ServiceReservations para conservar borradores cuando cambia un callback, usar el último handler y descartar respuestas de otro actor; **4/4** casos permanentes de precios del menú público; batería amplia de componentes **554/554**. El cierre inesperado del formulario por identidad de callback fue un fallo de revisión/navegador independiente, corregido mediante refs, no un descubrimiento del motor. Estas cifras corresponden a los reportes de ejecución del equipo; no se ejecutaron nuevamente para editar este documento.
