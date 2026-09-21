import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isCompositePartition } from '../../../core/partition/composite'
import { createNarsil, type Narsil } from '../../../narsil'
import { engineCoreOf } from '../../../narsil/internals'
import {
  __checkpointWorkerSpawnCountForTests,
  __failNextCheckpointWorkerForTests,
  resetCheckpointWorkerLatch,
} from '../../../persistence/durability/checkpoint-worker-dispatch'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import {
  captureWholePartition,
  serializeCapturedPartition,
} from '../../../persistence/durability/segment/captured-partition'

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const WORDS = ['harbour', 'lantern', 'ferry', 'quay']

function batch(from: number, to: number): Array<Record<string, unknown>> {
  const documents = []
  for (let i = from; i < to; i++) {
    documents.push({ id: `d${i}`, title: `${WORDS[i % WORDS.length]} light number ${i}`, year: 1900 + (i % 100) })
  }
  return documents
}

async function untilWorkersHoldCopies(engine: Narsil): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await engine.getMemoryStats()).workers.length > 0) return
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  throw new Error('no worker took a copy of the index')
}

async function engineWithFrozenSegments(root: string): Promise<Narsil> {
  const engine = await createNarsil({
    durability: { directory: root, checkpointIntervalMs: 0 },
    workers: { enabled: true, count: 2, promotionThreshold: 2 },
  })
  await engine.createIndex('docs', { schema: { title: 'string', year: 'number' }, language: 'english' })
  await engine.insertBatch('docs', batch(0, 4))
  await untilWorkersHoldCopies(engine)
  await engine.insertBatch('docs', batch(4, 504))
  await engine.insertBatch('docs', batch(504, 1004))
  return engine
}

function managerOf(engine: Narsil) {
  const manager = engineCoreOf(engine)?.executor.getManager('docs')
  if (manager === undefined) throw new Error('manager missing')
  return manager
}

async function segmentDocCounts(root: string): Promise<number[]> {
  const manifest = await readSegmentManifest(createDurableDirectory(root), 'docs')
  if (manifest === null) throw new Error('manifest missing')
  return manifest.partitions[0].segments.map(segment => segment.docCount)
}

describe.skipIf(!built)('a checkpoint of a partition that holds frozen segments', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-captured-partition-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    resetCheckpointWorkerLatch()
    await rm(root, { recursive: true, force: true })
  })

  it('serialises a captured partition to the bytes that the engine itself would write', async () => {
    const engine = await engineWithFrozenSegments(root)
    await engine.remove('docs', 'd17')
    await engine.update('docs', 'd600', { title: 'slipway bell', year: 2001 })
    await engine.insert('docs', { id: 'late', title: 'late quay arrival', year: 2020 })
    const manager = managerOf(engine)
    expect(isCompositePartition(manager.getPartition(0))).toBe(true)

    const captured = captureWholePartition(manager, 0)
    if (captured === null) throw new Error('the partition was not captured')
    const fromCapture = serializeCapturedPartition(
      'docs',
      { schema: manager.schema, language: 'english' },
      'english',
      captured,
    )

    expect(captured.docCount).toBe(1004)
    expect(Buffer.from(fromCapture).equals(Buffer.from(manager.serializePartitionToBytes(0)))).toBe(true)
    await engine.shutdown()
  }, 30_000)

  it('writes the whole partition in the checkpoint worker and recovers every document', async () => {
    const engine = await engineWithFrozenSegments(root)
    await engine.remove('docs', 'd17')
    const spawnedBefore = __checkpointWorkerSpawnCountForTests()

    await engine.checkpoint('docs')

    expect(__checkpointWorkerSpawnCountForTests()).toBe(spawnedBefore + 1)
    expect(await segmentDocCounts(root)).toEqual([1003])
    await engine.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(1003)
    expect(await reader.get('docs', 'd17')).toBeUndefined()
    expect(await reader.get('docs', 'd1003')).toMatchObject({ year: 1903 })
    const found = await reader.query('docs', { term: 'lantern', limit: 2000 })
    expect(found.count).toBe(250)
    await reader.shutdown()
  }, 30_000)

  it('recovers a document that arrives while the worker writes, from the segment or from the log', async () => {
    const engine = await engineWithFrozenSegments(root)

    const checkpointing = engine.checkpoint('docs')
    await engine.insert('docs', { id: 'after-capture', title: 'ferry after the capture', year: 2024 })
    await checkpointing

    const [segmentDocuments] = await segmentDocCounts(root)
    expect([1004, 1005]).toContain(segmentDocuments)
    await engine.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(1005)
    expect(await reader.get('docs', 'after-capture')).toMatchObject({ year: 2024 })
    await reader.shutdown()
  }, 30_000)

  it('writes the same segment in the current process when the worker fails', async () => {
    const engine = await engineWithFrozenSegments(root)
    __failNextCheckpointWorkerForTests()

    await engine.checkpoint('docs')

    expect(await segmentDocCounts(root)).toEqual([1004])
    await engine.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(1004)
    await reader.shutdown()
  }, 30_000)
})
