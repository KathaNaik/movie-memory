import {
  apiError,
  apiSuccess,
  internalError,
  logServerError,
  unauthenticated,
} from "@/lib/api-response";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { parseMovieTitle } from "@/lib/validation/movie";
import type { FavoriteMovie } from "@/types/api";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return unauthenticated();

    // Requiring JSON means a cross-site HTML form can't submit here.
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return apiError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
    }

    // Only `movie` is read; any userId or other field in the body is ignored.
    const movie = typeof body === "object" && body !== null && "movie" in body ? body.movie : undefined;
    const result = parseMovieTitle(movie);
    if (!result.success) {
      return apiError("INVALID_INPUT", result.error, 400);
    }

    const updated = await db.user.update({
      where: { id: user.id },
      data: { favoriteMovie: result.movieTitle },
      select: { favoriteMovie: true },
    });

    // The update just set it, so it's a string.
    const data: FavoriteMovie = { favoriteMovie: updated.favoriteMovie ?? result.movieTitle };
    return apiSuccess(data);
  } catch (error) {
    logServerError("PUT /api/me/movie", error);
    return internalError();
  }
}
