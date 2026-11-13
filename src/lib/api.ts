// Browser-side client for the Movie Memory API. Every response is validated at
// runtime, so the returned values really have the types they claim.

import { z } from "zod";

import type { FavoriteMovie, Me, MovieFact, UpdateFavoriteMovieRequest } from "@/types/api";

export type ApiClientErrorCode =
  // Server-sent codes (see ApiErrorCode), passed through as-is.
  | (string & {})
  // Client-side failures.
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INVALID_RESPONSE";

// Upper bounds so a loading state can never hang. /api/fact can legitimately
// take up to ~70s (waiting for another tab's generation, then its own), though
// it usually takes ~3s.
const DEFAULT_TIMEOUT_MS = 15_000;
const FACT_TIMEOUT_MS = 80_000;

/**
 * Every failure (HTTP error, network error, or unexpected body) becomes one of
 * these. `status` is the HTTP status, or 0 when no response was received.
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const meSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  favoriteMovie: z.string().nullable(),
}) satisfies z.ZodType<Me>;

const favoriteMovieSchema = z.object({
  favoriteMovie: z.string(),
}) satisfies z.ZodType<FavoriteMovie>;

const movieFactSchema = z.object({
  id: z.string(),
  content: z.string(),
  movieTitle: z.string(),
  identifiedTitle: z.string().nullable(),
  createdAt: z.iso.datetime(),
}) satisfies z.ZodType<MovieFact>;

const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const successEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
});

// Used when an error response has no usable body (e.g. a proxy's HTML page).
function fallbackError(status: number): ApiClientError {
  if (status === 400) return new ApiClientError(status, "INVALID_INPUT", "The request was invalid.");
  if (status === 403) {
    return new ApiClientError(status, "FORBIDDEN", "You don't have permission to do that.");
  }
  if (status === 401) {
    return new ApiClientError(status, "UNAUTHENTICATED", "Your session has expired. Please sign in again.");
  }
  if (status >= 500) {
    return new ApiClientError(status, "INTERNAL_ERROR", "The server ran into a problem. Please try again.");
  }
  return new ApiClientError(status, "INVALID_RESPONSE", "Unexpected response from the server.");
}

async function request<T>(
  path: string,
  dataSchema: z.ZodType<T>,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      // Never serve API data from the HTTP cache; caching is done deliberately in app code.
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      // The server may still finish the request (e.g. save the movie); callers
      // treat this like any other failure and the next read reconciles.
      throw new ApiClientError(0, "TIMEOUT", "The server took too long to respond. Please try again.");
    }
    throw new ApiClientError(0, "NETWORK_ERROR", "Couldn't reach the server. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiClientError(0, "TIMEOUT", "The server took too long to respond. Please try again.");
    }
    // Not JSON (empty body, HTML error page, truncated response...).
    if (!response.ok) throw fallbackError(response.status);
    throw new ApiClientError(response.status, "INVALID_RESPONSE", "Unexpected response from the server.");
  }

  const errorEnvelope = errorEnvelopeSchema.safeParse(body);
  if (errorEnvelope.success) {
    const { code, message } = errorEnvelope.data.error;
    throw new ApiClientError(response.status, code, message);
  }
  if (!response.ok) throw fallbackError(response.status);

  const envelope = successEnvelopeSchema.safeParse(body);
  const data = envelope.success ? dataSchema.safeParse(envelope.data.data) : undefined;
  if (!data?.success) {
    throw new ApiClientError(response.status, "INVALID_RESPONSE", "Unexpected response from the server.");
  }
  return data.data;
}

export function getMe(): Promise<Me> {
  return request("/api/me", meSchema);
}

export function updateFavoriteMovie(movie: string): Promise<FavoriteMovie> {
  const body: UpdateFavoriteMovieRequest = { movie };
  return request("/api/me/movie", favoriteMovieSchema, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getMovieFact(): Promise<MovieFact> {
  return request("/api/fact", movieFactSchema, undefined, FACT_TIMEOUT_MS);
}
