import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'

const PARTITION_COUNT = 4
const DOCUMENT_TOTAL = 40

interface CatalogueDocument {
  id: string
  title: string
  price: number
  category: string
}

function catalogueDocuments(): CatalogueDocument[] {
  const documents: CatalogueDocument[] = []
  for (let index = 0; index < DOCUMENT_TOTAL; index += 1) {
    documents.push({
      id: `product-${index}`,
      title: `Wireless Speaker ${index}`,
      price: index,
      category: index % 2 === 0 ? 'audio' : 'accessories',
    })
  }
  return documents
}

function idsInPartitions(documents: CatalogueDocument[], partitionIds: number[]): Set<string> {
  const wanted = new Set(partitionIds)
  return new Set(documents.filter(doc => wanted.has(resolvePartitionId(doc.id, PARTITION_COUNT))).map(doc => doc.id))
}

describe('partition-scoped reads on the cluster local engine', () => {
  let engine: ClusterLocalEngine
  const documents = catalogueDocuments()

  beforeEach(async () => {
    engine = await createClusterLocalEngine()
    await engine.createIndex('products', {
      schema: { title: 'string', price: 'number', category: 'enum' },
      partitions: { maxPartitions: PARTITION_COUNT },
    })
    const result = await engine.insertBatch('products', documents as unknown as Array<Record<string, unknown>>)
    expect(result.failed).toEqual([])
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('confines a keyword query to the named partitions', async () => {
    const expected = idsInPartitions(documents, [0])
    const result = await engine.queryPartitions('products', { term: 'wireless', limit: DOCUMENT_TOTAL }, [0])

    expect(result.count).toBe(expected.size)
    expect(new Set(result.hits.map(hit => hit.id))).toEqual(expected)
  })

  it('answers the whole index when every partition is named', async () => {
    const result = await engine.queryPartitions('products', { term: 'wireless', limit: DOCUMENT_TOTAL }, [0, 1, 2, 3])
    expect(result.count).toBe(DOCUMENT_TOTAL)
  })

  it('confines filters and facets to the named partitions', async () => {
    const expected = [...idsInPartitions(documents, [1, 2])].filter(id => {
      const doc = documents.find(candidate => candidate.id === id)
      return doc !== undefined && doc.category === 'audio'
    })

    const result = await engine.queryPartitions(
      'products',
      {
        term: 'wireless',
        filters: { fields: { category: { eq: 'audio' } } },
        facets: { category: {} },
        limit: DOCUMENT_TOTAL,
      },
      [1, 2],
    )

    expect(result.count).toBe(expected.length)
    const facetValues = result.facets?.category?.values ?? {}
    expect(facetValues.audio).toBe(expected.length)
    expect(facetValues.accessories).toBeUndefined()
  })

  it('confines a sorted query page to the named partitions', async () => {
    const expected = idsInPartitions(documents, [3])
    const result = await engine.queryPartitions<CatalogueDocument>(
      'products',
      { term: 'wireless', sort: [{ field: 'price', direction: 'desc' }], limit: DOCUMENT_TOTAL },
      [3],
    )

    expect(result.count).toBe(expected.size)
    const prices = result.hits.map(hit => hit.document.price)
    expect(prices).toEqual([...prices].sort((a, b) => b - a))
  })

  it('confines a preflight count to the named partitions', async () => {
    const expected = idsInPartitions(documents, [0, 2])
    const result = await engine.preflightPartitions('products', { term: 'wireless' }, [0, 2])
    expect(result.count).toBe(expected.size)
  })

  it('confines suggestions to the named partitions', async () => {
    const expected = idsInPartitions(documents, [1])
    const result = await engine.suggestPartitions('products', { prefix: 'speak' }, [1])

    const speaker = result.terms.find(entry => entry.term.startsWith('speak'))
    expect(speaker?.documentFrequency).toBe(expected.size)
  })

  it('confines a document listing and its total to the named partitions', async () => {
    const expected = idsInPartitions(documents, [2])
    const result = await engine.listPartitions('products', { limit: DOCUMENT_TOTAL }, [2])

    expect(result.total).toBe(expected.size)
    expect(new Set(result.documents.map(listed => listed.id))).toEqual(expected)
  })

  it('confines query statistics to the named partitions', async () => {
    const expected = idsInPartitions(documents, [0, 1])
    const stats = engine.collectQueryStats('products', ['wireless'], [0, 1])
    expect(stats.totalDocuments).toBe(expected.size)
  })
})
