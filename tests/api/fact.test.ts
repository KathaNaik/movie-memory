// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/fact/route";

const { getCurrentUser, create, findMany, count, executeRaw, generateMovieFact, MovieNotRecognizedError } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  executeRaw: vi.fn(),
  generateMovieFact: vi.fn(),
  MovieNotRecognizedError: class extends Error {},
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser }));
// The interactive transaction just runs its callback with a transaction client.
// (Real locking is covered by tests/integration against PostgreSQL.)
vi.mock("@/lib/db", () => {
  const tx = { $executeRaw: executeRaw, movieFact: { create, findMany, count } };
  return { db: { $transaction: (fn: (client: typeof tx) => unknown) => fn(tx) } };
});

/** Parameter values passed to the tagged-template $executeRaw calls. */
const rawCallValues = () => executeRaw.mock.calls.map(([, ...values]) => values);
vi.mock("@/lib/openai", () => ({ generateMovieFact, MovieNotRecognizedError }));

const signedInUser = {
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  image: null,
  favoriteMovie: "Spirited Away",
};

beforeEach(() => {
  getCurrentUser.mockReset();
  create.mockReset();
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  count.mockReset();
  count.mockResolvedValue(0);
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(1);
  generateMovieFact.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getCurrentUser.mockResolvedValue(signedInUser);
});

describe("GET /api/fact", () => {
  it("returns 401 when signed out without calling OpenAI", async () => {
    getCurrentUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    expect(generateMovieFact).not.toHaveBeenCalled();
  });

  it("returns 409 when the user has no favorite movie", async () => {
    getCurrentUser.mockResolvedValue({ ...signedInUser, favoriteMovie: null });

    const response = await GET();

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("MOVIE_NOT_SET");
    expect(generateMovieFact).not.toHaveBeenCalled();
  });

  it("generates a fact for the user's movie and stores it for that user", async () => {
    generateMovieFact.mockResolvedValue({
      fact: "Studio Ghibli hand-drew most of its frames.",
      identifiedTitle: "Spirited Away (2001)",
    });
    create.mockResolvedValue({
      id: "fact_1",
      content: "Studio Ghibli hand-drew most of its frames.",
      movieTitle: "Spirited Away",
      identifiedTitle: "Spirited Away (2001)",
      createdAt: new Date("2026-11-13T10:00:00.000Z"),
    });

    const response = await GET();

    expect(generateMovieFact).toHaveBeenCalledWith("Spirited Away", []);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        movieTitle: "Spirited Away",
        content: "Studio Ghibli hand-drew most of its frames.",
        identifiedTitle: "Spirited Away (2001)",
      },
      select: { id: true, content: true, movieTitle: true, identifiedTitle: true, createdAt: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      data: {
        id: "fact_1",
        content: "Studio Ghibli hand-drew most of its frames.",
        movieTitle: "Spirited Away",
        identifiedTitle: "Spirited Away (2001)",
        createdAt: "2026-11-13T10:00:00.000Z",
      },
    });
  });

  it("passes the user's recent facts for this movie so the next one differs", async () => {
    findMany.mockResolvedValue([{ content: "Newest fact." }, { content: "Older fact." }]);
    generateMovieFact.mockResolvedValue({ fact: "A new topic.", identifiedTitle: null });
    create.mockResolvedValue({ id: "f", content: "A new topic.", movieTitle: "Spirited Away", createdAt: new Date() });

    await GET();

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user_1", movieTitle: "Spirited Away" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { content: true },
    });
    expect(generateMovieFact).toHaveBeenCalledWith("Spirited Away", ["Newest fact.", "Older fact."]);
  });

  it("takes the per-user+movie lock before reading history or calling OpenAI", async () => {
    const order: string[] = [];
    executeRaw.mockImplementation(async () => order.push("raw"));
    findMany.mockImplementation(async () => (order.push("history"), []));
    count.mockImplementation(async () => (order.push("rate-limit"), 0));
    generateMovieFact.mockImplementation(async () => (order.push("openai"), { fact: "A fact.", identifiedTitle: null }));
    create.mockImplementation(async () => (order.push("save"), { id: "f", content: "A fact.", movieTitle: "Spirited Away", createdAt: new Date() }));

    await GET();

    // set lock_timeout, take the lock, then the protected work.
    expect(order).toEqual(["raw", "raw", "rate-limit", "history", "openai", "save"]);
    expect(rawCallValues()).toEqual([["35s"], ["movie-fact:user_1:Spirited Away"]]);
  });

  it("returns 429 RATE_LIMITED without calling OpenAI after 10 facts in a minute", async () => {
    count.mockResolvedValue(10);

    const response = await GET();

    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("RATE_LIMITED");
    expect(count.mock.calls[0][0].where.userId).toBe("user_1");
    expect(generateMovieFact).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("allows the 10th fact in a minute", async () => {
    count.mockResolvedValue(9);
    generateMovieFact.mockResolvedValue({ fact: "A fact.", identifiedTitle: null });
    create.mockResolvedValue({ id: "f", content: "A fact.", movieTitle: "Spirited Away", identifiedTitle: null, createdAt: new Date() });

    expect((await GET()).status).toBe(200);
  });

  it("returns 503 FACT_GENERATION_BUSY when the lock wait times out", async () => {
    executeRaw
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("FACT_GENERATION_BUSY");
    expect(generateMovieFact).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a generic 500 without calling OpenAI if reading history fails", async () => {
    // Inside the transaction a failed statement aborts it, so there's no
    // carrying on without history.
    findMany.mockRejectedValue(new Error("db hiccup"));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(generateMovieFact).not.toHaveBeenCalled();
  });

  it("stores a fact for a shortened title under the user's own title", async () => {
    getCurrentUser.mockResolvedValue({ ...signedInUser, favoriteMovie: "Barbie charm school" });
    generateMovieFact.mockResolvedValue({
      fact: "Barbie: Princess Charm School came out in 2011.",
      identifiedTitle: "Barbie: Princess Charm School (2011)",
    });
    create.mockImplementation(async ({ data }) => ({
      id: "fact_2",
      ...data,
      createdAt: new Date("2026-11-13T10:00:00.000Z"),
    }));

    const response = await GET();

    // The title stays exactly as the user saved it, so the client's cache
    // (keyed by favorite movie) matches the fact.
    expect(create.mock.calls[0][0].data).toEqual({
      userId: "user_1",
      movieTitle: "Barbie charm school",
      content: "Barbie: Princess Charm School came out in 2011.",
      identifiedTitle: "Barbie: Princess Charm School (2011)",
    });
    const { data } = await response.json();
    expect(data.movieTitle).toBe("Barbie charm school");
    expect(data.identifiedTitle).toBe("Barbie: Princess Charm School (2011)");
  });

  it("returns 422 MOVIE_NOT_RECOGNIZED and stores nothing when the film can't be identified", async () => {
    getCurrentUser.mockResolvedValue({ ...signedInUser, favoriteMovie: "Zorblax Moonquest Returns" });
    generateMovieFact.mockRejectedValue(new MovieNotRecognizedError());

    const response = await GET();

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "MOVIE_NOT_RECOGNIZED",
        message: "We couldn't tell which movie that is. Try editing it to the full title.",
      },
    });
    expect(create).not.toHaveBeenCalled();
    // An expected outcome, not a server fault: nothing logged.
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns a safe 502 when OpenAI fails and stores nothing", async () => {
    generateMovieFact.mockRejectedValue(
      new Error("401 Incorrect API key provided: sk-proj-abc123"),
    );

    const response = await GET();

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: {
        code: "FACT_GENERATION_FAILED",
        message: "We couldn't come up with a fact right now. Please try again in a moment.",
      },
    });
    expect(text).not.toContain("sk-proj");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when saving the fact fails", async () => {
    generateMovieFact.mockResolvedValue({ fact: "A fact.", identifiedTitle: null });
    create.mockRejectedValue(new Error("P2003 Foreign key constraint failed"));

    const response = await GET();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("P2003");
  });

  it("never logs error messages, which may contain secrets", async () => {
    generateMovieFact.mockRejectedValue(new Error("Incorrect API key provided: sk-proj-abc123"));

    await GET();

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("sk-proj");
  });
});
