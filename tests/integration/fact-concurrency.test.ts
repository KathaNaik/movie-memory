// @vitest-environment node
//
// Runs against the real PostgreSQL database in DATABASE_URL (OpenAI and the
// session are mocked). Opt in with: npm run test:db
// Creates two throwaway users (…@example.test) and deletes them afterwards.
import "dotenv/config";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/fact/route";
import { saveFavoriteMovie } from "@/app/onboarding/actions";
import { db } from "@/lib/db";
import {
  FACTS_PER_MINUTE,
  FactGenerationBusyError,
  FactRateLimitedError,
  generateAndStoreFact,
} from "@/lib/fact-generation";

const { getCurrentUser, generateMovieFact, auth } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  generateMovieFact: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser }));
vi.mock("@/lib/openai", () => ({ generateMovieFact, MovieNotRecognizedError: class extends Error {} }));

const MOVIE = "Jaws";
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let alice: { id: string; favoriteMovie: string | null };
let bob: { id: string; favoriteMovie: string | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mock OpenAI that takes `ms`, records concurrency and the history it saw. */
function slowGeneration(ms: number) {
  const seen: { title: string; history: string[] }[] = [];
  let active = 0;
  let maxActive = 0;
  generateMovieFact.mockImplementation(async (title: string, history: string[]) => {
    active++;
    maxActive = Math.max(maxActive, active);
    seen.push({ title, history });
    await sleep(ms);
    active--;
    return { fact: `fact #${seen.length} about ${title}`, identifiedTitle: `${title} (1975)` };
  });
  return { seen, maxActive: () => maxActive };
}

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("GET /api/fact against PostgreSQL", () => {
  beforeAll(async () => {
    alice = await db.user.create({
      data: { email: `itest-${runId}-alice@example.test`, favoriteMovie: MOVIE },
    });
    bob = await db.user.create({
      data: { email: `itest-${runId}-bob@example.test`, favoriteMovie: MOVIE },
    });
  });

  afterAll(async () => {
    // Cascades to their facts.
    await db.user.deleteMany({ where: { email: { endsWith: `@example.test`, startsWith: `itest-${runId}` } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    generateMovieFact.mockReset();
    getCurrentUser.mockReset();
    await db.movieFact.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
  });

  it("serializes simultaneous requests for the same user + movie", async () => {
    getCurrentUser.mockResolvedValue(alice);
    const generation = slowGeneration(400);

    // Two tabs asking at the same moment.
    const responses = await Promise.all([GET(), GET()]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    // Never generating in parallel...
    expect(generation.maxActive()).toBe(1);
    // ...and the second one saw the first one's saved fact.
    expect(generation.seen[0].history).toEqual([]);
    expect(generation.seen[1].history).toEqual(["fact #1 about Jaws"]);
    // Both facts were generated and stored (no server-side caching).
    expect(await db.movieFact.count({ where: { userId: alice.id } })).toBe(2);
  });

  it("doesn't make different users wait for each other", async () => {
    getCurrentUser.mockResolvedValueOnce(alice).mockResolvedValueOnce(bob);
    const generation = slowGeneration(400);

    await Promise.all([GET(), GET()]);

    expect(generation.maxActive()).toBe(2);
  });

  it("never uses another user's facts and stores facts only for the session user", async () => {
    await db.movieFact.create({
      data: { userId: bob.id, movieTitle: MOVIE, content: "Bob's private fact" },
    });
    getCurrentUser.mockResolvedValue(alice);
    const generation = slowGeneration(0);

    const response = await GET();
    const body = await response.json();

    expect(generation.seen[0].history).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Bob's private fact");
    const stored = await db.movieFact.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(stored.userId).toBe(alice.id);
    expect(await db.movieFact.count({ where: { userId: bob.id } })).toBe(1);
  });

  it("gives up waiting after the lock timeout and stores nothing", async () => {
    // Hold the same lock from another connection, as a stuck request would.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `movie-fact:${alice.id}:${MOVIE}`,
    ]);
    slowGeneration(0);

    try {
      await expect(generateAndStoreFact(alice.id, MOVIE, { lockWait: "500ms" })).rejects.toBeInstanceOf(
        FactGenerationBusyError,
      );
      expect(generateMovieFact).not.toHaveBeenCalled();
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }

    // Once the lock is free, generation works again.
    await expect(generateAndStoreFact(alice.id, MOVIE, { lockWait: "500ms" })).resolves.toMatchObject({
      movieTitle: MOVIE,
    });
  });
  it("stores a fact's identified title and Unicode or SQL-like titles unchanged", async () => {
    const title = `千と千尋の神隠し "it's"; DROP TABLE "User";--`;
    slowGeneration(0);

    const fact = await generateAndStoreFact(alice.id, title);

    const stored = await db.movieFact.findUniqueOrThrow({ where: { id: fact.id } });
    expect(stored.movieTitle).toBe(title);
    expect(stored.identifiedTitle).toBe(`${title} (1975)`);
    expect(await db.user.count({ where: { id: alice.id } })).toBe(1);
  });

  it(`rate-limits a user after ${FACTS_PER_MINUTE} facts in a minute`, async () => {
    await db.movieFact.createMany({
      data: Array.from({ length: FACTS_PER_MINUTE }, (_, i) => ({
        userId: alice.id,
        movieTitle: `Movie ${i}`,
        content: `fact ${i}`,
      })),
    });
    slowGeneration(0);

    await expect(generateAndStoreFact(alice.id, MOVIE)).rejects.toBeInstanceOf(FactRateLimitedError);
    expect(generateMovieFact).not.toHaveBeenCalled();
    // Other users are unaffected.
    await expect(generateAndStoreFact(bob.id, MOVIE)).resolves.toMatchObject({ movieTitle: MOVIE });
  });

  it("two racing onboarding submissions set the movie exactly once", async () => {
    const carol = await db.user.create({ data: { email: `itest-${runId}-carol@example.test` } });
    auth.mockResolvedValue({ user: { id: carol.id } });
    const form = (movie: string) => {
      const data = new FormData();
      data.set("favoriteMovie", movie);
      return data;
    };

    const results = await Promise.allSettled([
      saveFavoriteMovie({}, form("Interstellar")),
      saveFavoriteMovie({}, form("Titanic")),
    ]);

    // Both end on the dashboard; the first committed title wins, the other is a no-op.
    expect(results.map((r) => r.status === "rejected" && (r.reason as { url?: string }).url)).toEqual([
      "/dashboard",
      "/dashboard",
    ]);
    const saved = await db.user.findUniqueOrThrow({ where: { id: carol.id } });
    expect(["Interstellar", "Titanic"]).toContain(saved.favoriteMovie);

    // A later (or retried) onboarding submission can't overwrite it.
    await saveFavoriteMovie({}, form("Avatar")).catch(() => {});
    expect((await db.user.findUniqueOrThrow({ where: { id: carol.id } })).favoriteMovie).toBe(saved.favoriteMovie);
  });
});
