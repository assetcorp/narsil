import type { PartitionManager } from '../../partitioning/manager'
import type { VectorCheckpointPlan, VectorIndex } from '../../vector/vector-index'
import {
  LOG_RECORDS_PER_CHECKPOINT,
  WHOLE_PARTITION_LARGEST_DOCUMENT_COUNT,
  WHOLE_PARTITION_MIN_CHANGED_SHARE,
} from './constants'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState, PartitionState } from './manager-state'
import { snapshotCheckpointFor } from './recovery'
import {
  type CapturablePartitions,
  type CapturedWholePartition,
  captureWholePartition,
  type SegmentManifest,
  type VectorCheckpointLayout,
  type VectorFieldRef,
  type VectorFieldWritten,
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
  vectorPlans: Map<string, VectorCheckpointPlan>
  wholePartitions: WholePartitions
  recordsLeftInLog: number
}

export interface LiveVectorsWritten {
  vectors: VectorFieldRef[]
  layouts: VectorCheckpointLayout[]
  written: VectorFieldWritten[]
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

export type SerialisablePartitions = CapturablePartitions & Pick<PartitionManager, 'serializePartitionToBytes'>

export interface WholePartitions {
  serialized: Map<number, WholePartitionSegment>
  captured: CapturedWholePartition[]
}

export type WholePartitionsOf = (targets: readonly PartitionCheckpoint[]) => WholePartitions

function noWholePartitions(): WholePartitions {
  return { serialized: new Map(), captured: [] }
}

export interface WholePartitionRules {
  priorCheckpoint: PartitionCheckpoint[]
  priorPartitionIds: readonly number[]
  everyPartition: boolean
  aWorkerCanSerialise: boolean
}

export function wholePartitionsWhereMostChanged(
  manager: SerialisablePartitions,
  rules: WholePartitionRules,
): WholePartitionsOf {
  const { priorCheckpoint, priorPartitionIds, everyPartition, aWorkerCanSerialise } = rules
  return targets => {
    const whole: WholePartitions = { serialized: new Map(), captured: [] }
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
      const captured = aWorkerCanSerialise ? captureWholePartition(manager, partitionId) : null
      if (captured !== null) {
        whole.captured.push(captured)
      } else if (everyPartition || !aWorkerCanSerialise) {
        whole.serialized.set(partitionId, {
          payload: manager.serializePartitionToBytes(partitionId),
          docCount: manager.getPartition(partitionId).count(),
        })
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
): Promise<CheckpointCapture> {
  for (const vectorIndex of vectorIndexes.values()) await vectorIndex.completeGraph()
  return whileNoMutationApplies([...indexState.partitions.values()], () => {
    const documentCount = manager.countDocuments()
    const targets: PartitionCheckpoint[] = []
    let recordsLeftInLog = 0
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const partition = indexState.partitions.get(partitionId)
      const appliedSeqNo = partition?.appliedSeqNo ?? 0
      const lastSeqNo =
        priorCheckpointThatLimitsTheRecords === undefined
          ? appliedSeqNo
          : Math.min(
              appliedSeqNo,
              snapshotCheckpointFor(priorCheckpointThatLimitsTheRecords, partitionId) + LOG_RECORDS_PER_CHECKPOINT,
            )
      recordsLeftInLog += appliedSeqNo - lastSeqNo
      targets.push({
        partitionId,
        lastSeqNo,
        primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
      })
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
  directory: DurableDirectory,
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
  if (!rewriteUnchanged && everyFieldWritten && noPartitionChanged) {
    return { vectors: priorVectors, layouts: [], written: [] }
  }
  const written = await writeLiveVectors({ directory, indexName, plans: capture.vectorPlans, priorVectors })
  return { vectors: written.refs, layouts: written.layouts, written: written.written }
}
