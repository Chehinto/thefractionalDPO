import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// The RLS suite talks to the local Supabase stack, so it needs the same env the
// app uses. Loaded here rather than per-file so a test cannot accidentally run
// against whatever happens to be in the ambient environment.
config({ path: ".env.local" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests assert on real rows in a shared database. Running files in
    // parallel would let one file's tenants show up in another's counts.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
