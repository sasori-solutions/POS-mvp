# POS México: entrada para Claude

Lee y sigue [AGENTS.md](AGENTS.md), las reglas vigentes de este repositorio, antes de editar. Para el recorrido de trabajo consulta [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) y la documentación del módulo afectado. Publicación: [DEPLOYMENT.md](DEPLOYMENT.md).

## Encontrar el código

1. Lee [la guía del mapa](docs/code-map.md) y [el informe Graphify](graphify-out/GRAPH_REPORT.md).
2. Usa las comunidades, rutas y relaciones de [graph.json](graphify-out/graph.json) para localizar archivos. [graph.html](graphify-out/graph.html) permite explorar el mapa visualmente.
3. Comprueba la vigencia en [map-metadata.json](graphify-out/map-metadata.json) y abre el código/contrato/migración referenciado antes de concluir o editar. El grafo es un índice, no una autorización ni una comprobación de producción.
4. Distingue relaciones `EXTRACTED`, `INFERRED` y `AMBIGUOUS`. Las notas históricas y resultados reportados conservan su fecha; no reemplazan el comportamiento actual.

El mapa cubre código operativo y documentación. Las pruebas se localizan aparte en `tests/` y [tests/README.md](tests/README.md). No hace falta instalar Graphify para leer el informe o JSON. No leas todo el JSON si basta con el informe, la guía y una búsqueda por `source_file` o `label`.

Trabaja en un clon/worktree propio y una rama desde `origin/main`; usa Node 24, `npm ci` y `npm run dev` con Docker para desarrollo local. Conserva las fronteras de autorización, dinero, historial y reintentos de AGENTS. La revisión humana y el PR siguen siendo parte del recorrido.
