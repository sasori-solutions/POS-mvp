## Cambio

Qué cambia y por qué.

## Verificación

Resultado de `npm run test:smoke`, `npm run build` y las pruebas específicas del cambio. Indicar omisiones; no contar pruebas omitidas como aprobadas.

## Backend y publicación

Migraciones/funciones necesarias: **ninguna** o lista exacta con evidencia de publicación y compatibilidad con el frontend actual. Deben estar listas **antes de fusionar** este PR.

Revisión: solicitar al otro desarrollador. Un PR abierto no publica. Al fusionar a `main`, CI ejecuta **Basic checks**, publica el mismo build en Cloudflare y verifica sus assets. Confirmar ese resultado antes de anunciar que está en producción. Ver [CONTRIBUTING.md](../CONTRIBUTING.md) y [DEPLOYMENT.md](../DEPLOYMENT.md).

No incluir secretos, datos personales ni `dist/`.
