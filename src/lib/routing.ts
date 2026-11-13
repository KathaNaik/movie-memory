/**
 * Where a visitor belongs, based only on server-side state. Every page uses
 * this one mapping, so each state has exactly one home and pages can't bounce
 * a user back and forth.
 */
export function homePathFor(
  user: { favoriteMovie: string | null } | null,
): "/" | "/onboarding" | "/dashboard" {
  if (!user) return "/";
  return user.favoriteMovie ? "/dashboard" : "/onboarding";
}
