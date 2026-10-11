import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PatternIndexWriter } from '../../../core/pattern-index/types'
import { createNarsil } from '../../../narsil'
import { patternSearchModule } from '../../../pattern/module'

describe('the pattern filters of one partition', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the documents that hold a value in a field once for every ne and nin test on it in a search', async () => {
    let documentReads = 0
    const createIndex = patternSearchModule.createIndex
    vi.spyOn(patternSearchModule, 'createIndex').mockImplementation(host => {
      const index: PatternIndexWriter = createIndex(host)
      return {
        ...index,
        documents() {
          documentReads++
          return index.documents()
        },
      }
    })
    const narsil = await createNarsil({ workers: { enabled: false } })
    try {
      await narsil.createIndex('orders', { schema: { sku: 'verbatim' }, partitions: { maxPartitions: 1 } })
      await narsil.insertBatch('orders', [
        { id: 'o1', sku: 'ABC-100' },
        { id: 'o2', sku: 'ABD-200' },
        { id: 'o3', sku: 'XYZ-300' },
      ])
      documentReads = 0
      const page = await narsil.listDocuments('orders', {
        filters: {
          and: [
            { fields: { sku: { ne: 'ABC-100' } } },
            { fields: { sku: { ne: 'ABD-200' } } },
            { fields: { sku: { nin: ['XYZ-999'] } } },
          ],
        },
        limit: 10,
      })
      expect(page.documents.map(document => document.id)).toEqual(['o3'])
      expect(documentReads).toBe(1)
    } finally {
      await narsil.shutdown()
    }
  })
})
