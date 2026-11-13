import { redirect } from "next/navigation";

import { CinemaBackdrop } from "@/components/cinema-backdrop";
import { getCurrentUser } from "@/lib/current-user";
import { homePathFor } from "@/lib/routing";

import { OnboardingForm } from "./onboarding-form";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  const home = homePathFor(user);
  // Signed-out users go to "/", already-onboarded users to "/dashboard".
  if (home !== "/onboarding") redirect(home);

  return (
    <CinemaBackdrop>
      <h1 className="text-2xl font-semibold tracking-tight xl:text-3xl">Welcome to Movie Memory</h1>
      <OnboardingForm />
    </CinemaBackdrop>
  );
}
