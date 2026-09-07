import { defineConfig } from '@playwright/test'

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? 'http://127.0.0.1:19119'
const SESSION_TOKEN = process.env.HERMES_SESSION_TOKEN ?? 'test-smoke-token'

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      HERMES_GATEWAY_URL: GATEWAY_URL,
      HERMES_SESSION_TOKEN: SESSION_TOKEN,
    },
  },
})
