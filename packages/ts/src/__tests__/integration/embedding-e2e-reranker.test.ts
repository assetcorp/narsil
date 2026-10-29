import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { RerankAdapter } from '../../types/adapters'
import { compareCodePointOrder } from '../rerank/oracle'

const shouldRun = process.env.NARSIL_TEST_EMBEDDINGS === '1'

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
