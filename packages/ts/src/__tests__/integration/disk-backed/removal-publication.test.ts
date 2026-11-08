import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { bytesOf } from '../../e2e/portability/archive-oracle'
import { corruptRemovalToken } from './damage-removal'

const HEADER_BYTES = 32
const PREFIX_BYTES = 8

async function removalByte(directory: string): Promise<{ path: string; offset: number }> {
  const files = await readdir(directory, { recursive: true, withFileTypes: true })
  const file = files.find(entry => entry.isFile() && /\/segments\/\d+$/.test(entry.parentPath))
  if (file === undefined) throw new Error('The checkpoint wrote no segment')
  const path = join(file.parentPath, file.name)
  const bytes = await readFile(path)
  const length = bytes.readUInt32LE(HEADER_BYTES)
  const head = decode(bytes.subarray(HEADER_BYTES + PREFIX_BYTES, HEADER_BYTES + PREFIX_BYTES + length)) as {
    sections: Array<{ name: string; offset: number }>
  }
  const section = head.sections.find(entry => entry.name === 'removals')
  if (section === undefined) throw new Error('The segment holds no removal section')
  return { path, offset: HEADER_BYTES + section.offset }
}

async function flip(path: string, offset: number): Promise<void> {
  const file = await open(path, 'r+')
  try {
    const byte = new Uint8Array(1)
    await file.read(byte, 0, 1, offset)
    byte[0] ^= 0x40
    await file.write(byte, 0, 1, offset)
  } finally {
    await file.close()
  }
}

it.each([
  'remove',
  'update',
] as const)('preserves a disk-backed document when %s cannot read its removal page', async action => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-removal-publication-'))
  const config = { durability: { directory }, workers: { enabled: false } }
  let engine = await createNarsil(config)
  const original = { body: 'amber basil cedar', rating: 7 }
  try {
    await engine.createIndex('articles', { schema: { body: 'string', rating: 'number' }, textStorage: 'disk' })
    await engine.insert('articles', original, 'retained')
    await engine.insert('articles', { body: 'amber basil', rating: 3 }, 'other')
    await engine.checkpoint('articles')
    await engine.shutdown()
    engine = await createNarsil(config)
    const before = await engine.query('articles', { term: 'amber', includeScores: true })
    const damaged = await removalByte(directory)
    await flip(damaged.path, damaged.offset)
    try {
      const mutation =
        action === 'remove'
          ? engine.remove('articles', 'retained')
          : engine.update('articles', 'retained', { body: 'delta', rating: 99 })
      await expect(mutation).rejects.toMatchObject({ code: ErrorCodes.PERSISTENCE_CRC_MISMATCH })
      expect(await engine.get('articles', 'retained')).toEqual(original)
      expect(await engine.countDocuments('articles')).toBe(2)
      const after = await engine.query('articles', { term: 'amber', includeScores: true })
      expect(after.hits).toEqual(before.hits)
      expect((await engine.query('articles', { term: 'delta' })).count).toBe(0)
    } finally {
      await flip(damaged.path, damaged.offset)
    }
    await engine.shutdown()
    engine = await createNarsil(config)
    expect(await engine.get('articles', 'retained')).toEqual(original)
    expect(await engine.countDocuments('articles')).toBe(2)
    await engine.remove('articles', 'retained')
    expect((await engine.query('articles', { term: 'amber' })).hits.map(hit => hit.id)).toEqual(['other'])
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves documents and refuses a restored removal list with a repeated token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-removal-value-'))
  const config = { durability: { directory }, workers: { enabled: false } }
  let engine = await createNarsil(config)
  const document = { body: 'amber basil cedar' }
  try {
    await engine.createIndex('articles', { schema: { body: 'string' }, textStorage: 'disk' })
    await engine.insert('articles', document, 'retained')
    await engine.checkpoint('articles')
    await engine.shutdown()
    await corruptRemovalToken(directory, 0)
    engine = await createNarsil(config)
    const archive = await bytesOf(await engine.snapshot('articles'))
    await expect(engine.restore('articles', archive)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(await engine.get('articles', 'retained')).toEqual(document)
    const before = await engine.query('articles', { term: 'amber basil', includeScores: true })
    await expect(engine.remove('articles', 'retained')).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(await engine.get('articles', 'retained')).toEqual(document)
    expect(await engine.countDocuments('articles')).toBe(1)
    expect((await engine.query('articles', { term: 'amber basil', includeScores: true })).hits).toEqual(before.hits)
    await expect(engine.update('articles', 'retained', { body: 'delta' })).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(await engine.get('articles', 'retained')).toEqual(document)
    expect((await engine.query('articles', { term: 'delta' })).count).toBe(0)
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
