## Cambio

Describe el resultado visible y los archivos o módulos afectados.

## Verificación

- [ ] `npm run build`
- [ ] `npm run test:e2e` si cambia el frontend
- [ ] Pruebas de backend, migración y compatibilidad si cambian contratos o SQL
- [ ] Revisé que no hay secretos, datos personales ni archivos `dist/`

## Publicación

- [ ] No requiere publicar
- [ ] Requiere Supabase antes del frontend (detallar orden)
- [ ] Requiere despliegue de Pages desde `main` y comprobación live

Notas de compatibilidad, rollback y evidencia anonimizada:
