// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseUnavailableError, getCurrentUser } from "@/lib/current-user";

const { auth, cookieNames, queryRaw, findUnique } = vi.hoisted(() => ({
  auth: vi.fn(),
  cookieNames: new Set<string>(),
  queryRaw: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/headers", () => ({ cookies: async () => ({ has: (name: string) => cookieNames.has(name) }) }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: queryRaw, user: { findUnique } } }));

beforeEach(() => {
  vi.clearAllMocks();
  cookieNames.clear();
  queryRaw.mockResolvedValue([{ "?column?": 1 }]);
});

describe("getCurrentUser", () => {
  it("loads the session user's profile from the database", async () => {
    auth.mockResolvedValue({ user: { id: "user_1" } });
    findUnique.mockResolvedValue({ id: "user_1", favoriteMovie: "Jaws" });

    await expect(getCurrentUser()).resolves.toMatchObject({ id: "user_1" });
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: "user_1" });
  });

  it("returns null for a visitor without a session cookie, without touching the database", async () => {
    auth.mockResolvedValue(null);

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("returns null for a stale session cookie when the database is fine", async () => {
    auth.mockResolvedValue(null);
    cookieNames.add("authjs.session-token");

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each(["authjs.session-token", "__Secure-authjs.session-token"])(
    "throws DatabaseUnavailableError instead of 'signed out' when the database is down (%s)",
    async (cookie) => {
      // Auth.js swallows the database error and reports no session.
      auth.mockResolvedValue(null);
      cookieNames.add(cookie);
      queryRaw.mockRejectedValue(new Error("Can't reach database server"));

      await expect(getCurrentUser()).rejects.toBeInstanceOf(DatabaseUnavailableError);
    },
  );
});
