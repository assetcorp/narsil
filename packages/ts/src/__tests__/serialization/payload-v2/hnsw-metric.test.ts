import { describe, expect, it } from 'vitest'
import { makeMinimalPayload, roundtrip } from './fixtures'

describe('payload-v2 validateHnswMetric (via round-trip)', () => {
  it('preserves valid metrics: cosine, dotProduct, euclidean', () => {
    const metrics = ['cosine', 'dotProduct', 'euclidean'] as const
    for (const metric of metrics) {
      const wire = makeMinimalPayload({
        vector_data: {
          embedding: {
            dimension: 3,
            vectors: [],
            hnsw_graph: {
              entry_point: null,
              max_layer: 0,
              m: 16,
              ef_construction: 200,
              metric,
              nodes: [],
            },
          },
        },
      })
      const restored = roundtrip(wire)
      expect(restored.vectorData?.embedding.hnswGraph?.metric).toBe(metric)
    }
  })

  it('drops an invalid metric to undefined', () => {
    const wire = makeMinimalPayload({
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [],
          hnsw_graph: {
            entry_point: null,
            max_layer: 0,
            m: 16,
            ef_construction: 200,
            metric: 'manhattan',
            nodes: [],
          },
        },
      },
    })
    const restored = roundtrip(wire)
    expect(restored.vectorData?.embedding.hnswGraph?.metric).toBeUndefined()
  })

  it('treats missing metric as undefined', () => {
    const wire = makeMinimalPayload({
      vector_data: {
        embedding: {
          dimension: 3,
          vectors: [],
          hnsw_graph: {
            entry_point: null,
            max_layer: 0,
            m: 16,
            ef_construction: 200,
            nodes: [],
          },
        },
      },
    })
    const restored = roundtrip(wire)
    expect(restored.vectorData?.embedding.hnswGraph?.metric).toBeUndefined()
  })
})
