import { expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import {
  type NativeOperation,
  nativeSearchCoreIsEnabled,
  observeFallbacks,
  setNativeSearchCoreEnabled,
} from '../../vector/native/backend'
import { expectedFusion, fusionDocuments, fusionIndex, fusionQuery } from './hybrid-fusion-fixtures'

it('normalises infinite, cancelled, and finite overflowed score ranges without losing documents', async () => {
  const engine = await createNarsil({ workers: { enabled: false } })
  const fallbacks: NativeOperation[] = []
  observeFallbacks(operation => {
    if (nativeSearchCoreIsEnabled()) fallbacks.push(operation)
  })
  try {
    await engine.createIndex('products', fusionIndex)
    expect((await engine.insertBatch('products', fusionDocuments)).failed).toEqual([])
    for (const scale of [Number.MAX_VALUE, Number.MAX_VALUE / 8]) {
      const { vector: _vector, hybrid: _hybrid, ...text } = fusionQuery(scale, 0.5)
      const raw = await engine.query('products', text)
      const byId = new Map(raw.hits.map(hit => [hit.id, hit.score]))
      if (scale === Number.MAX_VALUE) {
        expect(byId.get('positive')).toBe(Infinity)
        expect(byId.get('negative')).toBe(-Infinity)
        expect(byId.get('cancelled')).toBeNaN()
      } else {
        const positive = byId.get('positive')
        const negative = byId.get('negative')
        expect(Number.isFinite(positive)).toBe(true)
        expect(Number.isFinite(negative)).toBe(true)
        if (positive === undefined || negative === undefined) throw new Error('The matching documents are absent')
        expect(positive - negative).toBe(Infinity)
      }
      const answer = await engine.query('products', fusionQuery(scale, 0.5))
      expect(answer.hits.map(({ id, score }) => ({ id, score }))).toEqual(
        expectedFusion(0.5, scale === Number.MAX_VALUE),
      )
      const enabled = nativeSearchCoreIsEnabled()
      setNativeSearchCoreEnabled(false)
      try {
        const portable = await engine.query('products', fusionQuery(scale, 0.5))
        expect(portable.hits.map(({ id, score }) => ({ id, score }))).toEqual(
          answer.hits.map(({ id, score }) => ({ id, score })),
        )
      } finally {
        setNativeSearchCoreEnabled(enabled)
      }
    }
    await engine.createIndex('prefixes', {
      schema: { positive: 'string', negative: 'string', neutral: 'string' },
      surfaceForms: true,
    })
    expect(
      (
        await engine.insertBatch('prefixes', [
          { id: 'target', positive: 'lamb', negative: 'lamb', neutral: 'lamp' },
          ...Array.from({ length: 56 }, (_, at) => ({ id: `desk-${at}`, positive: 'desk' })),
        ])
      ).failed,
    ).toEqual([])
    const prefixQuery = {
      term: 'lam',
      prefix: true,
      bm25: { k1: 0, b: 0 },
      boost: { positive: Number.MAX_VALUE, negative: -Number.MAX_VALUE, neutral: 1 },
    }
    const prefix = await engine.query('prefixes', prefixQuery)
    expect(prefix.hits.map(hit => hit.id)).toEqual(['target'])
    expect(prefix.hits[0].score).toBeCloseTo((Math.log(1 + 56.5 / 1.5) * 3) / 4, 12)
    const enabled = nativeSearchCoreIsEnabled()
    setNativeSearchCoreEnabled(false)
    try {
      const portable = await engine.query('prefixes', prefixQuery)
      expect(portable.hits.map(({ id, score }) => ({ id, score }))).toEqual(
        prefix.hits.map(({ id, score }) => ({ id, score })),
      )
    } finally {
      setNativeSearchCoreEnabled(enabled)
    }
    if (process.env.NARSIL_REQUIRE_NATIVE_CORE === '1') expect(fallbacks).toEqual([])
  } finally {
    observeFallbacks(null)
    await engine.shutdown()
  }
})
