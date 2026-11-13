import "server-only";

import { db } from "@/lib/db";
import { generateMovieFact, type GeneratedFact } from "@/lib/openai";

// Enough to steer away from repeats while keeping the prompt small.
const RECENT_FACTS_FOR_CONTEXT = 5;
// Abuse/cost guard: far above normal use (each fact takes ~3s to generate),
// but stops runaway loops and scripted requests. Counts stored facts, so
// failed generations don't count against the user.
export const FACTS_PER_MINUTE = 10;

const DEFAULTS = {
  // How long a request waits for another generation of the same user + movie
  // to finish. Longer than one worst-case generation (~30s: 15s timeout, 1 retry).
  lockWait: "35s",
  // Lock wait plus this request's own worst-case generation.
  transactionTimeoutMs: 70_000,
};

/** OpenAI failed (including MovieNotRecognizedError, kept as `reason`). Nothing was stored. */
export class FactGenerationFailedError extends Error {
  constructor(readonly reason: unknown) {
    super("Fact generation failed");
    this.name = "FactGenerationFailedError";
  }
}

/** The user hit FACTS_PER_MINUTE. Nothing was generated or stored. */
export class FactRateLimitedError extends Error {
  constructor() {
    super("Fact generation rate limited");
    this.name = "FactRateLimitedError";
  }
}

/** Waited too long for another generation of the same user + movie. Nothing was stored. */
export class FactGenerationBusyError extends Error {
  constructor() {
    super("Fact generation busy");
    this.name = "FactGenerationBusyError";
  }
}

/**
 * Generates a new fact about `movieTitle` for `userId` and stores it.
 *
 * Burst protection: concurrent calls for the same user + movie (several tabs,
 * rapid refreshes) take turns instead of generating in parallel. Each call
 * still generates its own fact (Variant B: no server-side caching), but only
 * after the previous one is saved, so it sees that fact in its history and
 * picks a different topic.
 *
 * The lock is a PostgreSQL transaction-level advisory lock, so it works across
 * serverless instances and through Neon's transaction-mode pooler, and it's
 * released automatically on commit, rollback or a crashed connection. Different
 * users or movies only contend on a 64-bit hash collision, which would merely
 * serialize two requests.
 *
 * Trade-off: the transaction holds a pooled connection while OpenAI responds
 * (usually ~3s), and a waiting request holds one too.
 */
export async function generateAndStoreFact(
  userId: string,
  movieTitle: string,
  options: { lockWait?: string; transactionTimeoutMs?: number } = {},
) {
  const { lockWait, transactionTimeoutMs } = { ...DEFAULTS, ...options };

  try {
    return await db.$transaction(
      async (tx) => {
        // Bound the wait; PostgreSQL raises lock_not_available (55P03) after it.
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockWait}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`movie-fact:${userId}:${movieTitle}`}, 0))`;

        // Per-user limit across all movies. Checked under the lock, so requests
        // for the same movie can't race past it; requests for different movies
        // hold different locks and could exceed it by a few, which is fine for
        // a cost guard.
        const recentCount = await tx.movieFact.count({
          where: { userId, createdAt: { gte: new Date(Date.now() - 60_000) } },
        });
        if (recentCount >= FACTS_PER_MINUTE) throw new FactRateLimitedError();

        // Read under the lock, so it includes facts saved by calls we waited for.
        const recent = await tx.movieFact.findMany({
          where: { userId, movieTitle },
          orderBy: { createdAt: "desc" },
          take: RECENT_FACTS_FOR_CONTEXT,
          select: { content: true },
        });

        let generated: GeneratedFact;
        try {
          generated = await generateMovieFact(
            movieTitle,
            recent.map((fact) => fact.content),
          );
        } catch (error) {
          throw new FactGenerationFailedError(error);
        }

        return tx.movieFact.create({
          data: {
            userId,
            movieTitle,
            content: generated.fact,
            identifiedTitle: generated.identifiedTitle,
          },
          select: { id: true, content: true, movieTitle: true, identifiedTitle: true, createdAt: true },
        });
      },
      { maxWait: 5_000, timeout: transactionTimeoutMs },
    );
  } catch (error) {
    if (isLockTimeout(error)) throw new FactGenerationBusyError();
    throw error;
  }
}

/** Finds PostgreSQL's lock_not_available (55P03) anywhere in a wrapped error. */
function isLockTimeout(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.code === "55P03" || record.originalCode === "55P03") return true;
    if (typeof record.message === "string" && /lock timeout/i.test(record.message)) return true;
    return Object.values(record).some(visit) || visit(record.cause);
  };
  return visit(error);
}
