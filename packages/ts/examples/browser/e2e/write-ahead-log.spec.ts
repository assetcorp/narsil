import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import { BROWSER_E2E_ORIGIN } from './settings'
import type { LogScenario, ReadBack } from './write-ahead-log/page-engine'

const PAGE_ENGINE_MODULE = '/e2e/write-ahead-log/page-engine.ts'
const ACKNOWLEDGED_BEFORE_THE_CRASH = 300
const ACKNOWLEDGEMENT_TIMEOUT_MS = 60_000

interface PageEngine {
  startWriting(scenario: LogScenario, acknowledge: (docId: string, title: string) => Promise<void>): Promise<void>
  readBack(scenario: LogScenario, docIds: string[]): Promise<ReadBack>
}

async function openProfile(profile: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(profile, { headless: true })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(BROWSER_E2E_ORIGIN)
  await page.waitForLoadState('networkidle')
  return { context, page }
}

async function crashTheBrowser(context: BrowserContext): Promise<void> {
  const browser = context.browser()
  if (browser === null) throw new Error('The persistent context reports no browser to crash')
  const session = await browser.newBrowserCDPSession()
  const disconnected = new Promise<void>(resolve => browser.once('disconnected', () => resolve()))
  void session.send('Browser.crash').catch(() => undefined)
  await disconnected
}

async function expectEveryAcknowledgedWriteAfterACrash(scenario: LogScenario): Promise<void> {
  const profile = await mkdtemp(path.join(tmpdir(), 'narsil-write-ahead-log-'))
  try {
    const acknowledged = new Map<string, string>()
    const writer = await openProfile(profile)
    await writer.page.exposeFunction('acknowledgeWrite', (docId: string, title: string) => {
      acknowledged.set(docId, title)
    })
    await writer.page.evaluate(
      async ([modulePath, chosen]) => {
        const engine = (await import(modulePath)) as PageEngine
        const target = window as unknown as { acknowledgeWrite: (docId: string, title: string) => Promise<void> }
        await engine.startWriting(chosen, (docId, title) => target.acknowledgeWrite(docId, title))
      },
      [PAGE_ENGINE_MODULE, scenario] as const,
    )
    await expect
      .poll(() => acknowledged.size, { timeout: ACKNOWLEDGEMENT_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(ACKNOWLEDGED_BEFORE_THE_CRASH)
    await crashTheBrowser(writer.context)
    const confirmed = new Map(acknowledged)

    const reader = await openProfile(profile)
    const docIds = [...confirmed.keys()]
    const found = await reader.page.evaluate(
      async ([modulePath, chosen, ids]) => {
        const engine = (await import(modulePath)) as PageEngine
        return engine.readBack(chosen, ids)
      },
      [PAGE_ENGINE_MODULE, scenario, docIds] as const,
    )
    await reader.context.close()

    expect(found.titles).toEqual(docIds.map(docId => confirmed.get(docId)))
    expect(found.count).toBeGreaterThanOrEqual(confirmed.size)
    expect(found.count).toBeLessThanOrEqual(confirmed.size + 1)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

test('a browser crash keeps every write that the log acknowledged in sync mode', async () => {
  await expectEveryAcknowledgedWriteAfterACrash({ dbName: 'narsil-e2e-log-sync' })
})

test('a browser crash keeps every write that the log acknowledged in async mode before the next flush', async () => {
  await expectEveryAcknowledgedWriteAfterACrash({
    dbName: 'narsil-e2e-log-async',
    durability: { mode: 'async', flushIntervalMs: 600_000 },
  })
})
