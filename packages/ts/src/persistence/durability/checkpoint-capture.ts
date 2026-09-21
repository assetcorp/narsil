import type { VectorIndex, VectorIndexPartsPlan } from '../../vector/vector-index'
import { WHOLE_PARTITION_MIN_CHANGED_SHARE } from './constants'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState, PartitionState } from './manager-state'
import { snapshotCheckpointFor } from './recovery'
import {
  type SegmentManifest,
  type VectorCheckpointLayout,
  type VectorSegmentRef,
  type WholePartitionSegment,
  writeLiveVectors,
} from './segment'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { PartitionCheckpoint } from './snapshot-bundle'

export interface CheckpointedPartitions {
  readonly partitionCount: number
  countDocuments(): number
}

export interface CheckpointCapture {
  targets: PartitionCheckpoint[]
  documentCount: number
  vectorPlans: Map<string, VectorIndexPartsPlan>
  wholePartitions: Map<number, WholePartitionSegment>
}

export interface LiveVectorsWritten {
  vectors: VectorSegmentRef[]
  layouts: VectorCheckpointLayout[]
}

function whileNoMutationApplies<T>(partitions: readonly PartitionState[], capture: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let release: () => void = () => undefined
    const released = new Promise<void>(settle => {
      release = settle
    })
    function captureNow(): void {
      try {
        resolve(capture())
      } catch (error) {
        reject(error)
      } finally {
        release()
      }
    }
    let waiting = partitions.length
    if (waiting === 0) {
      captureNow()
      return
    }
    for (const partition of partitions) {
      partition.appendChain = partition.appendChain.then(() => {
        waiting -= 1
        if (waiting === 0) captureNow()
        return released
      })
    }
  })
}

export async function makeEveryAppliedMutationDurable(
  indexState: IndexState,
  markFatal: (error: Error) => void,
): Promise<void> {
  for (const partition of [...indexState.partitions.values()]) {
    await partition.appendChain
    if (partition.failed !== null) throw partition.failed
    try {
      await partition.walWriter.commit()
    } catch (error) {
      partition.failed = error instanceof Error ? error : new Error(String(error))
      markFatal(partition.failed)
      throw partition.failed
    }
  }
}

export interface SerialisablePartitions {
  getPartition(partitionId: number): { count(): number }
  serializePartitionToBytes(partitionId: number): Uint8Array
}

export type WholePartitionsOf = (targets: readonly PartitionCheckpoint[]) => Map<number, WholePartitionSegment>

export function wholePartitionsWhereMostChanged(
  manager: SerialisablePartitions,
  priorCheckpoint: PartitionCheckpoint[],
  priorPartitionIds: readonly number[],
  everyPartition: boolean,
): WholePartitionsOf {
  return targets => {
    const whole = new Map<number, WholePartitionSegment>()
    const changed = targets.filter(
      target => everyPartition || target.lastSeqNo !== snapshotCheckpointFor(priorCheckpoint, target.partitionId),
    )
    const mostOfEachChanged = changed.every(target => {
      const records = target.lastSeqNo - snapshotCheckpointFor(priorCheckpoint, target.partitionId)
      return records >= manager.getPartition(target.partitionId).count() * WHOLE_PARTITION_MIN_CHANGED_SHARE
    })
    const logMatchesMemory = targets.length === 1 && priorPartitionIds.every(partitionId => partitionId === 0)
    if (!everyPartition && !(mostOfEachChanged && logMatchesMemory)) return whole
    for (const { partitionId } of changed) {
      whole.set(partitionId, {
        payload: manager.serializePartitionToBytes(partitionId),
        docCount: manager.getPartition(partitionId).count(),
      })
    }
    return whole
  }
}

export async function captureCheckpoint(
  indexState: IndexState,
  manager: CheckpointedPartitions,
  vectorIndexes: Map<string, VectorIndex>,
  wholePartitionsOf: WholePartitionsOf = () => new Map(),
): Promise<CheckpointCapture> {
  for (const vectorIndex of vectorIndexes.values()) await vectorIndex.completeGraph()
  return whileNoMutationApplies([...indexState.partitions.values()], () => {
    const documentCount = manager.countDocuments()
    const targets: PartitionCheckpoint[] = []
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const partition = indexState.partitions.get(partitionId)
      targets.push({
        partitionId,
        lastSeqNo: partition?.appliedSeqNo ?? 0,
        primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
      })
    }
    const vectorPlans = new Map<string, VectorIndexPartsPlan>()
    for (const [fieldPath, vectorIndex] of vectorIndexes) vectorPlans.set(fieldPath, vectorIndex.planParts())
    return { targets, documentCount, vectorPlans, wholePartitions: wholePartitionsOf(targets) }
  })
}

export async function writeCapturedVectors(
  directory: DurableDirectory,
  indexName: string,
  capture: CheckpointCapture,
  priorManifest: SegmentManifest | null,
  rewriteUnchanged: boolean,
): Promise<LiveVectorsWritten> {
  if (capture.vectorPlans.size === 0) return { vectors: [], layouts: [] }
  const priorVectors = priorManifest?.vectors ?? []
  const priorCheckpoint = priorManifest?.checkpoint ?? []
  const noPartitionChanged = capture.targets.every(
    target => target.lastSeqNo === snapshotCheckpointFor(priorCheckpoint, target.partitionId),
  )
  const everyFieldWritten = [...capture.vectorPlans.keys()].every(fieldPath =>
    priorVectors.some(ref => ref.fieldPath === fieldPath),
  )
  if (!rewriteUnchanged && everyFieldWritten && noPartitionChanged) return { vectors: priorVectors, layouts: [] }
  const written = await writeLiveVectors({ directory, indexName, plans: capture.vectorPlans, priorVectors })
  return { vectors: written.refs, layouts: written.layouts }
}
