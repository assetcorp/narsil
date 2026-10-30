import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPACITY } from '../../../../distribution'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import { DEFAULT_TRANSPORT_CONFIG } from '../../../../distribution/transport/types'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  ofType,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const SETTLED_WRITES = 5
const LARGE_NODE_MEMORY_MULTIPLE = 40
const REJOIN_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 10
const WRITES_AFTER_SWAP_MS = 1_000
const REPLICATION_TIMEOUT_MS = DEFAULT_TRANSPORT_CONFIG.replicationTimeout
const WRITE_MARGIN_MS = 2_000
const WRITE_PACE_MS = 20

type Ledger = Map<string, Record<string, unknown>>

interface InSyncWatch {
  leftAt(): number | null
  stop(): Promise<void>
}

function fields(label: string, amount: number): Record<string, unknown> {
  return { title: `transfer ${label}`, amount }
}

describe('a new primary that starts its term on every in-sync copy', () => {
  let cluster: TestCluster | undefined
  const watches: InSyncWatch[] = []

  afterEach(async () => {
    for (const watch of watches.splice(0)) await watch.stop()
    await cluster?.dispose()
    cluster = undefined
  })

  async function startLedger(): Promise<{ running: TestCluster; settled: PartitionAssignment; ledger: Ledger }> {
    const running = await createTestCluster()
    cluster = running
    await running.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b', 'node-c']) await running.start(nodeId, { durable: false })
    await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('every data node to hold the partition in sync', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
    })
    const ledger: Ledger = new Map()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await running.node(settled.primary ?? '').insert(INDEX, fields(`settled ${i}`, i), `settled-${i}`)
      ledger.set(`settled-${i}`, fields(`settled ${i}`, i))
    }
    return { running, settled, ledger }
  }

  function watchInSync(running: TestCluster, nodeId: string): InSyncWatch {
    let leftAt: number | null = null
    let stopped = false
    const loop = (async () => {
      while (!stopped) {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        if (
          leftAt === null &&
          current !== undefined &&
          current.primary !== nodeId &&
          !current.inSyncSet.includes(nodeId)
        ) {
          leftAt = Date.now()
        }
        await sleep(POLL_INTERVAL_MS)
      }
    })()
    const watch = {
      leftAt: () => leftAt,
      stop: async () => {
        stopped = true
        await loop
      },
    }
    watches.push(watch)
    return watch
  }

  async function swapLeadership(
    running: TestCluster,
    settled: PartitionAssignment,
  ): Promise<{ assignment: PartitionAssignment; at: number }> {
    await running.start('node-d', {
      durable: false,
      capacity: { ...DEFAULT_CAPACITY, memoryBytes: DEFAULT_CAPACITY.memoryBytes * LARGE_NODE_MEMORY_MULTIPLE },
    })
    const assignment = await waitUntil('the controller to hand leadership to an in-sync replica', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current !== undefined && current.primary !== settled.primary && current.primaryTerm > settled.primaryTerm
        ? current
        : null
    })
    expect(assignment.primary).toBe(settled.inSyncSet[0])
    return { assignment, at: Date.now() }
  }

  async function expectEveryCopyHolds(running: TestCluster, ledger: Ledger, rejoining: string[]): Promise<void> {
    const expected = Object.fromEntries(ledger)
    const healed = await waitUntil(
      `${rejoining.join(', ') || 'every copy'} to be in sync with the ledger`,
      async () => {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        if (current?.state !== 'ACTIVE' || current.primary === null) return null
        if (!rejoining.every(nodeId => current.inSyncSet.includes(nodeId))) return null
        for (const holder of [current.primary, ...current.inSyncSet]) {
          if ((await readCopy(running.probe, holder)).size !== ledger.size) return null
        }
        return current
      },
      REJOIN_TIMEOUT_MS,
    )
    for (const holder of [healed.primary ?? '', ...healed.inSyncSet]) {
      expect(Object.fromEntries(await readCopy(running.probe, holder)), holder).toEqual(expected)
    }
  }

  it('keeps a matching old primary in sync across a swap, and holds no write past the replication timeout', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const oldPrimaryWatch = watchInSync(running, oldPrimary)
    let writing = true
    let slowestMs = 0
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        const startedAt = Date.now()
        await running.node('controller').insert(INDEX, fields(`during swap ${i}`, 500 + i), `during-${i}`)
        slowestMs = Math.max(slowestMs, Date.now() - startedAt)
        ledger.set(`during-${i}`, fields(`during swap ${i}`, 500 + i))
        await sleep(WRITE_PACE_MS)
      }
    })()

    await swapLeadership(running, settled)
    await sleep(WRITES_AFTER_SWAP_MS)
    writing = false
    await writer

    await expectEveryCopyHolds(running, ledger, [oldPrimary])
    expect(oldPrimaryWatch.leftAt()).toBeNull()
    expect(slowestMs).toBeLessThan(REPLICATION_TIMEOUT_MS)
  }, 90_000)

  it('removes a diverged old primary within the replication timeout when nothing is written after the swap', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const transport = running.transport(oldPrimary)
    transport.loseReplyWhen(entryForDocument('stranded'))
    const removal = transport.holdWhen(ofType('replication.insync_remove'))
    const stranded = outcomeOf(running.node(oldPrimary).insert(INDEX, fields('stranded', 999), 'stranded'))
    await waitUntil('the stranded write to wait on its removal request', () => removal.count() > 0)
    const oldPrimaryWatch = watchInSync(running, oldPrimary)

    const handover = await swapLeadership(running, settled)
    removal.release()
    expect(await stranded).toEqual({ state: 'acknowledged' })
    ledger.set('stranded', fields('stranded', 999))

    const leftAt = await waitUntil('the old primary to leave the in-sync set', () => oldPrimaryWatch.leftAt())
    expect(leftAt - handover.at).toBeLessThan(REPLICATION_TIMEOUT_MS)
    await expectEveryCopyHolds(running, ledger, [oldPrimary])
    expect(transport.syncTiers()).toContain('snapshot')
  }, 90_000)

  async function failOver(
    running: TestCluster,
    settled: PartitionAssignment,
    release: () => void = () => undefined,
  ): Promise<{ assignment: PartitionAssignment; at: number }> {
    const oldPrimary = settled.primary ?? ''
    running.transport(oldPrimary).dropWhen(() => true)
    release()
    await running.stop(oldPrimary)
    const assignment = await waitUntil(
      'the controller to promote an in-sync replica',
      async () => {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        return current?.state === 'ACTIVE' &&
          current.primary !== null &&
          current.primary !== oldPrimary &&
          current.primaryTerm > settled.primaryTerm
          ? current
          : null
      },
      REJOIN_TIMEOUT_MS,
    )
    expect(assignment.primary).toBe(candidateOf(settled))
    return { assignment, at: Date.now() }
  }

  function candidateOf(settled: PartitionAssignment): string {
    return [...settled.inSyncSet].sort()[0] ?? ''
  }

  function otherCopyOf(settled: PartitionAssignment): string {
    return settled.inSyncSet.find(nodeId => nodeId !== candidateOf(settled)) ?? ''
  }

  it('sends a copy that lacks the last entry of the old term that entry, and keeps it in sync', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const candidate = candidateOf(settled)
    const behind = otherCopyOf(settled)
    const withheld = running
      .transport(oldPrimary)
      .holdWhen((target, message) => target === behind && entryForDocument('stranded')(target, message))
    void outcomeOf(running.node(oldPrimary).insert(INDEX, fields('stranded', 999), 'stranded'))
    await waitUntil('the candidate to hold the stranded write', async () =>
      (await readCopy(running.probe, candidate)).has('stranded'),
    )
    expect((await readCopy(running.probe, behind)).has('stranded')).toBe(false)
    ledger.set('stranded', fields('stranded', 999))
    const behindWatch = watchInSync(running, behind)
    const syncsBefore = running.transport(behind).syncTiers().length

    await failOver(running, settled, () => withheld.release())

    await expectEveryCopyHolds(running, ledger, [behind])
    expect(behindWatch.leftAt()).toBeNull()
    expect(running.transport(behind).syncTiers().slice(syncsBefore)).toEqual([])
  }, 90_000)

  it('removes and resyncs a copy that holds an entry of the old term beyond the new primary', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const candidate = candidateOf(settled)
    const ahead = otherCopyOf(settled)
    const withheld = running
      .transport(oldPrimary)
      .holdWhen((target, message) => target === candidate && entryForDocument('stranded')(target, message))
    void outcomeOf(running.node(oldPrimary).insert(INDEX, fields('stranded', 999), 'stranded'))
    await waitUntil('the copy ahead to hold the stranded write', async () =>
      (await readCopy(running.probe, ahead)).has('stranded'),
    )
    const aheadWatch = watchInSync(running, ahead)

    const handover = await failOver(running, settled, () => withheld.release())
    const leftAt = await waitUntil('the copy ahead to leave the in-sync set', () => aheadWatch.leftAt())
    expect(leftAt - handover.at).toBeLessThan(REPLICATION_TIMEOUT_MS)

    await expectEveryCopyHolds(running, ledger, [ahead])
    expect(running.transport(ahead).syncTiers()).toContain('snapshot')
  }, 90_000)

  it('keeps a write whose old-term entry reached no copy through the new primary, and resyncs the old primary that held it', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const transport = running.transport(oldPrimary)
    const lateEntries = transport.holdWhen(entryForDocument('late'))
    const late = outcomeOf(running.node(oldPrimary).insert(INDEX, fields('late', 2), 'late'))
    await waitUntil('the late write to wait on both replicas', () => lateEntries.count() >= settled.inSyncSet.length)
    const oldPrimaryWatch = watchInSync(running, oldPrimary)

    await swapLeadership(running, settled)
    await waitUntil('the old primary to leave the in-sync set', () => oldPrimaryWatch.leftAt())
    lateEntries.release()
    expect(await late).toEqual({ state: 'acknowledged' })
    ledger.set('late', fields('late', 2))

    await expectEveryCopyHolds(running, ledger, [oldPrimary])
    expect(transport.syncTiers()).toContain('snapshot')
  }, 90_000)

  it('removes an older copy that never answers the term start, then resyncs it, and holds writes no longer than the replication timeout', async () => {
    const { running, settled, ledger } = await startLedger()
    const older = otherCopyOf(settled)
    running.transport(older).ignoreWhen(ofType('replication.term_start'))
    const olderWatch = watchInSync(running, older)
    const syncsBefore = running.transport(older).syncTiers().length

    const handover = await failOver(running, settled)
    const startedAt = Date.now()
    await running.node('controller').insert(INDEX, fields('first of the term', 7), 'first-of-term')
    const firstWriteMs = Date.now() - startedAt
    ledger.set('first-of-term', fields('first of the term', 7))

    const leftAt = await waitUntil(
      'the older copy to leave the in-sync set',
      () => olderWatch.leftAt(),
      REPLICATION_TIMEOUT_MS + REJOIN_TIMEOUT_MS,
    )
    expect(leftAt - handover.at).toBeLessThan(REPLICATION_TIMEOUT_MS + WRITE_MARGIN_MS)
    expect(firstWriteMs).toBeLessThan(REPLICATION_TIMEOUT_MS + WRITE_MARGIN_MS)
    await expectEveryCopyHolds(running, ledger, [older])
    expect(running.transport(older).syncTiers().slice(syncsBefore)).toEqual(['incremental'])
  }, 120_000)
})
