import { ClientErrorCodes, NarsilError } from '../errors'
import type { Change, ChangePosition, ChangesEvent, ChangeType } from '../types/changes'
import type { AnyDocument } from '../types/schema'
import { MAX_VECTOR_FIELD_PATH_SEGMENTS } from './constants'

const CHANGE_TYPES: ReadonlySet<string> = new Set<ChangeType>(['put', 'insert', 'update', 'remove'])
const RESYNC_REASONS: ReadonlySet<string> = new Set(['epoch', 'history', 'ahead'])
const EPOCH = /^[0-9a-f]{32}$/
const FLOAT32_BYTES = 4

export type VectorFieldPaths = readonly (readonly string[])[]

export interface FirstEvent {
  event: ChangesEvent
  vectorFields: VectorFieldPaths
}

function malformed(detail: string): NarsilError {
  return new NarsilError(
    ClientErrorCodes.CLIENT_INVALID_RESPONSE,
    `The change feed sent a malformed message: ${detail}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positionsOf(raw: unknown, partitionCount: number, field: string): ChangePosition[] {
  if (!Array.isArray(raw) || raw.length !== partitionCount) throw malformed(`${field} must hold each partition once`)
  const seen = new Set<number>()
  const positions: ChangePosition[] = []
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || !isCount(item.partitionId) || !isCount(item.seqNo)) throw malformed(`${field} is invalid`)
    if (item.partitionId >= partitionCount || seen.has(item.partitionId)) {
      throw malformed(`${field} must hold each partition once`)
    }
    seen.add(item.partitionId)
    positions.push({ partitionId: item.partitionId, seqNo: item.seqNo })
  }
  return positions
}

function vectorOf(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % FLOAT32_BYTES !== 0) throw malformed('a vector has a length that is not whole floats')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const vector = new Float32Array(bytes.byteLength / FLOAT32_BYTES)
  for (let at = 0; at < vector.length; at++) vector[at] = view.getFloat32(at * FLOAT32_BYTES, true)
  return vector
}

function restoreVectorAt(document: Record<string, unknown>, path: readonly string[]): void {
  let holder = document
  for (let at = 0; at < path.length - 1; at++) {
    const segment = path[at]
    if (segment === undefined || !Object.hasOwn(holder, segment)) return
    const next = holder[segment]
    if (!isRecord(next)) return
    holder = next
  }
  const leaf = path.at(-1)
  if (leaf === undefined || !Object.hasOwn(holder, leaf)) return
  const value = holder[leaf]
  if (!(value instanceof Uint8Array)) return
  Object.defineProperty(holder, leaf, { value: vectorOf(value), enumerable: true, writable: true, configurable: true })
}

function documentOf(raw: unknown, field: string, vectorFields: VectorFieldPaths): AnyDocument {
  if (!isRecord(raw)) throw malformed(`${field} must be a map`)
  for (const path of vectorFields) restoreVectorAt(raw, path)
  return raw as AnyDocument
}

function changeOf(raw: unknown, vectorFields: VectorFieldPaths): Change {
  if (!isRecord(raw) || !isCount(raw.seqNo) || typeof raw.documentId !== 'string')
    throw malformed('a change is invalid')
  if (typeof raw.type !== 'string' || !CHANGE_TYPES.has(raw.type)) throw malformed('a change has an unknown type')
  const change: Change = { seqNo: raw.seqNo, type: raw.type as ChangeType, documentId: raw.documentId }
  if (raw.document !== undefined && raw.document !== null) {
    change.document = documentOf(raw.document, 'document', vectorFields)
  }
  if (raw.previousDocument !== undefined && raw.previousDocument !== null) {
    change.previousDocument = documentOf(raw.previousDocument, 'previousDocument', vectorFields)
  }
  return change
}

function vectorFieldsOf(raw: unknown): VectorFieldPaths {
  if (!Array.isArray(raw)) throw malformed('vectorFields must be a list of paths')
  const paths: string[][] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'string') throw malformed('vectorFields must be a list of paths')
    const path = item.split('.')
    if (path.length > MAX_VECTOR_FIELD_PATH_SEGMENTS || path.includes('')) {
      throw malformed(`the vector field path ${item} is invalid`)
    }
    paths.push(path)
  }
  return paths
}

function resyncOf(raw: Record<string, unknown>): ChangesEvent {
  if (typeof raw.reason !== 'string' || !RESYNC_REASONS.has(raw.reason)) throw malformed('the resync reason is unknown')
  return { type: 'resync', reason: raw.reason as 'epoch' | 'history' | 'ahead' }
}

export function firstEventOf(raw: unknown): FirstEvent {
  if (!isRecord(raw)) throw malformed('a message must be a map')
  if (raw.type === 'resync') return { event: resyncOf(raw), vectorFields: [] }
  if (raw.type !== 'subscribed') throw malformed('the first message must be subscribed or resync')
  const { epoch, partitionCount, bytesBehind, windowBytes, previousDocument } = raw
  if (typeof epoch !== 'string' || !EPOCH.test(epoch)) throw malformed('the epoch is invalid')
  if (!isCount(partitionCount) || partitionCount === 0) throw malformed('the partition count is invalid')
  if (!isCount(bytesBehind) || !isCount(windowBytes) || windowBytes === 0) throw malformed('a byte count is invalid')
  if (typeof previousDocument !== 'boolean') throw malformed('previousDocument must be a boolean')
  const event: ChangesEvent = {
    type: 'subscribed',
    epoch,
    partitionCount,
    positions: positionsOf(raw.positions, partitionCount, 'positions'),
    heads: positionsOf(raw.heads, partitionCount, 'heads'),
    bytesBehind,
    previousDocument,
  }
  return { event, vectorFields: vectorFieldsOf(raw.vectorFields) }
}

export function laterEventOf(raw: unknown, partitionCount: number, vectorFields: VectorFieldPaths): ChangesEvent {
  if (!isRecord(raw)) throw malformed('a message must be a map')
  if (raw.type === 'resync') return resyncOf(raw)
  if (raw.type !== 'changes') throw malformed('the message type is unknown')
  const { partitionId, scannedSeqNo, changes } = raw
  if (!isCount(partitionId) || partitionId >= partitionCount) throw malformed('the partition is unknown')
  if (!isCount(scannedSeqNo) || !Array.isArray(changes)) throw malformed('the changes are invalid')
  const decoded = (changes as unknown[]).map(change => changeOf(change, vectorFields))
  if (decoded.some(change => change.seqNo > scannedSeqNo)) throw malformed('a change lies above scannedSeqNo')
  return { type: 'changes', partitionId, changes: decoded, scannedSeqNo }
}
