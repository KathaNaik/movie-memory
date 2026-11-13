import type { ApiErrorCode, ApiResponse } from "@/types/api";

// API responses are per-user and, for facts, freshly generated: never let a
// browser or intermediary cache them.
const NO_STORE = { "Cache-Control": "no-store" };

export function apiSuccess<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return Response.json(body, { status, headers: NO_STORE });
}

export function apiError(code: ApiErrorCode, message: string, status: number): Response {
  const body: ApiResponse<never> = { success: false, error: { code, message } };
  return Response.json(body, { status, headers: NO_STORE });
}

export const unauthenticated = () =>
  apiError("UNAUTHENTICATED", "You need to sign in to do that.", 401);

export const internalError = () =>
  apiError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500);

/**
 * Logs an unexpected server error without its message or payload, which can
 * contain user data or connection details. Name and code are enough to triage.
 */
export function logServerError(context: string, error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const status =
    typeof error === "object" && error !== null && "status" in error ? String(error.status) : "";
  console.error(`[${context}]`, name, code, status);
}
