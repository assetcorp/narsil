import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import type { NodeRegistration } from '../../../distribution/coordinator/types'
import { NarsilError } from '../../../errors'
import type { ChangePosition } from '../../../types/changes'
import { activeTable, type Note, note, type SyncCluster, startSyncCluster, waitFor } from '../sync/cluster-fixtures'
import { ADMIN_TOKEN, upgradeStatus } from '../sync/fixtures'
import { CHANGES_SUBPROTOCOL, READER_TOKEN, readerHook } from './fixtures'

const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const FIRST_DOCUMENTS = 200
const DATA_NODES = ['harbour-a', 'harbour-b', 'harbour-c']
const ROUTER = 'harbour-office'
const OLDER_NODE = 'harbour-older'
const CLUSTER_TEST_TIMEOUT_MS = 180_000

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  return 'no error'
}

function olderRegistration(roles: NodeRegistration['roles']): NodeRegistration {
  return {
    nodeId: OLDER_NODE,
    address: `${OLDER_NODE}:9200`,
    roles,
    capacity: { memoryBytes: 8_000_000_000, cpuCores: 4, diskBytes: 100_000_000_000 },
    startedAt: '2026-10-01T00:00:00.000Z',
    version: '1.4',
  }
}

interface ExportAnswer {
  status: number
  retryAfter: string | null
  text: string
}

async function exportFrom(base: string, index: string): Promise<ExportAnswer> {
  const response = await fetch(`${base}/indexes/${index}/export`, {
    headers: { authorization: `Bearer ${READER_TOKEN}` },
  })
  return { status: response.status, retryAfter: response.headers.get('retry-after'), text: await response.text() }
}

interface DocumentExport {
  epoch: string
  positions: ChangePosition[]
  documents: Map<string, Note>
}

function parseExport(text: string): DocumentExport {
  const [header, ...lines] = text.split('\n').filter(line => line.length > 0)
  const { epoch, positions } = JSON.parse(header ?? '{}') as { epoch: string; positions: ChangePosition[] }
  const documents = new Map<string, Note>()
  for (const line of lines) {
    const { id, title, body } = JSON.parse(line) as Note & { id: string }
    documents.set(id, { title, body })
  }
  return { epoch, positions, documents }
}

function sameDocuments(left: Map<string, Note>, right: Map<string, Note>): boolean {
  if (left.size !== right.size) return false
  for (const [id, held] of left) {
    const other = right.get(id)
    if (other === undefined || other.title !== held.title || other.body !== held.body) return false
  }
  return true
}

function placedOn(table: Awaited<ReturnType<SyncCluster['coordinator']['getAllocation']>>, nodeId: string): boolean {
  if (table === null) return false
  return [...table.assignments.values()].some(
    assignment => assignment.primary === nodeId || assignment.replicas.includes(nodeId),
  )
}

describe('change capture served by a cluster', () => {
  let cluster: SyncCluster | null = null

  async function startCluster(backups: boolean, nodeLeftDelayMs?: number): Promise<SyncCluster> {
    const started = await startSyncCluster({ backups, nodeLeftDelayMs })
    cluster = started
    await started.start(ROUTER, ['coordinator', 'controller'])
    for (const nodeId of DATA_NODES) await started.start(nodeId, ['data'])
    return started
  }

  async function seed(running: SyncCluster, index: string): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    await running.admin.createIndex(index, SCHEMA)
    await activeTable(running.coordinator, index)
    const batch = []
    for (let at = 0; at < FIRST_DOCUMENTS; at++) {
      oracle.set(`n${at}`, note(at))
      batch.push({ id: `n${at}`, ...note(at) })
    }
    expect((await running.admin.insertBatch(index, batch)).failed).toEqual([])
    return oracle
  }

  afterEach(async () => {
    await cluster?.dispose()
    cluster = null
  })

  it(
    'refuses capture without a backup store and while a node registers below version 1.5, and refuses a subscriber then',
    async () => {
      const readers = readerHook([READER_TOKEN, ADMIN_TOKEN])
      const bare = await startCluster(false)
      await bare.serve(ROUTER, readers, 'changes')
      await seed(bare, 'alice')
      expect(await codeOf(bare.admin.updateChanges('alice', { enabled: true }))).toBe('CHANGES_BACKUP_STORE_REQUIRED')
      expect((await bare.admin.getChanges('alice')).enabled).toBe(false)
      await bare.dispose()
      cluster = null

      const running = await startCluster(true)
      const base = await running.serve(ROUTER, readers, 'changes')
      await seed(running, 'alice')
      await running.coordinator.registerNode(olderRegistration(['coordinator']))
      expect(await codeOf(running.admin.updateChanges('alice', { enabled: true }))).toBe('CHANGES_NOT_READY')
      expect((await running.admin.getChanges('alice')).enabled).toBe(false)
      await running.coordinator.deregisterNode(OLDER_NODE)
      await running.admin.updateChanges('alice', { enabled: true })
      expect(await upgradeStatus(base, '/indexes/alice/changes/feed', `${CHANGES_SUBPROTOCOL}, ${READER_TOKEN}`)).toBe(
        101,
      )
      await running.coordinator.registerNode(olderRegistration(['coordinator']))
      expect(await upgradeStatus(base, '/indexes/alice/changes/feed', `${CHANGES_SUBPROTOCOL}, ${READER_TOKEN}`)).toBe(
        503,
      )
    },
    CLUSTER_TEST_TIMEOUT_MS,
  )

  it(
    'exports from a backup that it starts, then follows every later write with its previous document through a node that leads no partition, across a failover',
    async () => {
      const running = await startCluster(true)
      const readers = readerHook([READER_TOKEN, ADMIN_TOKEN])
      const routerBase = await running.serve(ROUTER, readers, 'changes')
      const dataBase = await running.serve('harbour-b', readers, 'changes')
      const oracle = await seed(running, 'alice')
      await running.admin.updateChanges('alice', { enabled: true, previousDocument: true })

      const preparing = await exportFrom(dataBase, 'alice')
      expect(preparing.status).toBe(503)
      expect(preparing.retryAfter).toBe('5')
      expect(JSON.parse(preparing.text).error.code).toBe('CHANGES_EXPORT_PREPARING')
      const exported = await waitFor('a backup that qualifies for the export', async () => {
        const answer = await exportFrom(dataBase, 'alice')
        return answer.status === 200 ? parseExport(answer.text) : null
      })
      expect(exported.positions.map(position => position.partitionId)).toEqual([0, 1])
      expect(sameDocuments(exported.documents, oracle)).toBe(true)
      expect(exported.epoch).toBe((await running.admin.getChanges('alice')).epoch)

      const seededBefore = new Map<string, Note>()
      for (let at = FIRST_DOCUMENTS; at < FIRST_DOCUMENTS + 40; at++) {
        oracle.set(`n${at}`, note(at))
        await running.admin.put('alice', `n${at}`, note(at))
      }
      for (let at = 0; at < 25; at++) {
        const edited = { title: `edited note ${at}`, body: 'changed before the subscriber connected' }
        seededBefore.set(`n${at}`, note(at))
        oracle.set(`n${at}`, edited)
        await running.admin.put('alice', `n${at}`, edited)
      }
      for (let at = 25; at < 45; at++) {
        seededBefore.set(`n${at}`, note(at))
        oracle.delete(`n${at}`)
        await running.admin.remove('alice', `n${at}`)
      }

      const copy = new Map(exported.documents)
      const previousMismatches: string[] = []
      const firstPrevious = new Map<string, Note | undefined>()
      const reached = new Map(exported.positions.map(position => [position.partitionId, position.seqNo]))
      const reader = createNarsilClient({ url: routerBase })
      const subscription = reader.followChanges('alice', {
        epoch: exported.epoch,
        positions: exported.positions,
        credential: READER_TOKEN,
      })
      const following = (async () => {
        for await (const event of subscription) {
          if (event.type === 'resync') throw new Error(`The feed asked for a resync: ${event.reason}`)
          if (event.type !== 'changes') continue
          for (const change of event.changes) {
            const held = copy.get(change.documentId)
            const previous = change.previousDocument as Note | undefined
            if (!firstPrevious.has(change.documentId)) firstPrevious.set(change.documentId, previous)
            if (change.type !== 'insert' && (previous?.title !== held?.title || previous?.body !== held?.body)) {
              previousMismatches.push(`${change.documentId} at ${change.seqNo}`)
            }
            if (change.type === 'insert' && held !== undefined) previousMismatches.push(change.documentId)
            if (change.type === 'remove') copy.delete(change.documentId)
            else {
              const { title, body } = change.document as Note
              copy.set(change.documentId, { title, body })
            }
          }
          const earlier = reached.get(event.partitionId) ?? 0
          if (event.scannedSeqNo < earlier)
            throw new Error(`Partition ${event.partitionId} went back to ${event.scannedSeqNo}`)
          reached.set(event.partitionId, event.scannedSeqNo)
          subscription.ack([{ partitionId: event.partitionId, seqNo: event.scannedSeqNo }])
        }
      })()
      const failed = following.then(
        () => 'the subscription ended',
        (error: unknown) =>
          error instanceof NarsilError ? `${error.message} ${JSON.stringify(error.details)}` : String(error),
      )

      async function caughtUp(description: string): Promise<void> {
        await Promise.race([
          waitFor(description, async () => sameDocuments(copy, oracle)),
          failed.then(reason => Promise.reject(new Error(reason))),
        ])
      }

      await caughtUp('the subscriber to hold every write before the failover')
      for (const [id, seeded] of seededBefore) {
        const previous = firstPrevious.get(id)
        expect({ id, title: previous?.title, body: previous?.body }).toEqual({ id, ...seeded })
      }

      const before = await activeTable(running.coordinator, 'alice')
      const leader = before.assignments.get(0)?.primary
      if (leader === null || leader === undefined) throw new Error('partition 0 has no primary')
      await running.stop(leader)
      await waitFor('a new primary for partition 0', async () => {
        const assignment = (await running.coordinator.getAllocation('alice'))?.assignments.get(0)
        return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.primary !== leader
      })
      for (let at = 50; at < 90; at++) {
        const edited = { title: `edited note ${at}`, body: 'changed after the failover' }
        oracle.set(`n${at}`, edited)
        await running.admin.put('alice', `n${at}`, edited)
      }
      await caughtUp('the subscriber to hold every write after the failover')
      expect(previousMismatches).toEqual([])
      subscription.close()
      expect(await failed).toBe('the subscription ended')
    },
    CLUSTER_TEST_TIMEOUT_MS,
  )

  it(
    'keeps every copy of an index that records previous documents off a node below version 1.5',
    async () => {
      const running = await startCluster(true, 0)
      await running.serve(ROUTER, readerHook([READER_TOKEN, ADMIN_TOKEN]), 'changes')
      await seed(running, 'alice')
      await running.admin.updateChanges('alice', { enabled: true, previousDocument: true })
      await running.coordinator.registerNode(olderRegistration(['data']))

      await running.admin.createIndex('plain', SCHEMA)
      await waitFor('the plain index to take a copy on the older node', async () =>
        placedOn(await running.coordinator.getAllocation('plain'), OLDER_NODE),
      )

      const held = await activeTable(running.coordinator, 'alice')
      const holder = [...held.assignments.values()].flatMap(assignment => assignment.replicas).find(Boolean)
      if (holder === undefined) throw new Error('alice holds no copy')
      await running.stop(holder)
      const moved = await waitFor('alice to hold every copy away from the stopped node', async () => {
        const table = await running.coordinator.getAllocation('alice')
        if (table === null || placedOn(table, holder)) return null
        const full = [...table.assignments].every(
          ([partitionId, assignment]) =>
            assignment.state === 'ACTIVE' &&
            assignment.primary !== null &&
            assignment.replicas.length >= (held.assignments.get(partitionId)?.replicas.length ?? 1),
        )
        return full ? table : null
      })
      expect(placedOn(moved, OLDER_NODE)).toBe(false)
      expect(placedOn(await running.coordinator.getAllocation('alice'), OLDER_NODE)).toBe(false)
    },
    CLUSTER_TEST_TIMEOUT_MS,
  )
})
