import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { generateDocuments, indexConfig, schema } from './fixtures'

describe('E2E Full Workflow - auxiliary features', () => {
  let narsil: Narsil
  const documents = generateDocuments()

  afterEach(async () => {
    if (narsil) {
      await narsil.shutdown()
    }
  })

  it('supports preflight queries for fast count estimation', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents.slice(0, 50) as unknown as AnyDocument[])

    const preflightResult = await narsil.preflight('products', { term: 'wireless' })
    expect(preflightResult.count).toBeGreaterThanOrEqual(0)
    expect(preflightResult.elapsed).toBeGreaterThanOrEqual(0)

    const fullResult = await narsil.query('products', { term: 'wireless' })
    expect(preflightResult.count).toBe(fullResult.count)
  })

  it('handles clear and re-insert within the same index', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)

    await narsil.insertBatch('products', documents.slice(0, 20) as unknown as AnyDocument[])
    const beforeClear = await narsil.countDocuments('products')
    expect(beforeClear).toBe(20)

    await narsil.clear('products')
    const afterClear = await narsil.countDocuments('products')
    expect(afterClear).toBe(0)

    const indexesAfterClear = narsil.listIndexes()
    expect(indexesAfterClear.map(i => i.name)).toContain('products')

    await narsil.insertBatch('products', documents.slice(0, 10) as unknown as AnyDocument[])
    const afterReinsert = await narsil.countDocuments('products')
    expect(afterReinsert).toBe(10)

    const searchAfterReinsert = await narsil.query('products', { term: 'wireless' })
    expect(searchAfterReinsert.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('filters with combined boolean and numeric constraints', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents as unknown as AnyDocument[])

    const result = await narsil.query('products', {
      term: 'keyboard shoes jacket pillow',
      filters: {
        and: [{ fields: { inStock: { eq: true } } }, { fields: { price: { between: [20, 100] } } }],
      },
    })

    for (const hit of result.hits) {
      const doc = hit.document as Record<string, unknown>
      expect(doc.inStock).toBe(true)
      expect(doc.price as number).toBeGreaterThanOrEqual(20)
      expect(doc.price as number).toBeLessThanOrEqual(100)
    }
  })

  it('returns correct stats after mutations', async () => {
    narsil = await createNarsil()
    await narsil.createIndex('products', indexConfig)
    await narsil.insertBatch('products', documents.slice(0, 30) as unknown as AnyDocument[])

    const stats = narsil.getStats('products')
    expect(stats.documentCount).toBe(30)
    expect(stats.partitionCount).toBeGreaterThanOrEqual(1)
    expect(stats.language).toBe('english')
    expect(stats.schema).toEqual(schema)
  })
})
