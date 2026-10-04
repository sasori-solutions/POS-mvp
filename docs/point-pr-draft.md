Los cobros con tarjeta externa siguen siendo confirmaciones manuales. Esta integración añade Mercado Pago Point con OAuth cifrado, snapshots reservados, intentos persistidos, exclusión de terminal, webhooks durables y conciliación antes de registrar una venta. Timeouts y estados desconocidos mantienen el mismo intento pendiente; las devoluciones agregan ajustes sin borrar ventas.

Incluye ledger exacto de comisión de 0.30%, IVA separado, cierres mensuales y abonos con evidencia, alta guiada, recuperación, permisos por negocio y panel SASORI con alta administrativa independiente. Hay dos migraciones aditivas; todos los flags empiezan deshabilitados. El scheduler se instala explícitamente mediante el script revisado, después de preparar secretos/Vault.

La CI completa es requerida en el PR: navegador, SQL, dominio, Deno, standalone y Auth/Edge/PostgreSQL reales con proveedor HTTP local. El simulador no usa cuentas live ni terminales. Se preservan las suites heredadas y se están adaptando recorridos que quedaron anteriores al dashboard actual.

Validación inicial: npm ci, lint/typecheck, build, 9 pruebas SQL de Point y 14 del adaptador HTTP pasan; pruebas completas y servicio local real todavía en ejecución. Este PR es borrador hasta terminar esas comprobaciones. El equipo Windows no tiene Docker: la prueba real aislada se ejecutará en el job requerido de GitHub.

No desplegar ni fusionar como parte de este encargo. Faltan credenciales autorizadas, validación opcional con terminal virtual, ensayo físico y aceptación comercial. Ver [modelo financiero](docs/point-financial-model.md) y [runbook](docs/point-pilot-runbook.md) para alta, incidentes y publicación/rollback por etapas.
