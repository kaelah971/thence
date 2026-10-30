import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/thence",
  },
  verbose: true,
  strict: true,
} satisfies Config;
