import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import {
  packIndexSnapshotEnvelope,
  readMetadataEnvelope,
  unpackIndexSnapshotEnvelope,
  writeMetadataEnvelope,
} from '../../../serialization/envelope'

describe('field types on reopen and restore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-field-type-recovery-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('searches a sortable text field by word once recovery rebuilds its checkpointed segment', async () => {
    const writer = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    await writer.createIndex('books', { schema: { title: 'string:sortable', shelf: 'string[]:sortable' } })
    await writer.insert('books', { title: 'The Left Hand of Darkness', shelf: ['winter planet'] }, 'b1')
    await writer.checkpoint('books')
    await writer.shutdown()

    const reader = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    try {
      expect((await reader.query('books', { term: 'darkness' })).hits.map(hit => hit.id)).toEqual(['b1'])
      expect((await reader.query('books', { term: 'planet' })).hits.map(hit => hit.id)).toEqual(['b1'])
    } finally {
      await reader.shutdown()
    }
  })

  it('raises SCHEMA_INVALID_TYPE when the stored metadata or a snapshot holds a type this engine does not know', async () => {
    const writer = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    await writer.createIndex('books', { schema: { title: 'string', code: 'verbatim' } })
    await writer.insert('books', { title: 'Dune', code: 'ISBN 0441013597' }, 'b1')
    const snapshot = await writer.snapshot('books')
    await writer.shutdown()

    const payload = decode(await unpackIndexSnapshotEnvelope(snapshot)) as Record<string, unknown>
    const unknownTypeSnapshot = await packIndexSnapshotEnvelope(
      encode({ ...payload, schema: { title: 'string', code: 'verbatim:partial' } }),
    )
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      await expect(engine.restore('copy', unknownTypeSnapshot)).rejects.toMatchObject({
        code: ErrorCodes.SCHEMA_INVALID_TYPE,
      })
      expect(engine.listIndexes()).toEqual([])
    } finally {
      await engine.shutdown()
    }

    const metadataPath = join(root, 'books', 'meta')
    const stored = await readMetadataEnvelope(new Uint8Array(await readFile(metadataPath)))
    const unknownTypeMetadata = { ...stored.metadata, schema: { title: 'string', code: 'glob' } }
    await writeFile(metadataPath, await writeMetadataEnvelope(unknownTypeMetadata, { checksum: true }))

    await expect(createNarsil({ workers: { enabled: false }, durability: { directory: root } })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_TYPE,
      message: expect.stringMatching(/Recovery of index "books" failed.*"glob"/s),
    })
  })
})
