# POS México account backend

Agente de Larios · 1 October 2026.

This slice supports a new owner signing in with Google, creating a business and a six-digit PIN, unlocking that business, locking it, and signing out. Employee PINs, device pairing, PIN recovery, sales, and offline transactions are subsequent slices. Business access requires a network connection.

## Trust boundary

The PWA uses only the project's public publishable/anon key. It calls `POST /functions/v1/account` with its Supabase Auth access token in `Authorization: Bearer …`. The function verifies that token with `auth.getUser`, requires a confirmed Google identity in production, and obtains the identity and session ID from the verified token. Browser-supplied identity fields are rejected.

All six public `account_*` RPCs grant execution only to `service_role`. Every RPC checks the current user/session against live `auth.sessions`; tenant actions also check an active owner membership. An otherwise valid access JWT cannot continue accessing business data after its Auth session has been revoked. Google Auth and a PIN session are both required for business context.

The six tables live in `app_private`, with RLS enabled, no browser table/function grants, no permissive policies, and no exposure through the Data API. Security-definer entry points use an empty search path and fully qualified names. Do not add `app_private` to Supabase's exposed schemas. Future business commands must enforce the same tenant and operator-session checks; frontend visibility alone is insufficient.

## PINs and sessions

- PINs are exactly six ASCII digits, preserved as strings, including leading zeros. Postgres stores only salted bcrypt hashes at cost 12.
- Failed attempts are serialized with a credential row lock. Five failures lock that user/business for 15 minutes. The failure count survives rejected requests; expected PIN failures return values so transactions commit the counter. Creation retries cannot bypass this limit.
- An operator token has 256 bits of random entropy. Only its SHA-256 digest is stored server-side. The raw token belongs in frontend memory, never browser persistent storage, logs, or URLs.
- Tokens bind to the business, owner, and Google Auth session, expire after eight hours, and are checked on every context request. Unlocking again replaces the active token for the same Auth session/business.
- `lock` is idempotent and revokes that token. `revoke_sessions` revokes this Auth session's operator tokens across businesses. Signout should call it before `auth.signOut({ scope: 'local' })`; the frontend always clears its own operator token, including when a network request fails. Auth session revocation is also checked server-side.
- Creation uses an owner-scoped UUID operation ID and serializes retries with a transaction advisory lock. Equal normalized business details plus the same PIN return the existing business and a fresh operator session. A changed payload returns `OPERATION_CONFLICT`; no unsalted digest of a six-digit PIN is stored.

## Local development and deployment

The repository root contains the CLI configuration. Start/reset the local stack with `npm run db:start` and `npm run db:reset`, then run `npm run api:serve`. Create a private, ignored `.env.functions` in the repository root containing:

```dotenv
ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174
ALLOW_TEST_PASSWORD_AUTH=true
```

The CLI supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically. The test password bypass requires both the flag and a local Supabase hostname (`localhost`, loopback, Docker `kong`, or `host.docker.internal`); it is rejected on hosted Supabase project URLs. Never configure this test flag for a hosted deployment.

For hosted deployment, apply the migration, deploy `account`, and set `ALLOWED_ORIGINS` to the exact HTTPS PWA origin. The origin list must be nonempty; wildcards and insecure external origins are rejected. Set `[functions.account] verify_jwt = false`: the handler performs its own Auth verification for every non-preflight request, enabling consistent error shapes. Do not put a service key in any `VITE_*` variable.

Google OAuth additionally needs a Google Cloud Web OAuth client, its private secret configured in Supabase Auth, the Supabase callback URL registered at Google, and the actual PWA callback URL on Supabase's redirect allowlist. Google login cannot be verified until those credentials and redirect URLs exist.

Run focused validation with `deno test supabase/functions/account/validation.deno.ts` and typecheck with `deno check supabase/functions/account/index.ts`. The repository integration tests exercise the real local Auth, Edge Function, and Postgres; they use synthetic local users only. Deleting an Auth user cascades credentials, memberships, sessions, and operation records; business records remain deliberately independent of Auth account deletion. Reset the disposable local database for a clean test run.

## HTTP contract and observability

The shared TypeScript contract is `src/lib/contracts.ts`. Success responses have `{ data: … }`; failures have `{ error: { code, message, retryAfterSeconds? } }`. `status` returns only business ID, name, and type before PIN unlock. `create_business`/`unlock` return business context plus a token and expiry; `context` returns business context and expiry; `lock` and `revoke_sessions` return acknowledgement flags. Expected codes never contain database details. PIN lockouts return HTTP 429 with `Retry-After`.

Requests are JSON-only and capped at 8 KiB while streaming. Responses prohibit caching. CORS allows only configured origins. CORS is browser protection, while Auth, RPC grants, and SQL tenant checks provide authorization.

Private audit events record business creation, PIN success/failure/lockout, and operator revocation with server timestamps. They contain no PINs, tokens, email addresses, or request bodies. Unexpected function failures log only event, action, and stable database error code. Do not enable raw payload or RPC argument logging in external telemetry. Before pilots, schedule expired-session cleanup and define audit retention, alongside the broader backup/monitoring plan.

Primary references: [Supabase Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser), [Edge Function authorization](https://supabase.com/docs/guides/functions/auth-headers), [database function security](https://supabase.com/docs/guides/database/functions), [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google).
