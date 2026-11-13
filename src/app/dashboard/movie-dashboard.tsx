"use client";

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";

import { ApiClientError, getMovieFact, updateFavoriteMovie } from "@/lib/api";
import {
  forgetOtherUsers,
  isFreshFactFor,
  readCachedFact,
  writeCachedFact,
  type CachedFact,
} from "@/lib/fact-cache";
import { redirectToSignIn } from "@/lib/navigation";
import { parseMovieTitle } from "@/lib/validation/movie";

type FactStatus = "idle" | "loading" | "error";

/** The session ended (expired, or signed out in another tab). */
function isUnauthenticated(error: unknown) {
  return error instanceof ApiClientError && error.status === 401;
}

function messageFrom(error: unknown, fallback: string) {
  // ApiClientError messages are already user-friendly (server- or client-written).
  return error instanceof ApiClientError ? error.message : fallback;
}

const buttonBase =
  "rounded-full px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const primaryButton = `${buttonBase} bg-accent text-white hover:bg-accent-hover`;
const secondaryButton = `${buttonBase} border border-zinc-300 bg-white hover:bg-zinc-100`;

export function MovieDashboard({ userId, initialMovie }: { userId: string; initialMovie: string }) {
  // The last movie the server confirmed, plus the optimistic value shown while
  // a save is in flight.
  const [confirmedMovie, setConfirmedMovie] = useState(initialMovie);
  const [pendingMovie, setPendingMovie] = useState<string | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; movie: string } | null>(null);

  // Single-entry cache of the last successfully fetched fact, mirrored to
  // sessionStorage (per user) so it survives reloads; see rememberFact().
  const [cachedFact, setCachedFact] = useState<CachedFact | null>(null);
  // Starts as "loading" because the first fact is requested on mount.
  const [factStatus, setFactStatus] = useState<FactStatus>("loading");
  const [factError, setFactError] = useState<{ message: string; code: string } | null>(null);

  // Bumped by every fact request and every movie change. A response is applied
  // only if no newer request or movie change happened while it was in flight.
  const latestFactRequest = useRef(0);
  const initialFactRequested = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusToEdit = useRef(false);

  const isSaving = pendingMovie !== null;
  const displayedMovie = pendingMovie ?? confirmedMovie;
  // Never show a fact for any movie other than the confirmed one.
  const visibleFact = !isSaving && cachedFact?.movieTitle === confirmedMovie ? cachedFact : null;

  /** Updates the cache in state and in sessionStorage together. */
  function rememberFact(fact: CachedFact | null) {
    setCachedFact(fact);
    writeCachedFact(userId, fact);
  }

  /** Always requests a new fact (explicit generation and retries bypass the cache). */
  async function fetchFact() {
    const requestId = ++latestFactRequest.current;
    setFactStatus("loading");
    setFactError(null);
    try {
      const fact = await getMovieFact();
      if (requestId !== latestFactRequest.current) return; // stale: ignore entirely
      // The server generated this for the movie it has saved. If that differs
      // from what we show (a save that succeeded although its response was
      // lost, or a change in another tab), the server is right.
      if (fact.movieTitle !== confirmedMovie) {
        setConfirmedMovie(fact.movieTitle);
        setSaveError(null);
      }
      rememberFact({
        id: fact.id,
        movieTitle: fact.movieTitle,
        identifiedTitle: fact.identifiedTitle,
        content: fact.content,
        fetchedAt: Date.now(),
      });
      setFactStatus("idle");
    } catch (error) {
      if (requestId !== latestFactRequest.current) return;
      if (isUnauthenticated(error)) return redirectToSignIn();
      // Errors are shown, never cached.
      setFactStatus("error");
      setFactError({
        message: messageFrom(error, "We couldn't load a fact. Please try again."),
        code: error instanceof ApiClientError ? error.code : "UNKNOWN",
      });
    }
  }

  /** Shows a fact for `movieTitle`, reusing `cache` if it's under 30 seconds old. */
  function ensureFact(movieTitle: string, cache: CachedFact | null) {
    if (isFreshFactFor(cache, movieTitle, Date.now())) {
      setFactStatus("idle");
      return;
    }
    void fetchFact();
  }

  // First fact on mount: reuse this user's stored fact if it's for the current
  // movie and under 30 seconds old (e.g. after a reload or navigating back),
  // otherwise generate one. Runs after hydration, since sessionStorage only
  // exists in the browser.
  const loadInitialFact = useEffectEvent(() => {
    forgetOtherUsers(userId);
    const stored = readCachedFact(userId);
    if (isFreshFactFor(stored, initialMovie, Date.now())) {
      setCachedFact(stored);
      setFactStatus("idle");
    } else {
      void fetchFact();
    }
  });

  useEffect(() => {
    // Strict Mode runs effects twice in development; don't generate two facts.
    if (initialFactRequested.current) return;
    initialFactRequested.current = true;
    loadInitialFact();
  }, []);

  useEffect(() => {
    // Keep keyboard focus in place when the inline editor closes.
    if (!isEditing && returnFocusToEdit.current) {
      returnFocusToEdit.current = false;
      editButtonRef.current?.focus();
    }
  }, [isEditing]);

  async function saveMovie(movie: string) {
    if (isSaving) return;
    // Snapshot the confirmed state to roll back to.
    const previousMovie = confirmedMovie;
    const previousFact = cachedFact;

    // Any in-flight fact request is for the old movie: make it stale. Facts
    // can't be requested again until the server confirms the new movie, since
    // /api/fact uses the persisted value.
    latestFactRequest.current++;
    setPendingMovie(movie);
    setSaveError(null);
    setFactStatus("idle");
    setFactError(null);

    try {
      const { favoriteMovie } = await updateFavoriteMovie(movie);
      setConfirmedMovie(favoriteMovie);
      setPendingMovie(null);
      // A save only happens when the title changed, so the cached fact is for
      // the old movie: invalidate it and fetch one for the new movie.
      rememberFact(null);
      void fetchFact();
    } catch (error) {
      if (isUnauthenticated(error)) return redirectToSignIn();
      // Roll back: the unconfirmed movie disappears, and the old movie's fact
      // is reused if still fresh, otherwise refetched.
      setPendingMovie(null);
      setSaveError({
        message: messageFrom(error, "We couldn't save your movie. Please try again."),
        movie,
      });
      ensureFact(previousMovie, previousFact);
    }
  }

  function startEditing() {
    if (isSaving) return;
    setDraft(confirmedMovie);
    setDraftError(null);
    setSaveError(null);
    setIsEditing(true);
  }

  function stopEditing() {
    returnFocusToEdit.current = true;
    setIsEditing(false);
    setDraftError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Same validation as the server, for instant feedback; the server's
    // check remains authoritative.
    const result = parseMovieTitle(draft);
    if (!result.success) {
      setDraftError(result.error);
      return;
    }
    stopEditing();
    // Nothing changed: no request needed.
    if (result.movieTitle === confirmedMovie) return;
    void saveMovie(result.movieTitle);
  }

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="favorite-movie-heading">
        <div className="flex items-center justify-between gap-4">
          <h2
            id="favorite-movie-heading"
            className="text-sm font-medium uppercase tracking-wide text-zinc-500"
          >
            Favorite movie
          </h2>
          {!isEditing && (
            <button
              ref={editButtonRef}
              type="button"
              onClick={startEditing}
              aria-disabled={isSaving || undefined}
              aria-label="Edit favorite movie"
              className={secondaryButton}
            >
              Edit
            </button>
          )}
        </div>

        {isEditing ? (
          <form onSubmit={handleSubmit} noValidate className="mt-3 flex flex-col gap-3">
            <label htmlFor="favorite-movie-input" className="text-sm font-medium">
              New favorite movie
            </label>
            <input
              id="favorite-movie-input"
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") stopEditing();
              }}
              autoFocus
              autoComplete="off"
              aria-invalid={draftError ? true : undefined}
              aria-describedby={draftError ? "favorite-movie-error" : undefined}
              className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-lg outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 aria-invalid:border-red-600"
            />
            {draftError && (
              <p id="favorite-movie-error" role="alert" className="text-sm text-red-700">
                {draftError}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" className={primaryButton}>
                Save
              </button>
              <button type="button" onClick={stopEditing} className={secondaryButton}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-3 text-3xl font-semibold break-words">
            <span>{displayedMovie}</span>
            {isSaving && (
              <span role="status" className="text-sm font-normal text-zinc-500">
                Saving…
              </span>
            )}
          </p>
        )}

        {saveError && (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <span>
              Couldn&apos;t change your movie to &ldquo;{saveError.movie}&rdquo;. {saveError.message}
            </span>
            <button
              type="button"
              onClick={() => void saveMovie(saveError.movie)}
              disabled={isSaving}
              className={secondaryButton}
            >
              Try again
            </button>
          </div>
        )}
      </section>

      <section
        aria-labelledby="fact-heading"
        aria-busy={factStatus === "loading"}
        className="border-t border-zinc-200 pt-5"
      >
        <h2
          id="fact-heading"
          className="text-sm font-medium uppercase tracking-wide text-accent"
        >
          Fun fact
        </h2>

        <div aria-live="polite" className="mt-2 min-h-14">
          {isSaving ? (
            <p className="text-zinc-600">
              A new fact will appear once your movie is saved.
            </p>
          ) : factStatus === "loading" ? (
            <div className="flex flex-col gap-2">
              <span className="sr-only">Finding a fun fact about {confirmedMovie}…</span>
              <div aria-hidden className="h-4 w-full animate-pulse rounded bg-zinc-200" />
              <div aria-hidden className="h-4 w-2/3 animate-pulse rounded bg-zinc-200" />
            </div>
          ) : factStatus === "error" ? null : visibleFact ? (
            <div>
              <p className="text-lg leading-relaxed">{visibleFact.content}</p>
              {/* Makes a misidentified film visible, and sets expectations. */}
              <p className="mt-2 text-xs text-zinc-500">
                {visibleFact.identifiedTitle && (
                  <>
                    About <cite className="font-medium not-italic">{visibleFact.identifiedTitle}</cite>
                    {" · "}
                  </>
                )}
                AI-generated, may contain mistakes.
              </p>
            </div>
          ) : (
            <p className="text-zinc-600">No fact yet.</p>
          )}
        </div>

        {factStatus === "error" && !isSaving && (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <span>{factError?.message}</span>
            {factError?.code === "MOVIE_NOT_RECOGNIZED" ? (
              // Retrying the same title would fail the same way.
              <button type="button" onClick={startEditing} className={secondaryButton}>
                Edit movie
              </button>
            ) : (
              <button type="button" onClick={() => void fetchFact()} className={secondaryButton}>
                Retry
              </button>
            )}
          </div>
        )}

        {factStatus !== "error" && (
          <button
            type="button"
            onClick={() => void fetchFact()}
            disabled={isSaving || factStatus === "loading"}
            className={`${primaryButton} mt-3`}
          >
            {factStatus === "loading" ? "Generating…" : "Generate another fact"}
          </button>
        )}
      </section>
    </div>
  );
}
