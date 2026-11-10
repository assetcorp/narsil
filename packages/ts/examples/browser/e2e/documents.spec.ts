import { expect, type Locator, type Page, test } from '@playwright/test'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { loadPlaces } from './app'

const EMBEDDING_SAVE_TIMEOUT_MS = 240_000
const CHILE = 'Chile'
const NAME_PREFIX_PATTERN = /^san/i

function countLine(page: Page, total: number, filtered: boolean): Locator {
  const noun = total === 1 ? 'document' : 'documents'
  return page.getByText(new RegExp(`of ${total.toLocaleString('en-US')} ${noun}${filtered ? ' matching' : ''}$`))
}

async function addCondition(page: Page, field: string, operator: string, value: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Add condition' }).click()
  const rule = page.getByTestId('filter-rule').last()
  await rule.getByRole('combobox', { name: 'Field' }).click()
  await page.getByRole('option', { name: field, exact: true }).click()
  await rule.getByRole('combobox', { name: 'Test' }).click()
  await page.getByRole('option', { name: operator, exact: true }).click()
  await rule.getByLabel('Value').fill(value)
  return rule
}

test('conditions joined by any, and a negated wildcard, count what the oracle counts', async ({ page }) => {
  const places = readPlaces()
  const anyCount = places.filter(place => place.country === CHILE || NAME_PREFIX_PATTERN.test(place.name)).length
  const chileWithoutSan = places.filter(
    place => place.country === CHILE && !NAME_PREFIX_PATTERN.test(place.name),
  ).length
  expect(anyCount).toBeGreaterThan(chileWithoutSan)

  await loadPlaces(page)
  await page.goto('/documents')
  await expect(countLine(page, places.length, false)).toBeVisible()
  await page.getByRole('button', { name: 'Filters' }).click()

  await addCondition(page, 'country', 'is', CHILE)
  const nameRule = await addCondition(page, 'name', 'matches wildcard', 'SAN*')
  await nameRule.getByRole('button', { name: 'Ignore case' }).click()
  await page.getByRole('button', { name: 'Match any' }).click()
  await expect(countLine(page, anyCount, true)).toBeVisible()

  await page.getByRole('button', { name: 'Match all' }).click()
  await nameRule.getByRole('button', { name: 'not', exact: true }).click()
  await expect(countLine(page, chileWithoutSan, true)).toBeVisible()
})

test('a document saved in one tab shows up in another tab, and a removal there shows up here', async ({
  page,
  context,
}) => {
  test.setTimeout(EMBEDDING_SAVE_TIMEOUT_MS)
  const total = readPlaces().length
  await loadPlaces(page)
  await page.goto('/documents')
  await expect(countLine(page, total, false)).toBeVisible()

  const otherTab = await context.newPage()
  await otherTab.goto('/documents')
  await expect(countLine(otherTab, total, false)).toBeVisible()

  await page.getByRole('button', { name: 'New document' }).click()
  await page.getByLabel('Document ID').fill('e2e-harbour-town')
  await page.getByLabel('Fields as JSON').fill(
    JSON.stringify({
      name: 'Harbour Test Town',
      summary: 'Harbour Test Town, Test Coast, Testland.',
      country: 'Testland',
      region: 'Test Coast',
      kind: 'Populated place',
      tags: [],
      population: 4321,
      populations: [1200, 4321],
      location: { lat: 12.5, lon: -45.25 },
    }),
  )
  await page.getByRole('button', { name: 'Save document' }).click()
  await expect(countLine(page, total + 1, false)).toBeVisible({ timeout: EMBEDDING_SAVE_TIMEOUT_MS })
  await expect(countLine(otherTab, total + 1, false)).toBeVisible()

  await otherTab.getByRole('button', { name: 'Filters' }).click()
  await addCondition(otherTab, 'country', 'is', 'Testland')
  await expect(countLine(otherTab, 1, true)).toBeVisible()
  await otherTab.getByRole('button', { name: 'View' }).click()
  await otherTab.getByRole('button', { name: 'Edit document' }).click()
  await expect(otherTab.getByLabel('Fields as JSON')).toHaveValue(/Harbour Test Town/)
  await otherTab.getByRole('button', { name: 'Delete document' }).click()
  await otherTab.getByRole('button', { name: 'Clear all' }).click()
  await expect(countLine(otherTab, total, false)).toBeVisible()

  await expect(countLine(page, total, false)).toBeVisible()
})
