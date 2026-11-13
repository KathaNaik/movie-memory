"use server";

import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { parseMovieTitle } from "@/lib/validation/movie";

export type OnboardingState = {
  error?: string;
  // Echoed back so the input keeps what the user typed after an error.
  value?: string;
};

export async function saveFavoriteMovie(
  _prevState: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  // Server Actions are public endpoints: authenticate on every call and take
  // the user id from the session, never from the form.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/");

  const raw = formData.get("favoriteMovie");
  const result = parseMovieTitle(raw);
  if (!result.success) {
    return { error: result.error, value: typeof raw === "string" ? raw : "" };
  }

  // Only set the movie if it isn't set yet: onboarding must not double as a
  // way to edit the movie (that's the future PUT /api/me/movie endpoint).
  await db.user.updateMany({
    where: { id: userId, favoriteMovie: null },
    data: { favoriteMovie: result.movieTitle },
  });

  redirect("/dashboard");
}
