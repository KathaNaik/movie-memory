// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "@/app/api/me/movie/route";

const { getCurrentUser, update } = vi.hoisted(() => ({ getCurrentUser: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser }));
vi.mock("@/lib/db", () => ({ db: { user: { update } } }));

const signedInUser = {
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  image: null,
  favoriteMovie: "Jaws",
};

function put(body: string, contentType = "application/json") {
  return PUT(
    new Request("http://localhost/api/me/movie", {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    }),
  );
}

beforeEach(() => {
  getCurrentUser.mockReset();
  update.mockReset();
  getCurrentUser.mockResolvedValue(signedInUser);
});

describe("PUT /api/me/movie", () => {
  it("returns 401 when signed out and doesn't touch the database", async () => {
    getCurrentUser.mockResolvedValue(null);

    const response = await put(JSON.stringify({ movie: "Alien" }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    [{ movie: "A" }, "Movie title must be at least 2 characters."],
    [{ movie: "   " }, "Movie title must be at least 2 characters."],
    [{ movie: "x".repeat(101) }, "Movie title must be at most 100 characters."],
    [{ movie: 42 }, "Please enter a movie title."],
    [{}, "Please enter a movie title."],
    [null, "Please enter a movie title."],
  ])("rejects invalid input %j with 400", async (body, message) => {
    const response = await put(JSON.stringify(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "INVALID_INPUT", message },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await put("{not json");

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });

  it("rejects non-JSON content types with 415", async () => {
    const response = await put("movie=Alien", "application/x-www-form-urlencoded");

    expect(response.status).toBe(415);
    expect(update).not.toHaveBeenCalled();
  });

  it("updates only the session user's record, ignoring a userId in the body", async () => {
    update.mockResolvedValue({ favoriteMovie: "Alien" });

    const response = await put(JSON.stringify({ movie: "  Alien ", userId: "user_2" }));

    expect(update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: { favoriteMovie: "Alien" },
      select: { favoriteMovie: true },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { favoriteMovie: "Alien" } });
  });

  it("returns a generic 500 when the update fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    update.mockRejectedValue(new Error("P1001: Can't reach database server at db.internal"));

    const response = await put(JSON.stringify({ movie: "Alien" }));

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("db.internal");
  });
});
