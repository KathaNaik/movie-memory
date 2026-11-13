import {
  apiError,
  apiSuccess,
  internalError,
  logServerError,
  unauthenticated,
} from "@/lib/api-response";
import { getCurrentUser } from "@/lib/current-user";
import {
  FactGenerationBusyError,
  FactGenerationFailedError,
  FactRateLimitedError,
  generateAndStoreFact,
} from "@/lib/fact-generation";
import { MovieNotRecognizedError } from "@/lib/openai";
import type { MovieFact } from "@/types/api";

export const runtime = "nodejs";
// Every request must generate a new fact; caching is the client's job (Variant B).
export const dynamic = "force-dynamic";

export async function GET() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (error) {
    logServerError("GET /api/fact (user lookup)", error);
    return internalError();
  }
  if (!user) return unauthenticated();

  // Captured once so the fact is stored against the movie it was generated
  // for, even if the user changes their favorite mid-request.
  const movieTitle = user.favoriteMovie;
  if (!movieTitle) {
    return apiError("MOVIE_NOT_SET", "Set your favorite movie before asking for a fact.", 409);
  }

  try {
    // Identity comes only from the session; the request itself is never read.
    const fact = await generateAndStoreFact(user.id, movieTitle);
    const data: MovieFact = { ...fact, createdAt: fact.createdAt.toISOString() };
    return apiSuccess(data);
  } catch (error) {
    if (error instanceof FactGenerationFailedError) {
      if (error.reason instanceof MovieNotRecognizedError) {
        // Expected outcome, not a server fault: nothing is stored.
        return apiError(
          "MOVIE_NOT_RECOGNIZED",
          "We couldn't tell which movie that is. Try editing it to the full title.",
          422,
        );
      }
      logServerError("GET /api/fact (OpenAI)", error.reason);
      return apiError(
        "FACT_GENERATION_FAILED",
        "We couldn't come up with a fact right now. Please try again in a moment.",
        502,
      );
    }
    if (error instanceof FactRateLimitedError) {
      return apiError(
        "RATE_LIMITED",
        "You've generated a lot of facts in the last minute. Please wait a moment and try again.",
        429,
      );
    }
    if (error instanceof FactGenerationBusyError) {
      return apiError(
        "FACT_GENERATION_BUSY",
        "Another fact for this movie is still being generated. Please try again in a moment.",
        503,
      );
    }
    logServerError("GET /api/fact (database)", error);
    return internalError();
  }
}
