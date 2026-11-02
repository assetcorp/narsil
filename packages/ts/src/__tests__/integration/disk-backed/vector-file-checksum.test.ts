import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'
import { requireManifestOnDisk } from '../../persistence/durability/manifest-on-disk'
import { seededRandom } from './oracle'

const INDEX = 'passages'
const DIMENSION = 64
const PASSAGES = 3_000
const ENVELOPE_HEADER_BYTES = 32
const ENVELOPE_CHECKSUM_OFFSET = 14
const VECTOR_PAGE_BYTES = 65_536

const CONFIG: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
  language: 'english',
  textStorage: 'disk',
}

describe('vector files of a disk-backed index', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-checksum-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('records a file checksum that matches every byte on disk, across vector pages of two lengths', async () => {
    const random = seededRandom(95)
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await engine.createIndex(INDEX, CONFIG)
    const passages = Array.from({ length: PASSAGES }, (_, at) => ({
      title: `passage ${at}`,
      embedding: Array.from({ length: DIMENSION }, () => random() * 2 - 1),
    }))
    for (let at = 0; at < PASSAGES; at++) await engine.insert(INDEX, passages[at], `passage-${at}`)
    await engine.checkpoint(INDEX)
    await engine.shutdown()

    const manifest = await requireManifestOnDisk(root, INDEX)
    const files = manifest.vectors.flatMap(field => field.files)
    expect(files.length).toBeGreaterThan(0)
    let bytesAcrossFiles = 0
    for (const file of files) {
      expect(file.headOffset).toBeDefined()
      const bytes = await readFile(join(root, file.key))
      bytesAcrossFiles += bytes.byteLength
      const fromPayload = crc32(bytes.subarray(ENVELOPE_HEADER_BYTES))
      expect(bytes.readUInt32BE(ENVELOPE_CHECKSUM_OFFSET)).toBe(fromPayload)
      expect(file.checksum).toBe(fromPayload)
    }
    expect(bytesAcrossFiles).toBeGreaterThan(VECTOR_PAGE_BYTES * 2)

    const reopened = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    const answered = await reopened.query(INDEX, {
      vector: { field: 'embedding', value: passages[17].embedding, metric: 'cosine', similarity: -1 },
      limit: 1,
    })
    await reopened.shutdown()
    expect(answered.hits.map(hit => hit.id)).toEqual(['passage-17'])
  }, 60_000)
})
