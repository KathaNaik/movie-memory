// Client-side fact cache (Variant B): one entry per signed-in user, kept in
// sessionStorage so it survives remounts and page reloads within a tab, but
// isn't shared across tabs or kept after the tab closes.

import { z } from "zod";

export const FACT_CACHE_TTL_MS = 30_000;

const cachedFactSchema = z.object({
  id: z.string(),
  movieTitle: z.string(),
  // The film the AI identified, shown with the fact.
  identifiedTitle: z.string().nullable(),
  content: z.string(),
  // Client clock time of the successful fetch, in ms.
  fetchedAt: z.number(),
});

export type CachedFact = z.infer<typeof cachedFactSchema>;

/**
 * True when `cache` holds a fact for `movieTitle` fetched less than 30 seconds
 * ago. A fact for any other movie is never fresh, which is what invalidates the
 * cache when the favorite movie changes.
 */
export function isFreshFactFor(
  cache: CachedFact | null,
  movieTitle: string,
  now: number,
): cache is CachedFact {
  return cache !== null && cache.movieTitle === movieTitle && now - cache.fetchedAt < FACT_CACHE_TTL_MS;
}

const KEY_PREFIX = "movie-memory:fact:";
// Used when sessionStorage is unavailable (blocked, private mode, quota).
const memoryFallback = new Map<string, string>();

function storageKey(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

/** The cached fact for this user, or null. Corrupt or foreign data is ignored. */
export function readCachedFact(userId: string): CachedFact | null {
  let raw: string | null | undefined;
  try {
    raw = window.sessionStorage.getItem(storageKey(userId));
  } catch {
    raw = memoryFallback.get(storageKey(userId));
  }
  if (!raw) return null;
  try {
    const parsed = cachedFactSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Stores (or with null, clears) this user's cached fact. */
export function writeCachedFact(userId: string, fact: CachedFact | null) {
  const key = storageKey(userId);
  try {
    if (fact) window.sessionStorage.setItem(key, JSON.stringify(fact));
    else window.sessionStorage.removeItem(key);
  } catch {
    if (fact) memoryFallback.set(key, JSON.stringify(fact));
    else memoryFallback.delete(key);
  }
}

/**
 * Drops cached facts belonging to any other user, e.g. someone who signed out
 * of this tab before `userId` signed in. (Keys are per-user, so they're never
 * read across accounts anyway; this is housekeeping.)
 */
export function forgetOtherUsers(userId: string) {
  const keep = storageKey(userId);
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(KEY_PREFIX) && key !== keep) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable: nothing persisted to clean up.
  }
  for (const key of [...memoryFallback.keys()]) {
    if (key !== keep) memoryFallback.delete(key);
  }
}
