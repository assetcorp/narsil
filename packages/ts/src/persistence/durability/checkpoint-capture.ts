import type { VectorCheckpointPlan, VectorIndex } from '../../vector/vector-index'
import {
  LOG_RECORDS_PER_CHECKPOINT,
  WHOLE_PARTITION_LARGEST_DOCUMENT_COUNT,
  WHOLE_PARTITION_MIN_CHANGED_SHARE,
} from './constants'
import type { IndexState, PartitionState } from './manager-state'
import type { PartitionFailure } from './mutation-batch'
import type { PartitionCheckpoint, TermStart } from './partition-checkpoint'
import { snapshotCheckpointFor } from './recovery'
import {
  type CapturablePartitions,
  type CapturedWholePartition,
  captureWholePartition,
  type PartitionContents,
  partitionContentsOf,
  type WriteRecordCapture,
} from './segment/captured-partition'
import type { SegmentManifest, VectorFieldRef } from './segment/manifest'
import type { CheckpointStore } from './segment/store'
import { type VectorCheckpointLayout, type VectorFieldWritten, writeLiveVectors } from './segment/vector-write'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'

export interface CheckpointedPartitions {
  readonly partitionCount: number
  countDocuments(): number
}

export interface CheckpointCapture {
  targets: PartitionCheckpoint[]
  documentCount: number
  vectorPlans: Map<string, VectorCheckpointPlan>
  wholePartitions: WholePartitions
  recordsLeftInLog: number
}

export interface LiveVectorsWritten {
  vectors: VectorFieldRef[]
  layouts: VectorCheckpointLayout[]
  written: VectorFieldWritten[]
}

export function whileNoMutationApplies<T>(partitions: readonly PartitionState[], capture: () => T): Promise<T> {
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
  failPartition: PartitionFailure,
): Promise<void> {
  for (const [partitionId, partition] of [...indexState.partitions]) {
    await partition.appendChain
    if (partition.failed !== null) continue
    try {
      await partition.walWriter.commit()
    } catch (error) {
      failPartition(partitionId, partition, error)
    }
  }
}

export async function openNewLogSegments(indexState: IndexState, failPartition: PartitionFailure): Promise<void> {
  const rolls = [...indexState.partitions].map(([partitionId, partition]) => {
    const rolled = partition.appendChain
      .then(() => (partition.failed === null ? partition.walWriter.rollForCheckpoint() : undefined))
      .catch((error: unknown) => {
        failPartition(partitionId, partition, error)
      })
    partition.appendChain = rolled
    return rolled
  })
  await Promise.all(rolls)
}

export function aTargetFailed(indexState: IndexState, targets: readonly PartitionCheckpoint[]): boolean {
  return targets.some(target => (indexState.partitions.get(target.partitionId)?.failed ?? null) !== null)
}

export type SerialisablePartitions = CapturablePartitions

export interface WholePartitions {
  contents: PartitionContents[]
  captured: CapturedWholePartition[]
}

export type WholePartitionsOf = (targets: readonly PartitionCheckpoint[]) => WholePartitions

function noWholePartitions(): WholePartitions {
  return { contents: [], captured: [] }
}

export interface WholePartitionRules {
  priorCheckpoint: PartitionCheckpoint[]
  priorPartitionIds: readonly number[]
  everyPartition: boolean
  aWorkerCanSerialise: boolean
  captureRecords?: (partitionId: number) => WriteRecordCapture
}

export function wholePartitionsWhereMostChanged(
  manager: SerialisablePartitions,
  rules: WholePartitionRules,
): WholePartitionsOf {
  const { priorCheckpoint, priorPartitionIds, everyPartition, aWorkerCanSerialise, captureRecords } = rules
  return targets => {
    const whole: WholePartitions = { contents: [], captured: [] }
    const changed = targets.filter(
      target => everyPartition || target.lastSeqNo !== snapshotCheckpointFor(priorCheckpoint, target.partitionId),
    )
    const mostOfEachChanged = changed.every(target => {
      const records = target.lastSeqNo - snapshotCheckpointFor(priorCheckpoint, target.partitionId)
      const documents = manager.getPartition(target.partitionId).count()
      return (
        documents <= WHOLE_PARTITION_LARGEST_DOCUMENT_COUNT && records >= documents * WHOLE_PARTITION_MIN_CHANGED_SHARE
      )
    })
    const logMatchesMemory = targets.length === 1 && priorPartitionIds.every(partitionId => partitionId === 0)
    if (!everyPartition && !(mostOfEachChanged && logMatchesMemory)) return whole
    for (const { partitionId } of changed) {
      const capture = captureRecords?.(partitionId)
      const captured = aWorkerCanSerialise ? captureWholePartition(manager, partitionId, capture) : null
      if (captured !== null) {
        whole.captured.push(captured)
      } else if (everyPartition || !aWorkerCanSerialise) {
        whole.contents.push(partitionContentsOf(manager, partitionId, capture))
      }
    }
    return whole
  }
}

export async function captureCheckpoint(
  indexState: IndexState,
  manager: CheckpointedPartitions,
  vectorIndexes: Map<string, VectorIndex>,
  wholePartitionsOf: WholePartitionsOf = noWholePartitions,
  priorCheckpointThatLimitsTheRecords?: PartitionCheckpoint[],
  listedVectorFields: readonly VectorFieldRef[] = [],
  termHistoryOf?: (partitionId: number, lastSeqNo: number) => TermStart[],
  onCaptured?: () => void,
): Promise<CheckpointCapture> {
  for (const vectorIndex of vectorIndexes.values()) await vectorIndex.completeGraph()
  return whileNoMutationApplies([...indexState.partitions.values()], () => {
    onCaptured?.()
    const documentCount = manager.countDocuments()
    const targets: PartitionCheckpoint[] = []
    let recordsLeftInLog = 0
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const partition = indexState.partitions.get(partitionId)
      if (partition !== undefined && partition.failed !== null) continue
      const appliedSeqNo = partition?.appliedSeqNo ?? 0
      const lastSeqNo =
        priorCheckpointThatLimitsTheRecords === undefined
          ? appliedSeqNo
          : Math.min(
              appliedSeqNo,
              snapshotCheckpointFor(priorCheckpointThatLimitsTheRecords, partitionId) + LOG_RECORDS_PER_CHECKPOINT,
            )
      recordsLeftInLog += appliedSeqNo - lastSeqNo
      const target: PartitionCheckpoint = {
        partitionId,
        lastSeqNo,
        primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
      }
      if (termHistoryOf !== undefined) target.termHistory = termHistoryOf(partitionId, lastSeqNo)
      targets.push(target)
    }
    const vectorPlans = new Map<string, VectorCheckpointPlan>()
    for (const [fieldPath, vectorIndex] of vectorIndexes) {
      const listed = listedVectorFields.find(ref => ref.fieldPath === fieldPath)
      const listedKeys = listed === undefined ? null : listed.files.map(file => file.key)
      vectorPlans.set(fieldPath, vectorIndex.planCheckpoint(listedKeys))
    }
    const memoryMatchesTheTargets = recordsLeftInLog === 0
    const wholePartitions = memoryMatchesTheTargets ? wholePartitionsOf(targets) : noWholePartitions()
    return { targets, documentCount, vectorPlans, wholePartitions, recordsLeftInLog }
  })
}

export async function writeCapturedVectors(
  store: CheckpointStore,
  indexName: string,
  capture: CheckpointCapture,
  priorManifest: SegmentManifest | null,
  rewriteUnchanged: boolean,
): Promise<LiveVectorsWritten> {
  if (capture.vectorPlans.size === 0) return { vectors: [], layouts: [], written: [] }
  const priorVectors = priorManifest?.vectors ?? []
  const priorCheckpoint = priorManifest?.checkpoint ?? []
  const noPartitionChanged = capture.targets.every(
    target => target.lastSeqNo === snapshotCheckpointFor(priorCheckpoint, target.partitionId),
  )
  const everyFieldWritten = [...capture.vectorPlans.keys()].every(fieldPath =>
    priorVectors.some(ref => ref.fieldPath === fieldPath),
  )
  const everyPlanUnchanged = [...capture.vectorPlans.values()].every(plan => plan.unchanged)
  if (!rewriteUnchanged && everyFieldWritten && noPartitionChanged && everyPlanUnchanged) {
    return { vectors: priorVectors, layouts: [], written: [] }
  }
  const written = await writeLiveVectors({ store, indexName, plans: capture.vectorPlans, priorVectors })
  return { vectors: written.refs, layouts: written.layouts, written: written.written }
}
