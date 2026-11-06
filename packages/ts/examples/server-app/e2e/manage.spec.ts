import { readFile } from 'node:fs/promises'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { DATASET_LOAD_TIMEOUT_MS, loadPlaces, PLACES_INDEX, resultIds, searchFor, server } from './app'

const RESTORE_TIMEOUT_MS = 120_000

async function openManage(page: Page): Promise<void> {
  await page.goto('/inspector')
  await page.getByRole('button', { name: 'Manage', exact: true }).click()
}

function sectionStatus(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator('output')
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS + RESTORE_TIMEOUT_MS * 2)
  await loadPlaces(page)
})

test('a two-way synonym saved on the server finds every place that the other word finds', async ({ page }) => {
  const kenya = readPlaces()
    .filter(place => place.country === 'Kenya')
    .map(place => place.id)
    .sort()
  expect(kenya.length).toBeGreaterThan(0)

  await openManage(page)
  await page.getByLabel('Synonym rules').fill('jamhuri, kenya')
  await page.getByRole('button', { name: 'Save synonyms' }).click()
  await expect(sectionStatus(page, 'manage-synonyms')).toContainText('1 synonym rule')

  await page.goto('/search')
  await searchFor(page, 'jamhuri')
  await expect(page.getByText(`${kenya.length} results`, { exact: true })).toBeVisible()
  expect((await resultIds(page)).sort()).toEqual(kenya)
})

test('an export lists every place, and a snapshot restore brings back a place removed after it', async ({ page }) => {
  const places = readPlaces()
  const accra = places.find(place => place.name === 'Accra')
  expect(accra).toBeDefined()
  const accraId = accra?.id ?? ''
  await openManage(page)

  const exportDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download export' }).click()
  const exportPath = await (await exportDownload).path()
  const lines = (await readFile(exportPath, 'utf-8')).split('\n').filter(line => line.length > 0)
  const exported = lines.slice(1).map(line => JSON.parse(line) as { id: string; name: string })
  expect(new Map(exported.map(entry => [entry.id, entry.name]))).toEqual(
    new Map(places.map(place => [place.id, place.name])),
  )

  const snapshotDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download snapshot' }).click()
  const snapshotPath = await (await snapshotDownload).path()

  await server.remove(PLACES_INDEX, accraId)
  expect(await server.countDocuments(PLACES_INDEX)).toBe(places.length - 1)

  await page.getByLabel('Snapshot file to restore').setInputFiles(snapshotPath)
  await expect(sectionStatus(page, 'manage-backups')).toContainText('The index holds what', {
    timeout: RESTORE_TIMEOUT_MS,
  })
  expect(await server.has(PLACES_INDEX, accraId)).toBe(true)
  expect(await server.countDocuments(PLACES_INDEX)).toBe(places.length)
})
