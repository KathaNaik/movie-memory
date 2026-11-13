import { handlers } from "@/auth";

// Prisma's pg driver adapter needs Node.js APIs.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
