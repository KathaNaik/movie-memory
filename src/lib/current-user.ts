import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { auth } from "@/auth";
import { db } from "@/lib/db";

export type CurrentUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  favoriteMovie: string | null;
};

// Auth.js session cookie (the __Secure- variant is used over HTTPS).
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

/** The database couldn't be reached, so we can't tell who the visitor is. */
export class DatabaseUnavailableError extends Error {
  constructor(readonly reason: unknown) {
    super("Database unavailable");
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * The signed-in user, read from PostgreSQL using the id from the trusted
 * server-side session, or null when signed out. Cached per request.
 *
 * Throws DatabaseUnavailableError (and other database errors) rather than
 * returning null when the database is down, so an outage shows an error page
 * instead of looking like the user was signed out.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    // Auth.js catches database errors while reading a session and reports
    // "no session". If the browser has a session cookie, make sure the
    // database is actually reachable before treating the visitor as signed
    // out. (A stale cookie for a deleted or expired session passes this check.)
    const jar = await cookies();
    if (SESSION_COOKIES.some((name) => jar.has(name))) {
      try {
        await db.$queryRaw`SELECT 1`;
      } catch (error) {
        throw new DatabaseUnavailableError(error);
      }
    }
    return null;
  }

  return db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true, favoriteMovie: true },
  });
});
