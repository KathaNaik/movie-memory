// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/me/route";

const { getCurrentUser } = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser }));

beforeEach(() => {
  getCurrentUser.mockReset();
});

describe("GET /api/me", () => {
  it("returns 401 when signed out", async () => {
    getCurrentUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "You need to sign in to do that." },
    });
  });

  it("returns only the safe profile fields", async () => {
    getCurrentUser.mockResolvedValue({
      id: "user_1",
      name: "Ada",
      email: "ada@example.com",
      image: null,
      favoriteMovie: "Jaws",
      // Anything extra must not leak through.
      sessions: [{ sessionToken: "secret" }],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { id: "user_1", name: "Ada", email: "ada@example.com", image: null, favoriteMovie: "Jaws" },
    });
  });

  it("returns a generic 500 when the lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    getCurrentUser.mockRejectedValue(new Error("connect ECONNREFUSED db.internal:5432"));

    const response = await GET();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("ECONNREFUSED");
  });
});
