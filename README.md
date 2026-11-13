# Movie Memory

Sign in with Google, save your favorite movie, and get fun facts about it written by OpenAI.

Live app: https://moviememory-app.vercel.app

I built this for the Scowtt take-home and chose Variant B (frontend/API). I also added the parts of Variant A that don't conflict with B; details are below.

Stack: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Postgres on Neon, Prisma 7, Auth.js v5 with Google, the OpenAI SDK, Zod, and Vitest with React Testing Library.

## Running it locally

You need Node 20.19 or newer, a Postgres database (I used Neon), a Google OAuth client, and an OpenAI API key.

In Google Cloud Console, create an OAuth client of type "Web application" and add this redirect URI:

```
http://localhost:3000/api/auth/callback/google
```

Then:

```bash
npm install            # also generates the Prisma client
cp .env.example .env   # fill in the values below
npm run db:migrate     # creates the tables
npm run dev            # http://localhost:3000
```

Put your values in `.env` rather than `.env.local`. Next.js reads both, but the Prisma CLI only reads `.env`.

### Environment variables

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection, used by the app. On Neon the host contains `-pooler`. |
| `DIRECT_URL` | Direct (unpooled) connection, used only by Prisma migrations. |
| `AUTH_SECRET` | Random string for Auth.js. Generate one with `openssl rand -base64 32`. |
| `AUTH_GOOGLE_ID` | Google OAuth client ID. |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. |
| `OPENAI_API_KEY` | OpenAI API key. |
| `OPENAI_MODEL` | Model to use. I used `gpt-5.4-mini-2026-03-17`; a dated version keeps results consistent. |

None of these are sent to the browser.

### Database migrations

Migrations live in `prisma/migrations` and run against `DIRECT_URL`, because Prisma Migrate doesn't work through a connection pooler.

- `npm run db:migrate` applies migrations in development.
- `npx prisma migrate deploy` applies them in production or CI.
- `npm run db:generate` regenerates the Prisma client after a schema change.

There are two migrations so far: `init` creates the Auth.js tables and `MovieFact`, and `add_fact_identified_title` adds one nullable column.

### Tests

```bash
npm run lint
npm run typecheck
npm test          # 134 tests; the database and OpenAI are mocked
npm run test:db   # 7 tests against the real database in DATABASE_URL
npm run build
```

`test:db` creates a few throwaway users (`itest-…@example.test`) and deletes them when it's done. Only point it at a development database.

## How it works

### Pages and routing

There are three pages: `/` (sign-in), `/onboarding` and `/dashboard`. Each one is a server component that asks `getCurrentUser()` who's signed in, then decides where that person belongs:

- signed out goes to `/`
- signed in with no favorite movie goes to `/onboarding`
- signed in with a movie goes to `/dashboard`

Because this happens on the server before anything renders, a signed-out request for `/dashboard` gets a real 307 redirect, not a page that hides content in the browser. (An early `loading.tsx` broke this by turning the 307 into a 200, so I removed it.)

### Authentication

Auth.js handles Google sign-in and stores sessions in Postgres. The browser cookie is just an opaque token, so signing out ends the session everywhere immediately, including in other tabs.

`getCurrentUser()` in `src/lib/current-user.ts` is the only place identity comes from. No endpoint accepts a user ID from the browser, and every database query filters by the session's user.

Two edge cases are handled deliberately:

- If the database is down, Auth.js quietly reports "no session". To avoid showing the sign-in page as though you'd been logged out, `getCurrentUser()` checks the database whenever a session cookie exists, and shows an error page if it can't be reached.
- Auth.js errors, such as cancelling the Google consent screen, send you back to the sign-in page with a plain-language message instead of a raw error page.

### Data model

Besides the standard Auth.js tables (`User`, `Account`, `Session`, `VerificationToken`):

- `User.favoriteMovie` is a nullable column. It's empty until onboarding, and since it's a single column a user can only ever have one favorite.
- `MovieFact` stores each generated fact with `userId`, `movieTitle`, `identifiedTitle`, `content` and `createdAt`. Each fact keeps the title it was generated for, so facts stay correct if the user changes movies. Deleting a user deletes their facts.
- Accounts are matched by Google's account ID, not by email, so a changed Gmail address doesn't break anything.

I didn't add a `Movie` table, because there's no movie catalog to link to. A single index on `(userId, movieTitle, createdAt)` covers the queries the app makes.

### API

All responses have the same shape: `{ success: true, data }` or `{ success: false, error: { code, message } }`. They're sent with `Cache-Control: no-store`.

- `GET /api/me` returns the signed-in user's id, name, email, photo and favorite movie.
- `PUT /api/me/movie` takes `{ movie }` and returns the saved title. It only accepts JSON, which stops another site from submitting a form to it.
- `GET /api/fact` generates a new fact for the user's current movie, saves it, and returns it.

Movie titles are validated by one shared function, `parseMovieTitle()` (trimmed, 2 to 100 characters), used by onboarding, the API and the inline editor. Error responses never include raw database or OpenAI messages, and server logs record only the error type.

### Generating a fact

`GET /api/fact` does all of its work inside one database transaction:

1. It takes a Postgres advisory lock for this user and movie. Two tabs asking at the same moment take turns instead of both calling OpenAI. The lock lives in Postgres, so it works across serverless instances, and a request gives up with a 503 after waiting 35 seconds.
2. It checks a rate limit of 10 facts per user per minute (429 if exceeded).
3. It loads the user's last 5 facts for this movie, so the model can choose a new topic.
4. It calls OpenAI with a strict JSON schema: did it recognize the film, which film, and the fact. The title is sent as data, not as part of the instructions, to limit prompt injection. If the film isn't recognized it returns 422; empty, cut-off or overly long answers return 502. Nothing is saved in either case.
5. It saves the fact and returns it. A fact is never shown unless it's been saved.

The dashboard shows which film the model identified ("About Interstellar (2014)") and labels facts as AI-generated, since they aren't checked against a real source.

### The dashboard

The dashboard is one client component, `src/app/dashboard/movie-dashboard.tsx`, using the typed client in `src/lib/api.ts`. That client checks every response with Zod instead of trusting a TypeScript cast. HTML error pages, empty bodies, timeouts and network failures all become one error type with a status, code and message. A 401 sends you back to sign in.

Editing the movie is optimistic. The new title appears right away with "Saving…", and fact generation pauses until the server confirms the save. If the save fails, the previous movie comes back with an error and a Try again button. If a save actually went through but the response was lost, the next fact response reports the server's real movie, and the dashboard updates to match.

Facts are cached for 30 seconds, one entry per user, in React state and in `sessionStorage`. Reloading the page within 30 seconds reuses the fact instead of calling OpenAI again. "Generate another fact" and Retry always fetch a new one, errors are never cached, and a fact is only shown if it matches the current movie.

To stop slow, outdated responses overwriting newer ones, every fact request and every save increments a counter, and only the response belonging to the latest request is applied.

## Why Variant B

Most of what can go wrong in this app happens in the browser: optimistic updates, rolling them back, a time-based cache, and responses arriving out of order. Variant B is about exactly that, and its API contract and typed client cover the backend basics too.

From Variant A, I left out the 60-second server-side cache. Variant B requires every fact request to generate a new fact, with caching done in the browser, so the two can't both be true. I did add the parts of A that fit:

- protection against simultaneous requests (the advisory lock), tested against real Postgres
- tests showing one user can't read or change another user's data
- careful handling of OpenAI failures: timeouts, one retry, friendly errors, and nothing saved on failure

## Trade-offs

- Database sessions cost a database read per request, but sign-out takes effect immediately everywhere. I thought that was worth it.
- Storing the favorite as a column keeps "one per user" simple, but there's no history of past favorites.
- There's no movie catalog, so any title is accepted. The model either identifies the film or says it can't. Facts can still be wrong, which is why they're labelled.
- The advisory lock keeps a database connection open while OpenAI responds (about 3 seconds normally, up to about 30), and anyone waiting for the lock holds one too. That's fine at this scale but wouldn't be at high traffic.
- The rate limit means a request is occasionally refused, a deliberate exception to "always generate a new fact". Requests for different movies use different locks, so a user could slightly exceed it.
- The cache lives in `sessionStorage`. It survives a reload but not a new tab, and a fact can show for up to 30 seconds after a reload.
- If you edit your movie in two tabs at once, the last save wins.
- Google accounts are linked by email (`allowDangerousEmailAccountLinking`). Auth.js creates the user and links the Google account in two separate steps, and this repairs a half-finished sign-up. It's safe with Google as the only sign-in option, but I'd revisit it before adding another.
- `next-auth` v5 is still in beta, so it's pinned to an exact version.
- The deployed app uses the same Neon database as local development. With more time I'd give production its own database branch.

## With two more hours

1. Browser end-to-end tests with Playwright and a mocked Google login. Right now the full flow has only been tested by hand, against real Google, Postgres and OpenAI.
2. Look movies up in a catalog such as TMDB and let the user choose when a title is ambiguous ("It", "Frozen"). Facts would then be generated for a specific film.
3. When OpenAI fails, show the last saved fact with a note that it isn't new, instead of only an error.
4. Move the OpenAI call out of the database transaction, using a short "generation in progress" record, so no connection is held while waiting.
5. Add a version number to saves so edits from two tabs are detected instead of silently overwritten.
6. Error tracking and basic metrics in production: OpenAI latency, failures, rate-limit hits.

## How I used AI

- I used Claude Code as a pair programmer throughout: scaffolding, writing code and tests, and running checks.
- I worked in milestones (setup, sign-in and onboarding, API, dashboard, hardening), wrote the requirements for each, and reviewed the output before moving on. I made the design calls myself, for example choosing Variant B, which Variant A pieces to add, using `sessionStorage` for the cache, and the visual design.
- I had it check against the real services, not just mocks: read-only Neon queries before and after migrations, a few deliberate OpenAI calls when tuning the prompt, and HTTP checks of redirects and status codes.
- I used checklists of edge cases (authentication, onboarding, caching, race conditions) to review the app. That turned up real problems, which we then fixed and tested, such as a possible account lockout and a database outage that looked like being logged out.
- To make sure key tests could actually fail, I had it temporarily remove the code each test protects and confirm the test failed.
- I tested in the browser myself with several Google accounts, and supplied the artwork and design feedback through screenshots.
- Not everything it produced was right first time. A loading screen broke the server redirect, the first prompt mixed up two Barbie films, and early facts repeated the same point in different words. Each was caught in testing and fixed.
