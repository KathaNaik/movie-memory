# Architecture and decisions

[← Back to README](../README.md)

## Overview

```
Browser
  │
  ├─ /, /onboarding, /dashboard    server components: check the session, redirect, render
  ├─ onboarding form                server action
  ├─ dashboard                      one client component (editing, caching), using src/lib/api.ts
  │
  └─ /api/me, /api/me/movie, /api/fact, /api/auth/*    route handlers (Node.js runtime)
        │
        ├─ Postgres on Neon   via Prisma 7 and the pg driver adapter
        └─ OpenAI             server-side only (src/lib/openai.ts)
```

There's no middleware and no separate backend. Everything runs in Next.js on the Node.js runtime.

## Auth flow

1. "Sign in with Google" calls Auth.js. After Google, the Prisma adapter creates or finds the `User`, links the Google `Account`, and stores a `Session` row. The browser gets an opaque session cookie.
2. Each page calls `getCurrentUser()` (`src/lib/current-user.ts`). It reads the session and then loads the user from Postgres, once per request.
3. One function, `homePathFor(user)`, decides where everyone belongs: signed out goes to `/`, no favorite movie goes to `/onboarding`, and a saved movie goes to `/dashboard`. Pages redirect on the server before rendering, so a signed-out request for `/dashboard` gets a real 307, not a page that hides itself in the browser. Since each state has exactly one page, redirect loops can't happen.
4. Onboarding is decided by the database (`favoriteMovie` is null or not), never by browser state.
5. Signing out deletes the session row, which ends the session in every tab at once.

Edge cases handled:

- **Cancelled consent, replayed callbacks.** Auth.js errors come back to the landing page with a plain message instead of a 500 error page.
- **Half-finished sign-up.** Auth.js creates the user and links the Google account in two separate writes. If the second failed, the user would be locked out for good. Linking by email for Google repairs that on the next sign-in.
- **Database outage.** When the database is down, Auth.js reports "no session". If a session cookie exists, `getCurrentUser()` checks the database and shows an error page instead of acting as if you'd been logged out.
- **Session expiry mid-use.** Any 401 from the API sends the browser back to sign-in with an "expired" message.

## Data model, and why

Besides the standard Auth.js tables (`User`, `Account`, `Session`, `VerificationToken`):

```
User.favoriteMovie   String?    null until onboarding

MovieFact
  id               String (cuid)
  userId           → User, cascade delete
  movieTitle       String     the user's title when the fact was made
  identifiedTitle  String?    the film the model identified, e.g. "Inception (2010)"
  content          String
  createdAt        DateTime
  index (userId, movieTitle, createdAt desc)
```

Why it looks like this:

- **The favorite movie is a column, not a table.** The app has exactly one favorite per user. As a column, that rule holds without a unique constraint, and double-submits can't create duplicates. The cost is no history of past favorites, which nothing needs.
- **No `Movie` table.** There's no movie catalog to link to, so a `Movie` table would only hold strings typed by users. Each fact keeps the title it was generated for instead, so facts stay correct after the user changes their movie.
- **`identifiedTitle` is separate from `movieTitle`.** `movieTitle` is what the user typed, and it's what the cache and history match on. `identifiedTitle` is what the model thinks the film is, shown to the user so a mix-up is visible.
- **One index.** The main query is "this user's latest facts for this movie", which the index serves directly. The rate-limit count (all of a user's facts in the last minute) only uses the `userId` part of the index. That's fine at this scale; I'd add an index on `(userId, createdAt)` if it grew.
- **Identity is tied to Google's account ID**, through `Account(provider, providerAccountId)`, not to email.

## Security and authorization

- Identity comes only from the server-side session. No endpoint accepts a user ID, and every query filters by the session's user. Tests use two users' data to check that one can't read or change the other's, including with a forged `userId` in the body or headers.
- Validation is shared. `parseMovieTitle()` (trimmed, 2 to 100 characters) is used by onboarding, the API and the inline editor, and the server's check is the one that counts.
- `PUT /api/me/movie` only accepts JSON, so another site can't submit a form to it.
- Prisma uses parameterized queries, and React escapes all output, so titles containing SQL or HTML are just text.
- The movie title is sent to OpenAI as JSON data, kept separate from the instructions, to limit prompt injection.
- Secrets stay on the server. Error responses never include raw database or OpenAI messages, and logs record only the error type, code and status.
- The database client imports `server-only`, so it can't be bundled into browser code by accident.

## Error handling and failure cases

Every API response has the same shape: `{ success: true, data }` or `{ success: false, error: { code, message } }`, sent with `Cache-Control: no-store`.

| What fails | What the user sees | What's stored |
|---|---|---|
| Not signed in, or session expired | Redirect to sign-in with a message | Nothing |
| Invalid title | Inline validation message | Nothing |
| Saving the movie fails | Previous movie comes back, error with "Try again" | Nothing |
| OpenAI times out or errors (15 s timeout, one retry) | "Couldn't come up with a fact" with Retry | Nothing |
| Model doesn't recognize the film | "We couldn't tell which movie that is", with an Edit button | Nothing |
| Model returns empty, cut-off or very long text | Same as an OpenAI error | Nothing |
| Saving the fact fails | Generic error | Nothing; a fact is never shown unless saved |
| Too many facts (10 per user per minute) | "Please wait a moment" | Nothing |
| Database down | Error page with "Try again" | Nothing |
| Slow or lost response | The client times out (15 s, or 80 s for facts) and shows an error | Whatever the server finished |

The typed client (`src/lib/api.ts`) checks every response with Zod instead of trusting a TypeScript cast. HTML error pages, empty bodies, wrong shapes, timeouts and network failures all become one error type with a status, code and message. The UI can then tell validation, authentication, server and network problems apart.

## Generating a fact

`GET /api/fact` runs inside one database transaction (`src/lib/fact-generation.ts`):

1. **Lock.** It takes a Postgres advisory lock for this user and movie. Two tabs or a quick double refresh take turns instead of calling OpenAI at the same time. The lock lives in Postgres, so it works across serverless instances, and it's released automatically even if a request crashes. A request waits at most 35 seconds, then gets a 503.
2. **Rate limit.** At most 10 facts per user per minute.
3. **History.** The user's last 5 facts for this movie are sent to the model so it picks a new topic. This is read under the lock, so a request that waited sees the fact the previous one just saved.
4. **OpenAI.** The model returns structured JSON: did it recognize the film, which film, and the fact.
5. **Save, then return.**

## Client state and caching (Variant B)

All interactive state is in one component, `src/app/dashboard/movie-dashboard.tsx`. There's no state library; each operation has its own state rather than sharing one `loading` flag:

- **Movie:** the confirmed movie (from the server), plus a pending movie while a save is in progress.
- **Editing:** whether the editor is open, the draft, and its validation error.
- **Fact:** idle, loading or error, plus the cached fact.

**Optimistic edits.** Save shows the new title straight away with "Saving…". While it's pending, the old fact is hidden and fact generation is paused, because the server would still generate a fact for the old movie. On success, the server's (trimmed) title is used and a fact for the new movie is fetched. On failure, the confirmed movie comes back with an error, and its cached fact is shown again if it's still fresh. Only one save can be pending at a time.

**The 30-second cache.** One entry per user, holding `{ movieTitle, content, identifiedTitle, fetchedAt }`, kept in React state and copied to `sessionStorage` under a per-user key. So:

- reloading or coming back to the dashboard within 30 seconds reuses the fact instead of calling OpenAI;
- a fact counts as fresh while it's under 30,000 ms old;
- "Generate another fact" and Retry always fetch a new one;
- errors are never cached;
- a different user in the same tab never sees the previous user's fact.

I chose `sessionStorage` over React-only state because otherwise the cache was almost never used: every reload went to OpenAI. I chose it over `localStorage` because it isn't shared across tabs and is cleared when the tab closes.

**Invalidation.** A fact is shown only if its `movieTitle` matches the confirmed movie. That one rule invalidates the cache when the movie changes and keeps the old fact available if a save fails. The cache is cleared only after the server confirms a new movie, so a failed edit doesn't cost an extra OpenAI call.

**Out-of-order responses.** Every fact request and every save increments a counter kept in a `useRef`. A response, success or error, is applied only if it belongs to the latest request. A slow fact for the old movie can't overwrite the new one, and it can't show an outdated error either.

**A save that "failed" but actually went through.** If the response is lost after the database saved the change, the UI rolls back. The next time a fact is fetched, its `movieTitle` shows what the server really has, and the UI switches to that. If the old fact is still fresh, no fetch happens, so the UI stays on the old movie until the next reload or new fact.

## Where to look in the code

- `src/lib/current-user.ts`: identity and the database-outage check
- `src/lib/routing.ts`: the single rule for which page each user belongs on
- `src/lib/fact-generation.ts`: lock, rate limit, history, save
- `src/lib/openai.ts`: prompt, structured output, validation of the model's answer
- `src/lib/api.ts`: typed client and error normalization
- `src/app/dashboard/movie-dashboard.tsx`: optimistic editing, cache, out-of-order handling
- `tests/api/authorization.test.ts`: tests that one user can't reach another's data
- `tests/integration/fact-concurrency.test.ts`: real-Postgres tests for the lock, rate limit and onboarding race

## Why Variant B

Most of what can go wrong in this app happens in the browser: optimistic updates, rolling them back, a time-based cache, and responses arriving out of order. Variant B is about exactly that. Its API contract and typed client also cover the backend basics: validation, authorization and consistent errors.

I left out Variant A's 60-second server cache. Variant B requires every fact request to generate a new fact, with caching done in the browser, so both can't be true. I added the parts of A that fit:

- protection against simultaneous requests (the advisory lock)
- authorization tests
- careful handling of OpenAI failures

## Trade-offs

- **Database sessions instead of JWTs.** Each request does two small reads (the session, then the user), but sign-out takes effect everywhere immediately and there's no stale identity.
- **Any title is accepted.** There's no movie catalog, so the model either identifies the film or says it can't. Facts can still be wrong, so they're labelled "AI-generated, may contain mistakes" and show which film the model picked.
- **The lock holds a database connection while OpenAI responds** (about 3 seconds normally, up to about 30), and so does anyone waiting for it. That's fine here, but not at high traffic.
- **The rate limit occasionally refuses a request**, a deliberate exception to "always generate a new fact". Different movies use different locks, so a user could go slightly over.
- **`sessionStorage` cache.** It survives a reload, not a new tab, and a fact can show for up to 30 seconds after a reload.
- **Two tabs editing at once: the last save wins.** There's no version check.
- **Google accounts are linked by email.** That's what repairs a half-finished sign-up. It also means a Google login whose email matches an existing user is linked to that user, which is safe with Google as the only provider. I'd revisit it before adding another.
- **One database for local development and production.** The Neon integration connected the same database to every environment. Production should get its own branch.
- **Scope.** The lock, rate limit and persisted cache go a little beyond the brief. Each is small and kept in one place. The lock covers Variant A's concurrency requirement without its server cache, and the rate limit came out of reviewing failure cases (cost if something loops). The persisted cache fixed a gap I saw in testing: before it, every reload called OpenAI.
- **Known noise.** `next-auth` v5 is a beta, pinned to an exact version. `npm audit` reports 7 moderate issues, all in dev-only ESLint packages. `pg` logs a warning about future `sslmode` behavior.

## With two more hours

1. **Browser end-to-end tests** with Playwright and a mocked Google login, for sign-in, onboarding, edit and logout. The full flow has only been tested by hand so far, against real Google, Postgres and OpenAI, and that's the biggest gap.
2. **A fallback when OpenAI fails:** return the user's last saved fact with the error, labelled as not new. It's a small change and it makes the most common failure much less disruptive.
3. **A separate production database** (a Neon branch), so tests and local experiments can't touch live data.

Later: look titles up in a catalog such as TMDB so users can pick between ambiguous titles; move the OpenAI call out of the transaction so no connection is held while waiting; add a version check to saves to catch conflicting edits from two tabs; and add error tracking and basic metrics in production.
