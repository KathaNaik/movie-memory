import { redirect } from "next/navigation";

import { CinemaBackdrop } from "@/components/cinema-backdrop";
import { SignInButton } from "@/components/sign-in-button";
import { getCurrentUser } from "@/lib/current-user";
import { homePathFor } from "@/lib/routing";

// Auth.js redirects here with ?error=<code> (pages.error), and the dashboard
// uses SessionExpired. Unknown codes get the generic message; the raw value is
// never displayed.
const SIGN_IN_MESSAGES: Record<string, string> = {
  SessionExpired: "Your session has expired. Please sign in again.",
  AccessDenied: "Sign-in wasn't allowed. Please try again with a different Google account.",
};
const DEFAULT_SIGN_IN_MESSAGE =
  "Sign-in didn't complete. If you cancelled, no problem. You can try again.";

export default async function Home({ searchParams }: PageProps<"/">) {
  const user = await getCurrentUser();
  if (user) redirect(homePathFor(user));

  const { error } = await searchParams;
  const errorCode = typeof error === "string" ? error : undefined;
  const message = errorCode ? (SIGN_IN_MESSAGES[errorCode] ?? DEFAULT_SIGN_IN_MESSAGE) : null;

  return (
    <CinemaBackdrop>
      <div className="flex flex-col items-center gap-5 text-center">
        <h1 className="text-4xl font-semibold tracking-tight xl:text-5xl">Movie Memory</h1>
        <p className="max-w-md text-lg text-zinc-600">
          Save your favorite movie and discover fun facts about it.
        </p>
        {message && (
          <p role="alert" className="max-w-md rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            {message}
          </p>
        )}
        <SignInButton />
      </div>
    </CinemaBackdrop>
  );
}
