import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { db } from "@/lib/db";

// Google credentials are read from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET and the
// signing secret from AUTH_SECRET, all server-side only.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    Google({
      // Auth.js creates the User and links the Account in two separate writes.
      // If the second fails, the user row is left without an account and every
      // later sign-in would fail with OAuthAccountNotLinked (a lockout). Linking
      // by email repairs that on the next sign-in. Safe here because Google is
      // the only provider and it verifies email addresses.
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  // Database sessions: the cookie holds an opaque token and every auth() call
  // looks the session up in PostgreSQL, so sessions can be revoked server-side.
  session: { strategy: "database" },
  // The landing page doubles as the sign-in page and shows friendly messages
  // for Auth.js errors (cancelled consent, replayed callbacks…) via ?error=.
  pages: { signIn: "/", error: "/" },
  callbacks: {
    session({ session, user }) {
      // Expose the database user id so server code can scope queries to it.
      session.user.id = user.id;
      return session;
    },
  },
});
