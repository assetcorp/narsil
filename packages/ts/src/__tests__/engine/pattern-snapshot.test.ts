import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { FieldFilter } from '../../types/filters'
import {
  bytesOf,
  readTar,
  rewriteFiles,
  type TarEntry,
  uint32Bytes,
  uint32Values,
  writeTar,
} from '../e2e/portability/archive-oracle'
import { listedIds, PATTERN_INDEX, patternConfig, patternDocuments, referenceIds } from '../filters/pattern/fixtures'

interface PatternColumn {
  field: string
  documents: Uint8Array
  runs: Uint8Array
  offsets: Uint8Array
  postings: Uint8Array
}

function patternColumnsOf(payload: Record<string, unknown>): PatternColumn[] {
  return payload.pattern as PatternColumn[]
}

function segmentsOnly(name: string): boolean {
  return name.startsWith('segments/')
}

function withPatternColumn(
  entries: readonly TarEntry[],
  change: (column: PatternColumn, documentCount: number) => boolean,
): Uint8Array {
  let changed = 0
  const rewritten = rewriteFiles(entries, (payload, name) => {
    if (!segmentsOnly(name)) return false
    const column = patternColumnsOf(payload).find(entry => change(entry, payload.documentCount as number))
    if (column !== undefined) changed++
    return column !== undefined
  })
  if (changed === 0) throw new Error('no pattern column took the change')
  return writeTar(rewritten)
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

describe('the pattern columns of a snapshot', () => {
  let narsil: Narsil
  let entries: TarEntry[]

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(PATTERN_INDEX, patternConfig)
    await narsil.insertBatch(PATTERN_INDEX, patternDocuments())
    entries = readTar(await bytesOf(await narsil.snapshot(PATTERN_INDEX)))
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  async function expectRefused(data: Uint8Array): Promise<void> {
    await expect(narsil.restore(PATTERN_INDEX, data)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    await expectReferenceResults(narsil)
  }

  it('holds no column in a segment of an index without a pattern field', async () => {
    await narsil.createIndex('prose', { schema: { title: 'string', code: 'string' } })
    await narsil.insertBatch('prose', [
      { title: 'one', code: 'A-1' },
      { title: 'two', code: 'B-2' },
    ])
    let segments = 0
    rewriteFiles(readTar(await bytesOf(await narsil.snapshot('prose'))), (payload, name) => {
      if (!segmentsOnly(name)) return false
      segments++
      expect(patternColumnsOf(payload)).toEqual([])
      return false
    })
    expect(segments).toBeGreaterThan(0)
  })

  it('lists documents and postings in ascending order with runs of three code points', () => {
    let columns = 0
    rewriteFiles(entries, (payload, name) => {
      if (!segmentsOnly(name)) return false
      for (const column of patternColumnsOf(payload)) {
        columns++
        const documents = uint32Values(column.documents)
        const runs = uint32Values(column.runs)
        const offsets = uint32Values(column.offsets)
        const postings = uint32Values(column.postings)
        expect(runs.length % 3).toBe(0)
        expect(offsets).toHaveLength(runs.length / 3 + 1)
        expect(documents).toEqual([...new Set(documents)].sort((a, b) => a - b))
        for (let run = 0; run + 1 < offsets.length; run++) {
          const slice = postings.slice(offsets[run], offsets[run + 1])
          expect(slice).toEqual([...new Set(slice)].sort((a, b) => a - b))
          for (const ordinal of slice) expect(ordinal).toBeLessThan(payload.documentCount as number)
        }
      }
      return false
    })
    expect(columns).toBeGreaterThan(0)
  })

  it('restores an index whose pattern tests return the same documents', async () => {
    await narsil.dropIndex(PATTERN_INDEX)
    await narsil.restore(PATTERN_INDEX, writeTar(entries))
    await expectReferenceResults(narsil)
  })

  it('refuses a posting at or past the document count', async () => {
    await expectRefused(
      withPatternColumn(entries, (column, documentCount) => {
        const postings = uint32Values(column.postings)
        if (postings.length === 0) return false
        postings[postings.length - 1] = documentCount
        column.postings = uint32Bytes(postings)
        return true
      }),
    )
  })

  it('refuses a document list that names a document twice', async () => {
    await expectRefused(
      withPatternColumn(entries, column => {
        const documents = uint32Values(column.documents)
        if (documents.length === 0) return false
        column.documents = uint32Bytes([documents[0], ...documents])
        return true
      }),
    )
  })

  it('refuses runs that hold a broken number of code points, and runs out of order', async () => {
    await expectRefused(
      withPatternColumn(entries, column => {
        column.runs = uint32Bytes([...uint32Values(column.runs), 0x61])
        return true
      }),
    )
    await expectRefused(
      withPatternColumn(entries, column => {
        const runs = uint32Values(column.runs)
        if (runs.length < 6) return false
        column.runs = uint32Bytes([...runs.slice(3, 6), ...runs.slice(0, 3), ...runs.slice(6)])
        return true
      }),
    )
  })

  it('refuses postings out of ascending order inside a run, and offsets that overrun the postings', async () => {
    await expectRefused(
      withPatternColumn(entries, column => {
        const offsets = uint32Values(column.offsets)
        const postings = uint32Values(column.postings)
        const run = offsets.findIndex((start, at) => at + 1 < offsets.length && offsets[at + 1] - start >= 2)
        if (run < 0) return false
        const start = offsets[run]
        ;[postings[start], postings[start + 1]] = [postings[start + 1], postings[start]]
        column.postings = uint32Bytes(postings)
        return true
      }),
    )
    await expectRefused(
      withPatternColumn(entries, column => {
        const offsets = uint32Values(column.offsets)
        offsets[offsets.length - 1] += 1
        column.offsets = uint32Bytes(offsets)
        return true
      }),
    )
  })
})
