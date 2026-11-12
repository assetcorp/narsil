import { decode, ErrorCodes, NarsilError } from '#platform/storage-host'
import type { ChangeType } from '../types/changes'

export interface LoggedEntry {
  seqNo: number
  operation: 'INDEX' | 'DELETE'
  documentId: string
  document: Uint8Array | null
  previousDocument: Uint8Array | null | undefined
}

export interface DerivedChange {
  seqNo: number
  type: ChangeType
  documentId: string
  document: Uint8Array | null
  previousDocument: Uint8Array | null
}

export type DocumentTest = (document: Uint8Array) => boolean

function corrupt(seqNo: number, field: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_WAL_CORRUPT, `Log entry ${seqNo} holds a malformed ${field}`, {
    seqNo,
    field,
  })
}

function optionalBytes(value: unknown, seqNo: number, field: string): Uint8Array | null {
  if (value === null || value === undefined) return null
  if (value instanceof Uint8Array) return value
  return corrupt(seqNo, field)
}

export function loggedEntryOf(payload: Uint8Array, seqNo: number): LoggedEntry {
  const raw = decode(payload) as Record<string, unknown> | null
  if (raw === null || typeof raw !== 'object') return corrupt(seqNo, 'entry')
  const { operation, documentId } = raw
  if (operation !== 'INDEX' && operation !== 'DELETE') return corrupt(seqNo, 'operation')
  if (typeof documentId !== 'string') return corrupt(seqNo, 'documentId')
  const document = optionalBytes(raw.document, seqNo, 'document')
  if (operation === 'INDEX' && document === null) return corrupt(seqNo, 'document')
  const previousDocument =
    raw.previousDocument === undefined ? undefined : optionalBytes(raw.previousDocument, seqNo, 'previousDocument')
  return { seqNo, operation, documentId, document, previousDocument }
}

function changeOf(
  entry: LoggedEntry,
  type: ChangeType,
  document: Uint8Array | null,
  previousDocument: Uint8Array | null,
): DerivedChange {
  return { seqNo: entry.seqNo, type, documentId: entry.documentId, document, previousDocument }
}

export function changeOfEntry(entry: LoggedEntry): DerivedChange {
  const previous = entry.previousDocument ?? null
  if (entry.operation === 'DELETE') return changeOf(entry, 'remove', null, previous)
  if (entry.previousDocument === undefined) return changeOf(entry, 'put', entry.document, null)
  return changeOf(entry, previous === null ? 'insert' : 'update', entry.document, previous)
}

export function filteredChangeOfEntry(entry: LoggedEntry, test: DocumentTest): DerivedChange | null {
  const after = entry.operation === 'INDEX' ? entry.document : null
  const afterMatches = after !== null && test(after)
  if (entry.previousDocument === undefined) {
    return afterMatches ? changeOf(entry, 'put', after, null) : changeOf(entry, 'remove', null, null)
  }
  const before = entry.previousDocument
  const beforeMatches = before !== null && test(before)
  if (beforeMatches && afterMatches) return changeOf(entry, 'update', after, before)
  if (afterMatches) return changeOf(entry, 'insert', after, null)
  if (beforeMatches) return changeOf(entry, 'remove', null, before)
  return null
}
