import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestCluster, INDEX, partitionAssignment, readCopy, type TestCluster, waitUntil } from './harness'

const VECTOR_SCHEMA = { title: 'string', amount: 'number', embedding: 'vector[3]' } as const
const STORED_INVOICES = 8
const SHORT_VECTOR_INVOICE = 'invoice-3'
const MISTYPED_AMOUNT_INVOICE = 'invoice-5'

interface ForwardResult {
  documentId: string
  success: boolean
  errorCode: string | null
}

describe('a replacement that the partition refuses', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('leaves the stored document and its vector whole on every copy', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a')
    await cluster.start('node-b')

    await cluster
      .node('controller')
      .createIndex(INDEX, { schema: VECTOR_SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const table = await waitUntil('the partition to have a primary and an in-sync replica', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.inSyncSet.length === 1
        ? assignment
        : null
    })
    const primary = table.primary ?? ''
    const replica = table.replicas[0]

    const stored = new Map<string, { title: string; amount: number; embedding: number[] }>()
    for (let i = 0; i < STORED_INVOICES; i++) {
      const invoice = { title: `invoice ${i}`, amount: i * 11, embedding: [i, 1, 2] }
      await cluster.node(primary).insert(INDEX, invoice, `invoice-${i}`)
      stored.set(`invoice-${i}`, invoice)
    }

    const reply = await cluster.probe.send(primary, {
      type: 'cluster.reshard_forward',
      sourceId: 'copy-reader',
      requestId: 'refused-replacements',
      payload: encode({
        targetGeneration: INDEX,
        jobId: 'refused-replacements',
        sourcePartitionId: 0,
        sourcePrimaryTerm: table.primaryTerm,
        operations: [
          {
            documentId: SHORT_VECTOR_INVOICE,
            operation: 'replace',
            document: encode({ title: 'invoice 3 with a short vector', amount: 0, embedding: [0.5, 0.5] }),
          },
          {
            documentId: MISTYPED_AMOUNT_INVOICE,
            operation: 'replace',
            document: encode({ title: 'invoice 5 with a text amount', amount: 'fifty', embedding: [5, 5, 5] }),
          },
        ],
      }),
    })
    const results = (decode(reply.payload) as { results?: ForwardResult[] }).results ?? []
    expect(results.map(result => [result.documentId, result.success, result.errorCode])).toEqual([
      [SHORT_VECTOR_INVOICE, false, 'VECTOR_DIMENSION_MISMATCH'],
      [MISTYPED_AMOUNT_INVOICE, false, 'DOC_VALIDATION_FAILED'],
    ])

    for (const holder of [primary, replica]) {
      const copy = await readCopy(cluster.probe, holder)
      expect([...copy.keys()].sort()).toEqual([...stored.keys()].sort())
      for (const [id, { title, amount }] of stored) expect(copy.get(id)).toMatchObject({ title, amount })
    }
    const read = await cluster.node(primary).getMultiple(INDEX, [...stored.keys()], { document: { vectors: true } })
    for (const [id, { embedding }] of stored)
      expect(Array.from(read.get(id)?.embedding as Float32Array)).toEqual(embedding)
  }, 60_000)
})
