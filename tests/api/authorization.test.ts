// @vitest-environment node
//
// Authorization: a signed-in user can only ever read or change their own data.
// The endpoints run against an in-memory database holding two users' records,
// with the real getCurrentUser(); only the Auth.js session is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getFact } from "@/app/api/fact/route";
import { GET as getMe } from "@/app/api/me/route";
import { PUT as putMovie } from "@/app/api/me/movie/route";

type User = { id: string; name: string; email: string; image: null; favoriteMovie: string | null };
type Fact = { id: string; userId: string; movieTitle: string; content: string; createdAt: Date };

const { auth, store, generateMovieFact } = vi.hoisted(() => ({
  auth: vi.fn(),
  store: { users: new Map<string, User>(), facts: [] as Fact[] },
  generateMovieFact: vi.fn(),
}));

function pick<T extends object>(row: T, select?: Partial<Record<keyof T, boolean>>) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof T]]));
}

vi.mock("@/auth", () => ({ auth }));
// No session cookie: a missing session means "signed out", not "database down".
vi.mock("next/headers", () => ({ cookies: async () => ({ has: () => false }) }));
vi.mock("@/lib/openai", () => ({ generateMovieFact, MovieNotRecognizedError: class extends Error {} }));
vi.mock("@/lib/db", () => {
  const movieFact = {
    findMany: vi.fn(async ({ where, take, select }) =>
      store.facts
        // Like Prisma: only the fields present in `where` filter.
        .filter((f) => Object.entries(where).every(([key, value]) => f[key as keyof Fact] === value))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map((f) => pick(f, select)),
    ),
    count: vi.fn(async ({ where }) => store.facts.filter((f) => f.userId === where.userId).length),
    create: vi.fn(async ({ data, select }) => {
      const fact = { id: `fact_${store.facts.length + 1}`, createdAt: new Date(), ...data };
      store.facts.push(fact);
      return pick(fact, select);
    }),
  };
  const user = {
    findUnique: vi.fn(async ({ where, select }) => {
      const row = store.users.get(where.id);
      return row ? pick(row, select) : null;
    }),
    update: vi.fn(async ({ where, data, select }) => {
      const row = store.users.get(where.id);
      if (!row) throw new Error("Record to update not found");
      Object.assign(row, data);
      return pick(row, select);
    }),
  };
  const tx = { $executeRaw: vi.fn(async () => 1), movieFact };
  return { db: { user, movieFact, $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } };
});

function signInAs(userId: string | null) {
  auth.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

function putMovieRequest(body: unknown, headers: Record<string, string> = {}) {
  return putMovie(
    new Request("http://localhost/api/me/movie", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store.users = new Map([
    ["alice", { id: "alice", name: "Alice", email: "alice@example.com", image: null, favoriteMovie: "Jaws" }],
    ["bob", { id: "bob", name: "Bob", email: "bob@example.com", image: null, favoriteMovie: "Jaws" }],
  ]);
  store.facts = [
    { id: "bob_fact", userId: "bob", movieTitle: "Jaws", content: "Bob's private fact", createdAt: new Date() },
  ];
  generateMovieFact.mockResolvedValue({ fact: "A brand-new fact.", identifiedTitle: "Jaws (1975)" });
});

describe("authorization", () => {
  it("GET /api/fact never reads or returns another user's facts", async () => {
    signInAs("alice");

    const response = await getFact();
    const body = await response.json();

    // Same movie as Bob, but Bob's fact isn't in Alice's history...
    expect(generateMovieFact).toHaveBeenCalledWith("Jaws", []);
    // ...or in her response, and her new fact is stored as hers.
    expect(JSON.stringify(body)).not.toContain("Bob's private fact");
    expect(store.facts.find((f) => f.id === body.data.id)?.userId).toBe("alice");
  });

  it("GET /api/fact for each user only sees that user's own history", async () => {
    signInAs("bob");
    await getFact();
    expect(generateMovieFact).toHaveBeenLastCalledWith("Jaws", ["Bob's private fact"]);

    signInAs("alice");
    await getFact();
    expect(generateMovieFact).toHaveBeenLastCalledWith("Jaws", []);
  });

  it("GET /api/me returns only the session user's profile", async () => {
    signInAs("alice");

    const body = await (await getMe()).json();

    expect(body.data.id).toBe("alice");
    expect(JSON.stringify(body)).not.toContain("bob");
  });

  it("PUT /api/me/movie ignores a forged userId in the body or headers", async () => {
    signInAs("alice");

    const response = await putMovieRequest(
      { movie: "Alien", userId: "bob", id: "bob" },
      { "X-User-Id": "bob" },
    );

    expect(response.status).toBe(200);
    expect(store.users.get("alice")?.favoriteMovie).toBe("Alien");
    expect(store.users.get("bob")?.favoriteMovie).toBe("Jaws");
  });

  it("signed-out requests can't read or change anyone's data", async () => {
    signInAs(null);
    const { db } = await import("@/lib/db");

    const statuses = [
      (await getMe()).status,
      (await getFact()).status,
      (await putMovieRequest({ movie: "Alien", userId: "bob" })).status,
    ];

    expect(statuses).toEqual([401, 401, 401]);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.movieFact.findMany).not.toHaveBeenCalled();
    expect(generateMovieFact).not.toHaveBeenCalled();
    expect(store.users.get("bob")?.favoriteMovie).toBe("Jaws");
  });
});
