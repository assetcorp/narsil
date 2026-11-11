import { expect, type Page, test } from '@playwright/test'
import { type Corner, type ExpectedMatches, placesInside, placesWithin } from '../../shared/e2e/geo-oracle'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { DATASET_LOAD_TIMEOUT_MS, loadPlaces } from './app'

const NAIROBI: Corner = { lat: -1.2921, lon: 36.8219 }
const NAIROBI_DISTANCE_KM = 1_500
const IBERIA_QUADRILATERAL: Corner[] = [
  { lat: 44, lon: -10 },
  { lat: 36, lon: -9.5 },
  { lat: 36.5, lon: -1 },
  { lat: 43.5, lon: 3.5 },
]

async function expectMatchesOracle(page: Page, expected: ExpectedMatches): Promise<void> {
  expect(expected.inside.size).toBeGreaterThan(0)
  expect(expected.outside.size).toBeGreaterThan(0)
  const matches = page.getByTestId('map-matches')
  await expect
    .poll(async () => {
      await expect(matches).toHaveAttribute('aria-busy', 'false')
      const found = await matches
        .locator('[data-place-id]')
        .evaluateAll(items => items.map(item => item.getAttribute('data-place-id')))
      const matched = new Set(found.filter((id): id is string => id !== null))
      return {
        missing: [...expected.inside].filter(id => !matched.has(id)),
        unexpected: [...matched].filter(id => expected.outside.has(id)),
      }
    })
    .toEqual({ missing: [], unexpected: [] })
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS)
  await loadPlaces(page)
  await page.goto('/map')
})

test('a distance search over HTTP returns every place that a great-circle check puts inside the circle', async ({
  page,
}) => {
  await page.getByLabel('Centre latitude').fill(String(NAIROBI.lat))
  await page.getByLabel('Centre longitude').fill(String(NAIROBI.lon))
  await page.getByLabel('Distance in kilometres').fill(String(NAIROBI_DISTANCE_KM))
  await expectMatchesOracle(page, placesWithin(readPlaces(), NAIROBI, NAIROBI_DISTANCE_KM))
})

test('a polygon search over HTTP returns every place that a ray-casting check puts inside the corners', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Inside a polygon' }).click()
  await page
    .getByLabel('Polygon corners, one latitude and longitude a line')
    .fill(IBERIA_QUADRILATERAL.map(corner => `${corner.lat}, ${corner.lon}`).join('\n'))
  await expectMatchesOracle(page, placesInside(readPlaces(), IBERIA_QUADRILATERAL))
})
