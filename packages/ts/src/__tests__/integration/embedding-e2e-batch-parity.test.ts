import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

type TransformersModule = typeof import('@delali/narsil-embeddings-transformers')
type EmbeddingResult = ReturnType<TransformersModule['createTransformersEmbedding']>

const texts = [
  'Waterproof hiking boots',
  'A lightweight trail running shoe with a grippy outsole for wet rock',
  'Insulated winter jacket rated to minus twenty degrees, with a detachable hood and taped seams',
  'Tent',
]

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / Math.sqrt(normA * normB)
}

describe.skipIf(!shouldRun)('Embedding E2E: one text gives one vector alone or in a batch', () => {
  const adapters: EmbeddingResult[] = []

  async function adapterFor(dtype?: string): Promise<EmbeddingResult> {
    const mod = await import('@delali/narsil-embeddings-transformers')
    const adapter = mod.createTransformersEmbedding({ dimensions: 384, ...(dtype === undefined ? {} : { dtype }) })
    adapters.push(adapter)
    return adapter
  }

  beforeAll(async () => {
    await adapterFor()
  }, 120_000)

  afterAll(async () => {
    for (const adapter of adapters) await adapter.shutdown()
  })

  it.each([
    ['the default precision', undefined],
    ['8-bit quantisation', 'q8'],
    ['full precision', 'fp32'],
  ])(
    'matches the single and the batched vector under %s',
    async (_label, dtype) => {
      const adapter = await adapterFor(dtype)
      const batched = await adapter.embedBatch(texts, 'document')
      for (let i = 0; i < texts.length; i++) {
        const alone = await adapter.embed(texts[i], 'document')
        expect(cosine(alone, batched[i])).toBeGreaterThan(0.99999)
      }
    },
    120_000,
  )
})
