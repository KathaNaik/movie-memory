import { redirect } from "next/navigation";

import { Avatar } from "@/components/avatar";
import { CinemaBackdrop } from "@/components/cinema-backdrop";
import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentUser } from "@/lib/current-user";
import { homePathFor } from "@/lib/routing";

import { MovieDashboard } from "./movie-dashboard";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  // Signed-out users go to "/" (sign-in), not-yet-onboarded users to onboarding.
  if (!user || homePathFor(user) !== "/dashboard") redirect(homePathFor(user));

  const displayName = user.name?.trim() || user.email;

  return (
    <div className="flex flex-1 flex-col">
      {/* Same lavender as the artwork's background, with a fine black rule. */}
      <header className="border-b border-black bg-[#f4edf9] text-black">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <p className="text-xl font-semibold tracking-tight">Movie Memory</p>

          <div className="flex min-w-0 items-center gap-3">
            <Avatar src={user.image} name={displayName} />
            <div className="min-w-0">
              <p className="max-w-40 truncate text-sm font-medium sm:max-w-64">{displayName}</p>
              <p className="hidden max-w-64 truncate text-xs sm:block">{user.email}</p>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>

      <CinemaBackdrop>
        <h1 className="sr-only">Your dashboard</h1>
        {/* The page already confirmed favoriteMovie is set (or redirected). */}
        <MovieDashboard userId={user.id} initialMovie={user.favoriteMovie ?? ""} />
      </CinemaBackdrop>
    </div>
  );
}
