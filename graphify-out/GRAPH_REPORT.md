# Graph Report - POS México  (2026-10-07)

## Scope and Audit Limits

- Runtime code and documentation: tests/media excluded from extraction. A test file referenced by a document may appear as a reference-only node.
- AST relationships are static evidence. SQL names come from lexical CREATE declarations throughout migration history, not a live schema inspection.
- Edge/SQL name matches are INFERRED (0.95), never cross-language call edges. Lexical mentions may occur in dynamic SQL/comments and do not prove execution.
- The graph is undirected and consolidates relationships for each node pair. Original relation provenance remains on the surviving edge. External/unresolved AST imports may be omitted.
- Historical documents and reported validation retain status/source dates; this map does not prove production or hardware behavior.
- All source paths are repository-relative. HTML needs internet for its visualization CDN.
- See `../docs/code-map.md` and `map-metadata.json` for use, regeneration and coverage.

## Corpus Check
- 321 files · ~279,183 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2062 nodes · 5417 edges · 100 communities (98 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 31 edges (avg confidence: 0.89)
- Token cost: unavailable. Semantic agents ran in the host session, which does not expose their input/output usage; zero placeholders are not a measured zero cost.

## Graph Freshness
- Base commit (map-support source changes included separately): `b1eb8f4f`
- Compare per-source SHA-256 hashes in `map-metadata.json`; a merge commit alone does not determine freshness.
- Regenerate with the Graphify skill, fresh semantic fragments and the SQL supplement described in `docs/code-map.md`.

## God Nodes (most connected - your core abstractions)
1. `money()` - 58 edges
2. `AccountClientError` - 47 edges
3. `supabase/README.md` - 42 edges
4. `app_private.employees` - 33 edges
5. `app_private.pos_command` - 33 edges

## Surprising Connections (you probably didn't know these)
- `Disposable Auth/Edge/PostgreSQL integration without skipped tests` --references--> `tests/integration/employee-rejoin-migration-smoke.mjs`  [EXTRACTED]
  .github/workflows/full-checks.yml → tests/integration/employee-rejoin-migration-smoke.mjs
- `Reported local 202 browser, 65 integration and 22 Deno cases plus device/onboarding smokes` --references--> `tests/integration/real-onboarding-smoke.mjs`  [EXTRACTED]
  docs/employee-device-access.md → tests/integration/real-onboarding-smoke.mjs
- `Guarded exact-ledger upgrade and preflight before destructive tenant cleanup` --references--> `tests/integration/employee-unlink-migration-smoke.mjs`  [EXTRACTED]
  docs/employee-permanent-unlink.md → tests/integration/employee-unlink-migration-smoke.mjs

## Import Cycles
- 3-file cycle: `src/lib/contracts.ts -> src/lib/point-contracts.ts -> src/lib/operations-contracts.ts -> src/lib/contracts.ts`

## Hyperedges (group relationships)
- **Checked artifact publication with both gates, serialized upload and public verification** — workflows_ci_basic_checks, workflows_ci_required_financial_checks, workflows_ci_production_dist, workflows_deploy_pages_checked_artifact_deployment, workflows_deploy_pages_serialized_latest_main, workflows_deploy_pages_public_asset_verification [EXTRACTED 1.00]
- **Current documented server authorization flow and private tenant persistence** — readme_supabase_backend, readme_server_authorization_flow, agents_tenant_authorization, agents_private_rpc_boundary, agents_authorized_idempotency [EXTRACTED 1.00]
- **Signed linked-browser access with nonce consumption, owner replacement and shared-register boundary** — docs_employee_device_access_linked_employee_browser, docs_employee_device_access_signed_device_proof, docs_employee_device_access_service_nonce_consumption, docs_employee_device_access_owner_notifications, docs_employee_device_access_shared_register_boundary [EXTRACTED 1.00]
- **Atomic checkout acceptance and recoverable original result** — docs_financial_integrity_2026_10_03_atomic_financial_acceptance, docs_financial_integrity_2026_10_03_immutable_financial_history, docs_financial_integrity_2026_10_03_durable_exact_command_recovery, docs_financial_integrity_2026_10_03_financial_response_boundary [EXTRACTED 1.00]
- **Point verified browser context across authorized RPC completion** — docs_point_browser_context_verified_browser_context, docs_point_browser_context_point_io_reauthorization, docs_point_browser_context_coordinated_point_maintenance [EXTRACTED 1.00]
- **Verified provider evidence materializes the reserved financial snapshot once** — docs_point_financial_model_reserved_point_snapshot, docs_point_financial_model_authenticated_provider_evidence, docs_point_financial_model_exactly_once_point_materialization, docs_point_financial_model_exact_commission_numerator [EXTRACTED 1.00]
- **Service visit account and kitchen lifecycle** — docs_restaurant_pilot_2026_10_07_postpaid_service_flow, docs_restaurant_pilot_2026_10_07_visits_table_occupancy, docs_restaurant_pilot_2026_10_07_kitchen_courses, docs_restaurant_pilot_2026_10_07_reservations [EXTRACTED 1.00]
- **Immutable preparation and discount snapshots through financial outputs** — docs_shared_modifier_library_fixed_combos, docs_scoped_promotions_promotion_allocation_snapshots, docs_products_sales_printable_receipt [EXTRACTED 1.00]
- **Personal account identity, live session and tenant authorization chain** — supabase_readme_account_authentication, supabase_readme_live_session_authorization, supabase_readme_private_schema_security, supabase_readme_operator_session_tokens [EXTRACTED 1.00]

## Communities (100 total, 2 thin omitted)

### Community 0 - "Proveedor y conciliación Point"
Cohesion: 0.05
Nodes (69): Point entry points, BackgroundOptions, backgroundPointWork(), BackgroundRuntime, base64(), bytes(), challenge(), digest() (+61 more)

### Community 1 - "Clientes y errores POS"
Cohesion: 0.07
Nodes (52): dateLabel(), metricDefinitions, PointDashboardSession(), seconds(), matchesQuote(), PointPayment(), PointPaymentSession(), PointRefund() (+44 more)

### Community 2 - "Catálogo y selección"
Cohesion: 0.08
Nodes (49): ModifierLibrary(), ProductComboFields(), ProductEditor(), sections, palette, ProductSelection(), ProductAvailability(), ProductVatFields() (+41 more)

### Community 3 - "Espacio operativo y servicio"
Cohesion: 0.06
Nodes (45): BusinessSettingsProps, HomeScreen(), HomeScreenProps, PointDashboard(), SaleReceiptDialog(), TeamPanelProps, useCatalog(), usePoint() (+37 more)

### Community 4 - "Cobro y dinero"
Cohesion: 0.09
Nodes (42): CashChangeCalculator(), CheckoutClosingContext, CheckoutInteractionContext, CheckoutPanel(), ExternalCardConfirmation(), MoneyInput(), icons, PaymentMethodPicker() (+34 more)

### Community 5 - "Validación de resultados financieros"
Cohesion: 0.10
Nodes (48): amountParts(), assertFinancialAttempt(), assertFinancialOrder(), assertFinancialResponse(), assertFinancialSale(), assertFinancialShift(), assertFinancialVisit(), attemptCommands (+40 more)

### Community 6 - "Restaurante y evidencia local"
Cohesion: 0.06
Nodes (50): tests/components/public-menus.test.tsx, Revisión sintética de restaurante con MiroFish — 2026-10-07, Separate simulation hypotheses, code/tests and later browser observations, Held course prevents line removal until group release, MiroFish official repository, Promotion/cash-received integrated manual scenario remains pending, Public menu headline uses minimum purchasable variation price, Synthetic MiroFish review with local inference (+42 more)

### Community 7 - "Persistencia de pagos Point"
Cohesion: 0.09
Nodes (37): Private catalog and sale schema, app_private.assert_member, app_private.catalog_batch_row_uuid, app_private.catalog_customer_name_snapshot, app_private.combo_availability_reason, app_private.included_vat_cents, app_private.manual_availability_details, app_private.menu_configuration (+29 more)

### Community 8 - "Comandos y catálogo SQL"
Cohesion: 0.08
Nodes (37): app_private.ops_assert_payment_quote, app_private.point_admin_audit, app_private.point_checkout_json, app_private.point_command, app_private.point_guard_history, app_private.point_guard_terminal_binding, app_private.point_immutable, app_private.point_ledger_period (+29 more)

### Community 9 - "Menús públicos y horarios"
Cohesion: 0.08
Nodes (34): exact(), integer(), invalid(), parseMenuCommand(), parseMenuSchedule(), text(), uuid(), assertStoredRecovery() (+26 more)

### Community 10 - "Venta y borradores"
Cohesion: 0.08
Nodes (37): saleCommand(), SaleScreenSession(), TransferConfirmation(), cartLineInput(), cartLineName(), cartLineOrderInput(), cartLinePrice(), cartLineSelection() (+29 more)

### Community 11 - "Runner y contexto local"
Cohesion: 0.06
Nodes (35): Coordinated browser-binding migration and Account Edge maintenance, docs/point-browser-context.md, Point browser context loopback verification, Point I/O completion reauthorizes original verified browser and live session, Verified browser hash preserved across Point RPC transactions, tests/integration/point.integration.test.ts, ChartFrame(), root (+27 more)

### Community 12 - "Empaquetado de Edge Functions"
Cohesion: 0.05
Nodes (29): buildAccountSource(), aliases, buildPointModules(), buildPointSource(), namespaces, metadata, migration, prior (+21 more)

### Community 13 - "Permisos y ciclo de empleados"
Cohesion: 0.13
Nodes (37): app_private.accept_employee_invitation, app_private.can_rejoin_employee, app_private.cancel_employee_invitation, app_private.change_employee_lifecycle, app_private.consume_employee_pin_setup, app_private.create_employee_access, app_private.create_employee_access_before_permanent_unlink, app_private.create_invitation_access (+29 more)

### Community 14 - "Reservas y asignación financiera"
Cohesion: 0.07
Nodes (33): Historical amount-split migration in earlier worktree, app_private.ops_adjustment_items_valid, app_private.ops_amount_parts_valid, app_private.ops_amount_plan, app_private.ops_amount_quote, app_private.ops_assert_adjustment_remaining, app_private.ops_assert_order_integrity, app_private.ops_assert_reversal_integrity (+25 more)

### Community 15 - "Backend y política PIN"
Cohesion: 0.06
Nodes (39): Employee administration correction, Focused employee detail and invitation outcomes, Employee lifecycle compatibility and race test requirements, Historical employee soft delete and restoration, Credential changes and session issuance serialization, Employee PIN ownership and owner recovery, Employee-selected PIN setup and Google linking, Historical owner independent-code PIN recovery (+31 more)

### Community 16 - "Contratos y administración de equipo"
Cohesion: 0.08
Nodes (29): permissionGroups, InvitationQr(), InvitationQrProps, Code, EmployeeRole, sessionErrors, AccountContext, AccountEnvelope (+21 more)

### Community 17 - "Panel de reportes"
Cohesion: 0.06
Nodes (20): CashDifferenceChart, charts(), colors, DailySalesChart, employeeRoleLabels, FinancialWaterfall, Metric, PaymentNetChart (+12 more)

### Community 18 - "Visitas y tiempos SQL"
Cohesion: 0.08
Nodes (28): Legacy service account and table compatibility, app_private.assert_table_layout, app_private.ops_order_json, app_private.ops_table_json, app_private.service_associate_tables, app_private.service_batch_table_snapshot, app_private.service_checkout_visit, app_private.service_courses_json (+20 more)

### Community 19 - "Gráficas de analítica"
Cohesion: 0.07
Nodes (23): animation, axisTick, CashDifference, CashDifferenceChart, colors, compactCurrency, compactNumber, DailySalesChart (+15 more)

### Community 20 - "Entrada y escaneo QR"
Cohesion: 0.07
Nodes (20): Skeleton(), accountErrorMessages, invitationFromLink(), preferredBusiness(), rememberBusiness(), AccountErrorCode, AccountApp(), accountMessages (+12 more)

### Community 21 - "Operaciones y reportes SQL"
Cohesion: 0.15
Nodes (29): Atomic mutations and actor/UUID/payload-bound accepted retry, Integer cents, exact decimals and centralized rounding, Financial snapshots and linked corrections, docs/account-mode-flow.md, Service sends only new quantities; payment does not duplicate preparations, Pending order preserves UUID, payload and original type, Saved profile.accountsEnabled controls Venta flow, Dividir por cantidad: up to twenty positive exact amounts (+21 more)

### Community 22 - "Reintentos y snapshots"
Cohesion: 0.11
Nodes (22): app_private.assert_live_auth, app_private.change_person_pin, app_private.create_owner_recovery_code, app_private.invalidate_employee_email_recovery, app_private.prepare_pin_email, app_private.recover_owner_pin, app_private.refresh_employee_device_identity, app_private.revoke_person_operator_sessions (+14 more)

### Community 23 - "Recuperación y dispositivos SQL"
Cohesion: 0.13
Nodes (22): app_private.has_permission, app_private.ops_employee_report_window, app_private.ops_local_cutoff, app_private.ops_order_kind_immutable, app_private.ops_period_report, app_private.ops_period_report_at, app_private.ops_report, app_private.ops_report_series (+14 more)

### Community 24 - "Reglas y aislamiento"
Cohesion: 0.13
Nodes (27): Memory-only operator session; eight-hour expiry and immediate revocation, Confirmed-email PIN recovery: one use, 15 minutes, no access session, Six-digit PIN, bcrypt cost 12 and concurrent lockout, Proportional verification with precise limits and omissions, Business tenant: actor, session, membership and permissions, Binding identifies browser storage context, not attested hardware, MDN CryptoKey extractability, 0008 and account/device-proof before frontend; old clients fail closed (+19 more)

### Community 25 - "Descuentos y promociones"
Cohesion: 0.20
Nodes (20): PendingIndicator(), Draft, fromPromotion(), PromotionManager(), usePromotions(), OperationalOrder, OrderDiscount, Promotion (+12 more)

### Community 26 - "Account Edge y autenticación"
Cohesion: 0.10
Nodes (15): claimsFromVerifiedJwt(), google, VerifiedAuthClaims, verifiedGoogleAuthentication(), VerifiedUser, env(), mailConfiguration, RecoveryMail (+7 more)

### Community 27 - "Configuración del negocio"
Cohesion: 0.17
Nodes (20): BusinessOperationFields(), BusinessSettings(), emptyProfile, paymentOptions, profileSignature(), BusinessDraft, BusinessSetup(), PublicMenu() (+12 more)

### Community 28 - "Fundación de sesiones SQL"
Cohesion: 0.18
Nodes (20): app_private.assert_operator, app_private.assert_owner, app_private.business_context, app_private.check_employee_device, app_private.close_employee_device_requests, app_private.employee_notifications, public.account_context, public.account_create_business (+12 more)

### Community 29 - "Comandos npm"
Cohesion: 0.08
Nodes (25): scripts, api:serve, build, check, check:ledger, check:live, db:reset, db:start (+17 more)

### Community 30 - "Revisión y publicación"
Cohesion: 0.19
Nodes (22): .github/pull_request_template.md, Compatible backend before dependent frontend merge, Isolated checkout, focused PR and human review, Worktree → branch → PR → human review → merge → CI → verify, Native Pages SPA fallback preserves callback pathname/query, PWA shell precache and prompt-style worker update without banner, Reported frontend release of 2 October 2026, Frontend bytes, backend behavior and real-device checks have distinct evidence (+14 more)

### Community 31 - "Navegación del mapa"
Cohesion: 0.15
Nodes (18): Claude entry routes to AGENTS and module sources, Graph is a source index, never authorization or production evidence, Read report/guide or filter source_file/label instead of entire JSON, Operational code and documentation corpus excludes tests, media, environments and generated artifacts, Document date/status preserves plans and reported historical evidence, docs/code-map.md, Full skill regeneration reproduces docs semantics and SQL supplement, graph.html: interactive graph, CDN visualization library (+10 more)

### Community 32 - "Acceso y recuperación UI"
Cohesion: 0.13
Nodes (9): AccessButtonContent(), DeviceLoginProps, roles, Props, POS México HTML entrypoint, Spanish mobile-aware HTML entry metadata, DeviceStatus, OperatorSession (+1 more)

### Community 33 - "Comprobantes e importe libre"
Cohesion: 0.17
Nodes (14): AmountEntry(), CatalogFilters(), EmptyCatalog(), SaleDetail(), SaleReceiptActions(), VatSummary(), saleDate(), amountKey() (+6 more)

### Community 34 - "Reinvitación histórica"
Cohesion: 0.14
Nodes (16): Cash/reports entry points, Typed online POS architecture, currency, number(), numbers, averageTicket(), changePercent(), calendarDate (+8 more)

### Community 35 - "Contratos de servicio"
Cohesion: 0.10
Nodes (17): Reinviting a deleted employee, Historical reinvitation compatibility verification, Historical inactive-membership invitation rejection, Retired employee restoration through fresh invitation, tests/integration/employee-rejoin-migration-smoke.mjs, constraintValues, evidence, functionValues (+9 more)

### Community 36 - "Configuración TypeScript"
Cohesion: 0.14
Nodes (18): CheckoutSelection, KitchenBatch, ReservationStatus, ServiceCommand, ServiceCourse, ServiceDay, ServiceErrorCode, ServiceMutationCommand (+10 more)

### Community 37 - "CSV y edición masiva"
Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+12 more)

### Community 38 - "Dependencias de desarrollo"
Cohesion: 0.16
Nodes (16): Catalog/IVA/CSV entry points, bulkCatalogBatches(), catalogBatches(), catalogCsvHeaders, CatalogCsvRow, decodeText(), encodeText(), exportCatalogCsv() (+8 more)

### Community 39 - "Integridad financiera documentada"
Cohesion: 0.11
Nodes (18): devDependencies, @electric-sql/pglite, jsdom, oxlint, @playwright/test, supabase, tailwindcss, @tailwindcss/vite (+10 more)

### Community 40 - "Validación de acceso HTTP"
Cohesion: 0.15
Nodes (17): Adyen POS timeouts, Atomic receipt, paid quantities, kitchen batch and accepted response, Clover REST Pay tutorials, Clover calculating order totals, Cumulative exact quantity/discount/IVA prefixes, Deferred financial trigger privileges with empty search path, docs/financial-integrity-2026-10-03.md, Durable original UUID/payload recovery under live authorization (+9 more)

### Community 41 - "Evidencia histórica de backend"
Cohesion: 0.33
Nodes (13): access, businessDetails(), validCreate, exactKeys(), invalid(), name(), parseAccountRequest(), permissions() (+5 more)

### Community 42 - "Métricas personales"
Cohesion: 0.20
Nodes (15): Private app_private schema and service-only privileged RPCs, Exact JSON keys, 8 KiB, stable errors, no-store and explicit CORS, Later reported hosted publication of canonical amount-split migration, Reported backend release verified 5 October 2026 04:35 UTC, Reported function/grant/RLS and anonymous HTTP audit, docs/backend-release-2026-10-04.md, Transactional migration guard and canonical ledger reconciliation, Old preferences, NULL orderKind, direct delivered state and accepted retries preserved (+7 more)

### Community 43 - "Resumen y arquitectura"
Cohesion: 0.18
Nodes (14): Access/PIN/team entry points, supabase/functions/account/: authorized personal/register entry, Cloudflare Pages frontend, src/components/: catalog, access, team and Point/menu panels, supabase/migrations/: SQL ledger, permissions and atomic persistence, src/features/operations/: service, kitchen, checkout, cash and reports, POS México: online React/TypeScript/Vite PWA, Online-only product scope; no CFDI, fractional sales, stock automation or bank settlement (+6 more)

### Community 44 - "Preparación del piloto Point"
Cohesion: 0.16
Nodes (15): Approved Orders audit bounded by provider query window, docs/point-pilot-runbook.md, Disable new charges while preserving reconciliation and financial history, Mercado Pago Point official virtual terminal, Mercado Pago Point Orders query contract, Owner OAuth state consumed once under final live authorization, Human-authorized physical Point hardware and bank-evidence pilot, Independent environment/business/method activation controls (+7 more)

### Community 45 - "IVA y política histórica"
Cohesion: 0.21
Nodes (13): New migrations with compatible TypeScript/HTTP/SQL contracts, docs/catalogo-mvp-iva.md, IS DISTINCT FROM rejects retry by an erased actor with NULL identity, Final advertised price with VAT extracted once per line, LFPC article 7 Bis, LIVA articles 1 and 2-A, Reported local VAT, real integration and synthetic browser verification, Historical reduced MVP catalog editor scope (+5 more)

### Community 46 - "Navegación por permisos"
Cohesion: 0.25
Nodes (11): icons, WorkspaceShell(), availableDestinations(), businessWorkSections(), Destination, initialDestination(), NavigationBusiness, primaryDestinations() (+3 more)

### Community 47 - "Correo PIN e historial"
Cohesion: 0.16
Nodes (14): docs/pin-email-recovery.md, Dated PIN email deployment and local verification limits, Recovery URL fragment removed before render and held only in memory, Mailpit API, PIN confirmation consumes capability and revokes current operators, PIN recovery retry requires current result hash, Recovery server validates live identity, current person and confirmed email, Resend send email API (+6 more)

### Community 48 - "Comisiones y evidencia Point"
Cohesion: 0.21
Nodes (14): Concordant authenticated Orders/Payments evidence, Cumulative period commission close with original-IVA remainder allocation, Earlier single integrated-card presentation, docs/point-financial-model.md, Exact 30-basis-point production merchandise commission numerator, Reserved snapshot materialized once into receipt/paid items/kitchen/commission, Exclusive SKIP LOCKED worker with leases/backoff/bounded attempts, Mercado Pago Point create-order idempotency (+6 more)

### Community 49 - "Sesión Auth del cliente"
Cohesion: 0.19
Nodes (8): allowIdentitySignIn(), clearStoredIdentity(), closeIdentity(), discardIdentity(), hasCurrentStoredIdentity(), identityStorage, initializeIdentity(), isVerifierKey()

### Community 50 - "Modelo de analítica"
Cohesion: 0.15
Nodes (11): BusinessDayReport, BusinessPeriodReport, buildDailySalesChartData(), buildFinancialWaterfallData(), buildTemporalChartData(), TemporalDatum, TemporalMetric, TemporalPoint (+3 more)

### Community 51 - "Combos y materialización SQL"
Cohesion: 0.18
Nodes (11): app_private.capture_combo_kitchen_snapshot, app_private.capture_combo_legacy_receipt_snapshot, app_private.capture_combo_order_snapshot, app_private.capture_combo_product_snapshot, app_private.ops_amount_line, app_private.ops_amount_name, app_private.ops_amount_vat, app_private.ops_assert_attempt_integrity (+3 more)

### Community 52 - "Preferencias y dueños SQL"
Cohesion: 0.19
Nodes (10): app_private.assert_business_logo, app_private.assert_owner_operator, app_private.employee_context, app_private.profile_image_manage, app_private.validate_profile, public.account_manage, app_private.account_profiles, app_private.profile_image_operations (+2 more)

### Community 53 - "Dependencias del frontend"
Cohesion: 0.15
Nodes (13): dependencies, @fontsource/ibm-plex-sans, gsap, @gsap/react, jsqr, lucide-react, qrcode.react, react (+5 more)

### Community 54 - "Resumen de caja"
Cohesion: 0.21
Nodes (11): Deliberate legacy-checkout compatibility and owner activation, docs/lean-operations-backend.md, Historical direct record_payment contract, Tenant-qualified immutable kitchen cancellation overlay, Existing personal pos and shared device_pos transport, Pending executable kitchen work has bounded-queue priority, Persisted prepare/update/record checkout reservation, Private pos_command checks current actor/grants before replay (+3 more)

### Community 55 - "Contratos operativos documentados"
Cohesion: 0.30
Nodes (10): assertCatalogBatchPlan(), CatalogBatchPlan, CatalogRecoveryConflictError, clearCatalogBatchPlan(), encodePlan(), key(), loadCatalogBatchPlan(), saveCatalogBatchPlan() (+2 more)

### Community 56 - "Recuperación de lotes CSV"
Cohesion: 0.45
Nodes (10): commands, exact(), integer(), invalid(), object(), parseOperationsCommand(), payment(), reportDate() (+2 more)

### Community 57 - "Validación de operaciones"
Cohesion: 0.58
Nodes (10): array(), bool(), fail(), integer(), object(), parseModifierSet(), parseProductDetails(), parseSelection() (+2 more)

### Community 58 - "Validación de productos"
Cohesion: 0.38
Nodes (10): exact(), int(), invalid(), parsePromotionCommand(), parsePromotionScope(), text(), uuid(), parseOperation() (+2 more)

### Community 59 - "Validación de promociones"
Cohesion: 0.18
Nodes (10): Role-equivalent phone/tablet navigation and accessible 48 px controls, Original white interface, Tailwind, local IBM Plex Sans and Lucide, Tailwind CSS Vite architecture, Archived static PWA / thin Edge / transactional PostgreSQL architecture, Archived private-schema and service-only RPC boundary, docs/history/2026-10-02-agents-before-workflow-cleanup.md, Proposed durable offline financial queue, Proposed operational catalog/orders/sales/payments/shift model (+2 more)

### Community 60 - "Interfaz y arquitectura histórica"
Cohesion: 0.25
Nodes (11): Development server plus explicit flag plus loopback backend, Persistent local Supabase stack identity per absolute checkout path, Development Auth is gated by Vite mode, flag and loopback backend, docs/local-development.md, Local HTTP Point provider with normal Auth/Edge/PostgreSQL authorization, Deterministic Point recovery using a manual local worker, Node 24 / Docker / npm-ci development runner, Explicit local migration up preserves data (+3 more)

### Community 61 - "Persistencia del desarrollo local"
Cohesion: 0.24
Nodes (11): Revisión de Mercado Pago Point — 3 de octubre de 2026, Durable Point reconciliation and terminal exclusion, Mercado Pago Point webhook notifications, Mercado Pago OAuth token API, Mercado Pago Point order and transaction states, Mercado Pago Point payment processing, Mercado Pago Point refund API, Point recovery and financial consistency review (+3 more)

### Community 62 - "Revisión de consistencia Point"
Cohesion: 0.20
Nodes (11): Background catalog refresh and stale-response rejection, docs/products-sales.md, Historical stock-based sale transaction policy, Manual availability without inventory mutation, MVP catalog scope, Four independent payment methods, Personal and paired-register POS authorization, Printable receipt and browser PDF (+3 more)

### Community 63 - "Disponibilidad y catálogo histórico"
Cohesion: 0.18
Nodes (11): Preserved-data loading and retry states, Checkout selection and discount action guards, One-time accepted result consumption in checkout recovery, Clover POS systems, Dated removal of money-receipt confirmations, docs/ui-audit-2026-10-03.md, Grouped presence refresh with explicit staleness, Revolut Business Analytics (+3 more)

### Community 64 - "Auditoría de interfaz"
Cohesion: 0.20
Nodes (8): app_private.ops_apply_kitchen_cancellation, app_private.ops_batch_fully_cancelled, app_private.ops_batch_json, app_private.ops_batch_pending, app_private.permission_keys, app_private.kitchen_batches, app_private.kitchen_cancellations, app_private.order_cancellations

### Community 65 - "Cocina y cancelaciones SQL"
Cohesion: 0.18
Nodes (11): Business creation and employee access implementation plan, Employee extension security constraints, Business/team extension architecture plan, Historical business/team deployment evidence, Business/team extension reported local checkpoint, Approved unified employee record correction, Business creation and employee access, Restricted paired shared register specification (+3 more)

### Community 66 - "Planes históricos de equipo"
Cohesion: 0.18
Nodes (10): Alpha five-destination responsive navigation, Visible employee role and invitation-first creation, Integrated six-digit PIN keypad reference, White operation and carbon management separation, Original interface as dated visual authority, Square searchable library and separated checkout pattern, Square item grid, Square create and edit items (+2 more)

### Community 67 - "Referencias de diseño"
Cohesion: 0.44
Nodes (8): date(), integer(), invalid(), parsePointCommand(), providerId(), text(), uuid(), RequestValidationError

### Community 68 - "Validación HTTP Point"
Cohesion: 0.44
Nodes (9): commands, exact(), ids(), int(), invalid(), parseServiceCommand(), text(), timestamp() (+1 more)

### Community 69 - "Validación de servicio"
Cohesion: 0.36
Nodes (8): ProductVariationBuilder(), Variation, appendVariations(), key(), normalized(), previewVariations(), VariationDimension, VariationPreview

### Community 70 - "Generación de variantes"
Cohesion: 0.24
Nodes (10): docs/employee-permissions.md, Employee-before-operator lock ordering, Grouped employee action grants, Permission changes revoke personal and shared-register operators, Permission prerequisite closure, Personal metrics resolved by current employee identity, Protected owner identity, Current authorization before accepted retry or invitation acceptance (+2 more)

### Community 71 - "Permisos de empleados"
Cohesion: 0.27
Nodes (10): Auth/employee/operator/membership locks serialize Point acceptance and revocation, Dated backend/source/grant/scheduler publication report, Auditoría de cobros y terminal — 4 de octubre de 2026, Earlier audited unified integrated-card decision, Official/physical successful refund remains unverified, Dated official virtual-terminal outcome verification, Independent provider GET verification precedes sale materialization, Mercado Pago Point POS v2 creation (+2 more)

### Community 72 - "Auditoría de terminal Point"
Cohesion: 0.33
Nodes (9): base64url(), DeviceIdentity, EmployeeDeviceProof, loadIdentity(), openDatabase(), readIdentity(), signEmployeeDeviceRequest(), storeIdentityIfAbsent() (+1 more)

### Community 73 - "Firmas del navegador"
Cohesion: 0.33
Nodes (9): Business defaultVatTreatment only initializes new products, Accepted amount snapshots use business defaultVatTreatment, kind amount: name, quantity, unitPriceCents; no productId/version/selection, docs/custom-amount-charge.md, Venta → Importe adds an amount line, alone or with products, NULL product references allowed exclusively for amount lines, Documented SQL and HTTP payload regression scope for free amounts, tests/sql/free-amount-lines.test.ts (+1 more)

### Community 74 - "Importes libres e IVA"
Cohesion: 0.39
Nodes (9): 500 products/512 KB file, ≤20 products and 7000 bytes per atomic batch, Permissioned previewed CSV import/export and bulk editing, docs/catalogo-csv.md, Reported accepted/rejected late-response regression validation, Business/employee-bound original UUID/payload recovery in browser, pos_mexico_v1 with formula protection and detalles_json, Current-session and original-plan guard prevents late CSV progress overwrite, Product id/version controls creates and concurrent catalog updates (+1 more)

### Community 75 - "Contrato de importación CSV"
Cohesion: 0.28
Nodes (9): Pilot scope conditioned by actual merchant workflow, Preparación del primer cliente, Menu-to-close end-to-end acceptance flow, Separate manual external card and integrated Mercado Pago Point, Shift-level collected/refunded/net payment-method summary, Small cafe, one site/register, online pilot hypothesis, Print/save PDF commercial receipt from immutable snapshots, Synthetic combined-dev acceptance evidence (+1 more)

### Community 76 - "Preparación del primer cliente"
Cohesion: 0.43
Nodes (6): decode(), base64(), signed(), DeviceProofError, verifiedDeviceRequest(), isUuid()

### Community 77 - "Pruebas de dispositivo"
Cohesion: 0.57
Nodes (7): exactKeys(), integer(), invalid(), parsePosCommand(), text(), uuid(), ProductSaleInputLine

### Community 78 - "Validación HTTP POS"
Cohesion: 0.32
Nodes (7): Business → Operation → PIN → direct Home and preserved action data, Separate /business/ready confirmation, Full-screen black checkout with phone/tablet arrangement, GSAP with React cleanup and reduced-motion handling, Ivory/green products-sales styling proposal, Owner charcoal sidebar; employee white navigation and black actions, Full white six-digit PIN entry with single server validation

### Community 79 - "Sistema de diseño"
Cohesion: 0.39
Nodes (8): Immediate active polling on submit/simulate/focus/reconnect, Authorized per-attempt immediate reconciliation, Dated fast-path backend publication report, docs/point-confirmation-latency-2026-10-05.md, Periodic Point scheduler as durable reconciliation fallback, Private work indication after personal/device authorization, Simulation acceptance requires independent Orders/Payments evidence, Supabase background tasks

### Community 80 - "Confirmación rápida de Point"
Cohesion: 0.25
Nodes (8): Creación de productos: revisión de Square y adaptación al POS, Optional catalog metadata and product editor, Direct-add preference preserves required selections, Square catalog options additive contract, Square create item editor, Observed Square item editor reference, Square adaptation dated scope exclusions, Square adaptation reported verification

### Community 81 - "Adaptación del catálogo Square"
Cohesion: 0.43
Nodes (7): Permission-driven destinations and default entry, docs/owner-employee-experience-plan.md, Owner/employee composition verification in loopback dev, Server calendar analytics with correct partial comparisons, Owner management and employee operation composition, Shared real report dashboard and authorized period hook, Single mounted sale/account controller across navigation

### Community 82 - "Composición dueño y empleado"
Cohesion: 0.38
Nodes (7): docs/shift-payment-summary.md, Unattributed Point refunds in shift summary, Shift payment summary by method, Shift summary local and combined-preview evidence, Backward-compatible permission-gated paymentSummary, tests/integration/lean-operations.integration.test.ts, tests/sql/shift-payment-summary.test.ts

### Community 83 - "Cobros por turno"
Cohesion: 0.29
Nodes (7): Tailwind and unified interface — 2 October 2026, Impeccable, External reference guidance and shadcn MCP, Official shadcn MCP documentation, Tailwind responsive and accessibility evidence, Dated original-identity visual tokens, Vercel Web Design Guidelines

### Community 84 - "Guía histórica de Tailwind"
Cohesion: 0.33
Nodes (5): currency, integerCurrency(), ShiftPaymentSummary, CashPaymentSummary(), labels

### Community 85 - "Desbloqueo por PIN"
Cohesion: 0.40
Nodes (3): AccessBusy(), PinScreenEntrance(), Props

### Community 86 - "Notificaciones de acceso"
Cohesion: 0.33
Nodes (3): Notice, Props, statuses

### Community 87 - "Acceso a varios negocios"
Cohesion: 0.60
Nodes (6): Select own businesses and employee memberships with server roles, docs/business-access.md, Explicit local camera/jsQR scan of same-origin complete invitations, Per-user last business ID checked against fresh memberships, Visible catalog refresh every 15 seconds plus focus/reconnection/manual refresh, Reported dual-membership, tenant, browser and synthetic-camera regressions

### Community 88 - "Verificación de assets públicos"
Cohesion: 0.40
Nodes (4): check(), contentTypes, dist, sha256()

### Community 89 - "Alcance POS operativo"
Cohesion: 0.40
Nodes (5): Approved Lean POS scope and incremental rollout, docs/lean-pos-mvp.md, Shared drawer Open / Closing / Closed lifecycle, Independent order, preparation and persisted payment lifecycles, One unresolved mutation per operator/business with durable UUID/payload

### Community 90 - "Preparación histórica de Point"
Cohesion: 0.40
Nodes (5): Provider/sandbox activation pending in dated release record, Dated Point release backend staging and evidence, Point release preparation — 3 October 2026, Downloaded Edge sources match checked standalone artifacts, Generation-scoped synchronous guard preserves pending double-submit state

### Community 91 - "Referencias de integración"
Cohesion: 0.40
Nodes (5): tests/integration/employee-device-browser-smoke.mjs, tests/integration/employee-unlink-migration-smoke.mjs, tests/integration/production-google-guard.mjs, tests/integration/real-onboarding-smoke.mjs, Synthetic loopback integration and migration verification

### Community 92 - "Configuración del paquete"
Cohesion: 0.40
Nodes (4): name, private, type, version

## Knowledge Gaps
- **462 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+457 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `docs/history/2026-10-02-agents-before-workflow-cleanup.md` connect `Validación de promociones` to `Clientes y errores POS`, `Planes históricos de equipo`, `Evidencia histórica de backend`, `Resumen y arquitectura`, `Validación HTTP POS`, `Correo PIN e historial`, `Contratos y administración de equipo`, `Sesión Auth del cliente`, `Configuración del paquete`, `Backend y política PIN`, `Entrada y escaneo QR`, `Reglas y aislamiento`, `Account Edge y autenticación`, `Verificación de assets públicos`, `Fundación de sesiones SQL`, `Revisión y publicación`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `docs/financial-integrity-2026-10-03.md` connect `Validación de acceso HTTP` to `Clientes y errores POS`, `Espacio operativo y servicio`, `Cobro y dinero`, `Validación de resultados financieros`, `Venta y borradores`, `Resumen y arquitectura`, `Reservas y asignación financiera`, `Resumen de caja`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `docs/owner-employee-experience-plan.md` connect `Adaptación del catálogo Square` to `Clientes y errores POS`, `Reinvitación histórica`, `Espacio operativo y servicio`, `Cobro y dinero`, `Planes históricos de equipo`, `Generación de variantes`, `Venta y borradores`, `Validación HTTP POS`, `Navegación por permisos`, `Panel de reportes`, `Entrada y escaneo QR`, `Resumen de caja`, `Recuperación y dispositivos SQL`, `Alcance POS operativo`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._