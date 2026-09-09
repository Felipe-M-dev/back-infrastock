import "dotenv/config";
import { defineConfig } from "prisma/config";

const migrationUrl =
  process.env["DATABASE_MIGRATION_URL"] ?? process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  datasource: {
    url: migrationUrl,
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
