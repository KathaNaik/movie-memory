// Prisma 7 does not load .env automatically for CLI commands.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations use Neon's direct (non-pooled) connection: PgBouncer in
    // transaction mode does not support everything Prisma Migrate needs.
    // process.env (rather than the strict env() helper) keeps `prisma generate`
    // working in environments without database credentials, such as CI builds.
    url: process.env["DIRECT_URL"],
  },
});
