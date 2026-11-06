import { expect, test } from '@playwright/test'
import { cosine, type OraclePlace, readPlaces, readStoredVectors } from '../../shared/e2e/places-oracle'
import { chooseOption, loadPlaces, numberIn, resultIds, searchFor } from './app'

const BRAZIL = 'Brazil'
const VECTOR_SEARCH_TIMEOUT_MS = 240_000
const SIMILARITY_FLOOR = 0.73
const SIMILARITY_MARGIN = 0.02

function brazilPlaces(): OraclePlace[] {
  return readPlaces().filter(place => place.country === BRAZIL)
}

test.beforeEach(async ({ page }) => {
  await loadPlaces(page)
  await page.goto('/search')
})

test('group totals add up the population of every place in each region', async ({ page }) => {
  const expected = new Map<string, number>()
  for (const place of brazilPlaces()) {
    const region = place.region ?? 'no value'
    expected.set(region, (expected.get(region) ?? 0) + place.population)
  }

  await searchFor(page, 'brazil')
  await chooseOption(page, 'Group by', 'region')
  await chooseOption(page, 'Group total of', 'population')

  const rows = page.getByTestId('group-row')
  await expect(rows).toHaveCount(expected.size)
  const shown = await rows.evaluateAll(elements =>
    elements.map(row => [
      row.querySelector('[data-testid="group-value"]')?.textContent ?? '',
      row.querySelector('[data-testid="group-total"]')?.textContent ?? '',
    ]),
  )
  const totals = new Map(shown.map(([region, total]) => [region, numberIn(total)]))
  expect(totals).toEqual(expected)
})

test('range facets count each population band and the chosen band filters the results', async ({ page }) => {
  const bands = [
    { from: 0, to: 1_000_000 },
    { from: 1_000_000, to: 100_000_000 },
  ]
  const places = brazilPlaces()
  const counts = bands.map(
    band => places.filter(place => place.population >= band.from && place.population < band.to).length,
  )

  await searchFor(page, 'brazil')
  await chooseOption(page, 'Count values of', 'population')
  await page.getByLabel('Ranges, such as 0 to 100000, 100000 to 1000000').fill('0 to 1000000, 1000000 to 100000000')

  const sidebar = page.getByTestId('facet-sidebar').first()
  for (const [position, band] of bands.entries()) {
    const button = sidebar.getByRole('button', { name: new RegExp(`^${band.from}-${band.to}\\b`) })
    await expect(button).toContainText(String(counts[position]))
  }

  await sidebar.getByRole('button', { name: /^1000000-100000000\b/ }).click()
  await expect(page.getByText(`${counts[1]} result${counts[1] === 1 ? '' : 's'}`, { exact: true })).toBeVisible()
})

test('a quoted phrase finds only the places whose text holds those words in that order', async ({ page }) => {
  const inOrder = readPlaces().filter(place => /\bsouth africa\b/i.test(place.summary)).length
  expect(inOrder).toBeGreaterThan(1)

  await searchFor(page, '"south africa"')
  await expect(page.getByText(`${inOrder} results`, { exact: true })).toBeVisible()

  await searchFor(page, '"africa south"')
  await expect(page.getByTestId('result-card')).toHaveCount(0)
})

test('a pinned place takes the position that the tester chose', async ({ page }) => {
  const accra = readPlaces().find(place => place.name === 'Accra' && place.country === 'Ghana')
  expect(accra).toBeDefined()
  const pinnedId = accra?.id ?? ''

  await searchFor(page, 'brazil')
  await expect(page.getByTestId('result-card').first()).toBeVisible()
  expect(await resultIds(page)).not.toContain(pinnedId)

  await page.getByLabel('Pinned document ID').fill(pinnedId)
  await page.getByLabel('Pinned position').fill('3')
  await expect.poll(async () => (await resultIds(page))[2]).toBe(pinnedId)
})

test('sorting by the lowest value of a list field orders places by their smallest population', async ({ page }) => {
  const smallest = new Map(brazilPlaces().map(place => [place.id, Math.min(...place.populations)]))
  const lowest = Math.min(...smallest.values())

  await searchFor(page, 'brazil')
  await chooseOption(page, 'Sort by list field', 'populations')
  await chooseOption(page, 'List value to sort by', 'min')
  await page.getByRole('button', { name: 'Highest first' }).click()

  await expect.poll(async () => smallest.get((await resultIds(page))[0] ?? '')).toBe(lowest)
  const values = (await resultIds(page)).map(id => smallest.get(id) ?? Number.NaN)
  expect(values.every((value, position) => position === 0 || value >= (values[position - 1] ?? 0))).toBe(true)
})

test('vector search keeps only the places above the similarity floor', async ({ page }) => {
  test.setTimeout(VECTOR_SEARCH_TIMEOUT_MS)
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
