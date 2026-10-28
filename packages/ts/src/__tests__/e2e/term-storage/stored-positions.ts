import { decode } from '@msgpack/msgpack'
import type { AnyDocument } from '../../../types/schema'
import { stemOf } from '../partial-words/corpus'
import { openEnvelope, readTar, uint32Values } from '../portability/archive-oracle'

const textDecoder = new TextDecoder()

function postingKey(token: string, documentId: string, field: string): string {
  return `${token}\u0000${documentId}\u0000${field}`
}

function stringsOf(blob: Uint8Array, offsets: readonly number[]): string[] {
  return offsets.slice(0, -1).map((start, at) => textDecoder.decode(blob.subarray(start, offsets[at + 1])))
}

function uint16Values(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: Math.floor(bytes.byteLength / 2) }, (_, i) => view.getUint16(i * 2, true))
}

export function expectedPositions(documents: readonly AnyDocument[], field: string): Map<string, number[]> {
  const expected = new Map<string, number[]>()
  for (const document of documents) {
    const words = String(document[field])
      .split(' ')
      .filter(word => word.length > 0)
    words.forEach((word, position) => {
      const key = postingKey(stemOf(word.toLowerCase()), String(document.id), field)
      const positions = expected.get(key) ?? []
      positions.push(position)
      expected.set(key, positions)
    })
  }
  return expected
}

export function storedPositions(archive: Uint8Array, field: string): Map<string, number[]> {
  const segments: Array<Record<string, unknown>> = []
  for (const entry of readTar(archive).slice(2)) {
    const payload = decode(openEnvelope(entry.data).payload) as Record<string, unknown>
    if (payload.tokens instanceof Uint8Array && payload.postingOffsets instanceof Uint8Array) segments.push(payload)
  }
  const removed = new Set(segments.flatMap(segment => segment.tombstones as string[]))
  const stored = new Map<string, number[]>()
  for (const segment of segments) {
    const ids = stringsOf(segment.ids as Uint8Array, uint32Values(segment.idOffsets as Uint8Array))
    const tokens = stringsOf(segment.tokens as Uint8Array, uint32Values(segment.tokenOffsets as Uint8Array))
    const fieldNames = segment.fieldNames as string[]
    const postingOffsets = uint32Values(segment.postingOffsets as Uint8Array)
    const postingDocuments = uint32Values(segment.postingDocuments as Uint8Array)
    const postingFields = uint16Values(segment.postingFields as Uint8Array)
    if (!(segment.positionOffsets instanceof Uint8Array) || !(segment.positions instanceof Uint8Array)) {
      throw new Error('the archive holds a segment without positions')
    }
    const positionOffsets = uint32Values(segment.positionOffsets)
    const positions = uint32Values(segment.positions)
    tokens.forEach((token, ordinal) => {
      for (let posting = postingOffsets[ordinal]; posting < postingOffsets[ordinal + 1]; posting++) {
        const documentId = ids[postingDocuments[posting]]
        if (removed.has(documentId) || fieldNames[postingFields[posting]] !== field) continue
        const key = postingKey(token, documentId, field)
        if (stored.has(key)) throw new Error(`the archive holds ${key} twice`)
        stored.set(key, positions.slice(positionOffsets[posting], positionOffsets[posting + 1]))
      }
    })
  }
  return stored
}
