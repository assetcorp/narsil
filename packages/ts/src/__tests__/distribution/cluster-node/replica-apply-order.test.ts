import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { applySyncEntries } from '../../../distribution/cluster-node/bootstrap-sync/entries'
import type { LiveBootstrapSyncDeps } from '../../../distribution/cluster-node/bootstrap-sync/types'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
import { handleReplicationEntryBatch } from '../../../distribution/cluster-node/message-handler/writes'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../distribution/replication'
import { createEntryBatchMessage } from '../../../distribution/replication/codec'
import { buildEntry } from '../../../distribution/replication/entry-checksum'
import type { ReplicationLog, ReplicationLogEntry } from '../../../distribution/replication/types'

const INDEX_NAME = 'harbours'
const ENTRY_COUNT = 4

function harbourEntries(): ReplicationLogEntry[] {
  return Array.from({ length: ENTRY_COUNT }, (_, offset) =>
    buildEntry({
      seqNo: offset + 1,
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: INDEX_NAME,
      documentId: `harbour-${offset + 1}`,
      document: encode({ name: `quay ${offset + 1}` }),
    }),
  )
}

function strictDurableLog(): { applied: number[]; apply: (entry: ReplicationLogEntry) => Promise<void> } {
  const applied: number[] = []
  return {
    applied,
    async apply(entry) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const previous = applied.at(-1) ?? 0
      if (entry.seqNo <= previous) {
        throw new Error(`Log record ${entry.seqNo} does not follow record ${previous}`)
      }
      applied.push(entry.seqNo)
    },
  }
}

describe('a replica that receives the same entries from its sync stream and from the catch-up feed at once', () => {
  let coordinator: ClusterCoordinator

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('applies every entry once and ends with its log at the last entry', async () => {
    coordinator = createInMemoryCoordinator()
    await coordinator.putAllocation(INDEX_NAME, {
      indexName: INDEX_NAME,
      version: 1,
      replicationFactor: 1,
      assignments: new Map([
        [
          0,
          { primary: 'primary', replicas: ['replica'], inSyncSet: [], state: 'ACTIVE', primaryTerm: 1, commitPoint: 0 },
        ],
      ]),
    })
    const log: ReplicationLog = createReplicationLog(0)
    const durable = strictDurableLog()
    const entries = harbourEntries()

    const handlerDeps = {
      nodeId: 'replica',
      coordinator,
      engine: { applyReplicationEntry: durable.apply },
      writeDeps: { getReplicationLog: () => log },
    } as unknown as DataNodeHandlerDeps
    const syncDeps = {
      getReplicationLog: () => log,
      applyReplicationEntry: durable.apply,
    } as unknown as LiveBootstrapSyncDeps

    const fed = handleReplicationEntryBatch(createEntryBatchMessage(entries, 'primary'), async () => {}, handlerDeps)
    const synced = applySyncEntries(INDEX_NAME, 0, [{ entries, isLast: true }], 1, 1, syncDeps)
    const [, syncResult] = await Promise.all([fed, synced])

    expect(syncResult.ok).toBe(true)
    expect(durable.applied).toEqual([1, 2, 3, 4])
    expect(log.localLogEnd).toBe(ENTRY_COUNT)
  })
})
