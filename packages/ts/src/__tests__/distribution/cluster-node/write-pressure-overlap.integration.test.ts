import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  createTestCluster,
  INDEX,
  ofType,
  partitionAssignment,
  publishedHeapLimitBytes,
  readCopy,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './acknowledged-writes/harness'

const BATCH_DOCUMENTS = 40
const TITLE_CHARACTERS = 2_500
const LIMIT_ABOVE_ONE_BATCH = 1.5
const LIMIT_BELOW_ONE_BATCH = 0.5

type Entry = {
  title: string
  amount: number
}

function batchOf(prefix: string): Array<Entry & { id: string }> {
  return Array.from({ length: BATCH_DOCUMENTS }, (_, serial) => ({
    id: `${prefix}-${serial}`,
    title: `${prefix} ledger line ${serial} ${'n'.repeat(TITLE_CHARACTERS)}`,
    amount: serial,
  }))
}

function textBytesOf(batch: Array<Entry & { id: string }>): number {
  return batch.reduce((total, entry) => total + entry.id.length + entry.title.length, 0)
}

async function refusalOf(work: Promise<unknown>): Promise<NarsilError | null> {
  try {
    await work
    return null
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
}

describe('a primary that waits on its replica holds a batch in flight', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it.each([
    ['a bound above one batch', LIMIT_ABOVE_ONE_BATCH],
    ['a bound below one batch, which the first batch passes on an idle node', LIMIT_BELOW_ONE_BATCH],
  ])('refuses the batch that arrives while the first one waits under %s, then accepts it once the first completes', async (_bound, limitInBatches) => {
    cluster = await createTestCluster()
    const controller = await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    const heapLimitBytes = await publishedHeapLimitBytes(controller)
    const first = batchOf('april')
    const second = batchOf('may')
    const inFlightWriteFraction = (textBytesOf(first) * limitInBatches) / heapLimitBytes
    const memory = { inFlightWriteFraction }

    await cluster.start('node-a', { durable: false, memory })
    await cluster.start('node-b', { durable: false, memory })
    await cluster
      .node('controller')
      .createIndex(
        INDEX,
        { schema: { title: 'string', amount: 'number' } },
        { partitionCount: 1, replicationFactor: 1 },
      )
    const table = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = await cluster.coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(current)
      return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? current : null
    })
    const primary = partitionAssignment(table)?.primary ?? ''
    const replica = partitionAssignment(table)?.inSyncSet[0] ?? ''

    const held = cluster.transport(primary).holdWhen(ofType('replication.entry_batch', replica))
    const firstWrite = cluster.node(primary).insertBatch(INDEX, first)
    await waitUntil('the first batch to wait on the replica', () => held.count() > 0)

    const refusal = await refusalOf(cluster.node(primary).insertBatch(INDEX, second))
    expect(refusal?.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(refusal?.details).toMatchObject({ reason: 'write_bytes_in_flight', indexName: INDEX, nodeId: primary })
    expect(Number(refusal?.details.inFlightBytes)).toBeGreaterThanOrEqual(textBytesOf(first))

    held.release()
    expect((await firstWrite).failed).toEqual([])
    expect((await cluster.node(primary).insertBatch(INDEX, second)).failed).toEqual([])
    await waitForCopies(cluster.coordinator, primary, [replica])

    const expected = new Map<string, Entry>()
    for (const { id, ...fields } of [...first, ...second]) expected.set(id, fields)
    for (const nodeId of [primary, replica]) {
      const copy = await waitUntil(`${nodeId} to hold both batches`, async () => {
        const documents = await readCopy(cluster.probe, nodeId)
        return documents.size === expected.size ? documents : null
      })
      expect(copy).toEqual(expected)
    }
  })
})
