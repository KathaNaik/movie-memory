// Wire format shared by the API routes and the client in src/lib/api.ts.

export type ApiError = {
  code: string;
  message: string;
};

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: ApiError };

// Error codes the server sends.
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "MOVIE_NOT_SET"
  | "MOVIE_NOT_RECOGNIZED"
  | "FACT_GENERATION_FAILED"
  | "FACT_GENERATION_BUSY"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

// GET /api/me
export type Me = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  favoriteMovie: string | null;
};

// PUT /api/me/movie
export type UpdateFavoriteMovieRequest = { movie: string };
export type FavoriteMovie = { favoriteMovie: string };

// GET /api/fact
export type MovieFact = {
  id: string;
  content: string;
  movieTitle: string;
  // The film the AI identified from movieTitle; null for older facts.
  identifiedTitle: string | null;
  createdAt: string; // ISO 8601
};
