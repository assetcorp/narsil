import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'

describe('the facet error bound', () => {
  it('preserves object-property bucket names and code point ties across partitions', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      await engine.createIndex('labels', {
        schema: { title: 'string', label: 'enum' },
        partitions: { maxPartitions: 8, maxDocsPerPartition: 4 },
      })
      const labels = ['__proto__', 'constructor', 'toString', '', '\u{10000}']
      const documents = Array.from({ length: 20 }, (_, at) => ({
        id: `label-${at}`,
        title: 'label',
        label: labels[at % labels.length],
      }))
      await engine.insertBatch('labels', documents)
      expect(engine.getStats('labels').partitionCount).toBeGreaterThan(1)
      for (const sort of ['asc', 'desc'] as const) {
        const all = await engine.query('labels', { term: 'label', facets: { label: { sort } } })
        expect(Object.entries(all.facets?.label.values ?? {})).toEqual(labels.map(label => [label, 4]))
        expect(all.facets?.label.errorBound).toBe(0)
        const limited = await engine.query('labels', { term: 'label', facets: { label: { sort, limit: 2 } } })
        expect(Object.entries(limited.facets?.label.values ?? {})).toEqual(labels.slice(0, 2).map(label => [label, 4]))
        expect(limited.facets?.label.errorBound).toBe(4)
      }
    } finally {
      await engine.shutdown()
    }
  })
})
