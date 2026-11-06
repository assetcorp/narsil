import { expect, type Page, test } from '@playwright/test'
import { cosine, type OraclePlace, readPlaces, readStoredVectors } from '../../shared/e2e/places-oracle'
import {
  chooseOption,
  DATASET_LOAD_TIMEOUT_MS,
  loadPlaces,
  openSearchOptions,
  resultIds,
  searchFor,
  searchOptionsToggle,
} from './app'

const VECTOR_SEARCH_TIMEOUT_MS = 240_000
const SIMILARITY_FLOOR = 0.73
const SIMILARITY_MARGIN = 0.02
const BRAZIL = 'Brazil'
const GROUPS_SHOWN_COLLAPSED = 10
const EXPANDED_GROUP_SUMMARY_MAX_HEIGHT_PX = 560

function brazilPlaces(): OraclePlace[] {
  return readPlaces().filter(place => place.country === BRAZIL)
}

async function openSearchPage(page: Page): Promise<void> {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS + VECTOR_SEARCH_TIMEOUT_MS)
  await loadPlaces(page)
  await page.goto('/search')
  await openSearchOptions(page)
}

test('group rows name each place, open its detail, and list ten groups until the tester asks for all', async ({
  page,
}) => {
  const places = brazilPlaces()
  const nameById = new Map(places.map(place => [place.id, place.name]))
  const regionById = new Map(places.map(place => [place.id, place.region ?? 'no value']))
  const regions = new Set(regionById.values())
  expect(regions.size).toBeGreaterThan(GROUPS_SHOWN_COLLAPSED)

  await openSearchPage(page)
  await searchFor(page, 'brazil')
  await chooseOption(page, 'Group by', 'region')

  const rows = page.getByTestId('group-row')
  await expect(rows).toHaveCount(GROUPS_SHOWN_COLLAPSED)
  const firstHit = page.getByTestId('group-hit').first()
  const firstId = (await firstHit.getAttribute('data-doc-id')) ?? ''
  await firstHit.click()
  await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toHaveText(
    nameById.get(firstId) ?? 'unknown place',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: `Show all ${regions.size} groups` }).click()
  await expect(rows).toHaveCount(regions.size)
  const shown = await rows.evaluateAll(elements =>
    elements.map(row => ({
      region: row.querySelector('[data-testid="group-value"]')?.textContent ?? '',
      hits: [...row.querySelectorAll('[data-testid="group-hit"]')].map(hit => [
        hit.getAttribute('data-doc-id') ?? '',
        hit.textContent ?? '',
      ]),
    })),
  )
  expect(new Set(shown.map(row => row.region))).toEqual(regions)
  for (const row of shown) {
    expect(row.hits.length).toBeGreaterThan(0)
    for (const [id, text] of row.hits) {
      expect(text).toBe(nameById.get(id))
      expect(regionById.get(id)).toBe(row.region)
    }
  }
  const expandedBox = await page.getByTestId('group-summary').boundingBox()
  expect(expandedBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(EXPANDED_GROUP_SUMMARY_MAX_HEIGHT_PX)

  await page.getByRole('button', { name: `Show the first ${GROUPS_SHOWN_COLLAPSED} groups` }).click()
  await expect(rows).toHaveCount(GROUPS_SHOWN_COLLAPSED)
})

test('a counted field stays on after the search options close, and the header counts it as changed', async ({
  page,
}) => {
  const counts = new Map<string, number>()
  for (const place of brazilPlaces()) counts.set(place.kind, (counts.get(place.kind) ?? 0) + 1)

  await openSearchPage(page)
  await searchFor(page, 'brazil')
  await chooseOption(page, 'Count values of', 'kind')
  await searchOptionsToggle(page).click()
  await expect(page.getByTestId('ranking-options')).toBeHidden()
  await expect(page.getByTestId('search-options-changed')).toHaveText('· 1 changed')

  const sidebar = page.getByTestId('facet-sidebar').first()
  await expect(sidebar.getByRole('button')).toHaveCount(counts.size)
  for (const [kind, count] of counts) {
    await expect(sidebar.getByRole('button', { name: new RegExp(`^${kind}\\s*${count}$`) })).toBeVisible()
  }

  await openSearchOptions(page)
  await expect(page.getByRole('combobox', { name: 'Count values of' })).toHaveText('kind')
  await expect(page.getByTestId('search-options-changed')).toHaveText('· 1 changed')
})

test('vector search through the local model keeps only the places above the similarity floor', async ({ page }) => {
  test.setTimeout(DATASET_LOAD_TIMEOUT_MS + VECTOR_SEARCH_TIMEOUT_MS)
  await loadPlaces(page)
  await page.goto('/search')

  const places = readPlaces()
  const stored = readStoredVectors()
  const queryPosition = places.findIndex(place => place.name === 'Venice')
  const query = places[queryPosition]
  expect(query).toBeDefined()
  const queryVector = stored.vectorAt(queryPosition)
  const similarity = new Map(
    places.map((place, position) => [place.id, cosine(queryVector, stored.vectorAt(position))]),
  )
  const mustMatch = places.filter(place => (similarity.get(place.id) ?? 0) >= SIMILARITY_FLOOR + SIMILARITY_MARGIN)
  expect(mustMatch.length).toBeGreaterThan(1)

  await page.getByRole('button', { name: 'Vector', exact: true }).click()
  await page.getByLabel('Similarity floor').fill(String(SIMILARITY_FLOOR))
  await searchFor(page, query?.summary ?? '')

  await expect(page.getByTestId('result-card').first()).toHaveAttribute('data-doc-id', query?.id ?? '', {
    timeout: VECTOR_SEARCH_TIMEOUT_MS,
  })
  const ids = await resultIds(page)
  for (const place of mustMatch) expect(ids).toContain(place.id)
  for (const id of ids) expect(similarity.get(id) ?? 0).toBeGreaterThanOrEqual(SIMILARITY_FLOOR - SIMILARITY_MARGIN)
})
