import { describe, expect, it } from "vitest";

import { FACT_CACHE_TTL_MS, isFreshFactFor, type CachedFact } from "@/lib/fact-cache";

const cached: CachedFact = {
  id: "f1",
  movieTitle: "Jaws",
  identifiedTitle: "Jaws (1975)",
  content: "Fact.",
  fetchedAt: 1_000,
};

describe("isFreshFactFor", () => {
  it("is fresh for the same movie under 30 seconds", () => {
    expect(isFreshFactFor(cached, "Jaws", 1_000)).toBe(true);
    expect(isFreshFactFor(cached, "Jaws", 1_000 + FACT_CACHE_TTL_MS - 1)).toBe(true);
  });

  it("expires at exactly 30 seconds", () => {
    expect(FACT_CACHE_TTL_MS).toBe(30_000);
    expect(isFreshFactFor(cached, "Jaws", 1_000 + FACT_CACHE_TTL_MS)).toBe(false);
  });

  it("is never fresh for a different movie or an empty cache", () => {
    expect(isFreshFactFor(cached, "Alien", 1_000)).toBe(false);
    expect(isFreshFactFor(null, "Jaws", 1_000)).toBe(false);
  });
});
