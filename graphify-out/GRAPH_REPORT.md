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
- 321 files · ~279,349 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2068 nodes · 5429 edges · 101 communities (99 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 31 edges (avg confidence: 0.89)
- Token cost: unavailable. Semantic agents ran in the host session, which does not expose their input/output usage; zero placeholders are not a measured zero cost.

## Graph Freshness
- Base commit (map-support source changes included separately): `3a2f112c`
- Compare per-source SHA-256 hashes in `map-metadata.json`; a merge commit alone does not determine freshness.
- Regenerate with the Graphify skill, fresh semantic fragments and the SQL supplement described in `docs/code-map.md`.

## God Nodes (most connected - your core abstractions)
1. `money()` - 58 edges
2. `AccountClientError` - 47 edges
3. `supabase/README.md` - 43 edges
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

## Communities (101 total, 2 thin omitted)

### Community 91 - "Configuración del paquete"
Cohesion: 0.40
Nodes (4): name, version, private, type

### Community 30 - "Comandos npm"
Cohesion: 0.08
Nodes (25): scripts, dev, dev:frontend, dev:stop, test:dev, build, preview, test (+17 more)

### Community 58 - "Dependencias del frontend"
Cohesion: 0.15
Nodes (13): dependencies, @fontsource/ibm-plex-sans, @gsap/react, @supabase/supabase-js, gsap, jsqr, lucide-react, qrcode.react (+5 more)

### Community 46 - "Dependencias de desarrollo"
Cohesion: 0.11
Nodes (18): devDependencies, @electric-sql/pglite, @playwright/test, @tailwindcss/vite, @testing-library/jest-dom, @testing-library/react, @types/node, @types/react (+10 more)

### Community 29 - "Empaquetado de funciones Edge"
Cohesion: 0.09
Nodes (16): buildAccountSource(), namespaces, aliases, buildPointModules(), buildPointSource(), { source, edge }, rows, prior (+8 more)

### Community 8 - "Arranque y contexto local"
Cohesion: 0.06
Nodes (35): root, root, directory, cli, args, pointSimulatorEnabled, pointManualWorker, frontendArgs (+27 more)

### Community 88 - "Verificación de archivos públicos"
Cohesion: 0.40
Nodes (4): dist, sha256(), contentTypes, check()

### Community 31 - "Navegación del mapa"
Cohesion: 0.14
Nodes (19): Add auditable lexical SQL declarations; no claims about deployed/current schema., Claude entry routes to AGENTS and module sources, Graph is a source index, never authorization or production evidence, Read report/guide or filter source_file/label instead of entire JSON, docs/code-map.md, Graphify source index for files, symbols, contracts and documented concepts, GRAPH_REPORT.md: communities, central nodes and connections, graph.json: nodes, relations, provenance and confidence (+11 more)

### Community 39 - "Reinvitación histórica de empleados"
Cohesion: 0.10
Nodes (17): evidence, ledger, latest, migration, previous, row, historyChecks, functionValues (+9 more)

### Community 43 - "Preparación de desvinculación permanente"
Cohesion: 0.11
Nodes (14): evidence, ledger, latest, guarded, afterProducts, functionValues, tableValues, ledgerValues (+6 more)

### Community 26 - "Entrada y acceso personal"
Cohesion: 0.07
Nodes (20): InvitationScanner, HomeScreen, PublicMenu, TeamPanel, BusinessSettings, AccountProfileSettings, NotificationsPanel, DeviceLogin (+12 more)

### Community 33 - "Acceso y recuperación de PIN"
Cohesion: 0.12
Nodes (9): AccessButtonContent(), DeviceLoginProps, roles, Props, Notice, Props, statuses, OperatorSession (+1 more)

### Community 86 - "Desbloqueo por PIN"
Cohesion: 0.40
Nodes (3): AccessBusy(), PinScreenEntrance(), Props

### Community 7 - "Transporte y catálogo POS"
Cohesion: 0.14
Nodes (21): PendingIndicator(), ModifierLibrary(), PosDialog(), accessErrorCodes, CatalogState, useModifierLibrary(), AccountClientError, accountRequest() (+13 more)

### Community 89 - "Entrada de importe libre"
Cohesion: 0.70
Nodes (3): AmountEntry(), parseAmountCents(), amountKey()

### Community 34 - "Configuración del negocio"
Cohesion: 0.18
Nodes (18): BusinessOperationFields(), paymentOptions, emptyProfile, profileSignature(), BusinessSettings(), BusinessDraft, BusinessSetup(), TransferAccountFields() (+10 more)

### Community 6 - "Cuentas y servicio operativo"
Cohesion: 0.08
Nodes (31): BusinessSettingsProps, TeamPanelProps, icons, KitchenStage, stages, KitchenState, ServiceOrderPanel(), labels (+23 more)

### Community 5 - "Cobro y cálculo monetario"
Cohesion: 0.10
Nodes (32): CashChangeCalculator(), CheckoutClosingContext, CheckoutInteractionContext, CheckoutPanel(), ExternalCardConfirmation(), icons, PaymentMethodPicker(), AttemptPanel() (+24 more)

### Community 15 - "Contratos y gestión de empleados"
Cohesion: 0.08
Nodes (29): permissionGroups, InvitationQrProps, InvitationQr(), EmployeeRole, sessionErrors, Code, TransferConfirmation(), BusinessRole (+21 more)

### Community 17 - "Inicio, navegación y reportes"
Cohesion: 0.12
Nodes (25): HomeScreenProps, HomeScreen(), SaleReceiptDialog(), WorkspaceShell(), useCatalog(), usePoint(), ReportTab, ReportsScreen() (+17 more)

### Community 44 - "Métricas personales y formatos"
Cohesion: 0.14
Nodes (14): Skeleton(), TemporalChart, periods, calendarDate, dateLabel(), PersonalMetricsScreen(), Kpi(), invitationFromLink() (+6 more)

### Community 4 - "Menús públicos y horarios"
Cohesion: 0.08
Nodes (35): SaveMenu, Draft, Recovery, storageKey(), RecoveryConflictError, readRecovery(), assertStoredRecovery(), writeRecovery() (+27 more)

### Community 35 - "Editor de productos y extras"
Cohesion: 0.14
Nodes (16): MoneyInput(), ProductComboFields(), ProductCustomAttribute, sections, ProductEditor(), parseModifierPrice(), modifierPriceInput(), ModifierSet (+8 more)

### Community 12 - "Cliente y paneles Point"
Cohesion: 0.08
Nodes (31): dateLabel(), seconds(), metricDefinitions, PointDashboard(), PointDashboardSession(), SetupOperation, PointSetup(), PointStatements() (+23 more)

### Community 18 - "Ventas, comprobantes y pagos"
Cohesion: 0.12
Nodes (25): matchesQuote(), PointPayment(), PointPaymentSession(), Props, PointRefund(), PointRefundSession(), CatalogFilters(), EmptyCatalog() (+17 more)

### Community 42 - "Selección de productos y combos"
Cohesion: 0.36
Nodes (14): ProductSelection(), ItemSelection, productDetails(), selectedPrice(), modifierQuantity(), modifierOptionLimit(), modifierOptionAvailable(), activeModifierSets() (+6 more)

### Community 41 - "Contratos y metadatos de producto"
Cohesion: 0.12
Nodes (15): palette, ProductAvailability(), OperationsErrorCode, Modifier, ProductAttribute, ProductDetails, ComboComponentInput, ProductInput (+7 more)

### Community 71 - "Generación de variantes"
Cohesion: 0.36
Nodes (8): ProductVariationBuilder(), Variation, VariationDimension, VariationPreview, normalized(), key(), previewVariations(), appendVariations()

### Community 72 - "IVA de productos y líneas"
Cohesion: 0.33
Nodes (7): ProductVatFields(), OrderLine, VatTreatment, includedTax(), vatRates, vatLabels, VatLine

### Community 93 - "Búsqueda y filtrado de productos"
Cohesion: 0.50
Nodes (4): ProductsScreen(), OrderEditor(), searchText(), filterProducts()

### Community 13 - "Descuentos y promociones"
Cohesion: 0.14
Nodes (31): Draft, fromPromotion(), PromotionManager(), usePromotions(), OrderDiscountEditorProps, OrderDiscountEditor(), SavedPromotionPicker(), discountInputValue() (+23 more)

### Community 25 - "Venta y borradores"
Cohesion: 0.12
Nodes (23): saleCommand(), SaleScreenSession(), cartLineName(), cartLinePrice(), cartLineSelection(), cartLineInput(), cartLineOrderInput(), savedOrderLineInput() (+15 more)

### Community 21 - "Gráficas de analítica"
Cohesion: 0.07
Nodes (23): Payment, CashDifference, TooltipPayload, colors, metricLabels, compactCurrency, compactNumber, percentage (+15 more)

### Community 85 - "Resumen de cobros en Caja"
Cohesion: 0.33
Nodes (5): labels, CashPaymentSummary(), currency, integerCurrency(), ShiftPaymentSummary

### Community 16 - "Panel de reportes"
Cohesion: 0.06
Nodes (20): charts(), TemporalChart, DailySalesChart, RankedBars, PaymentNetChart, FinancialWaterfall, TaxChart, CashDifferenceChart (+12 more)

### Community 55 - "Modelo de analítica"
Cohesion: 0.15
Nodes (11): TemporalMetric, TemporalPoint, TemporalDatum, buildTemporalChartData(), buildDailySalesChartData(), temporalTicks(), WaterfallDatum, buildFinancialWaterfallData() (+3 more)

### Community 66 - "Estado y mutaciones operativas"
Cohesion: 0.22
Nodes (10): Mutation, OperationOrigin, PendingOperation, commands, readPendingOperation(), readOperation(), MutationState, uncertainErrorCodes (+2 more)

### Community 69 - "Validación de promociones"
Cohesion: 0.44
Nodes (9): parseOperation(), PromotionCommand, invalid(), exact(), uuid(), int(), text(), parsePromotionScope() (+1 more)

### Community 61 - "Recuperación de lotes CSV"
Cohesion: 0.30
Nodes (10): CatalogBatchPlan, key(), CatalogRecoveryConflictError, encodePlan(), assertCatalogBatchPlan(), loadCatalogBatchPlan(), saveCatalogBatchPlan(), clearCatalogBatchPlan() (+2 more)

### Community 53 - "CSV y edición masiva"
Cohesion: 0.18
Nodes (12): catalogCsvHeaders, formulaText(), encodeText(), decodeText(), exportCatalogCsv(), readCatalogCsv(), taxes, previewCatalogCsv() (+4 more)

### Community 2 - "Validación de resultados financieros"
Cohesion: 0.11
Nodes (48): checkoutAmountTotals(), ObjectValue, orderCommands, attemptCommands, shiftCommands, identifier(), sameId(), LineIdentity (+40 more)

### Community 22 - "Autenticación y correo Edge"
Cohesion: 0.08
Nodes (19): AccountRequest, AccountError, google, VerifiedAuthClaims, VerifiedUser, verifiedGoogleAuthentication(), claimsFromVerifiedJwt(), env() (+11 more)

### Community 54 - "Sesión Auth del cliente"
Cohesion: 0.19
Nodes (8): isVerifierKey(), identityStorage, hasCurrentStoredIdentity(), initializeIdentity(), clearStoredIdentity(), allowIdentitySignIn(), discardIdentity(), closeIdentity()

### Community 76 - "Firma del navegador del empleado"
Cohesion: 0.33
Nodes (9): DeviceIdentity, EmployeeDeviceProof, openDatabase(), readIdentity(), storeIdentityIfAbsent(), validateIdentity(), loadIdentity(), base64url() (+1 more)

### Community 57 - "Validación de operaciones"
Cohesion: 0.35
Nodes (12): OrderInputLine, OperationsCommand, commands, invalid(), object(), exact(), uuid(), integer() (+4 more)

### Community 79 - "Validación de comandos POS"
Cohesion: 0.57
Nodes (7): ProductSaleInputLine, invalid(), exactKeys(), integer(), uuid(), text(), parsePosCommand()

### Community 65 - "Validación de respuestas de servicio"
Cohesion: 0.29
Nodes (9): ServiceOrderState, ServiceDay, Row, record(), ids(), visit(), courses(), assertServiceOrderView() (+1 more)

### Community 94 - "Entrada HTML de la aplicación"
Cohesion: 0.50
Nodes (3): POS México HTML entrypoint, Spanish mobile-aware HTML entry metadata, public/favicon.svg

### Community 78 - "Verificación de firma de dispositivo"
Cohesion: 0.43
Nodes (6): base64(), signed(), DeviceProofError, decode(), verifiedDeviceRequest(), isUuid()

### Community 49 - "Validación de acceso HTTP"
Cohesion: 0.33
Nodes (13): access, validCreate, invalid(), exactKeys(), uuid(), pin(), token(), name() (+5 more)

### Community 68 - "Validación HTTP de Point"
Cohesion: 0.44
Nodes (8): invalid(), uuid(), providerId(), integer(), text(), date(), parsePointCommand(), RequestValidationError

### Community 62 - "Validación de productos"
Cohesion: 0.58
Nodes (10): fail(), object(), string(), integer(), uuid(), bool(), array(), parseSelection() (+2 more)

### Community 70 - "Validación de servicio"
Cohesion: 0.44
Nodes (9): commands, invalid(), exact(), uuid(), int(), text(), ids(), timestamp() (+1 more)

### Community 27 - "Webhooks y conciliación Point"
Cohesion: 0.15
Nodes (21): handleWebhook(), handleWorker(), backgroundPointWork(), encoder, base64(), bytes(), randomSecret(), digest() (+13 more)

### Community 37 - "Servicio y conciliación Point"
Cohesion: 0.17
Nodes (19): BackgroundRuntime, BackgroundOptions, Environment, record(), PointAdapter, RpcClient, configuration, PointServiceError (+11 more)

### Community 48 - "Validación de evidencia Point"
Cohesion: 0.18
Nodes (15): PaymentState, ProviderError, Json, decimal(), cents(), paymentCents(), TokenSet, ExpectedOrder (+7 more)

### Community 56 - "Adaptador de Mercado Pago"
Cohesion: 0.35
Nodes (3): identifier(), responseJSON(), MercadoPagoPoint

### Community 3 - "Restaurante y evidencia local"
Cohesion: 0.06
Nodes (50): PublicMenuDependencies, InvalidRequest, input(), handlePublicMenu(), origins, admin, public.public_menu_read, Revisión sintética de restaurante con MiroFish — 2026-10-07 (+42 more)

### Community 40 - "Configuración TypeScript"
Cohesion: 0.10
Nodes (20): compilerOptions, target, useDefineForClassFields, lib, module, skipLibCheck, moduleResolution, allowImportingTsExtensions (+12 more)

### Community 28 - "Diseño y contexto histórico"
Cohesion: 0.08
Nodes (25): Six-digit PIN, bcrypt cost 12 and concurrent lockout, Role-equivalent phone/tablet navigation and accessible 48 px controls, Original white interface, Tailwind, local IBM Plex Sans and Lucide, GSAP with React cleanup and reduced-motion handling, Full-screen black checkout with phone/tablet arrangement, Full white six-digit PIN entry with single server validation, Ivory/green products-sales styling proposal, Separate /business/ready confirmation (+17 more)

### Community 0 - "Acceso y empleados SQL"
Cohesion: 0.06
Nodes (88): app_private.business_memberships, app_private.operator_credentials, app_private.operator_sessions, app_private.business_create_operations, app_private.account_audit_events, app_private.assert_live_auth, app_private.assert_owner, app_private.business_context (+80 more)

### Community 1 - "Persistencia de pagos Point"
Cohesion: 0.07
Nodes (39): app_private.ops_uuid, app_private.ops_assert_payment_quote, app_private.point_settings, app_private.point_connections, app_private.point_terminals, app_private.point_checkouts, app_private.point_attempts, app_private.point_terminal_reservations (+31 more)

### Community 10 - "Catálogo y menús SQL"
Cohesion: 0.10
Nodes (33): app_private.businesses, app_private.assert_member, app_private.products, app_private.sale_items, app_private.pos_operations, app_private.product_json, app_private.sale_json, app_private.product_images (+25 more)

### Community 20 - "Operaciones y reportes SQL"
Cohesion: 0.13
Nodes (24): app_private.sales, app_private.pos_command, app_private.has_permission, app_private.cash_shifts, app_private.cash_movements, app_private.order_events, app_private.checkout_attempts, app_private.sale_reversals (+16 more)

### Community 36 - "IVA e importes libres"
Cohesion: 0.13
Nodes (22): Integer cents, exact decimals and centralized rounding, Business defaultVatTreatment only initializes new products, docs/catalogo-mvp-iva.md, Historical reduced MVP catalog editor scope, Final advertised price with VAT extracted once per line, vat_16, vat_0, exempt, border_8 and unconfigured are distinct, Compatible optional taxTreatment and immutable nullable historical snapshots, IS DISTINCT FROM rejects retry by an erased actor with NULL identity (+14 more)

### Community 14 - "Visitas y tiempos SQL"
Cohesion: 0.08
Nodes (31): app_private.operational_settings, app_private.dining_tables, app_private.operational_orders, app_private.ops_exact, app_private.ops_pending, app_private.ops_order_json, app_private.ops_table_json, app_private.ops_order_kind_immutable (+23 more)

### Community 11 - "Integridad y asignación financiera"
Cohesion: 0.08
Nodes (33): app_private.order_lines, app_private.ops_line_json, app_private.ops_price_order, app_private.ops_slice, app_private.ops_quote_totals_valid, app_private.ops_guard_financial_history, app_private.ops_guard_frozen_order, app_private.ops_guard_new_collection (+25 more)

### Community 45 - "Promociones y cancelaciones de cocina"
Cohesion: 0.12
Nodes (15): app_private.kitchen_batches, app_private.order_cancellations, app_private.ops_text, app_private.ops_batch_json, app_private.kitchen_cancellations, app_private.ops_apply_kitchen_cancellation, app_private.ops_batch_fully_cancelled, app_private.ops_batch_pending (+7 more)

### Community 60 - "Contratos operativos documentados"
Cohesion: 0.21
Nodes (11): docs/lean-operations-backend.md, Existing personal pos and shared device_pos transport, Private pos_command checks current actor/grants before replay, Shared drawer closure with blind immutable count, Historical direct record_payment contract, Superseded two-state paid-quantity kitchen interface, Tenant-qualified immutable kitchen cancellation overlay, Pending executable kitchen work has bounded-queue priority (+3 more)

### Community 32 - "División y publicación documentadas"
Cohesion: 0.15
Nodes (23): Private app_private schema and service-only privileged RPCs, Mercado Pago Point: provider-confirmed integrated payments, docs/amount-split-checkout.md, Dividir por cantidad: up to twenty positive exact amounts, prepare_checkout/update_checkout: items empty plus amountsCents, Stable UUID-ordered gross/discount/paid/IVA allocation, Only confirmed payment reduces balance; no item split after first amount payment, Reported local PostgreSQL, component, HTTP and synthetic Point validation (+15 more)

### Community 23 - "Revisión y publicación"
Cohesion: 0.15
Nodes (27): .github/pull_request_template.md, .github/workflows/ci.yml, Basic checks: smoke and production build, production-dist checked build artifact, PR and main checks; deployment only for main push, .github/workflows/deploy-pages.yml, Serialized uploads of latest main only, Deploy the checked frontend artifact to Cloudflare Pages (+19 more)

### Community 82 - "Comprobaciones completas de CI"
Cohesion: 0.43
Nodes (8): Required financial checks, .github/workflows/full-checks.yml, Web checks: lint, types, domain, SQL, provider, build and browser, Modular and standalone Edge validation, Disposable Auth/Edge/PostgreSQL integration without skipped tests, Deterministic local HTTP provider simulator, Integration gate rejects pending or failed tests, tests/provider/simulator.mjs

### Community 38 - "Aislamiento y acceso de empleados"
Cohesion: 0.18
Nodes (21): Business tenant: actor, session, membership and permissions, Memory-only operator session; eight-hour expiry and immediate revocation, Confirmed-email PIN recovery: one use, 15 minutes, no access session, docs/employee-device-access.md, Personal employee browser binding with owner-approved replacement, ECDSA P-256 exact-payload proof with nonce/time and non-exportable IndexedDB key, Edge verifies proof/freshness; SQL consumes nonce and checks verified key digest, Private persistent owner inbox with explicit read and replacement decisions (+13 more)

### Community 24 - "Contratos de operación y catálogo"
Cohesion: 0.15
Nodes (29): Exact JSON keys, 8 KiB, stable errors, no-store and explicit CORS, Atomic mutations and actor/UUID/payload-bound accepted retry, Financial snapshots and linked corrections, Cobro directo and Cuentas abiertas, Tenant catalog: products, variants, modifiers, combos and IVA, Reserved checkout, confirmed split payments and immutable receipts, Restaurant service, accounts, visits, tables, reservations and kitchen, Shared shifts, cash movements, blind close and registered-method net (+21 more)

### Community 63 - "Desarrollo local persistente"
Cohesion: 0.25
Nodes (11): Development server plus explicit flag plus loopback backend, Persistent local Supabase stack per checkout, docs/local-development.md, Node 24 / Docker / npm-ci development runner, Persistent local Supabase stack identity per absolute checkout path, Explicit local migration up preserves data, Development Auth is gated by Vite mode, flag and loopback backend, Local HTTP Point provider with normal Auth/Edge/PostgreSQL authorization (+3 more)

### Community 59 - "Arquitectura y alcance actual"
Cohesion: 0.21
Nodes (12): POS México: online React/TypeScript/Vite PWA, Cloudflare Pages frontend, Supabase Auth, Edge Functions and PostgreSQL, Published informational QR menus with anonymous access, Online-only product scope; no CFDI, fractional sales, stock automation or bank settlement, Auth/device identity → Edge → privileged RPC → PostgreSQL, src/components/: catalog, access, team and Point/menu panels, src/features/operations/: service, kitchen, checkout, cash and reports (+4 more)

### Community 87 - "Acceso a varios negocios"
Cohesion: 0.60
Nodes (6): docs/business-access.md, Select own businesses and employee memberships with server roles, Per-user last business ID checked against fresh memberships, Explicit local camera/jsQR scan of same-origin complete invitations, Visible catalog refresh every 15 seconds plus focus/reconnection/manual refresh, Reported dual-membership, tenant, browser and synthetic-camera regressions

### Community 73 - "Permisos de empleados"
Cohesion: 0.24
Nodes (10): docs/employee-permissions.md, Grouped employee action grants, Protected owner identity, Permission prerequisite closure, Personal metrics resolved by current employee identity, Permission changes revoke personal and shared-register operators, Current authorization before accepted retry or invitation acceptance, Employee-before-operator lock ordering (+2 more)

### Community 47 - "Integridad financiera documentada"
Cohesion: 0.15
Nodes (17): docs/financial-integrity-2026-10-03.md, Integer MXN cents and monetary invariants, Exact discount with stable largest-remainder allocation, Cumulative exact quantity/discount/IVA prefixes, Financial response validation before clearing recovery, Durable original UUID/payload recovery under live authorization, Atomic receipt, paid quantities, kitchen batch and accepted response, Session-scoped generations and cross-tab recovery locks (+9 more)

### Community 77 - "Preparación del primer cliente"
Cohesion: 0.28
Nodes (9): Preparación del primer cliente, Small cafe, one site/register, online pilot hypothesis, Menu-to-close end-to-end acceptance flow, Print/save PDF commercial receipt from immutable snapshots, Separate manual external card and integrated Mercado Pago Point, Shift-level collected/refunded/net payment-method summary, Pilot scope conditioned by actual merchant workflow, Synthetic combined-dev acceptance evidence (+1 more)

### Community 51 - "Correo PIN e historial"
Cohesion: 0.16
Nodes (14): Historical deployment notes — archived 2 October 2026, Archived Basic checks and exact-dist publication lane, Archived native SPA fallback preserves OAuth callback, Archived PWA shell cache and delayed worker adoption, Archived anonymous public route/asset hash gate, docs/pin-email-recovery.md, Confirmed-email single-use PIN recovery capability, Recovery server validates live identity, current person and confirmed email (+6 more)

### Community 83 - "Vistas de dueño y empleado"
Cohesion: 0.43
Nodes (7): docs/owner-employee-experience-plan.md, Owner management and employee operation composition, Permission-driven destinations and default entry, Single mounted sale/account controller across navigation, Shared real report dashboard and authorized period hook, Server calendar analytics with correct partial comparisons, Owner/employee composition verification in loopback dev

### Community 80 - "Confirmación rápida de Point"
Cohesion: 0.39
Nodes (8): docs/point-confirmation-latency-2026-10-05.md, Authorized per-attempt immediate reconciliation, Private work indication after personal/device authorization, Immediate active polling on submit/simulate/focus/reconnect, Periodic Point scheduler as durable reconciliation fallback, Simulation acceptance requires independent Orders/Payments evidence, Dated fast-path backend publication report, Supabase background tasks

### Community 52 - "Comisiones y evidencia Point"
Cohesion: 0.21
Nodes (14): docs/point-financial-model.md, Server-reserved immutable Point checkout snapshot, Uncertain bank operation retains terminal reservation beyond worker lease, Concordant authenticated Orders/Payments evidence, Reserved snapshot materialized once into receipt/paid items/kitchen/commission, Authorized refund balance reservations and immutable linked reversals, Exact 30-basis-point production merchandise commission numerator, Cumulative period commission close with original-IVA remainder allocation (+6 more)

### Community 50 - "Preparación del piloto Point"
Cohesion: 0.16
Nodes (15): docs/point-pilot-runbook.md, Separate local HTTP simulation, official sandbox and physical live pilot, Independent environment/business/method activation controls, Vault-backed Point scheduler installation and real queue progress, Owner OAuth state consumed once under final live authorization, Approved Orders audit bounded by provider query window, Disable new charges while preserving reconciliation and financial history, Independent audited SASORI platform administrator boundary (+7 more)

### Community 74 - "Auditoría de terminal Point"
Cohesion: 0.27
Nodes (10): Auditoría de cobros y terminal — 4 de octubre de 2026, Independent provider GET verification precedes sale materialization, Auth/employee/operator/membership locks serialize Point acceptance and revocation, Verified POS v2 onboarding with stable identity and bounded pagination, Dated official virtual-terminal outcome verification, Official/physical successful refund remains unverified, Dated backend/source/grant/scheduler publication report, Earlier audited unified integrated-card decision (+2 more)

### Community 90 - "Preparación histórica de Point"
Cohesion: 0.40
Nodes (5): Point release preparation — 3 October 2026, Dated Point release backend staging and evidence, Downloaded Edge sources match checked standalone artifacts, Generation-scoped synchronous guard preserves pending double-submit state, Provider/sandbox activation pending in dated release record

### Community 64 - "Revisión histórica de Point"
Cohesion: 0.24
Nodes (11): Revisión de Mercado Pago Point — 3 de octubre de 2026, Point recovery and financial consistency review, Point refund identity and uncertain-result recovery, Durable Point reconciliation and terminal exclusion, Provider evidence before financial materialization, Point review local verification, Mercado Pago Point payment processing, Mercado Pago Point refund API (+3 more)

### Community 75 - "Catálogo y ventas documentados"
Cohesion: 0.22
Nodes (10): docs/products-sales.md, Four independent payment methods, Printable receipt and browser PDF, MVP catalog scope, Manual availability without inventory mutation, Background catalog refresh and stale-response rejection, Personal and paired-register POS authorization, Product retirement preserves financial references (+2 more)

### Community 84 - "Cobros del turno documentados"
Cohesion: 0.38
Nodes (7): docs/shift-payment-summary.md, Shift payment summary by method, Unattributed Point refunds in shift summary, Backward-compatible permission-gated paymentSummary, Shift summary local and combined-preview evidence, tests/integration/lean-operations.integration.test.ts, tests/sql/shift-payment-summary.test.ts

### Community 81 - "Adaptación del catálogo Square"
Cohesion: 0.25
Nodes (8): Creación de productos: revisión de Square y adaptación al POS, Observed Square item editor reference, Square create item editor, Optional catalog metadata and product editor, Direct-add preference preserves required selections, Square catalog options additive contract, Square adaptation dated scope exclusions, Square adaptation reported verification

### Community 67 - "Planes históricos de empleados"
Cohesion: 0.18
Nodes (11): Business creation and employee access implementation plan, Business/team extension architecture plan, Employee extension security constraints, Business/team extension reported local checkpoint, Historical business/team deployment evidence, Approved unified employee record correction, Business creation and employee access, Atomic business creation and editable operational profile (+3 more)

### Community 9 - "Acceso y política PIN"
Cohesion: 0.05
Nodes (44): Employee administration correction, Focused employee detail and invitation outcomes, Historical employee soft delete and restoration, Employee lifecycle compatibility and race test requirements, Employee PIN ownership and owner recovery, Employee-selected PIN setup and Google linking, Historical owner independent-code PIN recovery, Credential changes and session issuance serialization (+36 more)

### Community 19 - "Interfaz y pagos NFC futuros"
Cohesion: 0.07
Nodes (32): docs/ui-audit-2026-10-03.md, Operational UI audit and polish, Square POS, Clover POS systems, Revolut Business Analytics, Preserved-data loading and retry states, Grouped presence refresh with explicit staleness, Checkout selection and discount action guards (+24 more)

## Knowledge Gaps
- **462 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+457 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `docs/history/2026-10-02-agents-before-workflow-cleanup.md` connect `Diseño y contexto histórico` to `Acceso y empleados SQL`, `Transporte y catálogo POS`, `Arquitectura y alcance actual`, `Acceso y política PIN`, `Contratos y gestión de empleados`, `Validación de acceso HTTP`, `Correo PIN e historial`, `Revisión y publicación`, `Interfaz y pagos NFC futuros`, `Sesión Auth del cliente`, `Autenticación y correo Edge`, `Verificación de archivos públicos`, `Entrada y acceso personal`, `Configuración del paquete`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `docs/financial-integrity-2026-10-03.md` connect `Integridad financiera documentada` to `Estado y mutaciones operativas`, `Validación de resultados financieros`, `Cobro y cálculo monetario`, `Transporte y catálogo POS`, `Integridad y asignación financiera`, `Venta y borradores`, `Arquitectura y alcance actual`, `Contratos operativos documentados`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **Why does `docs/owner-employee-experience-plan.md` connect `Vistas de dueño y empleado` to `Cobro y cálculo monetario`, `Cuentas y servicio operativo`, `Permisos de empleados`, `Contratos operativos documentados`, `Panel de reportes`, `Inicio, navegación y reportes`, `Ventas, comprobantes y pagos`, `Interfaz y pagos NFC futuros`, `Operaciones y reportes SQL`, `Venta y borradores`, `Entrada y acceso personal`, `Diseño y contexto histórico`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._