"use client";

import { useActionState } from "react";

import { saveFavoriteMovie, type OnboardingState } from "./actions";

const initialState: OnboardingState = {};

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(saveFavoriteMovie, initialState);

  return (
    <form action={formAction} noValidate className="flex w-full flex-col gap-2">
      <label htmlFor="favoriteMovie" className="text-lg font-medium">
        What is your favorite movie?
      </label>
      <input
        id="favoriteMovie"
        name="favoriteMovie"
        type="text"
        autoComplete="off"
        placeholder="e.g. Spirited Away"
        defaultValue={state.value}
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? "favoriteMovie-error" : undefined}
        className="rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 aria-invalid:border-red-600"
      />
      {state.error && (
        <p id="favoriteMovie-error" role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-full bg-accent px-6 py-2.5 text-base font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
