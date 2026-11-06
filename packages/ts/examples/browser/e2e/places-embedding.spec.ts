import { expect, test } from '@playwright/test'
import { cosine, largestDifference, readPlaces, readStoredVectors } from '../../shared/e2e/places-oracle'

const SAMPLED_PLACE_POSITIONS = [0, 311, 640, 977, 1250]
const MIN_COSINE = 0.9995
const MAX_COMPONENT_DIFFERENCE = 0.005
const MODEL_DOWNLOAD_TIMEOUT_MS = 240_000
const EMBEDDING_MODULE_PATH = '/src/worker/local-embedding.ts'

test('the browser embeds place summaries to the vectors stored in places-vectors-384.bin', async ({ page }) => {
  test.setTimeout(MODEL_DOWNLOAD_TIMEOUT_MS)
  const places = readPlaces()
  const stored = readStoredVectors()
  expect(stored.count).toBe(places.length)
  expect(stored.dimensions).toBe(384)

  const summaries = SAMPLED_PLACE_POSITIONS.map(position => places[position]?.summary ?? '')
  await page.goto('/')
  const embedded = await page.evaluate(
    async ({ texts, modulePath }) => {
      const module = await import(modulePath)
      const embedding = module.createPlacesEmbedding()
      const vectors: number[][] = []
      for (const text of texts) vectors.push(Array.from(await embedding.embed(text, 'document')))
      return vectors
    },
    { texts: summaries, modulePath: EMBEDDING_MODULE_PATH },
  )

  SAMPLED_PLACE_POSITIONS.forEach((position, sample) => {
    const browserVector = embedded[sample] ?? []
    const storedVector = stored.vectorAt(position)
    expect(browserVector, places[position]?.name).toHaveLength(384)
    expect(cosine(browserVector, storedVector), places[position]?.name).toBeGreaterThanOrEqual(MIN_COSINE)
    expect(largestDifference(browserVector, storedVector), places[position]?.name).toBeLessThanOrEqual(
      MAX_COMPONENT_DIFFERENCE,
    )
  })
})
