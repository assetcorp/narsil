import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import type { SchemaDefinition } from '../../../types/schema'

const PARTITION_COUNT = 4
const DOCUMENT_TOTAL = 40
const DIMENSION = 4

const schema: SchemaDefinition = {
  title: 'string',
  price: 'number',
  embedding: `vector[${DIMENSION}]`,
}

interface CatalogueDocument {
  id: string
  title: string
  price: number
  embedding: number[]
}

function embeddingFor(index: number): number[] {
  const angle = (index / DOCUMENT_TOTAL) * Math.PI * 2
  return [Math.cos(angle), Math.sin(angle), Math.cos(angle * 2), Math.sin(angle * 2)]
}

function catalogueDocuments(): CatalogueDocument[] {
  const documents: CatalogueDocument[] = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({
      id: `product-${index}`,
      title: `Speaker ${index}`,
      price: index,
      embedding: embeddingFor(index),
    })
  }
  return documents
}

function idsInPartitions(documents: CatalogueDocument[], partitionIds: number[]): Set<string> {
  const wanted = new Set(partitionIds)
  return new Set(documents.filter(doc => wanted.has(resolvePartitionId(doc.id, PARTITION_COUNT))).map(doc => doc.id))
}

describe('partition-scoped vector reads on the cluster local engine', () => {
  let engine: ClusterLocalEngine
  const documents = catalogueDocuments()

  beforeEach(async () => {
    engine = await createClusterLocalEngine()
    await engine.createIndex('products', { schema, partitions: { maxPartitions: PARTITION_COUNT } })
    const result = await engine.insertBatch('products', documents as unknown as Array<Record<string, unknown>>)
    expect(result.failed).toEqual([])
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('confines a vector query to the named partitions', async () => {
    const expected = idsInPartitions(documents, [1])
    const result = await engine.queryPartitions(
      'products',
      { vector: { field: 'embedding', value: embeddingFor(3) }, limit: DOCUMENT_TOTAL },
      [1],
    )

    expect(result.hits.length).toBe(expected.size)
    expect(new Set(result.hits.map(hit => hit.id))).toEqual(expected)
  })

  it('confines a hybrid query to the named partitions', async () => {
    const expected = idsInPartitions(documents, [0, 2])
    const result = await engine.queryPartitions(
      'products',
      { term: 'speaker', vector: { field: 'embedding', value: embeddingFor(7) }, limit: DOCUMENT_TOTAL },
      [0, 2],
    )

    expect(new Set(result.hits.map(hit => hit.id))).toEqual(expected)
  })

  it('answers the whole index when every partition is named', async () => {
    const result = await engine.queryPartitions(
      'products',
      { vector: { field: 'embedding', value: embeddingFor(11) }, limit: DOCUMENT_TOTAL },
      [0, 1, 2, 3],
    )

    expect(result.hits.length).toBe(DOCUMENT_TOTAL)
  })

  it('confines a vector query after a document is removed and written again', async () => {
    await engine.remove('products', 'product-5')
    await engine.insert('products', { title: 'Speaker 5', embedding: embeddingFor(5) }, 'product-5')

    const partitionId = resolvePartitionId('product-5', PARTITION_COUNT)
    const expected = idsInPartitions(documents, [partitionId])
    const result = await engine.queryPartitions(
      'products',
      { vector: { field: 'embedding', value: embeddingFor(5) }, limit: DOCUMENT_TOTAL },
      [partitionId],
    )

    expect(new Set(result.hits.map(hit => hit.id))).toEqual(expected)
  })

  it('confines a vector query carrying a filter to the named partitions', async () => {
    const partitionIds = [2, 3]
    const expected = idsInPartitions(documents, partitionIds)
    const result = await engine.queryPartitions(
      'products',
      {
        vector: { field: 'embedding', value: embeddingFor(13) },
        filters: { fields: { price: { gte: 0 } } },
        limit: DOCUMENT_TOTAL,
      },
      partitionIds,
    )

    expect(new Set(result.hits.map(hit => hit.id))).toEqual(expected)
  })

  it('names no partition and answers from every one', async () => {
    const result = await engine.query('products', {
      vector: { field: 'embedding', value: embeddingFor(2) },
      limit: DOCUMENT_TOTAL,
    })

    expect(result.hits.length).toBe(DOCUMENT_TOTAL)
  })
})
