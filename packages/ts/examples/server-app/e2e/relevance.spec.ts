import { expect, type Page, test } from '@playwright/test'
import { placeIdsWhere, readPlaces } from '../../shared/e2e/places-oracle'
import { DATASET_LOAD_TIMEOUT_MS, loadPlaces } from './app'

const QUERY = 'victoria'
const QUERY_WORD = /\bvictoria\b/i
const SEARCHED_FIELDS = ['name', 'summary', 'country', 'region']

async function setBoost(page: Page, field: string, key: 'Home' | 'End'): Promise<void> {
  const slider = page.getByRole('slider', { name: `Boost for ${field}` })
  await slider.focus()
  await slider.press(key)
}

async function topTunedIds(page: Page, count: number): Promise<string[]> {
  const ids = await page
    .getByTestId('rank-row')
    .evaluateAll(rows => rows.map(row => row.getAttribute('data-doc-id')).filter(id => id !== null))
  return ids.slice(0, count).sort()
}

async function boostOnly(page: Page, boosted: string): Promise<void> {
  for (const field of SEARCHED_FIELDS) await setBoost(page, field, field === boosted ? 'End' : 'Home')
}

test('boosting one field for a single query over HTTP ranks the places that match in that field first', async ({
  page,
}) => {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS)
  const places = readPlaces()
  const matching = placeIdsWhere(places, place => QUERY_WORD.test(place.summary))
  const namedVictoria = placeIdsWhere(places, place => QUERY_WORD.test(place.name))
  const inVictoriaRegion = placeIdsWhere(places, place => QUERY_WORD.test(place.region ?? ''))
  expect(namedVictoria.some(id => inVictoriaRegion.includes(id))).toBe(false)

  await loadPlaces(page)
  await page.goto('/relevance')
  await page.getByPlaceholder('Enter a query to analyze scoring...').fill(QUERY)
  await expect(page.getByText(`${matching.length} results in`, { exact: false })).toBeVisible()

  await boostOnly(page, 'region')
  await expect.poll(() => topTunedIds(page, inVictoriaRegion.length)).toEqual(inVictoriaRegion)

  await boostOnly(page, 'name')
  await expect.poll(() => topTunedIds(page, namedVictoria.length)).toEqual(namedVictoria)
})
