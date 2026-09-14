import { config } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

config({ path: ".env.local" });

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  /**
   * Next compiles each route the first time it is requested in dev, so the
   * first navigation into a not-yet-compiled page takes seconds rather than
   * milliseconds. Playwright's 5s default made this suite order-dependent:
   * whichever spec reached a route first paid the compile and failed on the
   * URL assertion, and reordering the specs just moved the failure elsewhere.
   * `ai-review.spec.ts` was the one that sorted first, so it was the one that
   * broke.
   *
   * Raising the assertion timeout is the honest fix for a dev server. The
   * alternative — pointing `webServer` at `next build && next start` — removes
   * the latency and tests what actually ships, at the cost of a full rebuild
   * on every run; worth revisiting when this runs in CI.
   */
  expect: { timeout: 15_000 },
  /**
   * Playwright's 30s default is a per-TEST budget, and the multi-person
   * journeys here spend most of it before asserting anything: a tier-2 test
   * creates two actors, signs in twice in two browser contexts, and walks six
   * routes that a dev server compiles on first request. The assertions are
   * individually fast; the setup is not.
   */
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
