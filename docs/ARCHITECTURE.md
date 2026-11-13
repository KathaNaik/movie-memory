# Architecture and decisions

[← Back to README](../README.md)

## Architecture overview

Movie Memory is a full-stack Next.js application. It uses Auth.js for Google sign-in, PostgreSQL with Prisma for persistence, and OpenAI to generate movie facts.

Server Components render the authenticated pages, and Route Handlers serve a small typed API. On the dashboard, client-side React handles inline movie editing, optimistic updates and a 30-second fact cache.

I kept everything in a single Next.js codebase to keep infrastructure minimal and put the effort into the API contract and client-side state, which is what Variant B emphasizes.

```
Browser
  ├─ /, /onboarding, /dashboard   Server Components: check the session, redirect, render
  ├─ dashboard                    one Client Component, using the typed client in src/lib/api.ts
  └─ /api/me, /api/me/movie, /api/fact
        ├─ PostgreSQL (Neon) via Prisma
        └─ OpenAI (server-side only)
```

## Authentication and routing

Google sign-in is handled by Auth.js, with sessions stored in the database.

Protected pages check the session on the server before rendering. A shared routing function sends first-time users to onboarding and returning users to the dashboard, based on whether they have a saved favorite movie. A signed-out request for `/dashboard` gets a real server redirect, not a page that hides itself in the browser.

The session and the database are always the source of truth. Onboarding completion is never stored in the browser.

Each API route checks authentication on its own, and signing out deletes the database session, so it ends in every tab.

## Data model

The data model is deliberately small. Besides the standard Auth.js tables:

- **User** holds the sign-in details and the user's current favorite movie (`favoriteMovie`, empty until onboarding).
- **MovieFact** holds each generated fact: the user, the movie title it was generated for, the film the model identified, the text, and when it was created.

Each user has exactly one current favorite movie, so storing it directly on the user record avoids an unnecessary relationship. It also means a double-submitted onboarding form can't create duplicates.

Facts are stored separately so each one stays linked to the movie it was generated for, even after the user changes their favorite.

I didn't add a movie catalog, because the assignment only calls for movie titles typed by the user.

## Security

- Identity comes only from the server-side session. No endpoint accepts a user ID, and every query filters by the signed-in user. Tests use two users' data to confirm that one can't read or change the other's, even with a forged `userId` in the request.
- One shared function validates movie titles (trimmed, 2 to 100 characters) for onboarding, the API and the inline editor. The server's check is the one that counts.
- `PUT /api/me/movie` only accepts JSON, so another site can't submit a form to it.
- Queries are parameterized and React escapes all output, so titles containing SQL or HTML are treated as plain text.
- The movie title is sent to OpenAI as data, kept separate from the instructions, to limit prompt injection.
- API keys and database access stay on the server. Error responses never include raw database or OpenAI messages.

## Movie fact generation

Facts are generated on the server with OpenAI.

The API checks the user's session, reads their saved movie, asks the model for a structured response (whether it recognized the film, which film it is, and the fact), and saves the result before returning it. If generation or saving fails, the API returns a consistent error and the client never shows an unsaved fact. If the model can't identify the film, the user is asked to edit the title instead of being shown a guess.

The implementation also has a per-user rate limit to control API usage, and it serializes requests so two tabs can't generate facts for the same movie at the same time.

For this assignment I prioritized predictable behavior and consistent data over a separate background processing system.

## Client state and caching

I used plain React state instead of a state-management library. The dashboard has only a few related interactions, so local state in one component (`src/app/dashboard/movie-dashboard.tsx`) was enough. Each operation has its own state (editing, saving, loading a fact) rather than one shared loading flag.

All API calls go through a small typed client (`src/lib/api.ts`). It validates every response at runtime with Zod instead of trusting a TypeScript cast, and turns any failure (error pages, malformed responses, timeouts, network errors) into one error type. That lets the UI tell validation, authentication, server and network problems apart.

### Optimistic movie updates

The edited movie appears immediately while the save is in progress.

The last confirmed movie is kept for rollback. During the save, the old fact is hidden so it can't appear under the new movie, and generating facts is paused, because the server still has the old movie until the save completes.

On success, the client uses the movie title the server confirmed and invalidates the previous fact. On failure, it restores the confirmed movie, plus its cached fact if that's still valid, and shows an error with a Try again button.

### 30-second fact cache

The client caches the latest fact, with its movie title and timestamp, in `sessionStorage`:

- When the dashboard loads, or a failed save is rolled back, a cached fact less than 30 seconds old is reused instead of calling OpenAI.
- "Generate another fact" always skips the cache.
- Changing the movie invalidates the previous fact.
- The cache is keyed by user, so another account in the same tab never sees it.
- Failed requests are never cached.

I chose `sessionStorage` because it keeps the cache across page reloads, without sharing it between tabs or needing a server-side cache.

### Stale response protection

Fact requests and movie saves each take a request number, and a response is only applied if it's still the latest one.

This matters when a user changes their movie while a fact is still loading. The late fact for the previous movie is ignored instead of being shown under the new one, and so is a late error.

## Error handling

Every API response has the same shape, `{ success: true, data }` or `{ success: false, error: { code, message } }`, and responses are never cached.

| When this fails | The user sees |
|---|---|
| Not signed in, or the session expires | A redirect to sign-in with a short explanation |
| Saving the movie | The previous movie restored, an error and Try again |
| Generating a fact | A friendly error with Retry; nothing is saved |
| The model doesn't recognize the film | A prompt to edit the title |
| The database is unavailable | An error page with Try again, not a false "signed out" |

## Where to look in the code

- `src/app/dashboard/movie-dashboard.tsx`: optimistic editing, the cache, stale-response handling
- `src/lib/api.ts`: the typed API client
- `src/lib/fact-cache.ts`: the cache rules
- `src/lib/current-user.ts` and `src/lib/routing.ts`: identity and redirects
- `src/lib/fact-generation.ts` and `src/lib/openai.ts`: fact generation
- `tests/movie-dashboard.test.tsx`, `tests/api/authorization.test.ts`: the most important tests

## Why Variant B

Most of what can go wrong in this app happens where the API and the UI meet: optimistic updates and rollback, a time-based cache, and responses arriving out of order. Variant B focuses on exactly that, and a clear API contract with a validated client covers the backend side.

## Trade-offs

**Single Next.js application.** Frontend and API live in one codebase instead of a separate backend service. That keeps deployment simple and is enough for this app's scope.

**Client-side caching.** The 30-second cache uses `sessionStorage`. It survives a page reload but isn't shared across tabs, which fits the required behavior.

**Synchronous fact generation.** The OpenAI call runs inside the API request. A PostgreSQL advisory lock serializes generation for the same user and movie, but it holds a database connection while waiting for the model (usually about 3 seconds). At larger scale I'd take generation out of the database transaction.

**Concurrent movie edits.** Edits from different tabs use last-write-wins. I didn't add version-based conflict detection, because collaborative editing is outside this app's scope.

## Known limitations

- Local development and the deployed app currently share one database. Until they're separated, test runs and experiments touch live data.
- `next-auth` v5 is still in beta, so it's pinned to an exact version.
- `npm audit` reports moderate issues in development-only lint packages, and the Postgres driver logs a warning about future SSL defaults. Neither affects the running app.

## Potential improvements

With two more hours, I'd start with the first two.

- **End-to-end tests:** automate sign-in, onboarding, editing and sign-out with Playwright. The full flow has only been tested by hand so far.
- **Database isolation:** give production its own database so test activity can't affect it.
- **Movie identification:** look titles up in a catalog such as TMDB, so users can pick the right film when a title is ambiguous.
- **Generation at scale:** move the OpenAI call out of the database transaction if traffic grows.

I left these out of the current scope to keep the work focused on Variant B's API and frontend requirements.
