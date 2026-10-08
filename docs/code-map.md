# Mapa del código con Graphify

El mapa conecta archivos, símbolos, contratos y conceptos documentados del POS. Sirve para orientar una lectura o un cambio; cada conclusión debe contrastarse con sus fuentes actuales.

## Artefactos disponibles al clonar

| Archivo | Uso |
| --- | --- |
| [GRAPH_REPORT.md](../graphify-out/GRAPH_REPORT.md) | Comunidades, nodos centrales, conexiones y preguntas sugeridas |
| [graph.json](../graphify-out/graph.json) | Índice procesable con nodos, relaciones, fuentes y confianza |
| [graph.html](../graphify-out/graph.html) | Exploración interactiva; abrir el archivo en un navegador |
| [map-metadata.json](../graphify-out/map-metadata.json) | Versión de herramienta, fuentes/huellas, alcance y límites |
| [CLAUDE.md](../CLAUDE.md) | Entrada que remite a AGENTS y al mapa |

El informe y JSON no requieren Graphify. El HTML incorpora el grafo y carga la biblioteca de visualización desde un CDN; necesita internet para esa biblioteca.

## Recorrido por módulos

| Cambio | Entradas que conviene localizar |
| --- | --- |
| Acceso/PIN/equipo | `src/App.tsx`, `src/lib/account.ts`, `contracts.ts`, `employee-device.ts`, componentes de acceso/equipo, `supabase/functions/account/` y migraciones de acceso |
| Catálogo/IVA/CSV | `ProductsScreen`, `ProductEditor`, `ModifierLibrary`, `CatalogBulkPanel`, `pos-contracts.ts`, `catalog-csv.ts`, `vat.ts`, validación de productos y migraciones de catálogo |
| Venta/cobro | `HomeScreen`, `SaleScreen`, `OrderDetail`, `CheckoutItemSelection`, `CheckoutAmountSelection`, `operations-contracts.ts` y RPC de reserva/registro |
| Mesas/visitas/cocina | `ServiceWorkspace`, `ServiceOrderPanel`, `ServiceReservations`, `OrdersScreen`, `service-contracts.ts`, `service-validation.ts` y migraciones de servicio |
| Caja/reportes | `CashScreen`, `CashPaymentSummary`, `ReportsScreen`, `PersonalMetricsScreen`, `reporting.ts` y RPC operativas/reportes |
| Point | Componentes `Point*`, `point-client.ts`, `point-contracts.ts`, `supabase/functions/point/`, `point-worker/`, `point-webhook/` y migraciones Point |
| Menú público | `MenuManager`, `PublicMenu`, `menu-contracts.ts`, `menu-client.ts`, `public-menu/` y migraciones de menús |
| Desarrollo/entrega | `scripts/dev.mjs`, `local-development.mjs`, `.github/workflows/`, CONTRIBUTING y DEPLOYMENT |

Para rastrear una operación empieza por el componente, sigue su cliente/contrato a Edge y después a la RPC SQL. Las relaciones de imports/referencias localizan candidatos; no prueban que un recorrido se ejecute ni que esté publicado.

## Consulta opcional con Graphify

Esta entrega usa **graphifyy 0.8.39**. Con `uv` disponible, desde la raíz del clon:

```sh
uvx --from graphifyy==0.8.39 graphify query "How does checkout connect to Point and immutable sales?"
uvx --from graphifyy==0.8.39 graphify explain "OrderDetail"
uvx --from graphifyy==0.8.39 graphify path "OrderDetail" "pointRequest"
```

Si una búsqueda no encuentra un concepto, busca sus nombres exactos en el informe/JSON y vuelve a consultar. Una ruta del grafo es una conexión entre nodos, no necesariamente una cadena de llamadas: el grafo es no dirigido y mezcla imports, referencias y conceptos.

Graphify puede guardar un registro local de consultas; `GRAPHIFY_QUERY_LOG_DISABLE=1` lo desactiva. No introduzcas credenciales ni datos humanos en preguntas, comandos o logs.

## Alcance, vigencia y regeneración

[.graphifyignore](../.graphifyignore) define el corpus: código operativo y documentación, sin pruebas, medios, dependencias, entornos locales, credenciales ni artefactos generados. Este archivo sustituye el fallback de `.gitignore` de Graphify y conserva exclusiones propias. Esta generación usa `detect(Path("."), follow_symlinks=False, google_workspace=False)` y no sigue fuentes externas/Drive. Al regenerar conserva esos parámetros y elimina de la lista detectada cualquier archivo bajo `graphify-out/`: Graphify 0.8.39 puede incluir su carpeta `memory` aunque exista una regla ignore.

El análisis combina AST de los lenguajes soportados, conceptos extraídos por agentes de la documentación y un suplemento léxico de declaraciones SQL. Los símbolos SQL representan nombres encontrados en el historial de migraciones; no son una inspección del esquema alojado. Las referencias léxicas pueden aparecer en cuerpos o SQL dinámico y no prueban una llamada en ejecución. Las migraciones aplicadas no se editan.

`EXTRACTED` señala evidencia explícita; `INFERRED` y `AMBIGUOUS` requieren interpretación/revisión. Las fechas/estados de conceptos documentales distinguen planes y evidencia histórica del código observado. No se conoce el consumo exacto de tokens de los agentes en esta interfaz; el informe lo declara como no disponible, no como coste cero.

Las huellas por archivo en `map-metadata.json` permiten comprobar qué fuentes cambiaron desde la generación, aunque un merge cambie el commit. El mapa no se actualiza solo. Tras un cambio de código/documentación, regenera con la skill Graphify respetando este corpus y revisa sus artefactos; no asumas que un grafo anterior sigue vigente.

El comando `graphify update .` puede actualizar estructura según los cambios detectados, pero no reproduce por sí solo la extracción semántica por agentes ni el suplemento SQL de esta entrega. Para regenerar los outputs vuelve a ejecutar la skill completa, con extracción documental actualizada. Después de extraer el AST y antes de mezclarlo con los fragmentos semánticos, ejecuta desde la raíz:

```sh
python3 scripts/graphify-sql-index.py
```

Este suplemento usa sólo la biblioteca estándar de Python, lee los archivos temporales `.graphify_detect.json`/`.graphify_ast.json` del pipeline y añade declaraciones/referencias SQL con fuentes y líneas. Después continúa con la construcción, etiquetas y exports de Graphify. No se instalaron hooks de Git/Claude ni servicios MCP.
