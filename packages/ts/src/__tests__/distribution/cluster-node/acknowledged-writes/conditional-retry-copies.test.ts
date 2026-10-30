import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import type { SchemaDefinition } from '../../../../types/schema'
import { createTestCluster, INDEX, SCHEMA, type TestCluster, waitForCopies } from './harness'
import { compensated, createWriteOracle, neverArrived, sendRetry, tookEffect } from './write-record-oracle'

const ROUTER = 'router'
const PRIMARY = 'node-a'
const REPLICA = 'node-b'
const RETAINED_LOG_BYTES = 4_096
const FILLER_DOCUMENTS = 40
const FILLER_TITLE_LENGTH = 300
const FIXTURE = fileURLToPath(
  new URL('../../../persistence/fixtures/cluster-node-without-write-records/', import.meta.url),
)

interface FixtureState {
  schemas: Record<string, SchemaDefinition>
  allocation: { indexName: string; version: number; replicationFactor: number; indexUuid: string } & {
    assignments: Array<[number, PartitionAssignment]>
  }
  values: Record<string, string | null>
}

function entry(title: string, amount: number): Record<string, unknown> {
  return { title, amount }
}

describe('a write sent again to a copy that the primary did not build itself', () => {
  let cluster: TestCluster | undefined
  let scratch: string | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  it('decides each retry the same way on a replica that copied a snapshot and then took over', async () => {
    cluster = await createTestCluster()
    await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start(PRIMARY, { durable: false, replication: { logRetentionBytes: RETAINED_LOG_BYTES } })
    await cluster.node(ROUTER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    await waitForCopies(cluster.coordinator, PRIMARY, [])
    const oracle = createWriteOracle(cluster, ROUTER)

    for (let i = 0; i < FILLER_DOCUMENTS; i++) {
      await oracle.insert(`filler-${i}`, entry(`${i} ${'x'.repeat(FILLER_TITLE_LENGTH)}`, i))
    }
    const keptBefore = await oracle.insert('kept', entry('kept', 1))
    const keptFailed = await oracle.update('kept', entry('kept', 2))
    const restoredFailed = await oracle.insert('restored', entry('restored', 3))
    const restoredBack = await oracle.update('restored', entry('restored', 4))
    const untouched = await oracle.insert('untouched', entry('untouched', 5))
    const gone = await oracle.insert('gone', entry('gone', 6))
    await oracle.remove('gone')

    await cluster.start(REPLICA, { durable: false })
    await waitForCopies(cluster.coordinator, PRIMARY, [REPLICA], 30_000)
    await cluster.stop(PRIMARY)
    await waitForCopies(cluster.coordinator, REPLICA, [], 30_000)

    expect(await sendRetry(cluster, REPLICA, 'kept', tookEffect(keptFailed, keptBefore), entry('kept', 90))).toBe(
      'accepted',
    )
    expect(
      await sendRetry(cluster, REPLICA, 'restored', compensated(restoredFailed, restoredBack), entry('restored', 91)),
    ).toBe('accepted')
    await oracle.appliedRetry('restored', entry('restored', 91))
    expect(
      await sendRetry(cluster, REPLICA, 'restored', compensated(restoredFailed, restoredBack), entry('restored', 92)),
    ).toBe('REPLICATION_WRITE_CONFLICT')
    expect(await sendRetry(cluster, REPLICA, 'untouched', neverArrived(untouched), entry('untouched', 93))).toBe(
      'accepted',
    )
    await oracle.appliedRetry('untouched', entry('untouched', 93))
    expect(await sendRetry(cluster, REPLICA, 'untouched', neverArrived(untouched), entry('untouched', 94))).toBe(
      'REPLICATION_WRITE_CONFLICT',
    )
    expect(await sendRetry(cluster, REPLICA, 'gone', neverArrived(gone), null)).toBe('REPLICATION_OUTCOME_UNKNOWN')
    const earliest = oracle.recordOf('filler-0')
    expect(await sendRetry(cluster, REPLICA, 'filler-0', neverArrived(earliest), entry('filler', 95))).toBe('accepted')
    await oracle.appliedRetry('filler-0', entry('filler', 95))
    await oracle.expectCopy(REPLICA)
  }, 90_000)

  it('answers outcome unknown for a document that a node from before write records stored', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'narsil-without-write-records-'))
    const directory = join(scratch, PRIMARY)
    await cp(join(FIXTURE, PRIMARY), directory, { recursive: true })
    const state = JSON.parse(await readFile(join(FIXTURE, 'coordinator.json'), 'utf8')) as FixtureState
    cluster = await createTestCluster()
    for (const [key, value] of Object.entries(state.values)) {
      if (value !== null) await cluster.coordinator.compareAndSet(key, null, Buffer.from(value, 'base64'))
    }
    for (const [name, schema] of Object.entries(state.schemas)) await cluster.coordinator.putSchema(name, schema)
    const { assignments, ...table } = state.allocation
    await cluster.coordinator.putAllocation(INDEX, { ...table, assignments: new Map(assignments) })
    cluster.directories.set(PRIMARY, directory)
    await cluster.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start(PRIMARY)
    await waitForCopies(cluster.coordinator, PRIMARY, [], 30_000)

    const oracle = createWriteOracle(cluster, ROUTER, 6)
    for (let i = 1; i <= 4; i++) oracle.documents.set(`kept-${i}`, entry(`kept ${i}`, i === 2 ? 20 : i))
    oracle.documents.set('logged-5', entry('logged 5', 5))
    const firstTerm = assignments[0]?.[1].primaryTerm ?? 0
    const logged = { seqNo: 6, primaryTerm: firstTerm }
    await oracle.expectCopy(PRIMARY)

    expect(await sendRetry(cluster, PRIMARY, 'kept-1', neverArrived({ seqNo: 1, primaryTerm: firstTerm }), null)).toBe(
      'REPLICATION_OUTCOME_UNKNOWN',
    )
    expect(
      await sendRetry(
        cluster,
        PRIMARY,
        'kept-2',
        tookEffect({ seqNo: 5, primaryTerm: firstTerm }, { seqNo: 2, primaryTerm: firstTerm }),
        entry('kept 2', 21),
      ),
    ).toBe('REPLICATION_OUTCOME_UNKNOWN')
    expect(await sendRetry(cluster, PRIMARY, 'logged-5', tookEffect(logged, logged), entry('logged 5', 50))).toBe(
      'accepted',
    )
    expect(await sendRetry(cluster, PRIMARY, 'logged-5', neverArrived(logged), entry('logged 5', 51))).toBe('accepted')
    await oracle.appliedRetry('logged-5', entry('logged 5', 51))
    const rewritten = await oracle.update('kept-3', entry('kept 3', 30))
    expect(await sendRetry(cluster, PRIMARY, 'kept-3', neverArrived(rewritten), entry('kept 3', 31))).toBe('accepted')
    await oracle.appliedRetry('kept-3', entry('kept 3', 31))
    await oracle.expectCopy(PRIMARY)
  }, 60_000)
})
