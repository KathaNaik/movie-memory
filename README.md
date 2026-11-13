# Movie Memory

Sign in with Google, tell us your favorite movie, and get AI-generated fun facts about it.

Built for the Scowtt full-stack take-home: **Variant B, Frontend/API-focused**, plus the parts of Variant A that don't conflict with it (see [Variant](#which-variant-and-why)).

**Stack:** Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, PostgreSQL on Neon, Prisma 7 (`@prisma/adapter-pg`), Auth.js v5 (Google OAuth, database sessions), OpenAI SDK (Responses API, structured output), Zod 4, Vitest and React Testing Library.

---

## Setup

### Prerequisites
- Node.js 20.19+, 22.12+ or 24+, and npm
- A PostgreSQL database. Neon is used here; any Postgres 14+ works.
- A Google OAuth client (Google Cloud Console → Credentials → OAuth client ID → *Web application*) with this **Authorized redirect URI**:
  `http://localhost:3000/api/auth/callback/google`
- An OpenAI API key

### Steps
```bash
npm install                 # also runs `prisma generate` (postinstall)
cp .env.example .env        # then fill in the values below
npm run db:migrate          # applies migrations to DIRECT_URL
npm run dev                 # http://localhost:3000
```

Use `.env`, not only `.env.local`: Next.js reads both, but the Prisma CLI reads `.env` only.

### Environment variables

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | App runtime | **Pooled** Postgres connection (on Neon, the host contains `-pooler`). |
| `DIRECT_URL` | Prisma Migrate | **Direct** (unpooled) connection. Migrations need a direct connection, not PgBouncer. |
| `AUTH_SECRET` | Auth.js | Random secret, e.g. `openssl rand -base64 32`. |
| `AUTH_GOOGLE_ID` | Auth.js | Google OAuth client ID. |
| `AUTH_GOOGLE_SECRET` | Auth.js | Google OAuth client secret. |
| `OPENAI_API_KEY` | Server only | OpenAI API key. |
| `OPENAI_MODEL` | Server only | Model ID, e.g. `gpt-5.4-mini-2026-03-17`. A dated snapshot keeps behavior stable. |

All variables are read only on the server; none are exposed to the browser.

### Database migrations
Migrations are versioned in `prisma/migrations` and run through `DIRECT_URL` (configured in `prisma.config.ts`).

| Command | When |
|---|---|
| `npm run db:migrate` (`prisma migrate dev`) | Local development: applies pending migrations, regenerates the client |
| `npx prisma migrate deploy` | CI or production: applies pending migrations only |
| `npm run db:generate` | Regenerate the Prisma Client after schema changes |

There are two migrations: `init` (Auth.js tables + `MovieFact`) and `add_fact_identified_title` (adds a nullable column).

### Scripts and tests
```bash
npm run lint
npm run typecheck           # next typegen + tsc --noEmit
npm test                    # unit/component tests; OpenAI and the DB are mocked (134 tests)
npm run test:db             # 7 integration tests against the real DATABASE_URL (opt-in)
npm run build
```
`test:db` creates throwaway users (`itest-…@example.test`) and deletes them afterwards. Run it only against a development database.

---

## Architecture overview

### Request flow
```
Browser ──► Next.js (Node.js runtime, no middleware)
             ├─ Server Components: /, /onboarding, /dashboard
             │    getCurrentUser() → auth() → Session + User rows → redirect decision
             ├─ Server Action: onboarding saveFavoriteMovie()
             ├─ Route Handlers: /api/me, /api/me/movie, /api/fact, /api/auth/*
             │    session check → Zod validation → Prisma (scoped to session user) → OpenAI
             └─ Client Component: MovieDashboard (editing, optimistic updates, fact cache)
                  └─ src/lib/api.ts (typed fetch client, runtime-validated)
PostgreSQL (Neon) ◄── Prisma 7 + pg driver adapter      OpenAI ◄── src/lib/openai.ts (server-only)
```

### Data model (`prisma/schema.prisma`)
- **User, Account, Session, VerificationToken**: the standard Auth.js models. `Account` is keyed by `(provider, providerAccountId)`, so users are tied to Google's stable account ID, not their email.
- **`User.favoriteMovie String?`**: `null` until onboarding. As a column, one favorite per user is guaranteed by the schema; no extra table or unique constraint is needed.
- **`MovieFact`**: `id, userId → User (cascade delete), movieTitle, identifiedTitle?, content, createdAt`. Each fact stores the title it was generated for, so facts stay correct after the user changes movies. There is no `Movie` table, because there's no movie catalog to normalize against. Index: `(userId, movieTitle, createdAt DESC)` serves "this user's recent facts for this movie" and, through its prefix, "this user's facts".

### Authentication and routing
- **Auth.js v5** with Google and the Prisma adapter, using **database sessions**: the cookie holds an opaque token, so sign-out or deletion revokes a session immediately in every tab.
- **`getCurrentUser()`** (`src/lib/current-user.ts`) is the only source of identity. It reads the session, then loads the user from Postgres, once per request. Every page, action and route uses it; no endpoint accepts a user ID.
- **`homePathFor(user)`** maps each state to one page: signed out → `/`, no movie → `/onboarding`, has a movie → `/dashboard`. Pages redirect on the server before rendering, so a signed-out request for `/dashboard` gets a real **307**. A `loading.tsx` was removed because streaming turned that into a 200.
- If Postgres is down, Auth.js reports "no session". When a session cookie exists, `getCurrentUser()` checks the database and throws `DatabaseUnavailableError`, so the visitor sees an error page instead of being treated as signed out.
- Auth.js errors (cancelled consent, replayed callbacks) go back to the landing page with a fixed, friendly message.

### API contract (`src/types/api.ts`)
Every response is `{ success: true, data }` or `{ success: false, error: { code, message } }`, sent with `Cache-Control: no-store`.

| Endpoint | Success | Errors |
|---|---|---|
| `GET /api/me` | `{ id, name, email, image, favoriteMovie }` (explicit allow-list) | 401 |
| `PUT /api/me/movie` with `{ movie }` | `{ favoriteMovie }` | 401, 415 (JSON only, which blocks form-based CSRF), 400 `INVALID_JSON` / `INVALID_INPUT`, 500 |
| `GET /api/fact` | `{ id, content, movieTitle, identifiedTitle, createdAt }` | 401, 409 `MOVIE_NOT_SET`, 422 `MOVIE_NOT_RECOGNIZED`, 429 `RATE_LIMITED`, 502 `FACT_GENERATION_FAILED`, 503 `FACT_GENERATION_BUSY`, 500 |

Validation is shared: `parseMovieTitle()` (trim, 2–100 characters) is used by onboarding, `PUT /api/me/movie` and the client editor. Errors never include raw database or OpenAI messages, and logs record only error name, code and status.

### Fact generation (`src/lib/fact-generation.ts`, `src/lib/openai.ts`)
`GET /api/fact` runs one Postgres transaction:
1. **`pg_advisory_xact_lock(hash(user, movie))`**: concurrent requests for the same user and movie (tabs, rapid refreshes) take turns, which works across serverless instances and through Neon's pooler. The wait is capped by `lock_timeout` (35 s), after which the request returns 503.
2. **Rate limit**: at most 10 stored facts per user per minute, then 429.
3. **History**: the user's last 5 facts for this movie, read under the lock so the next fact picks a new topic.
4. **OpenAI** (Responses API, `reasoning.effort: low`, 15 s timeout, 1 retry) with a **strict JSON schema** `{ recognized, identifiedTitle, fact }`. The user's title is sent as JSON data, never as instructions. Unrecognized titles return 422; refusals, truncated output, empty facts or facts over 500 characters return 502. Nothing is stored in either case.
5. **Insert, then return**: a fact is never shown unless it's stored.

### Client: editing, caching, races (`src/app/dashboard/movie-dashboard.tsx`)
- **Typed client** (`src/lib/api.ts`): every response is validated with Zod; there are no `as T` casts. Failures become an `ApiClientError { status, code, message }`, including HTML error pages, empty bodies, wrong shapes, timeouts (15 s, or 80 s for facts) and network errors. A 401 navigates to sign-in.
- **Optimistic editing**: the new title shows immediately with "Saving…", and fact generation is disabled until the server confirms. On success, the server's (trimmed) value is used. On failure, the confirmed movie is restored, with an error and *Try again*. A save that failed in the browser but was stored on the server is reconciled by the next fact response, which reports the server's actual movie.
- **30-second fact cache**: one entry per user (`{ movieTitle, content, identifiedTitle, fetchedAt }`) in component state, mirrored to `sessionStorage` under a per-user key. Reloads and navigation reuse a fresh fact. A fact is shown only if its `movieTitle` matches the confirmed movie, which also invalidates the cache on a movie change. *Generate another fact* and *Retry* always bypass the cache, and errors are never cached.
- **Stale responses**: a request counter in a `useRef` is incremented by every fact request and every save. A response, success or error, is applied only if it's still the latest.

---

## Which variant and why
**Variant B (Frontend/API-focused).** Most of the risk in this app is on the client: optimistic updates, rollback, a time-based cache and out-of-order responses all interact. Variant B makes those first-class, and its API contract and typed client also cover the backend correctness concerns (validation, auth, error normalization).

**Variant A, partially.** Its 60-second *server-side* cache conflicts with Variant B (every fact request must generate a new fact, and caching is the client's job), so I left it out. I did implement the parts that don't conflict:
- **Burst and idempotency protection**: the Postgres advisory lock above, with integration tests against real Postgres.
- **Authorization tests**: a user can't read or affect another user's data.
- **Safe failure handling**: timeouts, retries, friendly errors, and nothing stored on failure.

---

## Key trade-offs
- **Database sessions over JWT**: one DB read per request, in exchange for instant revocation and no stale identity in other tabs.
- **Favorite movie as a column**: one favorite per user is guaranteed by the schema, but there's no history of previous favorites.
- **No movie catalog**: any title is accepted. The model identifies the film (stored as `identifiedTitle` and shown as "About …") or returns *not recognized*. Facts are labelled "AI-generated, may contain mistakes" because they aren't verified against a source.
- **Advisory lock inside a transaction**: correct across instances with no extra infrastructure, but a pooled connection is held while OpenAI responds (about 3 s typically, 30 s worst case), and waiting requests hold one too.
- **Rate limit (10 facts per minute per user)**: a cost guard that deliberately rejects requests beyond normal use, an exception to Variant B's "always generate". Different movies use different locks, so the limit can be exceeded by a few.
- **`sessionStorage` cache**: survives reloads within a tab, and isn't shared across tabs or kept after the tab closes. A cached fact can therefore be shown for up to 30 s after a reload.
- **Last write wins** for movie edits in two tabs. There's no version column.
- **`allowDangerousEmailAccountLinking` for Google**: repairs a half-created account (Auth.js creates the user and links the account in two non-transactional writes). Safe with a single provider that verifies emails; it should be revisited before adding a second provider.
- **`next-auth@5` is a beta**, pinned to an exact version.

## What I'd improve with 2 more hours
1. **Browser E2E tests** (Playwright with a mocked OAuth provider) for sign-in → onboarding → edit → logout. The current end-to-end check was a manual smoke test against real Google, Postgres and OpenAI.
2. **Movie disambiguation**: look titles up in a catalog API (e.g. TMDB) and let the user pick between ambiguous titles ("It", "Frozen"), then generate facts from that record.
3. **Fallback on OpenAI failure**: return the user's last stored fact inside the 502 response and show it labelled "couldn't get a new fact; here's your last one".
4. **Move the OpenAI call out of the DB transaction**, using a short "generation in progress" lease row, so no connection is held while waiting on OpenAI.
5. **Versioned saves** (`If-Match` with a version column) to detect conflicting edits from two tabs.
6. **Deploy to Vercel** with `prisma migrate deploy`, error tracking, and metrics for OpenAI latency, failures and rate-limit hits.

---

## AI usage
- Used **Claude Code** as a pair programmer throughout: scaffolding, implementation, tests, and running verification commands.
- Worked **milestone by milestone**: I wrote the requirements for each step (scaffold → auth/onboarding → API → dashboard → hardening), reviewed the output, and made the design decisions, such as choosing Variant B, which Variant A parts to add, `sessionStorage` for the cache, and the UI direction.
- Had the AI **verify against real services**, not just mocks: read-only checks of the Neon database before and after each migration and test, a small number of controlled OpenAI calls when changing the prompt, and HTTP checks of redirects and status codes.
- Used **edge-case review checklists** (authentication, onboarding, caching, races) to audit the implementation. This found real gaps that were then fixed and tested, for example a possible account lockout, a database outage looking like being signed out, and a profile-photo host crash.
- Checked that important tests actually catch bugs by temporarily disabling the protection under test (stale-response guard, per-user scoping, advisory lock) and confirming they fail.
- Did **manual testing myself** in the browser with several Google accounts, and supplied the visual design (artwork, colors, layout feedback via screenshots).
- Reviewed AI output critically. Examples that needed correcting: a `loading.tsx` that broke the 307 redirect, a prompt that confused similar Barbie films, and facts that rephrased the same point.
