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

### Community 0 - "Acceso y empleados SQL"
Cohesion: 0.06
Nodes (88): Guarded exact-ledger upgrade and preflight before destructive tenant cleanup, app_private.accept_employee_invitation, app_private.assert_business_logo, app_private.assert_live_auth, app_private.assert_operator, app_private.assert_owner, app_private.assert_owner_operator, app_private.business_context (+80 more)

### Community 1 - "Persistencia de pagos Point"
Cohesion: 0.07
Nodes (39): Legacy service account and table compatibility, app_private.ops_assert_payment_quote, app_private.ops_uuid, app_private.point_admin_audit, app_private.point_checkout_json, app_private.point_command, app_private.point_guard_history, app_private.point_guard_terminal_binding (+31 more)

### Community 2 - "Validación de resultados financieros"
Cohesion: 0.11
Nodes (48): checkoutAmountTotals(), amountParts(), assertFinancialAttempt(), assertFinancialOrder(), assertFinancialResponse(), assertFinancialSale(), assertFinancialShift(), assertFinancialVisit() (+40 more)

### Community 3 - "Restaurante y evidencia local"
Cohesion: 0.06
Nodes (50): tests/components/public-menus.test.tsx, Revisión sintética de restaurante con MiroFish — 2026-10-07, Separate simulation hypotheses, code/tests and later browser observations, Held course prevents line removal until group release, MiroFish official repository, Promotion/cash-received integrated manual scenario remains pending, Public menu headline uses minimum purchasable variation price, Synthetic MiroFish review with local inference (+42 more)

### Community 4 - "Catálogo y promociones SQL"
Cohesion: 0.08
Nodes (35): exact(), integer(), invalid(), parseMenuCommand(), parseMenuSchedule(), text(), uuid(), assertStoredRecovery() (+27 more)

### Community 5 - "Descuentos y promociones"
Cohesion: 0.10
Nodes (32): CashChangeCalculator(), CheckoutClosingContext, CheckoutInteractionContext, CheckoutPanel(), ExternalCardConfirmation(), icons, PaymentMethodPicker(), amountInput() (+24 more)

### Community 6 - "Menús públicos y horarios"
Cohesion: 0.08
Nodes (31): BusinessSettingsProps, TeamPanelProps, icons, Tables/visits/kitchen entry points, hasPermission(), roleLabels, BusinessContext, BusinessSummary (+23 more)

### Community 7 - "Servicio y navegación operativa"
Cohesion: 0.14
Nodes (21): PendingIndicator(), ModifierLibrary(), PosDialog(), accessErrorCodes, CatalogState, useModifierLibrary(), Catalog/IVA/CSV entry points, AccountClientError (+13 more)

### Community 8 - "Arranque y contexto local"
Cohesion: 0.06
Nodes (35): Coordinated browser-binding migration and Account Edge maintenance, docs/point-browser-context.md, Point browser context loopback verification, Point I/O completion reauthorizes original verified browser and live session, Verified browser hash preserved across Point RPC transactions, tests/integration/point.integration.test.ts, ChartFrame(), root (+27 more)

### Community 9 - "Acceso y política PIN"
Cohesion: 0.05
Nodes (44): tests/integration/employee-device-browser-smoke.mjs, tests/integration/employee-unlink-migration-smoke.mjs, tests/integration/production-google-guard.mjs, tests/integration/real-onboarding-smoke.mjs, Employee administration correction, Focused employee detail and invitation outcomes, Employee lifecycle compatibility and race test requirements, Historical employee soft delete and restoration (+36 more)

### Community 10 - "Cliente y paneles Point"
Cohesion: 0.10
Nodes (33): app_private.assert_member, app_private.catalog_batch_row_uuid, app_private.catalog_customer_name_snapshot, app_private.combo_availability_reason, app_private.included_vat_cents, app_private.manual_availability_details, app_private.menu_configuration, app_private.menu_product_available (+25 more)

### Community 11 - "Transporte y catálogo POS"
Cohesion: 0.08
Nodes (33): Historical amount-split migration in earlier worktree, app_private.capture_combo_kitchen_snapshot, app_private.capture_combo_legacy_receipt_snapshot, app_private.capture_combo_order_snapshot, app_private.capture_combo_product_snapshot, app_private.ops_adjustment_items_valid, app_private.ops_amount_line, app_private.ops_amount_name (+25 more)

### Community 12 - "Cobro y cálculo monetario"
Cohesion: 0.08
Nodes (31): dateLabel(), metricDefinitions, PointDashboard(), PointDashboardSession(), seconds(), PointSetup(), SetupOperation, PointStatements() (+23 more)

### Community 13 - "Integridad y asignación financiera"
Cohesion: 0.14
Nodes (31): Draft, fromPromotion(), PromotionManager(), usePromotions(), MenuResponses, AttemptStatus, BalanceWaiver, CashMovement (+23 more)

### Community 14 - "Visitas y tiempos SQL"
Cohesion: 0.08
Nodes (31): app_private.assert_table_layout, app_private.ops_exact, app_private.ops_order_json, app_private.ops_order_kind_immutable, app_private.ops_pending, app_private.ops_table_json, app_private.service_associate_tables, app_private.service_batch_table_snapshot (+23 more)

### Community 15 - "Contratos y gestión de empleados"
Cohesion: 0.08
Nodes (29): permissionGroups, InvitationQr(), InvitationQrProps, Code, EmployeeRole, sessionErrors, TransferConfirmation(), AccountContext (+21 more)

### Community 16 - "Operaciones y reportes SQL"
Cohesion: 0.06
Nodes (20): CashDifferenceChart, charts(), colors, DailySalesChart, employeeRoleLabels, FinancialWaterfall, Metric, PaymentNetChart (+12 more)

### Community 17 - "Panel de reportes"
Cohesion: 0.12
Nodes (25): HomeScreen(), HomeScreenProps, SaleReceiptDialog(), useCatalog(), usePoint(), WorkspaceShell(), Cash/reports entry points, availableDestinations() (+17 more)

### Community 18 - "Interfaz y pagos NFC futuros"
Cohesion: 0.12
Nodes (25): matchesQuote(), PointPayment(), PointPaymentSession(), PointRefund(), PointRefundSession(), Props, CatalogFilters(), EmptyCatalog() (+17 more)

### Community 19 - "Gráficas de analítica"
Cohesion: 0.07
Nodes (32): Approved Lean POS scope and incremental rollout, Certified embedded SoftPOS SDK, Lean POS MVP implementation, Shared drawer Open / Closing / Closed lifecycle, Mexico payment partner and merchant onboarding feasibility, Native Android wrapper for the PWA, Independent order, preparation and persisted payment lifecycles, Complete-flow validation on physical NFC hardware (+24 more)

### Community 20 - "Autenticación y correo Edge"
Cohesion: 0.13
Nodes (24): Private catalog and sale schema, app_private.has_permission, app_private.ops_attempt_json, app_private.ops_batch_prepared, app_private.ops_employee_report_window, app_private.ops_local_cutoff, app_private.ops_period_report, app_private.ops_period_report_at (+16 more)

### Community 21 - "Revisión y publicación"
Cohesion: 0.07
Nodes (23): animation, axisTick, CashDifference, CashDifferenceChart, colors, compactCurrency, compactNumber, DailySalesChart (+15 more)

### Community 22 - "Contratos de operación y catálogo"
Cohesion: 0.08
Nodes (19): claimsFromVerifiedJwt(), google, VerifiedAuthClaims, verifiedGoogleAuthentication(), VerifiedUser, env(), mailConfiguration, RecoveryMail (+11 more)

### Community 23 - "Inicio y reportes"
Cohesion: 0.15
Nodes (27): .github/pull_request_template.md, Compatible backend before dependent frontend merge, Isolated checkout, focused PR and human review, New migrations with compatible TypeScript/HTTP/SQL contracts, Proportional verification with precise limits and omissions, Worktree → branch → PR → human review → merge → CI → verify, Native Pages SPA fallback preserves callback pathname/query, PWA shell precache and prompt-style worker update without banner (+19 more)

### Community 24 - "Venta y borradores"
Cohesion: 0.15
Nodes (29): Atomic mutations and actor/UUID/payload-bound accepted retry, Financial snapshots and linked corrections, Exact JSON keys, 8 KiB, stable errors, no-store and explicit CORS, docs/account-mode-flow.md, Service sends only new quantities; payment does not duplicate preparations, Pending order preserves UUID, payload and original type, Saved profile.accountsEnabled controls Venta flow, Business → Operation → PIN → Home; owner-selectable modality (+21 more)

### Community 25 - "Entrada y acceso personal"
Cohesion: 0.12
Nodes (23): saleCommand(), SaleScreenSession(), cartLineInput(), cartLineName(), cartLineOrderInput(), cartLinePrice(), cartLineSelection(), cartLineVat() (+15 more)

### Community 26 - "Ventas, caja y comprobantes"
Cohesion: 0.07
Nodes (20): Access/PIN/team entry points, accountErrorMessages, preferredBusiness(), rememberBusiness(), AccountErrorCode, supabase/functions/account/: authorized personal/register entry, AccountApp(), accountMessages (+12 more)

### Community 27 - "Webhooks y conciliación Point"
Cohesion: 0.15
Nodes (21): backgroundPointWork(), base64(), bytes(), challenge(), digest(), encoder, randomSecret(), boundedBody() (+13 more)

### Community 28 - "Diseño y contexto histórico"
Cohesion: 0.08
Nodes (25): Role-equivalent phone/tablet navigation and accessible 48 px controls, Six-digit PIN, bcrypt cost 12 and concurrent lockout, Business → Operation → PIN → direct Home and preserved action data, Separate /business/ready confirmation, Full-screen black checkout with phone/tablet arrangement, GSAP with React cleanup and reduced-motion handling, Ivory/green products-sales styling proposal, Owner charcoal sidebar; employee white navigation and black actions (+17 more)

### Community 29 - "Empaquetado de funciones Edge"
Cohesion: 0.09
Nodes (16): Standalone account artifact build, buildAccountSource(), aliases, buildPointModules(), buildPointSource(), namespaces, metadata, migration (+8 more)

### Community 30 - "Comandos npm"
Cohesion: 0.08
Nodes (25): scripts, api:serve, build, check, check:ledger, check:live, db:reset, db:start (+17 more)

### Community 31 - "Navegación del mapa"
Cohesion: 0.14
Nodes (19): Claude entry routes to AGENTS and module sources, Graph is a source index, never authorization or production evidence, Read report/guide or filter source_file/label instead of entire JSON, Operational code and documentation corpus excludes tests, media, environments and generated artifacts, Sale/checkout entry points, Document date/status preserves plans and reported historical evidence, docs/code-map.md, Full skill regeneration reproduces docs semantics and SQL supplement (+11 more)

### Community 32 - "División y publicación documentadas"
Cohesion: 0.15
Nodes (23): Private app_private schema and service-only privileged RPCs, Dividir por cantidad: up to twenty positive exact amounts, prepare_checkout/update_checkout: items empty plus amountsCents, Only confirmed payment reduces balance; no item split after first amount payment, docs/amount-split-checkout.md, Stable UUID-ordered gross/discount/paid/IVA allocation, Later reported hosted publication of canonical amount-split migration, Reported local PostgreSQL, component, HTTP and synthetic Point validation (+15 more)

### Community 33 - "Acceso y recuperación de PIN"
Cohesion: 0.12
Nodes (9): AccessButtonContent(), DeviceLoginProps, roles, Props, Notice, Props, statuses, DeviceStatus (+1 more)

### Community 34 - "Configuración del negocio"
Cohesion: 0.18
Nodes (18): BusinessOperationFields(), BusinessSettings(), emptyProfile, paymentOptions, profileSignature(), BusinessDraft, BusinessSetup(), TransferAccountFields() (+10 more)

### Community 35 - "Editor de productos y extras"
Cohesion: 0.14
Nodes (16): MoneyInput(), ProductComboFields(), ProductCustomAttribute, ProductEditor(), sections, modifierPriceInput(), parseModifierPrice(), ModifierSet (+8 more)

### Community 36 - "IVA e importes libres"
Cohesion: 0.13
Nodes (22): Integer cents, exact decimals and centralized rounding, Business defaultVatTreatment only initializes new products, docs/catalogo-mvp-iva.md, IS DISTINCT FROM rejects retry by an erased actor with NULL identity, Final advertised price with VAT extracted once per line, LFPC article 7 Bis, LIVA articles 1 and 2-A, Reported local VAT, real integration and synthetic browser verification (+14 more)

### Community 37 - "Servicio y conciliación Point"
Cohesion: 0.17
Nodes (19): BackgroundOptions, BackgroundRuntime, Environment, PointAdapter, record(), binding(), configuration, connectionToken (+11 more)

### Community 38 - "Aislamiento y acceso de empleados"
Cohesion: 0.18
Nodes (21): Memory-only operator session; eight-hour expiry and immediate revocation, Confirmed-email PIN recovery: one use, 15 minutes, no access session, Business tenant: actor, session, membership and permissions, Binding identifies browser storage context, not attested hardware, MDN CryptoKey extractability, 0008 and account/device-proof before frontend; old clients fail closed, docs/employee-device-access.md, Personal employee browser binding with owner-approved replacement (+13 more)

### Community 39 - "Reinvitación histórica de empleados"
Cohesion: 0.10
Nodes (17): Reinviting a deleted employee, Historical reinvitation compatibility verification, Historical inactive-membership invitation rejection, Retired employee restoration through fresh invitation, tests/integration/employee-rejoin-migration-smoke.mjs, constraintValues, evidence, functionValues (+9 more)

### Community 40 - "Configuración TypeScript"
Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleDetection, moduleResolution (+12 more)

### Community 41 - "Contratos y metadatos de producto"
Cohesion: 0.12
Nodes (15): palette, ProductAvailability(), OperationsErrorCode, AmountCartLine, AmountSaleInputLine, CatalogImportProduct, ComboComponentInput, Modifier (+7 more)

### Community 42 - "Selección de productos y combos"
Cohesion: 0.36
Nodes (14): ProductSelection(), ItemSelection, activeModifierSets(), isSoldOut(), modifierOptionAvailable(), modifierOptionLimit(), modifierQuantity(), normalizeModifierIds() (+6 more)

### Community 43 - "Preparación de desvinculación permanente"
Cohesion: 0.11
Nodes (14): afterProducts, columnValues, constraintValues, evidence, functionValues, guarded, latest, ledger (+6 more)

### Community 44 - "Métricas personales y formatos"
Cohesion: 0.14
Nodes (14): Skeleton(), Typed online POS architecture, invitationFromLink(), currency, number(), numbers, averageTicket(), changePercent() (+6 more)

### Community 45 - "Dependencias de desarrollo"
Cohesion: 0.12
Nodes (15): app_private.ops_apply_kitchen_cancellation, app_private.ops_batch_fully_cancelled, app_private.ops_batch_json, app_private.ops_batch_pending, app_private.ops_text, app_private.promotion_category, app_private.promotion_json, app_private.promotion_matches (+7 more)

### Community 46 - "Integridad financiera documentada"
Cohesion: 0.11
Nodes (18): devDependencies, @electric-sql/pglite, jsdom, oxlint, @playwright/test, supabase, tailwindcss, @tailwindcss/vite (+10 more)

### Community 47 - "Validación de evidencia Point"
Cohesion: 0.15
Nodes (17): Adyen POS timeouts, Atomic receipt, paid quantities, kitchen batch and accepted response, Clover REST Pay tutorials, Clover calculating order totals, Cumulative exact quantity/discount/IVA prefixes, Deferred financial trigger privileges with empty search path, docs/financial-integrity-2026-10-03.md, Durable original UUID/payload recovery under live authorization (+9 more)

### Community 48 - "Validación de acceso HTTP"
Cohesion: 0.18
Nodes (15): cents(), createPayload(), decimal(), ExpectedOrder, Json, mapState(), officialVirtualOrder(), OrderEvidence (+7 more)

### Community 49 - "Preparación del piloto Point"
Cohesion: 0.33
Nodes (13): access, businessDetails(), validCreate, exactKeys(), invalid(), name(), parseAccountRequest(), permissions() (+5 more)

### Community 50 - "Correo PIN e historial"
Cohesion: 0.16
Nodes (15): Approved Orders audit bounded by provider query window, docs/point-pilot-runbook.md, Disable new charges while preserving reconciliation and financial history, Mercado Pago Point official virtual terminal, Mercado Pago Point Orders query contract, Owner OAuth state consumed once under final live authorization, Human-authorized physical Point hardware and bank-evidence pilot, Independent environment/business/method activation controls (+7 more)

### Community 51 - "Comisiones y evidencia Point"
Cohesion: 0.16
Nodes (14): docs/pin-email-recovery.md, Dated PIN email deployment and local verification limits, Recovery URL fragment removed before render and held only in memory, Mailpit API, PIN confirmation consumes capability and revokes current operators, PIN recovery retry requires current result hash, Recovery server validates live identity, current person and confirmed email, Resend send email API (+6 more)

### Community 52 - "CSV y edición masiva"
Cohesion: 0.21
Nodes (14): Concordant authenticated Orders/Payments evidence, Cumulative period commission close with original-IVA remainder allocation, Earlier single integrated-card presentation, docs/point-financial-model.md, Exact 30-basis-point production merchandise commission numerator, Reserved snapshot materialized once into receipt/paid items/kitchen/commission, Exclusive SKIP LOCKED worker with leases/backoff/bounded attempts, Mercado Pago Point create-order idempotency (+6 more)

### Community 53 - "Sesión Auth del cliente"
Cohesion: 0.18
Nodes (12): bulkCatalogBatches(), catalogBatches(), catalogCsvHeaders, decodeText(), encodeText(), exportCatalogCsv(), formulaText(), previewCatalogCsv() (+4 more)

### Community 54 - "Modelo de analítica"
Cohesion: 0.19
Nodes (8): allowIdentitySignIn(), clearStoredIdentity(), closeIdentity(), discardIdentity(), hasCurrentStoredIdentity(), identityStorage, initializeIdentity(), isVerifierKey()

### Community 55 - "Adaptador de Mercado Pago"
Cohesion: 0.15
Nodes (11): BusinessDayReport, BusinessPeriodReport, buildDailySalesChartData(), buildFinancialWaterfallData(), buildTemporalChartData(), TemporalDatum, TemporalMetric, TemporalPoint (+3 more)

### Community 56 - "Validación de operaciones"
Cohesion: 0.35
Nodes (3): identifier(), MercadoPagoPoint, responseJSON()

### Community 57 - "Dependencias del frontend"
Cohesion: 0.35
Nodes (12): commands, exact(), integer(), invalid(), object(), parseOperationsCommand(), payment(), reportDate() (+4 more)

### Community 58 - "Arquitectura y alcance actual"
Cohesion: 0.15
Nodes (13): dependencies, @fontsource/ibm-plex-sans, gsap, @gsap/react, jsqr, lucide-react, qrcode.react, react (+5 more)

### Community 59 - "Contratos operativos documentados"
Cohesion: 0.21
Nodes (12): Cloudflare Pages frontend, src/components/: catalog, access, team and Point/menu panels, supabase/migrations/: SQL ledger, permissions and atomic persistence, src/features/operations/: service, kitchen, checkout, cash and reports, POS México: online React/TypeScript/Vite PWA, Online-only product scope; no CFDI, fractional sales, stock automation or bank settlement, Published informational QR menus with anonymous access, scripts/: local development, packaging and release verification (+4 more)

### Community 60 - "Recuperación de lotes CSV"
Cohesion: 0.21
Nodes (11): Deliberate legacy-checkout compatibility and owner activation, docs/lean-operations-backend.md, Historical direct record_payment contract, Tenant-qualified immutable kitchen cancellation overlay, Existing personal pos and shared device_pos transport, Pending executable kitchen work has bounded-queue priority, Persisted prepare/update/record checkout reservation, Private pos_command checks current actor/grants before replay (+3 more)

### Community 61 - "Validación de productos"
Cohesion: 0.30
Nodes (10): assertCatalogBatchPlan(), CatalogBatchPlan, CatalogRecoveryConflictError, clearCatalogBatchPlan(), encodePlan(), key(), loadCatalogBatchPlan(), saveCatalogBatchPlan() (+2 more)

### Community 62 - "Desarrollo local persistente"
Cohesion: 0.58
Nodes (10): array(), bool(), fail(), integer(), object(), parseModifierSet(), parseProductDetails(), parseSelection() (+2 more)

### Community 63 - "Revisión histórica de Point"
Cohesion: 0.25
Nodes (11): Development server plus explicit flag plus loopback backend, Persistent local Supabase stack identity per absolute checkout path, Development Auth is gated by Vite mode, flag and loopback backend, docs/local-development.md, Local HTTP Point provider with normal Auth/Edge/PostgreSQL authorization, Deterministic Point recovery using a manual local worker, Node 24 / Docker / npm-ci development runner, Explicit local migration up preserves data (+3 more)

### Community 64 - "Validación de respuestas de servicio"
Cohesion: 0.24
Nodes (11): Revisión de Mercado Pago Point — 3 de octubre de 2026, Durable Point reconciliation and terminal exclusion, Mercado Pago Point webhook notifications, Mercado Pago OAuth token API, Mercado Pago Point order and transaction states, Mercado Pago Point payment processing, Mercado Pago Point refund API, Point recovery and financial consistency review (+3 more)

### Community 65 - "Estado y mutaciones operativas"
Cohesion: 0.29
Nodes (9): ServiceDay, ServiceOrderState, assertServiceDayView(), assertServiceOrderView(), courses(), ids(), record(), Row (+1 more)

### Community 66 - "Planes históricos de empleados"
Cohesion: 0.22
Nodes (10): commands, Mutation, MutationState, OperationOrigin, OperationsState, PendingOperation, readOperation(), readPendingOperation() (+2 more)

### Community 67 - "Validación HTTP de Point"
Cohesion: 0.18
Nodes (11): Business creation and employee access implementation plan, Employee extension security constraints, Business/team extension architecture plan, Historical business/team deployment evidence, Business/team extension reported local checkpoint, Approved unified employee record correction, Business creation and employee access, Restricted paired shared register specification (+3 more)

### Community 68 - "Validación de promociones"
Cohesion: 0.44
Nodes (8): date(), integer(), invalid(), parsePointCommand(), providerId(), text(), uuid(), RequestValidationError

### Community 69 - "Validación de servicio"
Cohesion: 0.44
Nodes (9): exact(), int(), invalid(), parsePromotionCommand(), parsePromotionScope(), text(), uuid(), PromotionCommand (+1 more)

### Community 70 - "Generación de variantes"
Cohesion: 0.44
Nodes (9): commands, exact(), ids(), int(), invalid(), parseServiceCommand(), text(), timestamp() (+1 more)

### Community 71 - "IVA de productos y líneas"
Cohesion: 0.36
Nodes (8): ProductVariationBuilder(), Variation, appendVariations(), key(), normalized(), previewVariations(), VariationDimension, VariationPreview

### Community 72 - "Permisos de empleados"
Cohesion: 0.33
Nodes (7): ProductVatFields(), OrderLine, VatTreatment, includedTax(), vatLabels, VatLine, vatRates

### Community 73 - "Auditoría de terminal Point"
Cohesion: 0.24
Nodes (10): docs/employee-permissions.md, Employee-before-operator lock ordering, Grouped employee action grants, Permission changes revoke personal and shared-register operators, Permission prerequisite closure, Personal metrics resolved by current employee identity, Protected owner identity, Current authorization before accepted retry or invitation acceptance (+2 more)

### Community 74 - "Catálogo y ventas documentados"
Cohesion: 0.27
Nodes (10): Auth/employee/operator/membership locks serialize Point acceptance and revocation, Dated backend/source/grant/scheduler publication report, Auditoría de cobros y terminal — 4 de octubre de 2026, Earlier audited unified integrated-card decision, Official/physical successful refund remains unverified, Dated official virtual-terminal outcome verification, Independent provider GET verification precedes sale materialization, Mercado Pago Point POS v2 creation (+2 more)

### Community 75 - "Firma del navegador del empleado"
Cohesion: 0.22
Nodes (10): Background catalog refresh and stale-response rejection, docs/products-sales.md, Historical stock-based sale transaction policy, Manual availability without inventory mutation, MVP catalog scope, Four independent payment methods, Personal and paired-register POS authorization, Printable receipt and browser PDF (+2 more)

### Community 76 - "Preparación del primer cliente"
Cohesion: 0.33
Nodes (9): base64url(), DeviceIdentity, EmployeeDeviceProof, loadIdentity(), openDatabase(), readIdentity(), signEmployeeDeviceRequest(), storeIdentityIfAbsent() (+1 more)

### Community 77 - "Cocina y cancelaciones SQL"
Cohesion: 0.28
Nodes (9): Pilot scope conditioned by actual merchant workflow, Preparación del primer cliente, Menu-to-close end-to-end acceptance flow, Separate manual external card and integrated Mercado Pago Point, Shift-level collected/refunded/net payment-method summary, Small cafe, one site/register, online pilot hypothesis, Print/save PDF commercial receipt from immutable snapshots, Synthetic combined-dev acceptance evidence (+1 more)

### Community 78 - "Verificación de firma de dispositivo"
Cohesion: 0.43
Nodes (6): decode(), base64(), signed(), DeviceProofError, verifiedDeviceRequest(), isUuid()

### Community 79 - "Validación de comandos POS"
Cohesion: 0.57
Nodes (7): exactKeys(), integer(), invalid(), parsePosCommand(), text(), uuid(), ProductSaleInputLine

### Community 80 - "Confirmación rápida de Point"
Cohesion: 0.39
Nodes (8): Immediate active polling on submit/simulate/focus/reconnect, Authorized per-attempt immediate reconciliation, Dated fast-path backend publication report, docs/point-confirmation-latency-2026-10-05.md, Periodic Point scheduler as durable reconciliation fallback, Private work indication after personal/device authorization, Simulation acceptance requires independent Orders/Payments evidence, Supabase background tasks

### Community 81 - "Adaptación del catálogo Square"
Cohesion: 0.25
Nodes (8): Creación de productos: revisión de Square y adaptación al POS, Optional catalog metadata and product editor, Direct-add preference preserves required selections, Square catalog options additive contract, Square create item editor, Observed Square item editor reference, Square adaptation dated scope exclusions, Square adaptation reported verification

### Community 82 - "Comprobaciones completas de CI"
Cohesion: 0.43
Nodes (8): tests/provider/simulator.mjs, Required financial checks, Deterministic local HTTP provider simulator, .github/workflows/full-checks.yml, Modular and standalone Edge validation, Integration gate rejects pending or failed tests, Disposable Auth/Edge/PostgreSQL integration without skipped tests, Web checks: lint, types, domain, SQL, provider, build and browser

### Community 83 - "Vistas de dueño y empleado"
Cohesion: 0.43
Nodes (7): Permission-driven destinations and default entry, docs/owner-employee-experience-plan.md, Owner/employee composition verification in loopback dev, Server calendar analytics with correct partial comparisons, Owner management and employee operation composition, Shared real report dashboard and authorized period hook, Single mounted sale/account controller across navigation

### Community 84 - "Cobros del turno documentados"
Cohesion: 0.38
Nodes (7): docs/shift-payment-summary.md, Unattributed Point refunds in shift summary, Shift payment summary by method, Shift summary local and combined-preview evidence, Backward-compatible permission-gated paymentSummary, tests/integration/lean-operations.integration.test.ts, tests/sql/shift-payment-summary.test.ts

### Community 85 - "Resumen de cobros en Caja"
Cohesion: 0.33
Nodes (5): currency, integerCurrency(), ShiftPaymentSummary, CashPaymentSummary(), labels

### Community 86 - "Desbloqueo por PIN"
Cohesion: 0.40
Nodes (3): AccessBusy(), PinScreenEntrance(), Props

### Community 87 - "Acceso a varios negocios"
Cohesion: 0.60
Nodes (6): Select own businesses and employee memberships with server roles, docs/business-access.md, Explicit local camera/jsQR scan of same-origin complete invitations, Per-user last business ID checked against fresh memberships, Visible catalog refresh every 15 seconds plus focus/reconnection/manual refresh, Reported dual-membership, tenant, browser and synthetic-camera regressions

### Community 88 - "Verificación de archivos públicos"
Cohesion: 0.40
Nodes (4): check(), contentTypes, dist, sha256()

### Community 89 - "Entrada de importe libre"
Cohesion: 0.70
Nodes (3): AmountEntry(), amountKey(), parseAmountCents()

### Community 90 - "Preparación histórica de Point"
Cohesion: 0.40
Nodes (5): Provider/sandbox activation pending in dated release record, Dated Point release backend staging and evidence, Point release preparation — 3 October 2026, Downloaded Edge sources match checked standalone artifacts, Generation-scoped synchronous guard preserves pending double-submit state

### Community 91 - "Configuración del paquete"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 93 - "Búsqueda y filtrado de productos"
Cohesion: 0.50
Nodes (4): ProductsScreen(), filterProducts(), searchText(), OrderEditor()

### Community 94 - "Entrada HTML de la aplicación"
Cohesion: 0.50
Nodes (3): POS México HTML entrypoint, Spanish mobile-aware HTML entry metadata, public/favicon.svg

## Knowledge Gaps
- **462 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+457 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `docs/history/2026-10-02-agents-before-workflow-cleanup.md` connect `Diseño y contexto histórico` to `Acceso y empleados SQL`, `Servicio y navegación operativa`, `Verificación de archivos públicos`, `Contratos operativos documentados`, `Acceso y política PIN`, `Contratos y gestión de empleados`, `Preparación del piloto Point`, `Comisiones y evidencia Point`, `Gráficas de analítica`, `Contratos de operación y catálogo`, `Inicio y reportes`, `Modelo de analítica`, `Ventas, caja y comprobantes`, `Configuración del paquete`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `docs/financial-integrity-2026-10-03.md` connect `Validación de evidencia Point` to `Validación de resultados financieros`, `Planes históricos de empleados`, `Descuentos y promociones`, `Servicio y navegación operativa`, `Transporte y catálogo POS`, `Entrada y acceso personal`, `Contratos operativos documentados`, `Recuperación de lotes CSV`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **Why does `docs/owner-employee-experience-plan.md` connect `Vistas de dueño y empleado` to `Descuentos y promociones`, `Menús públicos y horarios`, `Auditoría de terminal Point`, `Recuperación de lotes CSV`, `Operaciones y reportes SQL`, `Panel de reportes`, `Interfaz y pagos NFC futuros`, `Gráficas de analítica`, `Autenticación y correo Edge`, `Entrada y acceso personal`, `Ventas, caja y comprobantes`, `Diseño y contexto histórico`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._