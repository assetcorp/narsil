import { expect, test } from '@playwright/test'
import { cosine, readPlaces, readStoredVectors } from '../../shared/e2e/places-oracle'
import { DATASET_LOAD_TIMEOUT_MS, loadPlaces, resultIds, searchFor } from './app'

const VECTOR_SEARCH_TIMEOUT_MS = 240_000
const SIMILARITY_FLOOR = 0.73
const SIMILARITY_MARGIN = 0.02

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
