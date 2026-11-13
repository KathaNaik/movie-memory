import { apiSuccess, internalError, logServerError, unauthenticated } from "@/lib/api-response";
import { getCurrentUser } from "@/lib/current-user";
import type { Me } from "@/types/api";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return unauthenticated();

    // Explicit allow-list so new User columns are never exposed by accident.
    const me: Me = {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      favoriteMovie: user.favoriteMovie,
    };
    return apiSuccess(me);
  } catch (error) {
    logServerError("GET /api/me", error);
    return internalError();
  }
}
