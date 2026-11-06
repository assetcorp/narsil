import { createNarsilClient } from '@delali/narsil/client'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { SERVER_APP_E2E_ORIGIN } from './settings'

const SYNCED_INDEX = 'field-notes'
const SYNC_TIMEOUT_MS = 30_000

const server = createNarsilClient({ url: `${SERVER_APP_E2E_ORIGIN}/api/narsil` })

const FIRST_SERVER_NOTE = { title: 'Harbour wall inspection', body: 'Cracks along the north pier' }
const SECOND_SERVER_NOTE = { title: 'Lighthouse lamp', body: 'Replaced the lamp housing' }
const BROWSER_NOTE = { title: 'Ferry timetable', body: 'Winter sailings start in November' }
const SECOND_TAB_NOTE = { title: 'Tide gauge', body: 'Gauge reads high at spring tide' }

function countLine(page: Page, total: number): Locator {
  const noun = total === 1 ? 'document' : 'documents'
  return page.getByText(new RegExp(`of ${total} ${noun}$`))
}

async function serverHolds(ids: readonly string[]): Promise<{ count: number; held: string[] }> {
  const held: string[] = []
  for (const id of ids) {
    if (await server.has(SYNCED_INDEX, id)) held.push(id)
  }
  return { count: await server.countDocuments(SYNCED_INDEX), held }
}

async function addDocument(page: Page, id: string, fields: Record<string, string>): Promise<void> {
  await page.getByRole('button', { name: 'New document' }).click()
  await page.getByLabel('Document ID').fill(id)
  await page.getByLabel('Fields as JSON').fill(JSON.stringify(fields))
  await page.getByRole('button', { name: 'Save document' }).click()
}

async function removeDocument(page: Page, title: string): Promise<void> {
  await page.getByRole('row').filter({ hasText: title }).getByRole('button', { name: 'View' }).click()
  await page.getByRole('button', { name: 'Edit document' }).click()
  await page.getByRole('button', { name: 'Delete document' }).click()
}

test.beforeEach(async () => {
  const existing = await server.listIndexes()
  if (existing.some(index => index.name === SYNCED_INDEX)) await server.dropIndex(SYNCED_INDEX)
  await server.createIndex(SYNCED_INDEX, { schema: { title: 'string', body: 'string' }, language: 'english' })
  await server.updateSync(SYNCED_INDEX, { enabled: true })
  await server.insert(SYNCED_INDEX, FIRST_SERVER_NOTE, 'note-server-1')
})

test('edits travel both ways between the browser and the server app, and a second tab edits through the tab that syncs', async ({
  page,
  context,
}) => {
  test.setTimeout(SYNC_TIMEOUT_MS * 6)
  await page.goto('/sync')
  await page.getByLabel('Index to sync').fill(SYNCED_INDEX)
  await page.getByRole('button', { name: 'Start sync' }).click()
  const session = page.getByTestId('sync-session')
  await expect(session.getByTestId('sync-connection')).toHaveText('connected', { timeout: SYNC_TIMEOUT_MS })

  await page.getByRole('link', { name: 'Documents' }).click()
  await expect(countLine(page, 1)).toBeVisible({ timeout: SYNC_TIMEOUT_MS })

  await server.insert(SYNCED_INDEX, SECOND_SERVER_NOTE, 'note-server-2')
  await expect(countLine(page, 2)).toBeVisible({ timeout: SYNC_TIMEOUT_MS })

  await addDocument(page, 'note-browser', BROWSER_NOTE)
  await expect(countLine(page, 3)).toBeVisible()
  await expect
    .poll(() => serverHolds(['note-server-1', 'note-server-2', 'note-browser']), { timeout: SYNC_TIMEOUT_MS })
    .toEqual({ count: 3, held: ['note-server-1', 'note-server-2', 'note-browser'] })

  const secondTab = await context.newPage()
  await secondTab.goto('/sync')
  await secondTab.getByLabel('Index to sync').fill(SYNCED_INDEX)
  await secondTab.getByRole('button', { name: 'Start sync' }).click()
  await expect(secondTab.getByRole('alert')).toContainText(`Another tab syncs ${SYNCED_INDEX}`)

  await secondTab.getByRole('link', { name: 'Documents' }).click()
  await expect(countLine(secondTab, 3)).toBeVisible({ timeout: SYNC_TIMEOUT_MS })
  await addDocument(secondTab, 'note-second-tab', SECOND_TAB_NOTE)
  await removeDocument(secondTab, FIRST_SERVER_NOTE.title)

  await expect
    .poll(() => serverHolds(['note-server-1', 'note-server-2', 'note-browser', 'note-second-tab']), {
      timeout: SYNC_TIMEOUT_MS,
    })
    .toEqual({ count: 3, held: ['note-server-2', 'note-browser', 'note-second-tab'] })
  await expect(page.getByRole('row').filter({ hasText: SECOND_TAB_NOTE.title })).toHaveCount(1, {
    timeout: SYNC_TIMEOUT_MS,
  })
  await expect(page.getByRole('row').filter({ hasText: FIRST_SERVER_NOTE.title })).toHaveCount(0)
  await expect(countLine(page, 3)).toBeVisible()
  await page.getByRole('link', { name: 'Sync' }).click()
  await expect(page.getByTestId('sync-refused-writes')).toHaveText('0')
  await expect(page.getByTestId('sync-queued-writes')).toHaveText('0', { timeout: SYNC_TIMEOUT_MS })
})
