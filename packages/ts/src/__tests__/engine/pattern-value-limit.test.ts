import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { readMetadataEnvelope, unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import type { IndexConfig } from '../../types/schema'

const schema: IndexConfig['schema'] = {
  title: 'string',
  code: 'verbatim',
  name: 'string:pattern',
  paths: 'verbatim[]',
}

const refused = { code: ErrorCodes.DOC_VALIDATION_FAILED }

describe('the pattern value limit', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('refuses a value over the limit in a verbatim field, a pattern field, or a list element, counted in code points', async () => {
    await narsil.createIndex('limited', { schema, patternValueLimit: 5 })

    await expect(narsil.insert('limited', { code: 'abcdef' }, 'a')).rejects.toMatchObject(refused)
    await expect(narsil.insert('limited', { name: 'abcdef' }, 'a')).rejects.toMatchObject(refused)
    await expect(narsil.insert('limited', { paths: ['ok', 'abcdef'] }, 'a')).rejects.toMatchObject({
      ...refused,
      details: { field: 'paths', index: 1, limit: 5 },
    })
    await narsil.insert('limited', { title: 'a title far longer than five', code: '😀😀😀😀😀', paths: ['abcde'] }, 'a')
    await expect(narsil.update('limited', 'a', { code: 'abcdef' })).rejects.toMatchObject(refused)
    const batch = await narsil.insertBatch('limited', [
      { id: 'b', code: 'abcde' },
      { id: 'c', name: 'abcdef' },
    ])
    expect(batch.succeeded).toEqual(['b'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['c', ErrorCodes.DOC_VALIDATION_FAILED],
    ])

    await narsil.createIndex('default', { schema })
    await narsil.insert('default', { code: 'a'.repeat(8_192) }, 'a')
    await expect(narsil.insert('default', { code: 'a'.repeat(8_193) }, 'b')).rejects.toMatchObject(refused)
  })

  it('raises CONFIG_INVALID for a limit outside 1 to 65,536', async () => {
    for (const patternValueLimit of [0, 65_537, 1.5, Number.NaN, '100']) {
      await expect(
        narsil.createIndex('limited', { schema, patternValueLimit } as unknown as IndexConfig),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    }
    await narsil.createIndex('widest', { schema, patternValueLimit: 65_536 })
    await narsil.insert('widest', { code: 'a'.repeat(65_536) }, 'a')
  })
})

describe('the pattern value limit across a reopen and a restore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-pattern-limit-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('applies the limit after a reopen and a restore, and records it only where the developer sets it', async () => {
    const writer = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    await writer.createIndex('limited', { schema, patternValueLimit: 5 })
    await writer.createIndex('open', { schema })
    const limitedSnapshot = await writer.snapshot('limited')
    const openSnapshot = await writer.snapshot('open')
    await writer.shutdown()

    const storedLimit = async (indexName: string) =>
      (await readMetadataEnvelope(new Uint8Array(await readFile(join(root, indexName, 'meta'))))).metadata
        .patternValueLimit
    expect(await storedLimit('limited')).toBe(5)
    expect(await storedLimit('open')).toBeUndefined()
    const snapshotPayload = async (bytes: Uint8Array) =>
      decode(await unpackIndexSnapshotEnvelope(bytes)) as Record<string, unknown>
    expect((await snapshotPayload(limitedSnapshot)).patternValueLimit).toBe(5)
    expect(Object.hasOwn(await snapshotPayload(openSnapshot), 'patternValueLimit')).toBe(false)

    const reader = await createNarsil({ workers: { enabled: false }, durability: { directory: root } })
    try {
      await expect(reader.insert('limited', { code: 'abcdef' }, 'a')).rejects.toMatchObject(refused)
      await reader.insert('open', { code: 'abcdef' }, 'a')
    } finally {
      await reader.shutdown()
    }

    const restored = await createNarsil({ workers: { enabled: false } })
    try {
      await restored.restore('copy', limitedSnapshot)
      await expect(restored.insert('copy', { code: 'abcdef' }, 'a')).rejects.toMatchObject(refused)
      await restored.insert('copy', { code: 'abcde' }, 'b')
    } finally {
      await restored.shutdown()
    }
  })
})
