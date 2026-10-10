import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { packIndexSnapshotEnvelope, unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import type { FieldFilter } from '../../types/filters'
import { listedIds, PATTERN_INDEX, patternConfig, patternDocuments, referenceIds } from '../filters/pattern/fixtures'

type RawPartition = { field_indexes: Record<string, unknown> }
type RawPatternEntry = { doc_ids: string[]; runs: Record<string, number[]> }

async function rewritePartitions(
  snapshot: Uint8Array,
  rewrite: (partition: RawPartition) => void,
): Promise<Uint8Array> {
  const envelope = decode(await unpackIndexSnapshotEnvelope(snapshot)) as { partitions: Uint8Array[] }
  envelope.partitions = envelope.partitions.map(bytes => {
    const partition = decode(bytes) as RawPartition
    rewrite(partition)
    return encode(partition)
  })
  return packIndexSnapshotEnvelope(encode(envelope))
}

async function partitionsOf(snapshot: Uint8Array): Promise<RawPartition[]> {
  const envelope = decode(await unpackIndexSnapshotEnvelope(snapshot)) as { partitions: Uint8Array[] }
  return envelope.partitions.map(bytes => decode(bytes) as RawPartition)
}

function codeEntryOf(partition: RawPartition): RawPatternEntry | undefined {
  return (partition.field_indexes.pattern as Record<string, RawPatternEntry> | undefined)?.code
}

const PROBES: FieldFilter[] = [
  { contains: 'inv', caseFold: true },
  { eq: 'strasse', caseFold: true },
  { startsWith: 'conn', caseFold: true },
  { endsWith: '😀' },
  { ne: 'ab' },
  { contains: 'a' },
]

async function expectReferenceResults(narsil: Narsil): Promise<void> {
  const documents = patternDocuments()
  for (const field of ['code', 'title', 'tags']) {
    for (const filter of PROBES) {
      expect(await listedIds(narsil, field, filter)).toEqual(referenceIds(documents, field, filter))
    }
  }
}

describe('the pattern entry of a snapshot', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(PATTERN_INDEX, patternConfig)
    await narsil.insertBatch(PATTERN_INDEX, patternDocuments())
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('is absent from every partition of an index without a pattern field', async () => {
    await narsil.createIndex('prose', { schema: { title: 'string', code: 'string' }, partitions: { maxPartitions: 2 } })
    await narsil.insertBatch('prose', [
      { title: 'one', code: 'A-1' },
      { title: 'two', code: 'B-2' },
    ])
    for (const partition of await partitionsOf(await narsil.snapshot('prose'))) {
      expect(Object.hasOwn(partition.field_indexes, 'pattern')).toBe(false)
    }
  })

  it('holds an entry for each pattern field, also in a partition where no document fills the field', async () => {
    await narsil.createIndex('sparse', {
      schema: { title: 'string', code: 'verbatim' },
      partitions: { maxPartitions: 2 },
    })
    await narsil.insertBatch('sparse', [{ title: 'one' }, { title: 'two' }, { title: 'three' }])
    for (const partition of await partitionsOf(await narsil.snapshot('sparse'))) {
      expect(codeEntryOf(partition)).toEqual({ doc_ids: [], runs: {} })
    }
  })

  it('lists positions inside its document list in ascending order', async () => {
    let entries = 0
    for (const partition of await partitionsOf(await narsil.snapshot(PATTERN_INDEX))) {
      const entry = codeEntryOf(partition)
      if (entry === undefined) continue
      entries++
      for (const positions of Object.values(entry.runs)) {
        positions.forEach((position, at) => {
          expect(position).toBeLessThan(entry.doc_ids.length)
          if (at > 0) expect(position).toBeGreaterThan(positions[at - 1])
        })
      }
    }
    expect(entries).toBeGreaterThan(0)
  })

  it('restores an index whose pattern tests return the same documents', async () => {
    const snapshot = await narsil.snapshot(PATTERN_INDEX)
    await narsil.dropIndex(PATTERN_INDEX)
    await narsil.restore(PATTERN_INDEX, snapshot)
    await expectReferenceResults(narsil)
  })

  it('rebuilds a missing entry from the documents', async () => {
    const snapshot = await rewritePartitions(await narsil.snapshot(PATTERN_INDEX), partition => {
      delete partition.field_indexes.pattern
    })
    await narsil.dropIndex(PATTERN_INDEX)
    await narsil.restore(PATTERN_INDEX, snapshot)
    await expectReferenceResults(narsil)
  })

  it('raises PERSISTENCE_LOAD_FAILED for a position outside the document list', async () => {
    const snapshot = await rewritePartitions(await narsil.snapshot(PATTERN_INDEX), partition => {
      const entry = codeEntryOf(partition)
      if (entry === undefined) return
      const [first] = Object.keys(entry.runs)
      entry.runs[first] = [entry.doc_ids.length]
    })
    await narsil.dropIndex(PATTERN_INDEX)
    await expect(narsil.restore(PATTERN_INDEX, snapshot)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
  })

  it('raises PERSISTENCE_LOAD_FAILED for positions out of ascending order', async () => {
    const snapshot = await rewritePartitions(await narsil.snapshot(PATTERN_INDEX), partition => {
      const entry = codeEntryOf(partition)
      if (entry === undefined || entry.doc_ids.length < 2) return
      const [first] = Object.keys(entry.runs)
      entry.runs[first] = [1, 0]
    })
    await narsil.dropIndex(PATTERN_INDEX)
    await expect(narsil.restore(PATTERN_INDEX, snapshot)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
  })
})
