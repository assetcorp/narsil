import { afterEach, describe, expect, it } from 'vitest'
import { readMemoryFigures } from '../../../distribution/cluster-node/memory/measure'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  createTestCluster,
  INDEX,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './acknowledged-writes/harness'

const LEADING_DOCUMENTS = 6
const TRAILING_DOCUMENTS = 6
const HEAP_LIMIT_BYTES_PER_OVERSIZED_CHARACTER = 1_000

type Entry = {
  title: string
  amount: number
}

function ledgerLine(serial: number): Entry & { id: string } {
  return { id: `line-${serial}`, title: `ledger line ${serial} for oak chairs`, amount: serial }
}

describe('a batch that a primary refuses part of the way through', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('keeps every document it reports as succeeded on the primary and its replica, and no refused one', async () => {
    const heapLimitBytes = readMemoryFigures()?.heapLimitBytes
    if (heapLimitBytes === undefined) throw new Error('this process reports no heap limit')

    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a', { durable: false })
    await cluster.start('node-b', { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const table = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = await cluster.coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(current)
      return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? current : null
    })
    const primary = partitionAssignment(table)?.primary ?? ''
    const replica = partitionAssignment(table)?.inSyncSet[0] ?? ''

    const leading = Array.from({ length: LEADING_DOCUMENTS }, (_, serial) => ledgerLine(serial))
    const oversized = {
      id: 'line-oversized',
      title: 'ledger '.repeat(Math.ceil(heapLimitBytes / HEAP_LIMIT_BYTES_PER_OVERSIZED_CHARACTER / 7)),
      amount: -1,
    }
    const trailing = Array.from({ length: TRAILING_DOCUMENTS }, (_, serial) => ledgerLine(LEADING_DOCUMENTS + serial))
    const result = await cluster.node(primary).insertBatch(INDEX, [...leading, oversized, ...trailing])

    expect(new Set(result.succeeded)).toEqual(new Set(leading.map(entry => entry.id)))
    expect(result.failed.map(failure => failure.docId)).toEqual([oversized.id, ...trailing.map(entry => entry.id)])
    for (const failure of result.failed) {
      expect(failure.error).toBeInstanceOf(NarsilError)
      expect(failure.error.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    }
    expect(result.failed[0].error.details).toMatchObject({ reason: 'write_exceeds_memory', nodeId: primary })
    for (const failure of result.failed.slice(1)) {
      expect(failure.error.details).toMatchObject({ reason: 'write_would_fill_memory', refusedDocId: oversized.id })
    }

    await waitForCopies(cluster.coordinator, primary, [replica])
    const expected = new Map<string, Entry>()
    for (const { id, ...fields } of leading) expected.set(id, fields)
    for (const nodeId of [primary, replica]) {
      const copy = await waitUntil(`${nodeId} to hold the documents that succeeded`, async () => {
        const documents = await readCopy(cluster.probe, nodeId)
        return documents.size >= expected.size ? documents : null
      })
      expect(copy).toEqual(expected)
    }

    const retried = await cluster.node(primary).insertBatch(INDEX, trailing)
    expect(retried.failed).toEqual([])
    for (const { id, ...fields } of trailing) expected.set(id, fields)
    await waitForCopies(cluster.coordinator, primary, [replica])
    for (const nodeId of [primary, replica]) {
      const copy = await waitUntil(`${nodeId} to hold the retried documents`, async () => {
        const documents = await readCopy(cluster.probe, nodeId)
        return documents.size >= expected.size ? documents : null
      })
      expect(copy).toEqual(expected)
    }
  })
})
