import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

type TransformersModule = typeof import('@delali/narsil-embeddings-transformers')
type EmbeddingResult = ReturnType<TransformersModule['createTransformersEmbedding']>

const DIM = 384

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  category: 'enum',
  embedding: `vector[${DIM}]`,
}

const animalDocs = [
  {
    title: 'African elephants in the savanna',
    body: 'African elephants are the largest land animals on Earth. They live in herds across sub-Saharan Africa and are known for their intelligence and complex social structures.',
    category: 'animals',
  },
  {
    title: 'Great white sharks and ocean predators',
    body: 'Great white sharks are apex predators found in coastal waters around the world. They can detect a single drop of blood in 25 gallons of water.',
    category: 'animals',
  },
  {
    title: 'Migration patterns of arctic wolves',
    body: 'Arctic wolves travel hundreds of miles following caribou herds across the frozen tundra. Their thick white fur protects them from temperatures dropping to negative 50 degrees.',
    category: 'animals',
  },
  {
    title: 'Behavioral ecology of chimpanzees',
    body: 'Chimpanzees use tools, communicate with gestures, and exhibit cultural behaviors passed between generations. They share 98.7 percent of their DNA with humans.',
    category: 'animals',
  },
]

const cookingDocs = [
  {
    title: 'Traditional Italian pasta carbonara',
    body: 'Authentic carbonara uses guanciale, egg yolks, Pecorino Romano cheese, and black pepper. The heat from the pasta cooks the egg mixture into a creamy sauce.',
    category: 'cooking',
  },
  {
    title: 'Japanese sushi preparation techniques',
    body: 'Proper sushi rice requires precise water ratios, rice vinegar seasoning, and hand-fanning during cooling. The rice should be slightly warm when served.',
    category: 'cooking',
  },
  {
    title: 'French pastry and bread baking fundamentals',
    body: 'Laminated doughs like croissants require repeated folding and chilling to create flaky layers. Butter temperature and flour hydration are critical variables.',
    category: 'cooking',
  },
  {
    title: 'Thai curry paste from scratch',
    body: 'Thai red curry paste combines dried chilies, lemongrass, galangal, shallots, garlic, and shrimp paste. Grinding with a mortar and pestle develops the deepest flavors.',
    category: 'cooking',
  },
]

const astronomyDocs = [
  {
    title: 'Black holes and event horizons explained',
    body: 'A black hole forms when a massive star collapses under its own gravity. The event horizon marks the boundary beyond which nothing can escape, not even light.',
    category: 'astronomy',
  },
  {
    title: 'Discovery of exoplanets using the transit method',
    body: 'The transit method detects exoplanets by measuring dips in starlight as a planet passes in front of its host star. Kepler discovered thousands of exoplanets this way.',
    category: 'astronomy',
  },
  {
    title: 'Neutron stars and pulsars in deep space',
    body: 'Neutron stars are remnants of supernova explosions. Pulsars are rapidly rotating neutron stars that emit beams of electromagnetic radiation detectable from Earth.',
    category: 'astronomy',
  },
  {
    title: 'The cosmic microwave background radiation',
    body: 'The cosmic microwave background is the thermal radiation left over from the Big Bang. It provides a snapshot of the universe when it was 380,000 years old.',
    category: 'astronomy',
  },
  {
    title: 'Mars rover explorations and geological findings',
    body: 'NASA rovers like Curiosity and Perseverance have found evidence of ancient riverbeds, organic molecules, and seasonal methane fluctuations on the Martian surface.',
    category: 'astronomy',
  },
]

const allDocs = [...animalDocs, ...cookingDocs, ...astronomyDocs]

const categoryMap = new Map<string, Set<string>>()

describe.skipIf(!shouldRun)('Embedding E2E: auto-vectorization with Transformers.js', () => {
  let narsil: Narsil
  let embeddingResult: EmbeddingResult

  beforeAll(async () => {
    const mod = await import('@delali/narsil-embeddings-transformers')
    embeddingResult = mod.createTransformersEmbedding({
      dimensions: DIM,
      dtype: 'q8',
    })
  })

  afterAll(async () => {
    await embeddingResult.shutdown()
  })

  beforeEach(async () => {
    const indexConfig: IndexConfig = {
      schema,
      language: 'english',
      embedding: {
        adapter: embeddingResult,
        fields: { embedding: ['title', 'body'] },
      },
    }

    narsil = await createNarsil()
    await narsil.createIndex('docs', indexConfig)

    const batchResult = await narsil.insertBatch('docs', allDocs)
    expect(batchResult.failed).toHaveLength(0)
    expect(batchResult.succeeded).toHaveLength(allDocs.length)
    const matchingIds = batchResult.succeeded

    for (let i = 0; i < allDocs.length; i++) {
      const id = matchingIds[i]
      const cat = allDocs[i].category as string
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, new Set())
      }
      const catSet = categoryMap.get(cat)
      if (catSet) {
        catSet.add(id)
      }
    }
  }, 120_000)

  afterEach(async () => {
    await narsil.shutdown()
    categoryMap.clear()
  })

  it('inserts all documents with auto-vectorization', async () => {
    const count = await narsil.countDocuments('docs')
    expect(count).toBe(allDocs.length)
  })

  it('retrieves semantically relevant animal results for animal queries', async () => {
    const result = await narsil.query('docs', {
      vector: { field: 'embedding', text: 'wildlife animals nature habitat' },
      mode: 'vector',
      limit: 5,
    })

    expect(result.hits.length).toBeGreaterThan(0)

    const animalIds = categoryMap.get('animals')
    if (!animalIds) throw new Error('No animal IDs found in category map')

    const topHitCategories = result.hits.slice(0, 3).map(hit => {
      const doc = hit.document as Record<string, unknown>
      return doc.category as string
    })

    const animalCount = topHitCategories.filter(c => c === 'animals').length
    expect(animalCount).toBeGreaterThanOrEqual(2)
  })

  it('retrieves semantically relevant cooking results for food queries', async () => {
    const result = await narsil.query('docs', {
      vector: { field: 'embedding', text: 'recipes ingredients kitchen cooking food' },
      mode: 'vector',
      limit: 5,
    })

    expect(result.hits.length).toBeGreaterThan(0)

    const topHitCategories = result.hits.slice(0, 3).map(hit => {
      const doc = hit.document as Record<string, unknown>
      return doc.category as string
    })

    const cookingCount = topHitCategories.filter(c => c === 'cooking').length
    expect(cookingCount).toBeGreaterThanOrEqual(2)
  })

  it('retrieves semantically relevant astronomy results for space queries', async () => {
    const result = await narsil.query('docs', {
      vector: { field: 'embedding', text: 'outer space stars galaxies universe' },
      mode: 'vector',
      limit: 5,
    })

    expect(result.hits.length).toBeGreaterThan(0)

    const topHitCategories = result.hits.slice(0, 3).map(hit => {
      const doc = hit.document as Record<string, unknown>
      return doc.category as string
    })

    const astroCount = topHitCategories.filter(c => c === 'astronomy').length
    expect(astroCount).toBeGreaterThanOrEqual(2)
  })

  it('ranks relevant category higher than irrelevant categories', async () => {
    const result = await narsil.query('docs', {
      vector: { field: 'embedding', text: 'marine biology ocean creatures underwater' },
      mode: 'vector',
      limit: allDocs.length,
    })

    expect(result.hits.length).toBeGreaterThan(0)

    let bestAnimalScore = 0
    let bestCookingScore = 0

    for (const hit of result.hits) {
      const doc = hit.document as Record<string, unknown>
      const cat = doc.category as string
      if (cat === 'animals' && hit.score > bestAnimalScore) {
        bestAnimalScore = hit.score
      }
      if (cat === 'cooking' && hit.score > bestCookingScore) {
        bestCookingScore = hit.score
      }
    }

    expect(bestAnimalScore).toBeGreaterThan(bestCookingScore)
  })

  it('produces results in hybrid search mode', async () => {
    const result = await narsil.query('docs', {
      term: 'pasta',
      vector: { field: 'embedding', text: 'Italian food and cooking' },
      mode: 'hybrid',
      hybrid: { alpha: 0.5 },
      limit: 5,
    })

    expect(result.hits.length).toBeGreaterThan(0)

    const topDoc = result.hits[0].document as Record<string, unknown>
    expect(topDoc.category).toBe('cooking')
  })

  it('returns scored results with positive scores', async () => {
    const result = await narsil.query('docs', {
      vector: { field: 'embedding', text: 'planets and solar system' },
      mode: 'vector',
      limit: 3,
    })

    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThan(0)
    }
  })
})
