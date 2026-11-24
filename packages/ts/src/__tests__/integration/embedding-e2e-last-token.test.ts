import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

type TransformersModule = typeof import('@delali/narsil-embeddings-transformers')
type EmbeddingResult = ReturnType<TransformersModule['createTransformersEmbedding']>
type EmbeddingConfig = Parameters<TransformersModule['createTransformersEmbedding']>[0]

interface SentenceTransformersReference {
  model: string
  library: string
  texts: string[]
  vectors: number[][]
}

const reference: SentenceTransformersReference = JSON.parse(
  readFileSync(new URL('./embedding-e2e-last-token-reference.json', import.meta.url), 'utf8'),
)

const QWEN3_ONNX_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
const QWEN3_DIMENSIONS = 1024
const SAME_DIRECTION = 0.9999
const MINILM_DIMENSIONS = 384

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
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

describe.skipIf(!shouldRun)('Embedding E2E: last-token pooling', () => {
  const adapters: EmbeddingResult[] = []

  async function adapterWith(config: EmbeddingConfig): Promise<EmbeddingResult> {
    const mod = await import('@delali/narsil-embeddings-transformers')
    const adapter = mod.createTransformersEmbedding(config)
    adapters.push(adapter)
    return adapter
  }

  afterAll(async () => {
    for (const adapter of adapters) await adapter.shutdown()
  })

  it('gives the vectors that Sentence Transformers gives for Qwen3-Embedding, alone and in a batch', async () => {
    const adapter = await adapterWith({
      model: QWEN3_ONNX_MODEL,
      dimensions: QWEN3_DIMENSIONS,
      dtype: 'fp16',
      pooling: 'last_token',
    })
    const batched = await adapter.embedBatch(reference.texts, 'document')
    for (let i = 0; i < reference.texts.length; i++) {
      const alone = await adapter.embed(reference.texts[i], 'document')
      expect(cosine(alone, reference.vectors[i]), reference.texts[i]).toBeGreaterThan(SAME_DIRECTION)
      expect(cosine(batched[i], reference.vectors[i]), reference.texts[i]).toBeGreaterThan(SAME_DIRECTION)
    }
  }, 600_000)

  it('pools each text of a batch at its own last token when the tokenizer pads on the right', async () => {
    const adapter = await adapterWith({ dimensions: MINILM_DIMENSIONS, pooling: 'last_token' })
    const batched = await adapter.embedBatch(reference.texts, 'document')
    for (let i = 0; i < reference.texts.length; i++) {
      const alone = await adapter.embed(reference.texts[i], 'document')
      expect(cosine(alone, batched[i]), reference.texts[i]).toBeGreaterThan(0.99999)
    }
  }, 120_000)
})
