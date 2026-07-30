import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import {
  checkpointLastSeqNo,
  checkpointPrimaryTerm,
  decodeSnapshotBundle,
  encodeSnapshotBundle,
  type SnapshotBundle,
} from '../../../persistence/durability/snapshot-bundle'
import { concatEnvelopeParts } from '../../../serialization/envelope'

async function encodeBundleBytes(bundle: SnapshotBundle): Promise<Uint8Array> {
  return concatEnvelopeParts(await encodeSnapshotBundle(bundle))
}

function sampleBundle(): SnapshotBundle {
  return {
    version: 1,
    schema: { title: 'string', year: 'number' },
    language: 'english',
    partitions: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    vectorIndexes: {},
    checkpoint: [
      { partitionId: 0, lastSeqNo: 12, primaryTerm: 1 },
      { partitionId: 1, lastSeqNo: 7, primaryTerm: 1 },
    ],
  }
}

describe('snapshot bundle', () => {
  it('round-trips through the envelope with a checksum', async () => {
    const bytes = await encodeBundleBytes(sampleBundle())
    const decoded = await decodeSnapshotBundle(bytes)

    expect(decoded.version).toBe(1)
    expect(decoded.schema).toEqual({ title: 'string', year: 'number' })
    expect(decoded.language).toBe('english')
    expect(decoded.partitions.map(p => [...p])).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
    expect(decoded.checkpoint).toEqual([
      { partitionId: 0, lastSeqNo: 12, primaryTerm: 1 },
      { partitionId: 1, lastSeqNo: 7, primaryTerm: 1 },
    ])
  })

  it('writes envelope_format_version 2 in the header byte', async () => {
    const bytes = await encodeBundleBytes(sampleBundle())
    expect(bytes[4]).toBe(2)
  })

  it('sets the mandatory checksum flag in the header', async () => {
    const bytes = await encodeBundleBytes(sampleBundle())
    const flagBits = (bytes[12] << 8) | bytes[13]
    expect((flagBits >> 3) & 1).toBe(1)
  })

  it('round-trips a v2-header bundle through the snapshot reader', async () => {
    const bytes = await encodeBundleBytes(sampleBundle())
    expect(bytes[4]).toBe(2)
    const decoded = await decodeSnapshotBundle(bytes)
    expect(decoded.version).toBe(1)
    expect(decoded.language).toBe('english')
  })

  it('detects payload corruption via the envelope CRC', async () => {
    const bytes = await encodeBundleBytes(sampleBundle())
    bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff
    await expect(decodeSnapshotBundle(bytes)).rejects.toBeInstanceOf(NarsilError)
  })

  it('resolves the checkpoint position per partition', () => {
    const checkpoint = sampleBundle().checkpoint
    expect(checkpointLastSeqNo(checkpoint, 0)).toBe(12)
    expect(checkpointLastSeqNo(checkpoint, 1)).toBe(7)
    expect(checkpointLastSeqNo(checkpoint, 9)).toBe(0)
    expect(checkpointPrimaryTerm(checkpoint, 0)).toBe(1)
    expect(checkpointPrimaryTerm(checkpoint, 9)).toBe(0)
  })

  it('treats a missing checkpoint array as replay-from-zero', async () => {
    const bundle = sampleBundle()
    const bytes = await encodeBundleBytes({ ...bundle, checkpoint: [] })
    const decoded = await decodeSnapshotBundle(bytes)
    expect(decoded.checkpoint).toEqual([])
    expect(checkpointLastSeqNo(decoded.checkpoint, 0)).toBe(0)
  })

  it('rejects an unsupported bundle version', async () => {
    const { packEnvelopeBytes } = await import('../../../serialization/envelope')
    const payload = encode({ version: 99, schema: {}, language: 'english', partitions: [] })
    const bytes = await packEnvelopeBytes(payload, { checksum: true })
    await expect(decodeSnapshotBundle(bytes)).rejects.toBeInstanceOf(NarsilError)
  })

  it('round-trips the analysis names and leaves them out when absent', async () => {
    const named = await decodeSnapshotBundle(
      await encodeBundleBytes({ ...sampleBundle(), tokenizer: 'letters', stopWords: 'keeps-everything' }),
    )
    expect(named.tokenizer).toBe('letters')
    expect(named.stopWords).toBe('keeps-everything')

    const bare = await decodeSnapshotBundle(await encodeBundleBytes(sampleBundle()))
    expect(bare.tokenizer).toBeUndefined()
    expect(bare.stopWords).toBeUndefined()
  })

  it('encodes the stop word name under the stop_words wire key', async () => {
    const bytes = await encodeBundleBytes({ ...sampleBundle(), stopWords: 'keeps-everything' })
    const { unpackEnvelopeBytes } = await import('../../../serialization/envelope')
    const { payloadBytes } = await unpackEnvelopeBytes(bytes)
    const { decode } = await import('@msgpack/msgpack')
    const raw = decode(payloadBytes) as Record<string, unknown>
    expect(raw.stop_words).toBe('keeps-everything')
    expect(raw.stopWords).toBeUndefined()
  })

  it('round-trips a literal stop word list under the stop_word_list wire key', async () => {
    const bytes = await encodeBundleBytes({ ...sampleBundle(), stopWordList: ['an', 'the'] })
    const { unpackEnvelopeBytes } = await import('../../../serialization/envelope')
    const { payloadBytes } = await unpackEnvelopeBytes(bytes)
    const { decode } = await import('@msgpack/msgpack')
    const raw = decode(payloadBytes) as Record<string, unknown>
    expect(raw.stop_word_list).toEqual(['an', 'the'])

    const decoded = await decodeSnapshotBundle(bytes)
    expect(decoded.stopWordList).toEqual(['an', 'the'])

    const bare = await decodeSnapshotBundle(await encodeBundleBytes(sampleBundle()))
    expect(bare.stopWordList).toBeUndefined()
  })

  it('rejects a stop word list that is not a list of strings', async () => {
    const { packEnvelopeBytes } = await import('../../../serialization/envelope')
    const base = { version: 1, schema: { title: 'string' }, language: 'english', partitions: [] }

    const notAList = await packEnvelopeBytes(encode({ ...base, stop_word_list: 'the' }), { checksum: true })
    await expect(decodeSnapshotBundle(notAList)).rejects.toBeInstanceOf(NarsilError)

    const mixedList = await packEnvelopeBytes(encode({ ...base, stop_word_list: ['the', 7] }), { checksum: true })
    await expect(decodeSnapshotBundle(mixedList)).rejects.toBeInstanceOf(NarsilError)
  })

  it('rejects a bundle whose analysis name is not a string', async () => {
    const { packEnvelopeBytes } = await import('../../../serialization/envelope')
    const base = { version: 1, schema: { title: 'string' }, language: 'english', partitions: [] }

    const badTokenizer = await packEnvelopeBytes(encode({ ...base, tokenizer: 42 }), { checksum: true })
    await expect(decodeSnapshotBundle(badTokenizer)).rejects.toBeInstanceOf(NarsilError)

    const badStopWords = await packEnvelopeBytes(encode({ ...base, stop_words: { not: 'a name' } }), {
      checksum: true,
    })
    await expect(decodeSnapshotBundle(badStopWords)).rejects.toBeInstanceOf(NarsilError)
  })
})
