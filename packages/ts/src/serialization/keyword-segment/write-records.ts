import { corrupt, requireBytesOrNil, requireCount } from './raw-fields'
import type { SegmentWriteRecords } from './types'

const UINT64_BYTES = 8

export function uint64Bytes(values: Float64Array): Uint8Array {
  const bytes = new Uint8Array(values.length * UINT64_BYTES)
  const view = new DataView(bytes.buffer)
  for (let at = 0; at < values.length; at++) view.setBigUint64(at * UINT64_BYTES, BigInt(values[at]), true)
  return bytes
}

function uint64sOf(bytes: Uint8Array, name: string): Float64Array {
  const values = new Float64Array(bytes.byteLength / UINT64_BYTES)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 0; at < values.length; at++) {
    const value = view.getBigUint64(at * UINT64_BYTES, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) corrupt(`${name} holds a value above 2^53 - 1`, { at })
    values[at] = Number(value)
  }
  return values
}

export function decodeWriteRecords(raw: Record<string, unknown>, documentCount: number): SegmentWriteRecords | null {
  const rawSeqNos = requireBytesOrNil(raw.seqNos, 'seqNos', UINT64_BYTES)
  const rawTerms = requireBytesOrNil(raw.primaryTerms, 'primaryTerms', UINT64_BYTES)
  if ((rawSeqNos === null) !== (rawTerms === null))
    corrupt('seqNos and primaryTerms must both be present or both absent')
  if (rawSeqNos === null || rawTerms === null) return null
  const seqNos = uint64sOf(rawSeqNos, 'seqNos')
  const primaryTerms = uint64sOf(rawTerms, 'primaryTerms')
  requireCount(seqNos.length, documentCount, 'seqNos')
  requireCount(primaryTerms.length, documentCount, 'primaryTerms')
  for (let at = 0; at < documentCount; at++) {
    if (seqNos[at] === 0 && primaryTerms[at] !== 0) {
      corrupt(`primaryTerms gives document ${at} a term without a seqNo`, { at })
    }
  }
  return { seqNos, primaryTerms }
}
