"use client";

import { CinemaBackdrop } from "@/components/cinema-backdrop";

// Shown when a page fails to render, e.g. the database is unreachable. Next.js
// hides error details in production, so the message stays generic. retry()
// re-fetches the page from the server (reset() would only re-render).
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <CinemaBackdrop>
      <div role="alert" className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="max-w-md text-zinc-600">
          We&apos;re having trouble loading Movie Memory right now. Your data is safe. Please try
          again in a moment.
        </p>
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-full bg-accent px-6 py-3 text-base font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Try again
        </button>
      </div>
    </CinemaBackdrop>
  );
}
