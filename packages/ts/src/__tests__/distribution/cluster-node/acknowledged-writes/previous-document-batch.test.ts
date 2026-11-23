import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPACITY } from '../../../../distribution'
import { MAX_MESSAGE_SIZE_BYTES } from '../../../../distribution/transport'
import { createFilesystemPersistence } from '../../../../persistence/filesystem'
import {
  createTestCluster,
  INDEX,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const DOCUMENTS = 1_000
const INSERT_CHUNK = 50
const DOCUMENT_TEXT_BYTES = 72_000
const LARGE_NODE_MEMORY_MULTIPLE = 40
const DATA_NODES = ['node-a', 'node-b']

function pageOf(position: number): { title: string; amount: number } {
  return { title: `page ${position} ${'x'.repeat(DOCUMENT_TEXT_BYTES)}`, amount: position }
}

describe('a batch of removes whose previous documents pass the message limit together', () => {
  let cluster: TestCluster | undefined
  let storeDirectory: string | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
    if (storeDirectory !== undefined) await rm(storeDirectory, { recursive: true, force: true })
    storeDirectory = undefined
  })

  it('keeps the replica in sync and empties both copies', async () => {
    expect(DOCUMENTS * DOCUMENT_TEXT_BYTES).toBeGreaterThan(MAX_MESSAGE_SIZE_BYTES)
    const directory = await mkdtemp(join(tmpdir(), 'narsil-previous-document-batch-'))
    storeDirectory = directory
    const backups = { store: createFilesystemPersistence({ directory }), keyPrefix: 'ledger-backups' }
    const running = await createTestCluster()
    cluster = running
    await running.start('controller', { roles: ['controller', 'coordinator'], backups })
    for (const nodeId of DATA_NODES) {
      await running.start(nodeId, {
        backups,
        capacity: { ...DEFAULT_CAPACITY, memoryBytes: DEFAULT_CAPACITY.memoryBytes * LARGE_NODE_MEMORY_MULTIPLE },
      })
    }
    await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const settled = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const primary = settled.primary ?? ''
    const replica = settled.inSyncSet[0] ?? ''
    await running.node('controller').updateChanges(INDEX, { enabled: true, previousDocument: true })

    const docIds: string[] = []
    for (let start = 0; start < DOCUMENTS; start += INSERT_CHUNK) {
      const chunk = Array.from({ length: Math.min(INSERT_CHUNK, DOCUMENTS - start) }, (_, offset) => start + offset)
      const inserted = await running.node(primary).insertBatch(
        INDEX,
        chunk.map(position => ({ id: `page-${position}`, ...pageOf(position) })),
      )
      expect(inserted.failed).toEqual([])
      docIds.push(...inserted.succeeded)
    }
    await waitForCopies(running.coordinator, primary, [replica])
    expect((await readCopy(running.probe, replica)).size).toBe(DOCUMENTS)

    const removed = await running.node(primary).removeBatch(INDEX, docIds)

    expect(removed.failed).toEqual([])
    expect(removed.succeeded).toHaveLength(DOCUMENTS)
    expect(partitionAssignment(await running.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(replica)
    expect((await readCopy(running.probe, primary)).size).toBe(0)
    expect((await readCopy(running.probe, replica)).size).toBe(0)
    expect(running.transport(primary).failuresOf(() => true)).not.toContain('TRANSPORT_MESSAGE_TOO_LARGE')
  }, 240_000)
})
