import { defineConfig, devices } from '@playwright/test';

const PORT = 4311;

/**
 * Browser tests drive the two primary journeys end to end.
 *
 * They run against a production build on a separate port so they never clash
 * with a dev server, and each test file gets its own demo session (a fresh
 * browser context means a fresh session cookie, so tests cannot corrupt
 * one another's state).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 950 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // The freight module keeps a real database, so give the browser tests
    // their own directory rather than sharing a developer's local data.
    env: { MPC_DATA_DIR: '.demo-data-e2e', FREIGHT_DATA_DIR: '.freight-data-e2e', FREIGHT_MODE_SWITCH: 'off' },
  },
});
