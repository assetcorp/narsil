import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { INDEX_SNAPSHOT_ENVELOPE_VERSION, unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import { HEADER_SIZE } from '../../serialization/header'

const schema = { title: 'string' as const }

describe('index snapshot envelope', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'machine learning' })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('writes the NRSL header with format version 3 and a checksum', async () => {
    const data = await narsil.snapshot('prose')

    expect([data[0], data[1], data[2], data[3]]).toEqual([0x4e, 0x52, 0x53, 0x4c])
    expect(data[4]).toBe(INDEX_SNAPSHOT_ENVELOPE_VERSION)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getUint16(12, false) & 0b1000).toBe(0b1000)
    expect(view.getUint32(14, false)).not.toBe(0)
  })

  it('restores its own enveloped snapshot', async () => {
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })

  it('restores a legacy snapshot that carries no header', async () => {
    const data = await narsil.snapshot('prose')
    const legacy = encode(decode(await unpackIndexSnapshotEnvelope(data)))
    await narsil.dropIndex('prose')

    await narsil.restore('prose', legacy)

    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })

  it('rejects an envelope whose payload no longer matches its checksum', async () => {
    const data = await narsil.snapshot('prose')
    const corrupted = new Uint8Array(data)
    corrupted[HEADER_SIZE + 5] ^= 0xff

    await expect(narsil.restore('prose', corrupted)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_CRC_MISMATCH,
    })
  })

  it('rejects an envelope carrying a newer format version', async () => {
    const data = await narsil.snapshot('prose')
    const newer = new Uint8Array(data)
    newer[4] = INDEX_SNAPSHOT_ENVELOPE_VERSION + 1

    await expect(narsil.restore('prose', newer)).rejects.toMatchObject({
      code: ErrorCodes.ENVELOPE_VERSION_MISMATCH,
    })
  })

  it('rejects an envelope carrying an older format version', async () => {
    const data = await narsil.snapshot('prose')
    const older = new Uint8Array(data)
    older[4] = 1

    await expect(narsil.restore('prose', older)).rejects.toMatchObject({
      code: ErrorCodes.ENVELOPE_VERSION_MISMATCH,
    })
  })
})
