import { z } from "zod";

export const MOVIE_TITLE_MIN = 2;
export const MOVIE_TITLE_MAX = 100;

export const movieTitleSchema = z
  .string({ error: "Please enter a movie title." })
  .trim()
  .min(MOVIE_TITLE_MIN, `Movie title must be at least ${MOVIE_TITLE_MIN} characters.`)
  .max(MOVIE_TITLE_MAX, `Movie title must be at most ${MOVIE_TITLE_MAX} characters.`);

export type MovieTitleResult =
  | { success: true; movieTitle: string }
  | { success: false; error: string };

/**
 * Validates untrusted input (form field or JSON body) as a movie title.
 * Shared by onboarding and the future PUT /api/me/movie endpoint.
 */
export function parseMovieTitle(input: unknown): MovieTitleResult {
  const result = movieTitleSchema.safeParse(input);
  if (!result.success) {
    return { success: false, error: result.error.issues[0].message };
  }
  return { success: true, movieTitle: result.data };
}
