import { createNarsilClient } from '@delali/narsil/client'
import { expect, type Page, test } from '@playwright/test'
import { BROWSER_E2E_ORIGIN, SERVER_APP_E2E_ORIGIN } from './settings'

const SYNC_TIMEOUT_MS = 30_000
async function serverFor(page: Page) {
  const response = await page.request.post(`${BROWSER_E2E_ORIGIN}/server-app/api/sync-grant`, {
    headers: { origin: BROWSER_E2E_ORIGIN },
    data: {},
  })
  expect(response.ok()).toBe(true)
  const grant = await response.json()
  const cookies = await page.context().cookies()
  return createNarsilClient({
    url: `${SERVER_APP_E2E_ORIGIN}/api/narsil`,
    headers: {
      authorization: `Bearer ${grant.credential}`,
      cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    },
  })
}

async function firstNoteId(page: Page): Promise<string> {
  const id = await page.getByTestId('notes-list').locator('li').first().getAttribute('data-note-id')
  if (id === null) throw new Error('The saved note has no identifier')
  return id
}

async function openDevice(page: Page, device: string): Promise<void> {
  await page.goto(`/sync?device=${device}`)
  await expect(page.getByTestId('sync-connection')).toHaveText('Syncing live', { timeout: SYNC_TIMEOUT_MS })
}

async function addNote(page: Page, title: string, body: string): Promise<void> {
  const form = page.getByRole('form', { name: 'New note' })
  if (!(await form.isVisible())) await page.getByRole('button', { name: 'New note', exact: true }).click()
  await form.getByLabel('Title', { exact: true }).fill(title)
  await form.getByLabel('Note text', { exact: true }).fill(body)
  await form.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(form.getByText('Saved on this device', { exact: true })).toBeVisible()
}

async function editNote(page: Page, title: string, body: string): Promise<void> {
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click()
  const form = page.getByRole('form', { name: `Edit ${title}` })
  await form.getByLabel('Note text', { exact: true }).fill(body)
  await form.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('notes-list').getByText('Saved on this device', { exact: true })).toBeVisible()
}

async function notesIndexName(page: Page): Promise<string> {
  const space = await page.evaluate(() => localStorage.getItem('narsil-notes-space'))
  return `demo-notes-${space}`
}

test('a first visit names the device and refuses a malformed device name', async ({ page }) => {
  await page.goto('/sync?device=Bad%20Name')
  await expect(page.getByRole('alert')).toContainText("'Bad Name' is not a usable device name")
  await page.getByLabel('Device name').fill('../escape')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(/device=Bad/)
  await page.getByLabel('Device name').fill('Laptop')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(/device=laptop$/)
  await expect(page.getByTestId('sync-connection')).toHaveText('Syncing live', { timeout: SYNC_TIMEOUT_MS })
})

test('independent devices search offline edits locally and deliver their durable queue after reconnecting', async ({
  page,
  context,
}) => {
  await openDevice(page, 'laptop')
  const second = await context.newPage()
  await openDevice(second, 'phone')
  await page.getByRole('switch', { name: 'Sync' }).click()
  await expect(page.getByTestId('sync-connection')).toHaveText('Paused')
  await addNote(page, 'Harbour inspection', 'Check the north pier after the storm')
  await expect(page.getByTestId('sync-queued-writes')).toHaveText('1')
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('harbour')
  await expect(page.getByTestId('notes-list')).toContainText('Harbour inspection')
  await expect(second.getByTestId('notes-list')).not.toContainText('Harbour inspection')
  const indexName = await notesIndexName(page)
  const noteId = await firstNoteId(page)
  expect(await (await serverFor(page)).get(indexName, noteId)).toBeUndefined()

  await page.reload()
  await expect(page.getByTestId('sync-connection')).toHaveText('Syncing live', { timeout: SYNC_TIMEOUT_MS })
  await expect(page.getByTestId('sync-queued-writes')).toHaveText('0', { timeout: SYNC_TIMEOUT_MS })
  await expect(second.getByTestId('notes-list')).toContainText('Harbour inspection', { timeout: SYNC_TIMEOUT_MS })
  expect(await (await serverFor(page)).get(indexName, noteId)).toEqual({
    title: 'Harbour inspection',
    body: 'Check the north pier after the storm',
  })

  await second.getByRole('switch', { name: 'Sync' }).click()
  await expect(second.getByTestId('sync-connection')).toHaveText('Paused')
  await editNote(second, 'Harbour inspection', 'Repairs complete on the north pier')
  await second.getByRole('searchbox', { name: 'Search notes' }).fill('repairs')
  await expect(second.getByTestId('notes-list')).toContainText('Repairs complete')
  await expect(page.getByTestId('notes-list')).not.toContainText('Repairs complete')
  await second.getByRole('switch', { name: 'Sync' }).click()
  await expect(second.getByTestId('sync-queued-writes')).toHaveText('0', { timeout: SYNC_TIMEOUT_MS })
  await expect(page.getByTestId('notes-list')).toContainText('Repairs complete', { timeout: SYNC_TIMEOUT_MS })
  const duplicate = await context.newPage()
  await duplicate.goto('/sync?device=phone')
  await expect(duplicate.getByRole('alert')).toContainText('phone is open in another tab')
})

test('a lost network connection keeps local editing and search available until queued notes reach the server', async ({
  page,
  context,
}) => {
  await openDevice(page, 'laptop')
  const second = await context.newPage()
  await openDevice(second, 'phone')
  const indexName = await notesIndexName(page)
  const server = await serverFor(page)
  let noteId = ''
  const failedGrant = context.waitForEvent('requestfailed', {
    predicate: request => request.url().endsWith('/api/sync-grant'),
    timeout: SYNC_TIMEOUT_MS,
  })
  await context.setOffline(true)
  try {
    await failedGrant
    await expect(page.getByTestId('sync-connection')).toHaveText('Offline, working locally')
    await addNote(page, 'Lighthouse repairs', 'Replace the lamp housing before winter')
    await page.getByRole('searchbox', { name: 'Search notes' }).fill('lighthouse')
    await expect(page.getByTestId('notes-list')).toContainText('Lighthouse repairs')
    await expect(page.getByTestId('sync-queued-writes')).toHaveText('1')
    noteId = await firstNoteId(page)
    expect(await server.get(indexName, noteId)).toBeUndefined()
    await expect(second.getByTestId('notes-list')).not.toContainText('Lighthouse repairs')
  } finally {
    await context.setOffline(false)
  }
  await expect(page.getByTestId('sync-queued-writes')).toHaveText('0', { timeout: SYNC_TIMEOUT_MS })
  await expect(second.getByTestId('notes-list')).toContainText('Lighthouse repairs', { timeout: SYNC_TIMEOUT_MS })
  expect(await (await serverFor(page)).get(indexName, noteId)).toEqual({
    title: 'Lighthouse repairs',
    body: 'Replace the lamp housing before winter',
  })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('"lighthouse repairs" '.repeat(33))
  await expect(page.getByRole('alert')).toContainText('at most 32 phrases')
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('lighthouse')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('notes-list')).toContainText('Lighthouse repairs')
})

test('grants require a browser cookie regardless of a supplied index name', async ({ request }) => {
  for (const indexName of ['places', 'field-notes', '', 'demo-notes-../../places']) {
    const response = await request.post(`${SERVER_APP_E2E_ORIGIN}/api/sync-grant`, {
      headers: { origin: SERVER_APP_E2E_ORIGIN },
      data: { indexName },
    })
    expect(response.status()).toBe(401)
  }
})
