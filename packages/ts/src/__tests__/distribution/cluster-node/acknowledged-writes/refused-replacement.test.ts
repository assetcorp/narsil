import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestCluster, INDEX, partitionAssignment, readCopy, type TestCluster, waitUntil } from './harness'

const VECTOR_SCHEMA = { title: 'string', amount: 'number', embedding: 'vector[3]' } as const
const STORED_INVOICES = 8
const SOURCE_PARTITIONS = 2
const TARGET_PARTITIONS = 1
const SHORT_VECTOR_INVOICE = 'invoice-3'
const MISTYPED_AMOUNT_INVOICE = 'invoice-5'
const RECORD_KEY = `_narsil/index/${INDEX}/rebalance`
const CUTOVER = 'cluster.reshard_cutover'

interface ForwardResult {
  documentId: string
  success: boolean
  errorCode: string | null
}

interface RunningJob {
  jobId: string
  targetGeneration: string
}

describe('a replacement that the partition refuses', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('leaves the stored document and its vector whole on every copy', async () => {
    cluster = await createTestCluster()
    const controller = await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a')
    await cluster.start('node-b')

    await controller.createIndex(
      INDEX,
      { schema: VECTOR_SCHEMA },
      { partitionCount: SOURCE_PARTITIONS, replicationFactor: 1 },
    )
    await waitUntil('every partition to have a primary and an in-sync replica', async () => {
      const assignments = [...((await cluster.coordinator.getAllocation(INDEX))?.assignments.values() ?? [])]
      return (
        assignments.length === SOURCE_PARTITIONS &&
        assignments.every(assignment => assignment.state === 'ACTIVE' && assignment.inSyncSet.length === 1)
      )
    })

    const stored = new Map<string, { title: string; amount: number; embedding: number[] }>()
    for (let i = 0; i < STORED_INVOICES; i++) {
      const invoice = { title: `invoice ${i}`, amount: i * 11, embedding: [i, 1, 2] }
      await controller.insert(INDEX, invoice, `invoice-${i}`)
      stored.set(`invoice-${i}`, invoice)
    }

    const cutovers = cluster.transport('controller').holdWhen((_to, message) => message.type === CUTOVER)
    const changing = controller.rebalance(INDEX, TARGET_PARTITIONS)
    const job = await waitUntil('the partition count change to reach its cutover', async () => {
      const bytes = await cluster.coordinator.get(RECORD_KEY)
      if (bytes === null || bytes.byteLength === 0 || cutovers.count() === 0) return null
      const record = decode(bytes) as Partial<RunningJob> & { phase?: unknown }
      return record.phase === 'cutover' &&
        typeof record.jobId === 'string' &&
        typeof record.targetGeneration === 'string'
        ? { jobId: record.jobId, targetGeneration: record.targetGeneration }
        : null
    })
    const target = await waitUntil('the new layout to have a primary and an in-sync replica', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(job.targetGeneration))
      return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.inSyncSet.length === 1
        ? assignment
        : null
    })
    const sourceTerm = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.primaryTerm ?? 1

    const reply = await cluster.probe.send(target.primary ?? '', {
      type: 'cluster.reshard_forward',
      sourceId: 'copy-reader',
      requestId: 'refused-replacements',
      payload: encode({
        targetGeneration: job.targetGeneration,
        jobId: job.jobId,
        sourcePartitionId: 0,
        sourcePrimaryTerm: sourceTerm,
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

    for (const holder of [target.primary ?? '', ...target.replicas]) {
      const copy = await readCopy(cluster.probe, holder, 0, job.targetGeneration)
      expect([...copy.keys()].sort()).toEqual([...stored.keys()].sort())
      for (const [id, { title, amount }] of stored) expect(copy.get(id)).toMatchObject({ title, amount })
    }

    cutovers.release()
    await changing
    const read = await controller.getMultiple(INDEX, [...stored.keys()], { document: { vectors: true } })
    for (const [id, { embedding }] of stored)
      expect(Array.from(read.get(id)?.embedding as Float32Array)).toEqual(embedding)
  }, 60_000)
})
