import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SchemaDefinition } from '../../types/schema'

const MAX_PARTITIONS = 4
const DOCUMENT_TOTAL = 40

const schema: SchemaDefinition = {
  title: 'string',
  price: 'number',
}

function catalogueDocuments(): Array<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({ id: `product-${index}`, title: `wireless speaker ${index}`, price: index })
  }
  return documents
}

describe('a single-node query reporting its partition coverage', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('catalogue', {
      schema,
      language: 'english',
      partitions: { maxPartitions: MAX_PARTITIONS },
    })
    const result = await narsil.insertBatch('catalogue', catalogueDocuments())
    expect(result.failed).toEqual([])
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('reports every partition as queried, with none timed out and none failed', async () => {
    const partitionCount = narsil.getStats('catalogue').partitionCount
    expect(partitionCount).toBeGreaterThan(1)

    const result = await narsil.query('catalogue', { term: 'wireless', limit: DOCUMENT_TOTAL })

    expect(result.coverage).toEqual({
      totalPartitions: partitionCount,
      queriedPartitions: partitionCount,
      timedOutPartitions: 0,
      failedPartitions: 0,
    })
  })
})
