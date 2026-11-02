import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openBackupStore, readBackupManifest } from '../../../distribution/backups/store'
import type { BackupListing } from '../../../distribution/backups/types'
import { getIndexMetadata } from '../../../distribution/cluster/index-metadata'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { NarsilError } from '../../../errors'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import { createTestCluster, type TestCluster, waitUntil } from '../cluster-node/acknowledged-writes/harness'

const INDEX = 'ledger'
const CONTROLLER = 'controller'
const DATA_NODES = ['data-a', 'data-b', 'data-c']
const KEY_PREFIX = 'clusters/ledger'
const PARTITION_COUNT = 2
const OPENING_DOCUMENTS = 300
const LATER_DOCUMENTS = 120
const CHECKPOINT_ROUNDS = 4
const COMPACT_ABOVE_SEGMENTS = 2
const SETTLE_TIMEOUT_MS = 60_000
const HIDDEN_GENERATION_PREFIX = 'narsil-generation-'

type Entry = { title: string; version: number }

function entry(id: string, version: number): Entry {
  return { title: `ledger entry ${id}`, version }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  return 'no error'
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (item.isFile()) found.push(relative(directory, join(item.parentPath, item.name)))
  }
  return found.sort()
}

async function storedDigests(storeDirectory: string): Promise<Set<string>> {
  const files = await readdir(join(storeDirectory, KEY_PREFIX, 'files'))
  for (const name of files) {
    const bytes = await readFile(join(storeDirectory, KEY_PREFIX, 'files', name))
    expect(createHash('sha256').update(bytes).digest('hex'), `the file stored under ${name}`).toBe(name)
  }
  return new Set(files)
}

async function expectNoIndex(coordinator: ClusterCoordinator, indexName: string): Promise<void> {
  expect(await getIndexMetadata(coordinator, indexName)).toBeNull()
  expect(await coordinator.getSchema(indexName)).toBeNull()
  expect(await coordinator.getAllocation(indexName)).toBeNull()
  expect(await strayGenerations(coordinator)).toEqual([])
}

async function strayGenerations(coordinator: ClusterCoordinator): Promise<string[]> {
  const schemas = await coordinator.listSchemas()
  const served = new Set<string>()
  for (const name of schemas.filter(schema => !schema.startsWith(HIDDEN_GENERATION_PREFIX))) {
    const generation = (await coordinator.getAllocation(name))?.generation
    if (generation !== undefined) served.add(generation)
  }
  return schemas.filter(schema => schema.startsWith(HIDDEN_GENERATION_PREFIX) && !served.has(schema))
}

describe('backups that share stored files across a compaction and a failover', () => {
  let cluster: TestCluster
  let scratch = ''
  let storeDirectory = ''
  const ledger = new Map<string, Entry>()

  async function expectIndexHolds(indexName: string, expected: ReadonlyMap<string, Entry>): Promise<void> {
    const router = cluster.node(CONTROLLER)
    expect(await router.countDocuments(indexName)).toBe(expected.size)
    const stored = await router.getMultiple(indexName, [...expected.keys()])
    const differing = [...expected].filter(([id, value]) => {
      const document = stored.get(id)
      return document === undefined || document.title !== value.title || document.version !== value.version
    })
    expect(differing.slice(0, 10)).toEqual([])
  }

  async function checkpointEveryCopy(): Promise<void> {
    for (const nodeId of cluster.nodes.keys()) {
      if (nodeId !== CONTROLLER) await cluster.node(nodeId).checkpoint(INDEX)
    }
  }

  async function startDataNode(nodeId: string): Promise<void> {
    await cluster.start(nodeId, {
      durable: false,
      backups: { store: createFilesystemPersistence({ directory: storeDirectory }), keyPrefix: KEY_PREFIX },
      engine: {
        workers: { enabled: false },
        durability: { directory: join(scratch, nodeId), mode: 'sync', compactionThreshold: COMPACT_ABOVE_SEGMENTS },
      },
    })
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'narsil-backup-nodes-'))
    storeDirectory = await mkdtemp(join(tmpdir(), 'narsil-backup-store-'))
    cluster = await createTestCluster()
    await cluster.start(CONTROLLER, {
      roles: ['controller', 'coordinator'],
      durable: false,
      backups: { store: createFilesystemPersistence({ directory: storeDirectory }), keyPrefix: KEY_PREFIX },
    })
    for (const nodeId of DATA_NODES) await startDataNode(nodeId)
    await cluster
      .node(CONTROLLER)
      .createIndex(
        INDEX,
        { schema: { title: 'string', version: 'number' } },
        { partitionCount: PARTITION_COUNT, replicationFactor: 1 },
      )
  }, SETTLE_TIMEOUT_MS)

  afterAll(async () => {
    await cluster.dispose()
    await rm(scratch, { recursive: true, force: true })
    await rm(storeDirectory, { recursive: true, force: true })
  })

  it('restores the second backup in full after the first is deleted', async () => {
    const router = cluster.node(CONTROLLER)
    const opening = Array.from({ length: OPENING_DOCUMENTS }, (_, at) => ({
      id: `doc-${at}`,
      ...entry(`doc-${at}`, 1),
    }))
    expect((await router.insertBatch(INDEX, opening)).failed).toEqual([])
    for (const document of opening) ledger.set(document.id, entry(document.id, 1))
    await checkpointEveryCopy()

    await router.cluster.createBackup(INDEX, 'first')
    const afterFirst = await storedDigests(storeDirectory)
    await router.cluster.createBackup(INDEX, 'unchanged')
    expect(await storedDigests(storeDirectory)).toEqual(afterFirst)
    await router.cluster.deleteBackup('unchanged')
    expect(await storedDigests(storeDirectory)).toEqual(afterFirst)

    for (let round = 0; round < CHECKPOINT_ROUNDS; round++) {
      for (let at = round; at < OPENING_DOCUMENTS; at += 7) {
        const id = `doc-${at}`
        if (at % 3 === 0) {
          await router.remove(INDEX, id)
          ledger.delete(id)
        } else if (ledger.has(id)) {
          await router.update(INDEX, id, entry(id, round + 2))
          ledger.set(id, entry(id, round + 2))
        }
      }
      await checkpointEveryCopy()
    }

    const before = await cluster.coordinator.getAllocation(INDEX)
    const leaving = before?.assignments.get(0)?.primary
    if (leaving === undefined || leaving === null) throw new Error('Partition 0 has no primary')
    await cluster.stop(leaving)
    await waitUntil(
      'a surviving copy to take over partition 0',
      async () => {
        const assignment = (await cluster.coordinator.getAllocation(INDEX))?.assignments.get(0)
        return assignment?.state === 'ACTIVE' && assignment.primary !== null && assignment.primary !== leaving
      },
      SETTLE_TIMEOUT_MS,
    )
    for (let at = 0; at < LATER_DOCUMENTS; at++) {
      const id = `later-${at}`
      await router.insert(INDEX, entry(id, 1), id)
      ledger.set(id, entry(id, 1))
    }

    await router.cluster.createBackup(INDEX, 'second')
    const listing: BackupListing[] = await router.cluster.listBackups()
    expect(listing.map(backup => backup.name)).toEqual(['first', 'second'])
    await router.cluster.deleteBackup('first')
    expect((await router.cluster.listBackups()).map(backup => backup.name)).toEqual(['second'])

    await router.cluster.restoreBackup('second', { indexName: 'ledger-copy' })
    await expectIndexHolds('ledger-copy', ledger)
    expect(await strayGenerations(cluster.coordinator)).toEqual([])
  }, 180_000)

  it('refuses a damaged backup with BACKUP_DAMAGED and creates no index', async () => {
    const router = cluster.node(CONTROLLER)
    await router.cluster.createBackup(INDEX, 'to-damage')
    const manifest = await readBackupManifest(
      openBackupStore({ store: createFilesystemPersistence({ directory: storeDirectory }), keyPrefix: KEY_PREFIX }),
      'to-damage',
    )
    const segmentFile = manifest.partitions[0]?.files[0]?.sha256
    const missing = manifest.partitions[1]?.files.find(file => file.sha256 !== segmentFile)?.sha256
    if (segmentFile === undefined || missing === undefined) throw new Error('The backup lists too few files')

    const flipped = join(storeDirectory, KEY_PREFIX, 'files', segmentFile)
    const bytes = await readFile(flipped)
    bytes[bytes.length >> 1] ^= 0xff
    await writeFile(flipped, bytes)
    expect(await codeOf(router.cluster.restoreBackup('to-damage', { indexName: 'flipped-copy' }))).toBe(
      'BACKUP_DAMAGED',
    )
    await expectNoIndex(cluster.coordinator, 'flipped-copy')

    await unlink(join(storeDirectory, KEY_PREFIX, 'files', missing))
    expect(await codeOf(router.cluster.restoreBackup('to-damage', { indexName: 'missing-copy' }))).toBe(
      'BACKUP_DAMAGED',
    )
    await expectNoIndex(cluster.coordinator, 'missing-copy')
  }, 120_000)

  it('writes nothing outside the key prefix for a backup name that climbs out of it', async () => {
    const router = cluster.node(CONTROLLER)
    const before = await filesUnder(storeDirectory)
    for (const name of ['../escape', '../../escape', 'a/../../escape', '..']) {
      expect(await codeOf(router.cluster.createBackup(INDEX, name))).toBe('CONFIG_INVALID')
      expect(await codeOf(router.cluster.restoreBackup(name, { indexName: 'escaped' }))).toBe('CONFIG_INVALID')
      expect(await codeOf(router.cluster.deleteBackup(name))).toBe('CONFIG_INVALID')
    }
    const after = await filesUnder(storeDirectory)
    expect(after).toEqual(before)
    expect(after.every(path => path.startsWith(`${KEY_PREFIX}/`))).toBe(true)
  })
})
