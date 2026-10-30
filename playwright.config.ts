import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** Playwright wants its own browser build; in sandboxes with a pre-installed Chromium point PW_CHROMIUM at it. */
function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
  const p = dir && join(root, dir, 'chrome-linux64', 'chrome');
  return p && existsSync(p) ? p : undefined;
}

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:4180',
    ...devices['Pixel 7'],
    launchOptions: { executablePath: chromiumPath() },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
});
