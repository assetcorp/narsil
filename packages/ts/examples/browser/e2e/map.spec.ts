import { expect, type Page, test } from '@playwright/test'
import { type Corner, type ExpectedMatches, placesInside, placesWithin } from '../../shared/e2e/geo-oracle'
import { readPlaces } from '../../shared/e2e/places-oracle'
import { loadPlaces } from './app'

const PARIS: Corner = { lat: 48.8566, lon: 2.3522 }
const PARIS_DISTANCE_KM = 900
const SOUTH_AMERICA_TRIANGLE: Corner[] = [
  { lat: 12, lon: -82 },
  { lat: -56, lon: -76 },
  { lat: -6, lon: -34 },
]

async function matchedIds(page: Page): Promise<Set<string>> {
  const matches = page.getByTestId('map-matches')
  await expect(matches).toHaveAttribute('aria-busy', 'false')
  const ids = await matches
    .locator('[data-place-id]')
    .evaluateAll(items => items.map(item => item.getAttribute('data-place-id')))
  return new Set(ids.filter((id): id is string => id !== null))
}

async function expectMatchesOracle(page: Page, expected: ExpectedMatches): Promise<void> {
  expect(expected.inside.size).toBeGreaterThan(0)
  expect(expected.outside.size).toBeGreaterThan(0)
  await expect
    .poll(async () => {
      const matched = await matchedIds(page)
      return {
        missing: [...expected.inside].filter(id => !matched.has(id)),
        unexpected: [...matched].filter(id => expected.outside.has(id)),
      }
    })
    .toEqual({ missing: [], unexpected: [] })
}

test.beforeEach(async ({ page }) => {
  await loadPlaces(page)
  await page.goto('/map')
})

test('a distance search returns every place that a great-circle check puts inside the circle', async ({ page }) => {
  await page.getByLabel('Centre latitude').fill(String(PARIS.lat))
  await page.getByLabel('Centre longitude').fill(String(PARIS.lon))
  await page.getByLabel('Distance in kilometres').fill(String(PARIS_DISTANCE_KM))
  await expectMatchesOracle(page, placesWithin(readPlaces(), PARIS, PARIS_DISTANCE_KM))
})

test('a polygon search returns every place that a ray-casting check puts inside the corners', async ({ page }) => {
  await page.getByRole('button', { name: 'Inside a polygon' }).click()
  await page
    .getByLabel('Polygon corners, one latitude and longitude a line')
    .fill(SOUTH_AMERICA_TRIANGLE.map(corner => `${corner.lat}, ${corner.lon}`).join('\n'))
  await expectMatchesOracle(page, placesInside(readPlaces(), SOUTH_AMERICA_TRIANGLE))
})
