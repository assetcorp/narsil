import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'
import { E2E_DATA_DIR_ENV, E2E_ORIGIN, E2E_PORT, E2E_SYNC_GRANT_MS } from './e2e/settings'

const E2E_START_TIMEOUT_MS = 180_000

const OMITTED_ENV = new Set([
  'OPENAI_API_KEY',
  'ASK_EMBEDDING_API_KEY',
  'NARSIL_SERVER_URL',
  'NARSIL_API_KEY',
  'NARSIL_SYNC_GRANT_SECRET',
])

function e2eDataDirectory(): string {
  const existing = process.env[E2E_DATA_DIR_ENV]
  if (existing !== undefined) return existing
  const created = mkdtempSync(path.join(tmpdir(), 'narsil-server-app-e2e-'))
  process.env[E2E_DATA_DIR_ENV] = created
  return created
}

function e2eEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !OMITTED_ENV.has(name)) env[name] = value
  }
  env.NARSIL_DATA_DIR = e2eDataDirectory()
  env.NARSIL_SYNC_GRANT_MS = String(E2E_SYNC_GRANT_MS)
  return env
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalTeardown: './e2e/teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite dev --port ${E2E_PORT} --strictPort`,
    url: `${E2E_ORIGIN}/api/narsil/health`,
    reuseExistingServer: false,
    timeout: E2E_START_TIMEOUT_MS,
    env: e2eEnvironment(),
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
