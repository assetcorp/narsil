import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { RerankAdapter } from '../../types/adapters'
import { compareCodePointOrder } from '../rerank/oracle'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

type RerankerModule = typeof import('@delali/narsil-embeddings-transformers/reranker')
type TransformersReranker = ReturnType<RerankerModule['createTransformersReranker']>
type RerankerConfig = NonNullable<Parameters<RerankerModule['createTransformersReranker']>[0]>

const passages: Record<string, string> = {
  shark: 'Great white sharks hunt seals by ambushing them from below and striking at speed near the surface.',
  elephant: 'African elephants live in herds led by the oldest female and roam the savanna in search of water.',
  pasta: 'Carbonara takes guanciale, egg yolks, Pecorino Romano, and black pepper, and the hot pasta cooks the egg.',
  sushi: 'Sushi rice needs rice vinegar and careful cooling, and a chef serves it slightly warm.',
  wolf: 'Arctic wolves follow caribou herds across the tundra and hunt in packs during the long winter.',
  orca: 'Orcas hunt in family pods and sometimes wash seals off ice floes with coordinated waves.',
}

describe.skipIf(!shouldRun)('reranking with the Transformers.js cross-encoder', () => {
  let narsil: Narsil
  let reranker: RerankAdapter & { shutdown(): Promise<void> }

  beforeAll(async () => {
    const mod = await import('@delali/narsil-embeddings-transformers/reranker')
    reranker = mod.createTransformersReranker()
    await reranker.rerank('warm the model', ['the first call loads the model files'])
    narsil = await createNarsil({ workers: { enabled: false }, rerankAdapters: { minilm: reranker } })
    await narsil.createIndex('passages', { schema: { body: 'string' }, language: 'english' })
    for (const [id, body] of Object.entries(passages)) await narsil.insert('passages', { body }, id)
  }, 180_000)

  afterAll(async () => {
    await narsil?.shutdown()
  }, 180_000)

  it('orders the hits by the model scores, with the hunting passages first', async () => {
    const query = 'how do sharks hunt seals'
    const result = await narsil.query('passages', {
      term: 'hunt seals sharks herds rice',
      termMatch: 'any',
      rerank: { adapter: 'minilm', fields: ['body'], query },
      limit: 10,
    })

    const ids = result.hits.map(hit => hit.id)
    const direct = await reranker.rerank(
      query,
      ids.map(id => passages[id]),
    )
    const expected = ids
      .map((id, i) => ({ id, score: direct[i] }))
      .sort((a, b) => b.score - a.score || compareCodePointOrder(a.id, b.id))
    expect(ids).toEqual(expected.map(hit => hit.id))
    for (const [i, hit] of result.hits.entries()) expect(hit.score).toBeCloseTo(expected[i].score, 5)
    expect(ids[0]).toBe('shark')
    expect(ids.indexOf('orca')).toBeLessThan(ids.indexOf('sushi'))
  }, 180_000)
})

describe.skipIf(!shouldRun)('the Transformers.js reranker settings against a real model', () => {
  const query = 'how do sharks hunt seals'
  const documents = Object.values(passages)
  const adapters: TransformersReranker[] = []

  async function rerankerWith(config: RerankerConfig = {}): Promise<TransformersReranker> {
    const mod = await import('@delali/narsil-embeddings-transformers/reranker')
    const adapter = mod.createTransformersReranker(config)
    adapters.push(adapter)
    return adapter
  }

  afterAll(async () => {
    for (const adapter of adapters) await adapter.shutdown()
  }, 180_000)

  it('gives each document the score it gets alone, in order, across batches', async () => {
    const batched = await (await rerankerWith({ batchSize: 2 })).rerank(query, documents)
    const whole = await rerankerWith()

    expect(batched).toHaveLength(documents.length)
    for (const [i, document] of documents.entries()) {
      const [alone] = await whole.rerank(query, [document])
      expect(batched[i]).toBeCloseTo(alone, 4)
    }
    const reversed = await whole.rerank(query, [...documents].reverse())
    for (const [i, score] of [...reversed].reverse().entries()) expect(score).toBeCloseTo(batched[i], 4)
  }, 180_000)

  it('returns logits that the logistic function turns into the default scores', async () => {
    const scores = await (await rerankerWith()).rerank(query, documents)
    const logits = await (await rerankerWith({ activation: 'none' })).rerank(query, documents)

    expect(logits.some(logit => logit < 0 || logit > 1)).toBe(true)
    for (const [i, logit] of logits.entries()) {
      expect(scores[i]).toBeGreaterThanOrEqual(0)
      expect(scores[i]).toBeLessThanOrEqual(1)
      expect(scores[i]).toBeCloseTo(1 / (1 + Math.exp(-logit)), 5)
    }
  }, 180_000)

  it('ignores the text beyond maxLength, and reads it without the limit', async () => {
    const opening = passages.pasta
    const endings = [`${opening} ${passages.shark}`, `${opening} ${passages.sushi}`]

    const [capped, cappedOther] = await (await rerankerWith({ maxLength: 16 })).rerank(query, endings)
    expect(capped).toBeCloseTo(cappedOther, 5)

    const [full, fullOther] = await (await rerankerWith()).rerank(query, endings)
    expect(Math.abs(full - fullOther)).toBeGreaterThan(1e-4)
  }, 180_000)

  it('gives a finite score for hostile text', async () => {
    const hostile = ['', '   ', '\u0000\u0000', '\ud800 lone surrogate', '🦀'.repeat(2_000), 'word '.repeat(20_000)]
    const reranker = await rerankerWith()

    for (const hostileQuery of ['', query, 'word '.repeat(20_000)]) {
      const scores = await reranker.rerank(hostileQuery, hostile)
      expect(scores).toHaveLength(hostile.length)
      for (const score of scores) {
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
      }
    }
  }, 180_000)

  it('stops between batches once the signal aborts', async () => {
    const reranker = await rerankerWith({ batchSize: 1 })
    await reranker.rerank(query, ['load the model first'])
    const controller = new AbortController()
    const reason = new Error('the caller cancelled the rerank')
    const manyDocuments = Array.from({ length: 500 }, (_, i) => `${passages.shark} ${i}`)

    const scoring = reranker.rerank(query, manyDocuments, controller.signal)
    setTimeout(() => controller.abort(reason), 0)

    await expect(scoring).rejects.toBe(reason)
  }, 180_000)

  it('loads once for calls that arrive together, and again after a shutdown', async () => {
    const modelLoads: unknown[] = []
    const reranker = await rerankerWith({
      progress: event => {
        const { status, file } = event as { status?: string; file?: string }
        if (status === 'initiate' && file?.endsWith('.onnx')) modelLoads.push(event)
      },
    })

    const [first, second] = await Promise.all([
      reranker.rerank(query, [passages.shark]),
      reranker.rerank(query, [passages.shark]),
    ])
    await reranker.rerank(query, [passages.pasta])
    expect(modelLoads).toHaveLength(1)
    expect(first[0]).toBeCloseTo(second[0], 5)

    await reranker.shutdown()
    await reranker.shutdown()
    const [reloaded] = await reranker.rerank(query, [passages.shark])
    expect(reloaded).toBeCloseTo(first[0], 5)
    expect(modelLoads).toHaveLength(2)
  }, 180_000)

  it('loads the model on the next call after a load fails', async () => {
    const failure = new Error('the model files are unavailable')
    let failNextLoad = true
    const reranker = await rerankerWith({
      progress: () => {
        if (!failNextLoad) return
        failNextLoad = false
        throw failure
      },
    })

    await expect(reranker.rerank(query, [passages.shark])).rejects.toBe(failure)
    expect(await reranker.rerank(query, [passages.shark])).toHaveLength(1)
  }, 180_000)

  it('rejects a device that does not exist', async () => {
    const reranker = await rerankerWith({ device: 'not-a-device' as 'cpu' })
    await expect(reranker.rerank(query, [passages.shark])).rejects.toThrow()
  }, 180_000)
})
