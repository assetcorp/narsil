import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/durability/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../persistence/durability/constants')>()),
  LOG_RECORDS_PER_CHECKPOINT: 20,
  WHOLE_PARTITION_LARGEST_DOCUMENT_COUNT: 30,
}))

import { createNarsil, type Narsil } from '../../../narsil'
import {
  captureCheckpoint,
  type SerialisablePartitions,
  wholePartitionsWhereMostChanged,
} from '../../../persistence/durability/checkpoint-capture'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { IndexState, PartitionState } from '../../../persistence/durability/manager-state'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

const NO_VECTOR_FIELDS = new Map<string, VectorIndex>()

async function insertRange(engine: Narsil, from: number, to: number): Promise<void> {
  const documents = []
  for (let i = from; i < to; i += 1) documents.push({ id: `d${i}`, title: `harbour light number ${i}`, year: 1900 + i })
  const result = await engine.insertBatch('docs', documents)
  expect(result.failed).toEqual([])
}

async function manifestOf(root: string) {
  const manifest = await readSegmentManifest(createDurableDirectory(root), 'docs')
  if (manifest === null) throw new Error('manifest missing')
  return manifest
}

function indexStateAt(appliedSeqNo: number): IndexState {
  const partition: PartitionState = {
    walWriter: { commit: async () => undefined } as PartitionState['walWriter'],
    seqOwner: { primaryTerm: 1 } as PartitionState['seqOwner'],
    appendChain: Promise.resolve(),
    appliedSeqNo,
    failed: null,
  }
  return {
    partitions: new Map([[0, partition]]),
    mutationsSinceCheckpoint: 0,
    checkpointInFlight: null,
    unloading: false,
    documentBytesSinceCheckpoint: 0,
    stalledWrites: [],
  }
}

describe('a checkpoint of more log records than one checkpoint may cover', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-bounded-checkpoint-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stops the capture at the record limit, reports the records left, and takes no whole partition', async () => {
    let wholePartitionsAsked = false
    const capture = await captureCheckpoint(
      indexStateAt(50),
      { partitionCount: 1, countDocuments: () => 50 },
      NO_VECTOR_FIELDS,
      () => {
        wholePartitionsAsked = true
        return { serialized: new Map(), captured: [] }
      },
      [{ partitionId: 0, lastSeqNo: 5, primaryTerm: 1 }],
    )

    expect(capture.targets).toEqual([{ partitionId: 0, lastSeqNo: 25, primaryTerm: 1 }])
    expect(capture.recordsLeftInLog).toBe(25)
    expect(wholePartitionsAsked).toBe(false)
  })

  it('covers every applied record when the log holds fewer than the limit', async () => {
    const capture = await captureCheckpoint(
      indexStateAt(18),
      { partitionCount: 1, countDocuments: () => 18 },
      NO_VECTOR_FIELDS,
      undefined,
      [],
    )

    expect(capture.targets).toEqual([{ partitionId: 0, lastSeqNo: 18, primaryTerm: 1 }])
    expect(capture.recordsLeftInLog).toBe(0)
  })

  it('leaves a partition above the document limit to the log, however much of it changed', () => {
    const partitions = {
      getPartition: () => ({ count: () => 31 }),
      serializePartitionToBytes: () => new Uint8Array(1),
    } as unknown as SerialisablePartitions
    const wholePartitionsOf = wholePartitionsWhereMostChanged(partitions, {
      priorCheckpoint: [],
      priorPartitionIds: [],
      everyPartition: false,
      aWorkerCanSerialise: false,
    })

    const whole = wholePartitionsOf([{ partitionId: 0, lastSeqNo: 31, primaryTerm: 1 }])

    expect(whole.serialized.size).toBe(0)
    expect(whole.captured).toEqual([])
  })

  it('writes the backlog as consecutive bounded segments and recovers every document', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    await insertRange(writer, 0, 50)
    await writer.update('docs', 'd1', { title: 'lantern on the quay', year: 2001 })
    await writer.remove('docs', 'd2')

    await writer.checkpoint('docs')

    const manifest = await manifestOf(root)
    expect(manifest.partitions[0].segments.map(segment => segment.docCount)).toEqual([20, 20, 11])
    expect(manifest.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 52, primaryTerm: 1 }])
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(49)
    expect(await reader.get('docs', 'd1')).toMatchObject({ title: 'lantern on the quay', year: 2001 })
    expect(await reader.get('docs', 'd2')).toBeUndefined()
    const harbours = await reader.query('docs', { term: 'harbour', limit: 100 })
    expect(harbours.count).toBe(48)
    await reader.shutdown()
  })
})
