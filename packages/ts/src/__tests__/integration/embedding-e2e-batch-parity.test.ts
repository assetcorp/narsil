import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

type TransformersModule = typeof import('@delali/narsil-embeddings-transformers')
type EmbeddingResult = ReturnType<TransformersModule['createTransformersEmbedding']>
type EmbeddingConfig = Parameters<TransformersModule['createTransformersEmbedding']>[0]

const DIM = 384

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

function lengthOf(vector: Float32Array): number {
  let squared = 0
  for (const value of vector) squared += value * value
  return Math.sqrt(squared)
}

function expectSameVector(actual: Float32Array, expected: Float32Array): void {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 4)
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

  it.each([
    ['a quantised dtype in the pipeline options', { dtype: 'q8' }],
    ['a quantised dtype for one model part', { dtype: { model: 'q8' } }],
    ['full precision in the pipeline options', { dtype: 'fp32' }],
  ])(
    'matches the single and the batched vector under %s',
    async (_label, pipelineOptions) => {
      const mod = await import('@delali/narsil-embeddings-transformers')
      const adapter = mod.createTransformersEmbedding({ dimensions: DIM, pipelineOptions })
      adapters.push(adapter)
      const batched = await adapter.embedBatch(texts, 'document')
      for (let i = 0; i < texts.length; i++) {
        const alone = await adapter.embed(texts[i], 'document')
        expect(cosine(alone, batched[i])).toBeGreaterThan(0.99999)
      }
    },
    120_000,
  )
})

describe.skipIf(!shouldRun)('Embedding E2E: the adapter settings against a real model', () => {
  const adapters: EmbeddingResult[] = []

  async function adapterWith(config: Partial<EmbeddingConfig> = {}): Promise<EmbeddingResult> {
    const mod = await import('@delali/narsil-embeddings-transformers')
    const adapter = mod.createTransformersEmbedding({ dimensions: DIM, ...config })
    adapters.push(adapter)
    return adapter
  }

  afterAll(async () => {
    for (const adapter of adapters) await adapter.shutdown()
  })

  it('puts each prefix on the text of its own purpose, alone and in a batch', async () => {
    const plain = await adapterWith()
    const prefixed = await adapterWith({ documentPrefix: 'passage: ', queryPrefix: 'query: ' })
    const text = texts[0]

    const document = await prefixed.embed(text, 'document')
    const query = await prefixed.embed(text, 'query')
    expectSameVector(document, await plain.embed(`passage: ${text}`, 'document'))
    expectSameVector(query, await plain.embed(`query: ${text}`, 'query'))
    expect(cosine(document, query)).toBeLessThan(0.99999)

    const [batchedDocument] = await prefixed.embedBatch([text], 'document')
    const [batchedQuery] = await prefixed.embedBatch([text], 'query')
    expectSameVector(batchedDocument, document)
    expectSameVector(batchedQuery, query)
  }, 120_000)

  it('gives unit vectors by default, and raw vectors that scale to them when normalize is false', async () => {
    const unit = await (await adapterWith()).embed(texts[1], 'document')
    const raw = await (await adapterWith({ normalize: false })).embed(texts[1], 'document')

    expect(lengthOf(unit)).toBeCloseTo(1, 5)
    expect(Math.abs(lengthOf(raw) - 1)).toBeGreaterThan(0.01)
    const rawLength = lengthOf(raw)
    expectSameVector(
      unit,
      Float32Array.from(raw, value => value / rawLength),
    )
  }, 120_000)

  it('pools with the first token under cls, which differs from the default mean', async () => {
    const mean = await (await adapterWith()).embed(texts[1], 'document')
    const cls = await (await adapterWith({ pooling: 'cls' })).embed(texts[1], 'document')
    expect(lengthOf(cls)).toBeCloseTo(1, 5)
    expect(cosine(mean, cls)).toBeLessThan(0.999)
  }, 120_000)

  it('loads the precision that the settings ask for, from either setting', async () => {
    const full = await (await adapterWith({ dtype: 'fp32' })).embed(texts[1], 'document')
    const quantised = await (await adapterWith({ dtype: 'q8' })).embed(texts[1], 'document')
    const fromOptions = await (await adapterWith({ pipelineOptions: { dtype: 'q8' } })).embed(texts[1], 'document')

    expect(full.some((value, i) => Math.abs(value - quantised[i]) > 1e-5)).toBe(true)
    expectSameVector(quantised, fromOptions)
  }, 120_000)

  it.each([
    128,
    0,
    -1,
    Number.NaN,
  ])('refuses the model output when the configured dimensions are %d', async dimensions => {
    const adapter = await adapterWith({ dimensions })
    await expect(adapter.embed('text', 'document')).rejects.toThrow(/\(384\) do not match/)
    await expect(adapter.embedBatch(['one', 'two'], 'document')).rejects.toThrow(/\(384\) do not match/)
  }, 120_000)

  it.each(['fp32', 'q8'])('refuses a pooling that leaves one vector for each token under %s', async dtype => {
    const adapter = await adapterWith({ dtype, pooling: 'none' as 'mean' })
    await expect(adapter.embed('text', 'document')).rejects.toThrow(/unexpected tensor shape/i)
    await expect(adapter.embedBatch(['one', 'two'], 'document')).rejects.toThrow(/unexpected tensor shape/i)
  }, 120_000)

  it('rejects a device that does not exist', async () => {
    const adapter = await adapterWith({ device: 'not-a-device' as 'cpu' })
    await expect(adapter.embed('text', 'document')).rejects.toThrow()
  }, 120_000)

  it('gives a finite vector for hostile text, the same alone and in a batch', async () => {
    const hostile = ['', '   ', '\u0000\u0000', '\ud800 lone surrogate', '🦀'.repeat(2_000), 'word '.repeat(20_000)]
    const adapter = await adapterWith()
    const batched = await adapter.embedBatch(hostile, 'document')

    expect(batched).toHaveLength(hostile.length)
    for (let i = 0; i < hostile.length; i++) {
      const alone = await adapter.embed(hostile[i], 'document')
      expect(alone).toHaveLength(DIM)
      expect(alone.every(Number.isFinite)).toBe(true)
      expect(cosine(alone, batched[i])).toBeGreaterThan(0.9999)
    }
  }, 120_000)

  it('loads once for calls that arrive together, and again after a shutdown', async () => {
    const readyEvents: unknown[] = []
    const adapter = await adapterWith({
      progress: event => {
        if ((event as { status?: string }).status === 'ready') readyEvents.push(event)
      },
    })

    const [first, second] = await Promise.all([
      adapter.embed(texts[0], 'document'),
      adapter.embed(texts[0], 'document'),
    ])
    await adapter.embed(texts[1], 'document')
    expect(readyEvents).toHaveLength(1)
    expectSameVector(first, second)

    await adapter.shutdown()
    await adapter.shutdown()
    expectSameVector(await adapter.embed(texts[0], 'document'), first)
    expect(readyEvents).toHaveLength(2)
  }, 120_000)

  it('loads the model on the next call after a load fails', async () => {
    const failure = new Error('the model files are unavailable')
    let failNextLoad = true
    const adapter = await adapterWith({
      progress: () => {
        if (!failNextLoad) return
        failNextLoad = false
        throw failure
      },
    })

    await expect(adapter.embed(texts[0], 'document')).rejects.toBe(failure)
    expect(await adapter.embed(texts[0], 'document')).toHaveLength(DIM)
  }, 120_000)

  it('stops after the load when the signal aborts during it, and keeps the loaded model', async () => {
    const controller = new AbortController()
    const reason = new Error('the caller cancelled during the load')
    const readyEvents: unknown[] = []
    const adapter = await adapterWith({
      progress: event => {
        controller.abort(reason)
        if ((event as { status?: string }).status === 'ready') readyEvents.push(event)
      },
    })

    await expect(adapter.embed(texts[0], 'document', controller.signal)).rejects.toBe(reason)
    expect(await adapter.embed(texts[0], 'document')).toHaveLength(DIM)
    expect(readyEvents).toHaveLength(1)
  }, 120_000)

  it('stops a quantised batch between texts once the signal aborts', async () => {
    const adapter = await adapterWith({ dtype: 'q8' })
    await adapter.embed('load the model first', 'document')
    const controller = new AbortController()
    const reason = new Error('the caller cancelled the batch')
    const manyTexts = Array.from({ length: 500 }, (_, i) => `${texts[2]} ${i}`)

    const batch = adapter.embedBatch(manyTexts, 'document', controller.signal)
    setTimeout(() => controller.abort(reason), 0)

    await expect(batch).rejects.toBe(reason)
  }, 120_000)
})
