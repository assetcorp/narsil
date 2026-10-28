import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { ClusterCoordinator } from '../../coordinator/types'
import { isRecord, isValidInteger } from '../../payload-guards'
import { HIDDEN_GENERATION_PREFIX, RESHARD_RECORD_CAS_ATTEMPTS } from '../constants'

export type RebalancePhase = 'copying' | 'cutover' | 'aborting'

export interface RebalanceRecord {
  jobId: string
  sourceGeneration: string
  targetGeneration: string
  targetPartitionCount: number
  phase: RebalancePhase
  cutoverAttempts: number
}

export interface RebalanceProgress {
  jobId: string
  primaryTerm: number
  snapshotSeqNo: number
  forwardedSeqNo: number
  sourceLastSeqNo: number
}

const PHASES: ReadonlySet<string> = new Set<RebalancePhase>(['copying', 'cutover', 'aborting'])
const ABSENT = new Uint8Array(0)

export function rebalanceRecordKey(indexName: string): string {
  return `_narsil/index/${indexName}/rebalance`
}

export function rebalanceProgressKey(indexName: string, partitionId: number): string {
  return `_narsil/index/${indexName}/rebalance/${partitionId}`
}

export function generationNameOf(indexUuid: string): string {
  return `${HIDDEN_GENERATION_PREFIX}${indexUuid}`
}

export function isHiddenGeneration(indexName: string): boolean {
  return indexName.startsWith(HIDDEN_GENERATION_PREFIX)
}

function malformed(key: string): never {
  throw new NarsilError(ErrorCodes.CONTROLLER_METADATA_INVALID, `The value stored under '${key}' is malformed`, { key })
}

function isCount(value: unknown): value is number {
  return isValidInteger(value) && value >= 0
}

function decodeRecord(key: string, bytes: Uint8Array): RebalanceRecord {
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch (_) {
    malformed(key)
  }
  if (
    !isRecord(raw) ||
    typeof raw.jobId !== 'string' ||
    typeof raw.sourceGeneration !== 'string' ||
    typeof raw.targetGeneration !== 'string' ||
    !isCount(raw.targetPartitionCount) ||
    typeof raw.phase !== 'string' ||
    !PHASES.has(raw.phase) ||
    !isCount(raw.cutoverAttempts)
  ) {
    malformed(key)
  }
  return {
    jobId: raw.jobId,
    sourceGeneration: raw.sourceGeneration,
    targetGeneration: raw.targetGeneration,
    targetPartitionCount: raw.targetPartitionCount,
    phase: raw.phase as RebalancePhase,
    cutoverAttempts: raw.cutoverAttempts,
  }
}

function decodeProgress(key: string, bytes: Uint8Array): RebalanceProgress {
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch (_) {
    malformed(key)
  }
  if (
    !isRecord(raw) ||
    typeof raw.jobId !== 'string' ||
    !isCount(raw.primaryTerm) ||
    !isCount(raw.snapshotSeqNo) ||
    !isCount(raw.forwardedSeqNo) ||
    !isCount(raw.sourceLastSeqNo)
  ) {
    malformed(key)
  }
  return {
    jobId: raw.jobId,
    primaryTerm: raw.primaryTerm,
    snapshotSeqNo: raw.snapshotSeqNo,
    forwardedSeqNo: raw.forwardedSeqNo,
    sourceLastSeqNo: raw.sourceLastSeqNo,
  }
}

interface Stored<T> {
  value: T | null
  bytes: Uint8Array | null
}

async function readStored<T>(
  coordinator: ClusterCoordinator,
  key: string,
  decodeValue: (key: string, bytes: Uint8Array) => T,
): Promise<Stored<T>> {
  const bytes = await coordinator.get(key)
  if (bytes === null || bytes.byteLength === 0) return { value: null, bytes }
  return { value: decodeValue(key, bytes), bytes }
}

export async function readRebalanceRecord(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<RebalanceRecord | null> {
  return (await readStored(coordinator, rebalanceRecordKey(indexName), decodeRecord)).value
}

export async function createRebalanceRecord(
  coordinator: ClusterCoordinator,
  indexName: string,
  record: RebalanceRecord,
): Promise<boolean> {
  const key = rebalanceRecordKey(indexName)
  const stored = await readStored(coordinator, key, decodeRecord)
  if (stored.value !== null) return false
  return coordinator.compareAndSet(key, stored.bytes, new Uint8Array(encode(record)))
}

export async function updateRebalanceRecord(
  coordinator: ClusterCoordinator,
  indexName: string,
  jobId: string,
  change: (record: RebalanceRecord) => RebalanceRecord | null,
): Promise<RebalanceRecord | null> {
  const key = rebalanceRecordKey(indexName)
  for (let attempt = 0; attempt < RESHARD_RECORD_CAS_ATTEMPTS; attempt++) {
    const stored = await readStored(coordinator, key, decodeRecord)
    if (stored.value === null || stored.value.jobId !== jobId) return null
    const next = change(stored.value)
    const written = next === null ? ABSENT : new Uint8Array(encode(next))
    if (await coordinator.compareAndSet(key, stored.bytes, written)) return next
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The partition count change of index '${indexName}' lost ${RESHARD_RECORD_CAS_ATTEMPTS} compare-and-set attempts`,
    { indexName, jobId },
  )
}

export async function readRebalanceProgress(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
): Promise<RebalanceProgress | null> {
  return (await readStored(coordinator, rebalanceProgressKey(indexName, partitionId), decodeProgress)).value
}

export async function writeRebalanceProgress(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  progress: RebalanceProgress,
): Promise<boolean> {
  const key = rebalanceProgressKey(indexName, partitionId)
  for (let attempt = 0; attempt < RESHARD_RECORD_CAS_ATTEMPTS; attempt++) {
    const stored = await readStored(coordinator, key, decodeProgress)
    if (
      stored.value !== null &&
      stored.value.jobId === progress.jobId &&
      stored.value.primaryTerm > progress.primaryTerm
    ) {
      return false
    }
    if (await coordinator.compareAndSet(key, stored.bytes, new Uint8Array(encode(progress)))) return true
  }
  return false
}

export async function clearRebalanceProgress(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
): Promise<void> {
  const key = rebalanceProgressKey(indexName, partitionId)
  for (let attempt = 0; attempt < RESHARD_RECORD_CAS_ATTEMPTS; attempt++) {
    const bytes = await coordinator.get(key)
    if (bytes === null || bytes.byteLength === 0) return
    if (await coordinator.compareAndSet(key, bytes, ABSENT)) return
  }
}
