# Development without Google

Use Node 24, Docker Desktop and the checked-in lockfile. In your own checkout:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 and choose **Entrar en desarrollo**. The first start can take longer while Docker downloads Supabase images. Missing Docker or occupied ports produce an error; the runner never falls back to the hosted backend.

## Synthetic accounts

All three accounts use the local-only password `Local-POS-only-2026!`; the access screen fills it for you. These credentials belong only to the isolated loopback stack.

| Account | Initial state |
| --- | --- |
| `owner@pos.local.test` | Owner of Cafetería de desarrollo, PIN `123456`, three products and all three payment methods |
| `new@pos.local.test` | No business; use it to develop business creation and PIN setup |
| `employee@pos.local.test` | No membership; invite it from the owner, open the link in a separate browser context, then select this account and choose its PIN |

The initial owner PIN is a fixture, not an automatic reset: if you change it, subsequent starts keep the new PIN. Accounts/businesses/products are not reseeded over existing changes. Sales are actual local PostgreSQL records. Auth sessions, owner/employee permissions, device binding, PIN checks, revocation and recovery continue through the normal application and backend.

## Persistence and isolation

`scripts/dev.mjs` derives a stable Supabase project ID and local ports from the checkout's absolute path. Another checkout gets a different project ID. A rare port collision fails visibly; it does not select another checkout's data. Moving a checkout changes its stack identity.

Generated configuration, source copies and the server-only mail configuration live in ignored `.local-dev/`. No cloud link or credentials are copied. The script applies pending migrations with explicit `migration up --local`; it never runs `db reset` or deletes database volumes. Schema changes require restarting the runner. Frontend changes use Vite reloads; Edge source/shared contracts are copied to the mounted local workspace when edited.

Ctrl+C stops the frontend/function server. Docker keeps the database available. To stop this checkout's containers and preserve its data:

```sh
npm run dev:stop
```

To choose another frontend port:

```sh
npm run dev -- --port 5177
```

The runner prints the local API and mailbox URLs. Recovery messages are captured in local Mailpit, with no delivery to a real inbox. To inspect this checkout's stack privately, run `npx supabase --workdir .local-dev status`; do not paste its administrator keys into logs, Git or `VITE_*` variables.

## Production compatibility

The local access screen is loaded only by a development Vite server with `VITE_LOCAL_PASSWORD_AUTH=true` and an HTTP loopback Supabase URL. Local Auth storage is separate per backend port and never reads or overwrites the hosted `pos-mexico-auth` identity. The runner injects only the public key into Vite; the service-role key stays in its Node setup process. The existing Edge password allowance also requires its server flag and a local backend hostname. Hosted Google/OAuth requirements are unchanged; no migration or hosted Edge deployment is required.

Production compilation eliminates the development screen and fixture credentials. `npm run build` scans all emitted chunks and fails if either appears; the same check runs in ordinary CI. Unit checks cover the flag/mode/backend guards and nested-chunk detection. Browser tests use `dev:frontend` with local fixture configuration and the development login disabled so existing Google-flow assertions remain useful.

For an explicitly chosen backend, use `npm run dev:frontend` with its public URL/key in `.env.local`. A hosted backend still requires Google. Routine development should use `npm run dev`.

## Point con el proveedor local

Para revisar esta integración completa con Auth, Edge y PostgreSQL locales, sin credenciales Mercado Pago ni cargos bancarios:

```powershell
Set-Location 'C:\Users\siriu\Documents\ChatGPT\SASORI\point-integration'
npm ci
npm run dev -- --point-simulator --port 5177
```

Docker Desktop debe estar funcionando con contenedores Linux. En Windows, el runner usa las entradas Node de Supabase y Vite para conservar rutas con espacios sin comandos de shell. Abre `http://127.0.0.1:5177/dev-login`, entra con `owner@pos.local.test` y el PIN inicial `123456`. En **Vincular una terminal**:

1. **Cuenta:** conserva **Pruebas** y pulsa **Conectar Mercado Pago**. La cuenta se verifica al regresar.
2. **Terminal:** selecciona **Terminal de prueba** (`SERIAL-1`, Sucursal de prueba / Caja de prueba), pulsa **Vincular terminal** y después **Comprobar terminal**.
3. **Listo:** pulsa **Activar modo prueba**. El acceso siguiente abre Caja si falta un turno, o Venta si ya está abierto.

El callback conserva el state/PKCE y atraviesa la autorización normal del backend. La comprobación física de una terminal real sigue siendo una etapa separada.

Activa el módulo operativo y abre un turno. Añade productos, entra a **Cobrar**, selecciona **Mercado Pago** y pulsa **Enviar a terminal**. Se envía el importe exacto de la reserva, con sus descuentos e IVA; en una cuenta dividida, sólo el de los artículos seleccionados. Esta integración envía el importe, no el detalle de productos, y solicita `no_ticket`. El pago se registra automáticamente cuando el backend verifica su aprobación; **Tarjeta externa** conserva el registro manual.

El worker local procesa la cola cada tres segundos mientras este runner permanezca abierto. Una recarga o bloqueo del navegador conserva los intentos en PostgreSQL. Los cobros del entorno sandbox no generan comisión SASORI; los estados de cuenta productivos se verifican con la suite SQL financiera.

El runner imprime el puerto exclusivo de su proveedor HTTP. Para cambiar el resultado de los siguientes cobros, usa esa URL de simulador, por ejemplo:

```powershell
$pointSimulatorUrl = 'http://127.0.0.1:PUERTO_IMPRESO'
Invoke-RestMethod -Uri "$pointSimulatorUrl/__control" -Method Post -ContentType 'application/json' -Body '{"scenario":"rejected"}'
```

Otros escenarios: `approved`, `pending`, `at_terminal`, `action_required`, `timeout-before`, `timeout-after`, `transient-before`, `transient-after`, `invalid-json`, `wrong-amount`, `wrong-currency`, `wrong-account`, `revoked`, `refund-timeout` y `refresh-timeout`. Para volver al recorrido normal, selecciona `approved`. Una revisión incierta permanece bloqueada hasta obtener evidencia verificable; cambiar el escenario no modifica automáticamente una orden existente. El endpoint `/__control` también admite `orderId`/`order` y `externalRefund` para generar cambios externos explícitos.

Las claves locales y las órdenes/idempotencias sintéticas se conservan en `.local-dev/point-secrets.json` y `.local-dev/point-simulator.json`, ambos ignorados por Git. Conserva estos archivos junto con la base local para recuperar operaciones después de reiniciar. El arranque normal, sin `--point-simulator`, mantiene los nuevos cobros Point deshabilitados. Ctrl+C cierra los servidores de esta sesión; `npm run dev:stop` detiene los contenedores de este checkout conservando los datos.

Este modo no abre una cuenta administrativa SASORI ni establece credenciales productivas. El worker de un backend alojado se programa con [el runbook de Point](point-pilot-runbook.md), no con este proceso local.

The design follows [Supabase's local workflow](https://supabase.com/docs/guides/local-development/cli-workflows) and [Vite's development/build environment distinction](https://vite.dev/guide/env-and-mode).


Para comprobar recuperación de Point de forma determinista, arranca con `npm run dev -- --point-simulator --point-manual-worker` y ejecuta `npm run test:point:local` en otra terminal del mismo checkout. Las pruebas controlan el worker y conservan las identidades del simulador; crean y limpian sólo sus negocios sintéticos. Reinicia sin `--point-manual-worker` al terminar para recuperar el procesamiento automático del entorno interactivo.
