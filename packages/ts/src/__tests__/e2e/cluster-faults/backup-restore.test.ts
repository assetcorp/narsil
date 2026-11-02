import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BackupJob, readBackupJobs } from '../../../distribution/backups/jobs'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/cluster/controller/types'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import { type BackupLedger, createBackupLedger } from './backup-oracle'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, type FleetSettings, startFleet } from './fleet'
import type { LedgerDocument } from './oracle'
import { type FaultState, SEARCH_TERM, send, startWorkload } from './workload'

const INDEX_NAME = 'ledger'
const RESTORED_NAME = 'ledger-restored'
const BACKUP_NAME = 'during-writes'
const BACKUP_KEY_PREFIX = 'clusters/ledger'
const SOURCE_NODES = 3
const TARGET_NODES = 2
const PARTITION_COUNT = 3
const REPLICATION_FACTOR = 1
const WRITERS = 4
const PRELOADED_DOCUMENTS = 60_000
const PRELOAD_BATCH = 2_000
const PRELOAD_TITLE_WORDS = 24
const TITLE_VOCABULARY = [
  'harbour',
  'invoice',
  'cargo',
  'manifest',
  'tariff',
  'berth',
  'crane',
  'pallet',
  'freight',
  'customs',
  'vessel',
  'anchor',
  'quay',
  'ledger',
  'voyage',
  'barge',
  'tonnage',
  'dock',
  'pilot',
  'tide',
  'hold',
  'bunker',
  'charter',
  'consignee',
  'container',
  'draught',
  'gangway',
  'hawser',
  'lighter',
  'mooring',
  'stevedore',
  'wharf',
]
const WRITES_BEFORE_BACKUP = 400
const KILL_HOLD_MS = 3_000
const BACKUP_ATTEMPTS = 3
const JOB_POLL_MS = 10
const JOB_APPEAR_TIMEOUT_MS = 10_000
const TASK_POLL_MS = 250
const TASK_TIMEOUT_MS = 240_000
const ACTIVE_TIMEOUT_MS = 120_000
const LIST_PAGE = 500

const FLEET_TIMING = {
  heartbeatTtlSeconds: 10,
  controllerLeaseTtlMs: 5_000,
  standbyRetryMs: 1_000,
  waitForServingMs: 30_000,
}

interface TaskRecord {
  id: string
  status: string
  error?: { code?: string; message?: string }
}

function fleetSettings(nodes: number, backupDirectory: string): FleetSettings {
  return {
    ...FLEET_TIMING,
    keyPrefix: `_narsil_backup_${nodes}_${randomUUID()}`,
    partitionCount: PARTITION_COUNT,
    replicationFactor: REPLICATION_FACTOR,
    fixedNodeIds: true,
    backups: { directory: backupDirectory, keyPrefix: BACKUP_KEY_PREFIX },
  }
}

async function finishedTask(base: string, started: TaskRecord): Promise<TaskRecord> {
  const deadline = Date.now() + TASK_TIMEOUT_MS
  while (Date.now() < deadline) {
    const reply = await send(base, 'GET', `/tasks/${started.id}`, undefined, 10_000)
    const task = JSON.parse(reply.text) as TaskRecord
    if (task.status !== 'running') return task
    await sleep(TASK_POLL_MS)
  }
  throw new Error(`Task ${started.id} did not finish within ${TASK_TIMEOUT_MS} ms`)
}

async function startTask(base: string, path: string, body: unknown): Promise<TaskRecord> {
  const reply = await send(base, 'POST', path, body, 30_000)
  expect(reply.status, reply.text).toBe(202)
  return JSON.parse(reply.text) as TaskRecord
}

function preloadedTitle(at: number): string {
  const words = Array.from(
    { length: PRELOAD_TITLE_WORDS },
    (_, word) => TITLE_VOCABULARY[(at * 7 + word * 13) % TITLE_VOCABULARY.length],
  )
  return `${SEARCH_TERM} preload ${at} ${words.join(' ')}`
}

async function preload(base: string, ledger: BackupLedger): Promise<void> {
  for (let start = 0; start < PRELOADED_DOCUMENTS; start += PRELOAD_BATCH) {
    const documents = Array.from({ length: Math.min(PRELOAD_BATCH, PRELOADED_DOCUMENTS - start) }, (_, offset) => ({
      id: `preload-${start + offset}`,
      title: preloadedTitle(start + offset),
      version: 0,
    }))
    const reply = await send(base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, { documents }, 120_000)
    expect(reply.status, reply.text).toBe(200)
    expect((JSON.parse(reply.text) as { failed: unknown[] }).failed).toEqual([])
    for (const document of documents) {
      ledger.record(document.id, { title: document.title, version: document.version }, 'acknowledged')
    }
  }
}

async function runningBackupJob(coordinator: ClusterCoordinator): Promise<BackupJob> {
  const deadline = Date.now() + JOB_APPEAR_TIMEOUT_MS
  while (Date.now() < deadline) {
    const jobs = await readBackupJobs(coordinator)
    for (const job of jobs.values()) {
      if (job.kind === 'backup' && job.backupName === BACKUP_NAME && job.status === 'running') {
        if (job.partitionsTotal > 0) return job
      }
    }
    await sleep(JOB_POLL_MS)
  }
  throw new Error(`The controller recorded no running backup '${BACKUP_NAME}' within ${JOB_APPEAR_TIMEOUT_MS} ms`)
}

async function firstPartitionDoneAt(coordinator: ClusterCoordinator): Promise<number> {
  for (;;) {
    const jobs = await readBackupJobs(coordinator)
    const job = [...jobs.values()].find(
      entry => entry.kind === 'backup' && entry.backupName === BACKUP_NAME && entry.finishedAt === undefined,
    )
    if (job === undefined || job.partitionsDone > 0) return Date.now()
    await sleep(JOB_POLL_MS)
  }
}

async function victimOf(coordinator: ClusterCoordinator, fleet: Fleet) {
  const table = await coordinator.getAllocation(INDEX_NAME)
  const controller = await coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  const primaries = new Set([...(table?.assignments.values() ?? [])].map(assignment => assignment.primary))
  const candidates = fleet.nodes.filter(node => node.slot !== 0 && primaries.has(node.nodeId()))
  const victim = candidates.find(node => node.nodeId() !== controller) ?? candidates[0]
  if (victim === undefined) throw new Error('Every primary is on the node that takes the requests')
  return victim
}

async function untilActive(coordinator: ClusterCoordinator, fleet: Fleet, indexName: string): Promise<void> {
  const deadline = Date.now() + ACTIVE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const running = new Set(fleet.nodes.filter(node => node.running()).map(node => node.nodeId()))
    const table = await coordinator.getAllocation(indexName).catch(() => null)
    const assignments = [...(table?.assignments.values() ?? [])]
    if (
      assignments.length === PARTITION_COUNT &&
      assignments.every(
        assignment =>
          assignment.state === 'ACTIVE' &&
          assignment.primary !== null &&
          running.has(assignment.primary) &&
          assignment.inSyncSet.length >= REPLICATION_FACTOR,
      )
    ) {
      return
    }
    await sleep(TASK_POLL_MS)
  }
  throw new Error(`Index '${indexName}' never had every partition active with its replicas`)
}

async function listEveryDocument(base: string, indexName: string): Promise<Map<string, LedgerDocument>> {
  const documents = new Map<string, LedgerDocument>()
  let cursor: string | null = null
  do {
    const reply = await send(
      base,
      'POST',
      `/indexes/${indexName}/documents/_list`,
      { limit: LIST_PAGE, ...(cursor === null ? {} : { cursor }) },
      30_000,
    )
    expect(reply.status, reply.text).toBe(200)
    const page = JSON.parse(reply.text) as {
      documents: Array<{ id: string; document: { title: unknown; version: unknown } }>
      cursor: string | null
    }
    for (const entry of page.documents) {
      documents.set(entry.id, { title: String(entry.document.title), version: Number(entry.document.version) })
    }
    cursor = page.cursor
  } while (cursor !== null)
  return documents
}

describe('a backup taken while a client writes and a primary dies', () => {
  let etcd: EtcdMembers | null = null
  let source: Fleet | null = null
  let target: Fleet | null = null
  let sourceCoordinator: ClusterCoordinator | null = null
  let backupDirectory = ''
  let sourcePrefix = ''

  beforeAll(async () => {
    backupDirectory = await mkdtemp(join(tmpdir(), 'narsil-backup-store-'))
    etcd = await startEtcdMembers(null)
    const settings = fleetSettings(SOURCE_NODES, backupDirectory)
    sourcePrefix = settings.keyPrefix
    source = await startFleet(SOURCE_NODES, etcd, null, settings)
    for (const node of source.nodes) await source.start(node.slot)
    sourceCoordinator = await createEtcdCoordinator({ endpoints: [...etcd.endpoints], keyPrefix: sourcePrefix })
  }, 240_000)

  afterAll(async () => {
    await sourceCoordinator?.shutdown().catch(() => {})
    await source?.remove()
    await target?.remove()
    await etcd?.remove()
    await rm(backupDirectory, { recursive: true, force: true })
  }, 120_000)

  it('restores onto a two-node cluster every write acknowledged before the backup that completed', async () => {
    if (etcd === null || source === null || sourceCoordinator === null) throw new Error('The cluster never started')
    const fleet = source
    const coordinator = sourceCoordinator
    const entry = fleet.nodes[0]?.base ?? ''
    const created = await send(
      entry,
      'POST',
      '/indexes',
      { name: INDEX_NAME, config: { schema: { title: 'string', version: 'number' } } },
      60_000,
    )
    expect(created.status, created.text).toBe(201)
    await untilActive(coordinator, fleet, INDEX_NAME)

    const ledger = createBackupLedger()
    await preload(entry, ledger)
    const faults: FaultState = { unavailable: new Set(), startedOn: [], describe: () => 'a backup' }
    const workload = startWorkload({
      fleet,
      ledger,
      faults,
      indexName: INDEX_NAME,
      writers: WRITERS,
      searchers: 0,
      random: Math.random,
    })
    let cutAt = 0
    const outcomes: string[] = []
    try {
      while (ledger.counts().acknowledged < PRELOADED_DOCUMENTS + WRITES_BEFORE_BACKUP) await sleep(TASK_POLL_MS)
      for (let attempt = 1; attempt <= BACKUP_ATTEMPTS; attempt++) {
        await untilActive(coordinator, fleet, INDEX_NAME)
        const victim = attempt === 1 ? await victimOf(coordinator, fleet) : null
        cutAt = Date.now()
        const started = await startTask(entry, `/indexes/${INDEX_NAME}/backups`, { backup: BACKUP_NAME })
        const acceptedAt = Date.now()
        if (victim !== null) {
          const job = await runningBackupJob(coordinator)
          expect(job.partitionsTotal).toBe(PARTITION_COUNT)
          expect(job.partitionsDone, 'a partition finished before the kill, so the kill missed the backup').toBe(0)
          faults.unavailable.add(victim.slot)
          const killAt = Date.now()
          await fleet.kill(victim.slot)
          const firstDone = firstPartitionDoneAt(coordinator)
          await sleep(KILL_HOLD_MS)
          await fleet.start(victim.slot)
          faults.unavailable.delete(victim.slot)
          const firstDoneAt = await firstDone
          console.log(
            `the kill of ${victim.nodeId()} landed ${killAt - acceptedAt} ms after the 202, and the first partition finished ${firstDoneAt - acceptedAt} ms after it`,
          )
        }
        const finished = await finishedTask(entry, started)
        outcomes.push(`attempt ${attempt}: ${finished.status} ${finished.error?.code ?? ''}`)
        if (finished.status === 'succeeded') break
        expect(finished.status, JSON.stringify(finished)).toBe('failed')
        expect(finished.error?.code, JSON.stringify(finished)).not.toBe('INTERNAL_ERROR')
      }
    } finally {
      await workload.stop()
    }
    console.log(`backup ${outcomes.join('; ')}, writes ${JSON.stringify(ledger.counts())}`)
    expect(outcomes[outcomes.length - 1]).toMatch(/succeeded/)

    target = await startFleet(TARGET_NODES, etcd, null, fleetSettings(TARGET_NODES, backupDirectory))
    for (const node of target.nodes) await target.start(node.slot)
    const targetEntry = target.nodes[0]?.base ?? ''
    const listed = await send(targetEntry, 'GET', '/backups', undefined, 30_000)
    expect(listed.status, listed.text).toBe(200)
    expect(
      (JSON.parse(listed.text) as { backups: Array<{ name: string }> }).backups.map(backup => backup.name),
    ).toEqual([BACKUP_NAME])
    const restore = await startTask(targetEntry, `/backups/${BACKUP_NAME}/_restore`, { indexName: RESTORED_NAME })
    const restored = await finishedTask(targetEntry, restore)
    expect(restored.status, JSON.stringify(restored)).toBe('succeeded')

    const documents = await listEveryDocument(targetEntry, RESTORED_NAME)
    expect(ledger.counts().acknowledged).toBeGreaterThanOrEqual(PRELOADED_DOCUMENTS + WRITES_BEFORE_BACKUP)
    expect(ledger.checkBackup(cutAt, documents)).toEqual([])
    const search = await send(targetEntry, 'POST', `/indexes/${RESTORED_NAME}/search`, { term: 'ledger' }, 30_000)
    expect(search.status, search.text).toBe(200)
    expect((JSON.parse(search.text) as { count: number }).count).toBe(documents.size)
  }, 1_200_000)
})
