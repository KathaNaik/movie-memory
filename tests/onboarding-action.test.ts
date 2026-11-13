import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveFavoriteMovie } from "@/app/onboarding/actions";

import { expectRedirect } from "./helpers/navigation";

const { auth, updateMany } = vi.hoisted(() => ({ auth: vi.fn(), updateMany: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db: { user: { updateMany } } }));
vi.mock("next/navigation", async () => {
  const { mockRedirect } = await import("./helpers/navigation");
  return { redirect: vi.fn(mockRedirect) };
});

function formWith(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

beforeEach(() => {
  auth.mockReset();
  updateMany.mockReset();
});

describe("saveFavoriteMovie", () => {
  it("rejects unauthenticated submissions without touching the database", async () => {
    auth.mockResolvedValue(null);

    await expectRedirect(saveFavoriteMovie({}, formWith({ favoriteMovie: "Jaws" })), "/");

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a validation error and keeps the input for invalid titles", async () => {
    auth.mockResolvedValue({ user: { id: "user_1" } });

    const state = await saveFavoriteMovie({}, formWith({ favoriteMovie: " A " }));

    expect(state).toEqual({
      error: "Movie title must be at least 2 characters.",
      value: " A ",
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns a validation error when the field is missing", async () => {
    auth.mockResolvedValue({ user: { id: "user_1" } });

    const state = await saveFavoriteMovie({}, new FormData());

    expect(state.error).toBe("Please enter a movie title.");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("stores Unicode titles unchanged", async () => {
    auth.mockResolvedValue({ user: { id: "user_1" } });

    await expectRedirect(saveFavoriteMovie({}, formWith({ favoriteMovie: "千と千尋の神隠し" })), "/dashboard");

    expect(updateMany.mock.calls[0][0].data).toEqual({ favoriteMovie: "千と千尋の神隠し" });
  });

  it("saves the trimmed title for the session user, then goes to the dashboard", async () => {
    auth.mockResolvedValue({ user: { id: "user_1" } });

    await expectRedirect(
      // A forged userId field must be ignored in favor of the session.
      saveFavoriteMovie({}, formWith({ favoriteMovie: "  Spirited Away ", userId: "user_2" })),
      "/dashboard",
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user_1", favoriteMovie: null },
      data: { favoriteMovie: "Spirited Away" },
    });
  });
});
