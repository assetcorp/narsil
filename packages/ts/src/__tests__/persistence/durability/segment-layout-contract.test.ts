import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'
import { openEnvelope } from '../../e2e/portability/archive-oracle'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number', tags: 'string[]' },
  language: 'english',
}

function uint32s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_, i) => view.getUint32(i * 4, true))
}

function uint16s(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getUint16(i * 2, true))
}

function sliced(blob: Uint8Array, offsets: number[]): Uint8Array[] {
  return offsets.slice(0, -1).map((start, i) => blob.subarray(start, offsets[i + 1]))
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

async function fileAt(root: string, key: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(root, key)))
}

describe('segment on-disk layout contract', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-seglayout-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the manifest and keyword segment that the specification defines', async () => {
    const inserted = new Map<string, Record<string, unknown>>()
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    for (let i = 0; i < 12; i += 1) {
      const document = { title: `harbour title ${i}`, year: 2000 + i, tags: [`tag${i % 3}`, 'ålesund'] }
      inserted.set(`d${i}`, document)
      await writer.insert('docs', document, `d${i}`)
    }
    await writer.checkpoint('docs')
    await writer.shutdown()

    const manifestFile = openEnvelope(await fileAt(root, 'docs/manifest'))
    expect(manifestFile.version).toBe(2)
    const manifest = decode(manifestFile.payload) as Record<string, unknown>
    expect(manifest.version).toBe(7)
    expect(manifest.schema).toEqual({ title: 'string', year: 'number', tags: 'string[]' })
    expect(manifest.language).toBe('english')
    expect(manifest.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 12, primaryTerm: 1 }])
    expect(manifest.vectors).toEqual([])
    const partitions = manifest.partitions as Array<{ partitionId: number; nextSegmentId: number; segments: unknown[] }>
    expect(partitions).toHaveLength(1)
    expect(partitions[0].partitionId).toBe(0)
    expect(partitions[0].segments).toHaveLength(1)

    const segment = partitions[0].segments[0] as Record<string, unknown>
    expect(Object.keys(segment).sort()).toEqual(['bytes', 'checksum', 'docCount', 'id', 'key', 'tombstoneCount'])
    expect(segment.key).toBe(`docs/segments/0/s${String(segment.id).padStart(16, '0')}`)
    expect(segment.docCount).toBe(12)
    expect(segment.tombstoneCount).toBe(0)
    expect(partitions[0].nextSegmentId).toBe((segment.id as number) + 1)

    const segmentBytes = await fileAt(root, segment.key as string)
    expect(segmentBytes.byteLength).toBe(segment.bytes)
    const segmentFile = openEnvelope(segmentBytes)
    expect(segmentFile.version).toBe(4)
    expect(crc32(segmentFile.payload)).toBe(segment.checksum)

    const payload = decode(segmentFile.payload) as Record<string, unknown>
    expect(payload.v).toBe(1)
    expect(payload.schema).toEqual(manifest.schema)
    expect(payload.tombstones).toEqual([])
    expect(payload.documentCount).toBe(12)

    const idOffsets = uint32s(payload.idOffsets as Uint8Array)
    const ids = sliced(payload.ids as Uint8Array, idOffsets).map(bytes => new TextDecoder().decode(bytes))
    expect([...ids].sort()).toEqual([...inserted.keys()].sort())
    const idOrder = uint32s(payload.idOrder as Uint8Array)
    expect(idOrder.map(ordinal => ids[ordinal])).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))

    const documentOffsets = uint32s(payload.documentOffsets as Uint8Array)
    const documents = sliced(payload.documents as Uint8Array, documentOffsets).map(bytes => decode(bytes))
    ids.forEach((id, ordinal) => {
      expect(documents[ordinal]).toEqual(inserted.get(id))
    })

    const fieldNames = payload.fieldNames as string[]
    const tokenOffsets = uint32s(payload.tokenOffsets as Uint8Array)
    const tokenBytes = sliced(payload.tokens as Uint8Array, tokenOffsets)
    for (let i = 1; i < tokenBytes.length; i++) expect(compareBytes(tokenBytes[i - 1], tokenBytes[i])).toBeLessThan(0)
    const tokens = tokenBytes.map(bytes => new TextDecoder().decode(bytes))
    expect(tokens).toContain('harbour')
    expect(tokens).toContain('ålesund')

    const postingOffsets = uint32s(payload.postingOffsets as Uint8Array)
    expect(postingOffsets).toHaveLength(tokens.length + 1)
    const postingDocuments = uint32s(payload.postingDocuments as Uint8Array)
    const postingFields = uint16s(payload.postingFields as Uint8Array)
    expect(postingFields).toHaveLength(postingDocuments.length)
    for (const field of postingFields) expect(field).toBeLessThan(fieldNames.length)
    const harbour = tokens.indexOf('harbour')
    const harbourDocuments = postingDocuments
      .slice(postingOffsets[harbour], postingOffsets[harbour + 1])
      .map(ordinal => ids[ordinal])
    expect(harbourDocuments.sort()).toEqual([...inserted.keys()].sort())
    expect(uint32s(payload.documentFrequencies as Uint8Array)[harbour]).toBe(12)

    const years = (payload.numeric as Array<{ field: string; documents: Uint8Array; values: Uint8Array }>).find(
      column => column.field === 'year',
    )
    if (years === undefined) throw new Error('the segment holds no year column')
    const yearView = new DataView(years.values.buffer, years.values.byteOffset, years.values.byteLength)
    const yearValues = Array.from({ length: years.values.byteLength / 8 }, (_, i) => yearView.getFloat64(i * 8, true))
    expect(yearValues).toEqual([...yearValues].sort((a, b) => a - b))
    uint32s(years.documents).forEach((ordinal, i) => {
      expect(inserted.get(ids[ordinal])?.year).toBe(yearValues[i])
    })
  })
})
