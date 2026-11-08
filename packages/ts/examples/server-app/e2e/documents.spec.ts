import { expect, test } from '@playwright/test'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { countLine, DATASET_LOAD_TIMEOUT_MS, loadPlaces, PLACES_INDEX, server } from './app'

const SAVE_TIMEOUT_MS = 60_000
const ADDED_ID = 'e2e-harbour-town'

test.afterEach(async () => {
  if (await server.has(PLACES_INDEX, ADDED_ID)) await server.remove(PLACES_INDEX, ADDED_ID)
})

test('a document saved and deleted on the Documents page reaches the server, and the page counts it', async ({
  page,
}) => {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS + SAVE_TIMEOUT_MS * 2)
  const total = readPlaces().length
  await loadPlaces(page)
  if (await server.has(PLACES_INDEX, ADDED_ID)) await server.remove(PLACES_INDEX, ADDED_ID)
  await page.goto('/documents')
  await expect(countLine(page, total)).toBeVisible()

  const added = {
    name: 'Harbour Test Town',
    summary: 'Harbour Test Town, Test Coast, Testland.',
    country: 'Testland',
    region: 'Test Coast',
    kind: 'Populated place',
    tags: [],
    population: 4321,
    populations: [1200, 4321],
    location: { lat: 12.5, lon: -45.25 },
  }
  await page.getByRole('button', { name: 'New document' }).click()
  await page.getByLabel('Document ID').fill(ADDED_ID)
  await page.getByLabel('Fields as JSON').fill(JSON.stringify(added))
  await page.getByRole('button', { name: 'Save document' }).click()
  await expect(countLine(page, total + 1)).toBeVisible({ timeout: SAVE_TIMEOUT_MS })
  const stored = await server.get(PLACES_INDEX, ADDED_ID)
  expect(stored).toMatchObject(added)

  await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('button', { name: 'Add condition' }).click()
  const rule = page.getByTestId('filter-rule').last()
  await rule.getByRole('combobox', { name: 'Field' }).click()
  await page.getByRole('option', { name: 'name', exact: true }).click()
  await rule.getByRole('combobox', { name: 'Test' }).click()
  await page.getByRole('option', { name: 'is', exact: true }).click()
  await rule.getByLabel('Value').fill(added.name)
  await expect(countLine(page, 1, true)).toBeVisible()
  await page.getByRole('button', { name: 'View' }).click()
  await page.getByRole('button', { name: 'Edit document' }).click()
  await page.getByRole('button', { name: 'Delete document' }).click()
  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(countLine(page, total)).toBeVisible({ timeout: SAVE_TIMEOUT_MS })
  expect(await server.has(PLACES_INDEX, ADDED_ID)).toBe(false)
  expect(await server.countDocuments(PLACES_INDEX)).toBe(total)
})
