import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MovieDashboard } from "@/app/dashboard/movie-dashboard";
import { ApiClientError } from "@/lib/api";
import type { FavoriteMovie, MovieFact } from "@/types/api";

const { getMovieFact, updateFavoriteMovie } = vi.hoisted(() => ({
  getMovieFact: vi.fn<() => Promise<MovieFact>>(),
  updateFavoriteMovie: vi.fn<(movie: string) => Promise<FavoriteMovie>>(),
}));
const { redirectToSignIn } = vi.hoisted(() => ({ redirectToSignIn: vi.fn() }));
vi.mock("@/lib/navigation", () => ({ redirectToSignIn }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getMovieFact,
  updateFavoriteMovie,
}));

const START = new Date("2026-11-13T10:00:00.000Z").getTime();
const USER = "user_1";

function fact(movieTitle: string, content: string): MovieFact {
  return {
    id: `${movieTitle}-${content}`,
    movieTitle,
    identifiedTitle: `${movieTitle} (1975)`,
    content,
    createdAt: new Date(START).toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const movieHeading = () => screen.getByRole("region", { name: "Favorite movie" });
const factRegion = () => screen.getByRole("region", { name: "Fun fact" });
const editButton = () => screen.getByRole("button", { name: "Edit favorite movie" });
const generateButton = () => screen.getByRole("button", { name: /Generat/ });

/** Lets pending promises (mocked API calls) settle and React re-render. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/** Renders with "Jaws" and lets the initial fact load. */
async function renderWithFact(content = "Jaws fact 1") {
  getMovieFact.mockResolvedValueOnce(fact("Jaws", content));
  render(<MovieDashboard userId={USER} initialMovie="Jaws" />);
  await screen.findByText(content);
}

function editAndSave(title: string) {
  fireEvent.click(editButton());
  fireEvent.change(screen.getByLabelText("New favorite movie"), { target: { value: title } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

beforeEach(() => {
  getMovieFact.mockReset();
  updateFavoriteMovie.mockReset();
  redirectToSignIn.mockReset();
  // The fact cache persists to sessionStorage; start every test empty.
  window.sessionStorage.clear();
  // Fake only the clock, so promises and Testing Library's polling stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initial load", () => {
  it("shows a loading state, then the current movie's fact", async () => {
    const pending = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(pending.promise);
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    expect(within(movieHeading()).getByText("Jaws")).toBeInTheDocument();
    expect(within(factRegion()).getByText("Finding a fun fact about Jaws…")).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    await act(async () => pending.resolve(fact("Jaws", "The shark was nicknamed Bruce.")));

    expect(screen.getByText("The shark was nicknamed Bruce.")).toBeInTheDocument();
    expect(generateButton()).toHaveTextContent("Generate another fact");
    expect(getMovieFact).toHaveBeenCalledTimes(1);
  });
});

describe("inline editing", () => {
  it("opens a prefilled, focused input when Edit is clicked", async () => {
    await renderWithFact();

    fireEvent.click(editButton());

    const input = screen.getByLabelText("New favorite movie");
    expect(input).toHaveValue("Jaws");
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel discards the draft without any request", async () => {
    await renderWithFact();

    fireEvent.click(editButton());
    fireEvent.change(screen.getByLabelText("New favorite movie"), { target: { value: "Alien" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("New favorite movie")).not.toBeInTheDocument();
    expect(within(movieHeading()).getByText("Jaws")).toBeInTheDocument();
    expect(updateFavoriteMovie).not.toHaveBeenCalled();
    expect(editButton()).toHaveFocus();
  });

  it("Escape also cancels", async () => {
    await renderWithFact();

    fireEvent.click(editButton());
    fireEvent.keyDown(screen.getByLabelText("New favorite movie"), { key: "Escape" });

    expect(screen.queryByLabelText("New favorite movie")).not.toBeInTheDocument();
    expect(updateFavoriteMovie).not.toHaveBeenCalled();
  });

  it("validates on the client before sending anything", async () => {
    await renderWithFact();

    editAndSave("  A ");

    expect(screen.getByRole("alert")).toHaveTextContent("Movie title must be at least 2 characters.");
    expect(screen.getByLabelText("New favorite movie")).toHaveAttribute("aria-invalid", "true");
    expect(updateFavoriteMovie).not.toHaveBeenCalled();
  });

  it("doesn't send a request when the title is unchanged", async () => {
    await renderWithFact();

    editAndSave("  Jaws  ");

    expect(updateFavoriteMovie).not.toHaveBeenCalled();
    expect(screen.getByText("Jaws fact 1")).toBeInTheDocument();
  });
});

describe("saving a new movie", () => {
  it("updates optimistically, then shows the confirmed movie and a fact for it", async () => {
    await renderWithFact();
    const save = deferred<FavoriteMovie>();
    updateFavoriteMovie.mockReturnValueOnce(save.promise);
    const newFact = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(newFact.promise);

    editAndSave("  Alien ");

    // Optimistic: new title shown at once, old fact hidden, no fact requests or duplicate saves.
    expect(updateFavoriteMovie).toHaveBeenCalledWith("Alien");
    expect(within(movieHeading()).getByText("Alien")).toBeInTheDocument();
    expect(within(movieHeading()).getByRole("status")).toHaveTextContent("Saving…");
    expect(screen.queryByText("Jaws fact 1")).not.toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    expect(editButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(editButton());
    expect(screen.queryByLabelText("New favorite movie")).not.toBeInTheDocument();

    await act(async () => save.resolve({ favoriteMovie: "Alien" }));

    // Confirmed: the cache was invalidated, so a fact for the new movie is requested.
    expect(within(movieHeading()).getByText("Alien")).toBeInTheDocument();
    expect(within(movieHeading()).queryByRole("status")).not.toBeInTheDocument();
    expect(getMovieFact).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Jaws fact 1")).not.toBeInTheDocument();

    await act(async () => newFact.resolve(fact("Alien", "The chestburster scene surprised the cast.")));

    expect(screen.getByText("The chestburster scene surprised the cast.")).toBeInTheDocument();
  });

  it("rolls back to the previous movie and its still-fresh fact when the save fails", async () => {
    await renderWithFact();
    updateFavoriteMovie.mockRejectedValueOnce(
      new ApiClientError(500, "INTERNAL_ERROR", "Something went wrong. Please try again."),
    );

    vi.setSystemTime(START + 10_000);
    editAndSave("Alien");
    await settle();

    expect(within(movieHeading()).getByText("Jaws")).toBeInTheDocument();
    expect(within(movieHeading()).queryByText("Alien")).not.toBeInTheDocument();
    expect(within(movieHeading()).getByRole("alert")).toHaveTextContent(
      "Couldn't change your movie to “Alien”. Something went wrong. Please try again.",
    );
    // Cache reused: Jaws' fact is under 30 seconds old, so no new request.
    expect(screen.getByText("Jaws fact 1")).toBeInTheDocument();
    expect(getMovieFact).toHaveBeenCalledTimes(1);
  });

  it("lets the user retry a failed save", async () => {
    await renderWithFact();
    updateFavoriteMovie
      .mockRejectedValueOnce(new ApiClientError(0, "NETWORK_ERROR", "Couldn't reach the server."))
      .mockResolvedValueOnce({ favoriteMovie: "Alien" });
    getMovieFact.mockResolvedValueOnce(fact("Alien", "Alien fact"));

    editAndSave("Alien");
    await settle();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));

    expect(updateFavoriteMovie).toHaveBeenNthCalledWith(2, "Alien");
    expect(within(movieHeading()).getByText("Alien")).toBeInTheDocument();
    expect(within(movieHeading()).queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByText("Alien fact")).toBeInTheDocument();
  });

  // What prevents the duplicate is structural: the first click closes the editor
  // (or clears the error alert), so the second click hits a removed button.
  // saveMovie's isSaving check and the disabled Try again button are backups.
  it("double-clicking Save (or Try again) sends only one request", async () => {
    await renderWithFact();
    const save = deferred<FavoriteMovie>();
    updateFavoriteMovie.mockReturnValueOnce(save.promise);

    fireEvent.click(editButton());
    fireEvent.change(screen.getByLabelText("New favorite movie"), { target: { value: "Alien" } });
    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    // Edit is blocked while saving, so the form can't be resubmitted either.
    fireEvent.click(editButton());

    expect(updateFavoriteMovie).toHaveBeenCalledTimes(1);

    // Same for the retry button after a failure.
    await act(async () => save.reject(new ApiClientError(500, "INTERNAL_ERROR", "Nope.")));
    const retry = deferred<FavoriteMovie>();
    updateFavoriteMovie.mockReturnValueOnce(retry.promise);
    const tryAgain = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(tryAgain);
    fireEvent.click(tryAgain);

    expect(updateFavoriteMovie).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve({ favoriteMovie: "Alien" }));
  });
});

describe("rollback edge cases", () => {
  it("ignores a fact request that was pending for the old movie when the save fails", async () => {
    const lateJawsFact = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(lateJawsFact.promise);
    updateFavoriteMovie.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "Nope."));
    const restoredFact = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(restoredFact.promise);
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    // Save fails while the first Jaws fact is still pending.
    editAndSave("Alien");
    await settle();

    // Restored to Jaws; nothing was cached, so a new request was made.
    expect(within(movieHeading()).getByText("Jaws")).toBeInTheDocument();
    expect(updateFavoriteMovie).toHaveBeenCalledTimes(1);
    expect(getMovieFact).toHaveBeenCalledTimes(2);

    // The pre-save response arrives late and is ignored.
    await act(async () => lateJawsFact.resolve(fact("Jaws", "Late fact")));
    expect(screen.queryByText("Late fact")).not.toBeInTheDocument();
    expect(within(factRegion()).getByText("Finding a fun fact about Jaws…")).toBeInTheDocument();

    await act(async () => restoredFact.resolve(fact("Jaws", "Current fact")));
    expect(screen.getByText("Current fact")).toBeInTheDocument();
    expect(within(movieHeading()).getByRole("alert")).toBeInTheDocument();
  });

  it("follows the server if a save that 'failed' was actually stored", async () => {
    await renderWithFact();
    // E.g. the response was lost or malformed after the database committed.
    updateFavoriteMovie.mockRejectedValueOnce(
      new ApiClientError(200, "INVALID_RESPONSE", "Unexpected response from the server."),
    );
    // The cached Jaws fact has expired, so a fact is requested: the server
    // answers for the movie it actually has.
    getMovieFact.mockResolvedValueOnce(fact("Alien", "Alien fact"));
    vi.setSystemTime(START + 30_000);

    editAndSave("Alien");
    await settle();

    expect(within(movieHeading()).getByText("Alien")).toBeInTheDocument();
    expect(screen.getByText("Alien fact")).toBeInTheDocument();
    expect(within(movieHeading()).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("fact cache", () => {
  it("fetches a new fact after rollback when the cached one is 30 seconds old", async () => {
    await renderWithFact();
    updateFavoriteMovie.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "Nope."));
    getMovieFact.mockResolvedValueOnce(fact("Jaws", "Jaws fact 2"));

    vi.setSystemTime(START + 30_000);
    editAndSave("Alien");
    await settle();

    expect(getMovieFact).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Jaws fact 2")).toBeInTheDocument();
  });

  it("'Generate another fact' bypasses a fresh cache and replaces the fact", async () => {
    await renderWithFact();
    const next = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(next.promise);

    vi.setSystemTime(START + 1_000);
    fireEvent.click(generateButton());

    expect(getMovieFact).toHaveBeenCalledTimes(2);
    // Duplicate generation is blocked while pending.
    expect(generateButton()).toBeDisabled();
    expect(generateButton()).toHaveTextContent("Generating…");

    await act(async () => next.resolve(fact("Jaws", "Jaws fact 2")));

    expect(screen.getByText("Jaws fact 2")).toBeInTheDocument();
    expect(screen.queryByText("Jaws fact 1")).not.toBeInTheDocument();

    // The refreshed fact is what's cached now: a rollback 20s later reuses it.
    updateFavoriteMovie.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "Nope."));
    vi.setSystemTime(START + 21_000);
    editAndSave("Alien");
    await settle();
    expect(screen.getByText("Jaws fact 2")).toBeInTheDocument();
    expect(getMovieFact).toHaveBeenCalledTimes(2);
  });
});

describe("stale responses", () => {
  it("a late fact for the old movie can't overwrite the new movie's state", async () => {
    const jawsFact = deferred<MovieFact>();
    const alienFact = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(jawsFact.promise).mockReturnValueOnce(alienFact.promise);
    updateFavoriteMovie.mockResolvedValueOnce({ favoriteMovie: "Alien" });
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    // Change the movie while the Jaws fact is still pending.
    editAndSave("Alien");
    await settle();
    expect(getMovieFact).toHaveBeenCalledTimes(2);

    // The old request finishes late: ignored, and Alien is still loading.
    await act(async () => jawsFact.resolve(fact("Jaws", "Late Jaws fact")));
    expect(screen.queryByText("Late Jaws fact")).not.toBeInTheDocument();
    expect(within(factRegion()).getByText("Finding a fun fact about Alien…")).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    await act(async () => alienFact.resolve(fact("Alien", "Alien fact")));
    expect(screen.getByText("Alien fact")).toBeInTheDocument();
    expect(screen.queryByText("Late Jaws fact")).not.toBeInTheDocument();
  });

  it("a late error for the old movie isn't shown", async () => {
    const jawsFact = deferred<MovieFact>();
    getMovieFact.mockReturnValueOnce(jawsFact.promise).mockResolvedValueOnce(fact("Alien", "Alien fact"));
    updateFavoriteMovie.mockResolvedValueOnce({ favoriteMovie: "Alien" });
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    editAndSave("Alien");
    await settle();
    await screen.findByText("Alien fact");
    await act(async () => jawsFact.reject(new ApiClientError(502, "FACT_GENERATION_FAILED", "Old failure")));

    expect(screen.queryByText("Old failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText("Alien fact")).toBeInTheDocument();
  });
});

describe("cache persistence across reloads", () => {
  const storedFor = (userId: string) => window.sessionStorage.getItem(`movie-memory:fact:${userId}`);

  /** Simulates a reload: unmount and mount a fresh dashboard. */
  async function reload(userId = USER, movie = "Jaws") {
    cleanup();
    render(<MovieDashboard userId={userId} initialMovie={movie} />);
    await settle();
  }

  it("reuses the fact after a reload within 30 seconds, without a new request", async () => {
    await renderWithFact("Jaws fact 1");

    vi.setSystemTime(START + 29_999);
    await reload();

    expect(screen.getByText("Jaws fact 1")).toBeInTheDocument();
    expect(getMovieFact).toHaveBeenCalledTimes(1);
  });

  it("fetches a new fact after a reload once the cached one is 30 seconds old", async () => {
    await renderWithFact("Jaws fact 1");
    getMovieFact.mockResolvedValueOnce(fact("Jaws", "Jaws fact 2"));

    vi.setSystemTime(START + 30_000);
    await reload();

    expect(getMovieFact).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Jaws fact 2")).toBeInTheDocument();
    expect(JSON.parse(storedFor(USER)!).content).toBe("Jaws fact 2");
  });

  it("doesn't reuse a cached fact for a different movie (e.g. changed in another tab)", async () => {
    await renderWithFact("Jaws fact 1");
    getMovieFact.mockResolvedValueOnce(fact("Alien", "Alien fact"));

    await reload(USER, "Alien");

    expect(getMovieFact).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Jaws fact 1")).not.toBeInTheDocument();
  });

  it("never shows one user's cached fact to another user, and drops it", async () => {
    await renderWithFact("Alice's Jaws fact");
    getMovieFact.mockResolvedValueOnce(fact("Jaws", "Bob's Jaws fact"));

    // Alice signs out, Bob signs in to the same tab (same movie, within 30s).
    await reload("user_2", "Jaws");

    expect(screen.queryByText("Alice's Jaws fact")).not.toBeInTheDocument();
    expect(screen.getByText("Bob's Jaws fact")).toBeInTheDocument();
    expect(storedFor(USER)).toBeNull();
  });

  it("stores the new movie's fact after a successful change and never caches errors", async () => {
    await renderWithFact("Jaws fact 1");
    updateFavoriteMovie.mockResolvedValueOnce({ favoriteMovie: "Alien" });
    getMovieFact.mockRejectedValueOnce(new ApiClientError(502, "FACT_GENERATION_FAILED", "Nope."));

    editAndSave("Alien");
    await settle();

    // Old movie's fact invalidated; the failed request left nothing behind.
    expect(storedFor(USER)).toBeNull();
  });

  it("ignores corrupt stored data", async () => {
    window.sessionStorage.setItem(`movie-memory:fact:${USER}`, "{not json");
    getMovieFact.mockResolvedValueOnce(fact("Jaws", "Fresh fact"));

    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    expect(await screen.findByText("Fresh fact")).toBeInTheDocument();
  });

  it("still works when sessionStorage is blocked", async () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    try {
      await renderWithFact("Jaws fact 1");
      vi.setSystemTime(START + 1_000);
      await reload();

      // Falls back to in-memory storage for this page session.
      expect(screen.getByText("Jaws fact 1")).toBeInTheDocument();
      expect(getMovieFact).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("fact display", () => {
  it("shows which film the AI identified and that the fact is AI-generated", async () => {
    getMovieFact.mockResolvedValueOnce({
      ...fact("Barbie charm school", "A fact."),
      identifiedTitle: "Barbie: Princess Charm School (2011)",
    });
    render(<MovieDashboard userId={USER} initialMovie="Barbie charm school" />);

    await screen.findByText("A fact.");
    expect(within(factRegion()).getByText("Barbie: Princess Charm School (2011)")).toBeInTheDocument();
    expect(within(factRegion()).getByText(/AI-generated, may contain mistakes/)).toBeInTheDocument();
  });

  it("still labels older facts that have no identified title", async () => {
    getMovieFact.mockResolvedValueOnce({ ...fact("Jaws", "Old fact."), identifiedTitle: null });
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    await screen.findByText("Old fact.");
    expect(within(factRegion()).queryByText(/About/)).not.toBeInTheDocument();
    expect(within(factRegion()).getByText(/AI-generated/)).toBeInTheDocument();
  });
});

describe("expired session", () => {
  const expired = () => new ApiClientError(401, "UNAUTHENTICATED", "You need to sign in to do that.");

  it("redirects to sign-in when loading a fact returns 401", async () => {
    getMovieFact.mockRejectedValueOnce(expired());
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);
    await settle();

    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
    expect(within(factRegion()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("redirects to sign-in when saving the movie returns 401", async () => {
    await renderWithFact();
    updateFavoriteMovie.mockRejectedValueOnce(expired());

    editAndSave("Alien");
    await settle();

    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
    expect(getMovieFact).toHaveBeenCalledTimes(1);
  });

  it("doesn't redirect for other errors", async () => {
    getMovieFact.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL_ERROR", "Oops."));
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    await within(factRegion()).findByRole("alert");
    expect(redirectToSignIn).not.toHaveBeenCalled();
  });
});

describe("fact errors", () => {
  it("shows a friendly error with Retry, no fallback fact, and doesn't cache the error", async () => {
    getMovieFact
      .mockRejectedValueOnce(
        new ApiClientError(
          502,
          "FACT_GENERATION_FAILED",
          "We couldn't come up with a fact right now. Please try again in a moment.",
        ),
      )
      .mockResolvedValueOnce(fact("Jaws", "Jaws fact after retry"));
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    const alert = await within(factRegion()).findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't come up with a fact right now.");
    expect(within(factRegion()).queryByText(/Jaws fact/)).not.toBeInTheDocument();

    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: "Retry" })));

    expect(getMovieFact).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Jaws fact after retry")).toBeInTheDocument();
    expect(within(factRegion()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Edit instead of Retry when the movie isn't recognized", async () => {
    getMovieFact.mockRejectedValueOnce(
      new ApiClientError(
        422,
        "MOVIE_NOT_RECOGNIZED",
        "We couldn't tell which movie that is. Try editing it to the full title.",
      ),
    );
    render(<MovieDashboard userId={USER} initialMovie="Zorblax" />);

    const alert = await within(factRegion()).findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't tell which movie that is.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Edit movie" }));

    expect(screen.getByLabelText("New favorite movie")).toHaveValue("Zorblax");
    expect(getMovieFact).toHaveBeenCalledTimes(1);
  });

  it("uses a generic message for unexpected errors", async () => {
    getMovieFact.mockRejectedValueOnce(new Error("boom"));
    render(<MovieDashboard userId={USER} initialMovie="Jaws" />);

    expect(await within(factRegion()).findByRole("alert")).toHaveTextContent(
      "We couldn't load a fact. Please try again.",
    );
  });
});
